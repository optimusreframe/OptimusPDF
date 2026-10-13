import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { PageRef } from "@/lib/pdf/core";
import { mergePdfFiles, mergePdfFilesWithReport } from "@/lib/pdf/merge";
import { organizePdf, organizePdfWithReport, type OrganizePage } from "@/lib/pdf/organize";
import { removePdfPages, removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { splitPdf } from "@/lib/pdf/split";
import {
  legacyMergePdfFiles,
  legacyOrganizePdf,
  legacyRemovePdfPages,
} from "@/lib/pdf/testing/legacyPageEngines";
import { inspectPdf, makeRichPdf, pageDrawFingerprints } from "@/lib/pdf/testing/pageAssemblyFixtures";
import type { PageAssemblyWarning } from "@/lib/pdf/pageAssembly";

/**
 * B3 · Las herramientas sueltas devuelven el PDF Y lo que no pudieron conservar.
 *
 *  1. EQUIVALENCIA: con documentos que traen etiquetas de pagina, enlaces, firma y estructura etiquetada,
 *     las paginas, el orden, las cajas, las rotaciones y el contenido dibujado siguen siendo los del motor
 *     viejo (lo que no cambia, no cambia).
 *  2. AVISOS por herramienta: la tabla de lo que se avisa para un mismo documento.
 *  3. Los envoltorios de siempre (`mergePdfFiles`, `organizePdf`, `removePdfPages`) siguen dando solo el Blob.
 */

const RICH = {
  title: "Libro",
  author: "Ana",
  form: true,
  outline: true,
  links: true,
  signedSignature: true,
  taggedContent: true,
  labelRanges: [
    { start: 0, style: "r" },
    { start: 2, style: "D" },
  ],
} as const;

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

const codes = (warnings: readonly PageAssemblyWarning[]) => warnings.map((warning) => warning.code).sort();
const ref = (fileIndex: number, pageIndex: number, rotation = 0, selected = true): PageRef => ({
  id: `${fileIndex}:${pageIndex}`,
  fileIndex,
  pageIndex,
  rotation,
  selected,
});

describe("equivalencia con el motor viejo en documentos con etiquetas, enlaces, firma y estructura", () => {
  it("Quitar paginas: mismas paginas, orden, cajas, rotaciones y dibujo", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 8, rotations: { 1: 90 }, cropBoxes: { 3: [10, 10, 120, 120] } });
    const plan = { remove: [3, 5, 6] };
    const legacy = await bytesOf(await legacyRemovePdfPages(toFile(bytes), plan));
    const mine = await bytesOf(await removePdfPages(toFile(bytes), plan));
    const a = await inspectPdf(legacy);
    const b = await inspectPdf(mine);
    expect(b.pageCount).toBe(a.pageCount);
    expect(b.markers).toEqual(a.markers);
    expect(b.widths).toEqual(a.widths);
    expect(b.rotations).toEqual(a.rotations);
    expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
  });

  it("Organizar: mover, girar y anadir una pagina en blanco", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 6, rotations: { 2: 270 } });
    const plan: OrganizePage[] = [
      { kind: "existing", page: 4, rotation: 90 },
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "blank" },
      { kind: "existing", page: 6, rotation: 180 },
      { kind: "existing", page: 3, rotation: 0 },
    ];
    const legacy = await bytesOf(await legacyOrganizePdf(toFile(bytes), plan));
    const mine = await bytesOf(await organizePdf(toFile(bytes), plan));
    const a = await inspectPdf(legacy);
    const b = await inspectPdf(mine);
    expect(b.markers).toEqual(a.markers);
    expect(b.widths).toEqual(a.widths);
    expect(b.rotations).toEqual(a.rotations);
    expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
  });

  it("Unir: tres archivos con paginas desmarcadas y giradas", async () => {
    const files = [
      toFile(await makeRichPdf({ ...RICH, pages: 3, baseWidth: 300 }), "a.pdf"),
      toFile(await makeRichPdf({ ...RICH, pages: 3, baseWidth: 400 }), "b.pdf"),
      toFile(await makeRichPdf({ ...RICH, pages: 2, baseWidth: 500 }), "c.pdf"),
    ];
    const pages = [
      ref(0, 0), ref(1, 2, 90), ref(0, 1), ref(2, 1), ref(1, 0, 0, false), ref(2, 0, 180), ref(0, 2, 0, false), ref(1, 1),
    ];
    const legacy = await bytesOf(await legacyMergePdfFiles(files, { pages }));
    const mine = await bytesOf(await mergePdfFiles(files, { pages }));
    const a = await inspectPdf(legacy);
    const b = await inspectPdf(mine);
    expect(b.pageCount).toBe(a.pageCount);
    expect(b.widths).toEqual(a.widths);
    expect(b.rotations).toEqual(a.rotations);
    expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
  });
});

describe("los envoltorios con informe dan el mismo PDF que los de siempre", () => {
  it("removePdfPagesWithReport / organizePdfWithReport / mergePdfFilesWithReport", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 5 });
    const removed = await removePdfPagesWithReport(toFile(bytes), { remove: [2] });
    expect(removed.pageCount).toBe(4);
    expect(await pageDrawFingerprints(await bytesOf(removed.blob))).toEqual(
      await pageDrawFingerprints(await bytesOf(await removePdfPages(toFile(bytes), { remove: [2] }))),
    );
    const organized = await organizePdfWithReport(toFile(bytes), [
      { kind: "existing", page: 2, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
    ]);
    expect(organized.pageCount).toBe(2);
    const merged = await mergePdfFilesWithReport([toFile(bytes, "a.pdf"), toFile(bytes, "b.pdf")]);
    expect(merged.pageCount).toBe(10);
    expect(merged.blob.type).toBe("application/pdf");
    expect(removed.blob.type).toBe("application/pdf");
  });

  it("los errores no cambian (vacio, falta uno, todo quitado)", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    await expect(mergePdfFilesWithReport([])).rejects.toMatchObject({ code: "empty" });
    await expect(mergePdfFilesWithReport([toFile(bytes)])).rejects.toMatchObject({ code: "needTwo" });
    await expect(removePdfPagesWithReport(toFile(bytes), { remove: [1, 2] })).rejects.toMatchObject({ code: "empty" });
    await expect(organizePdfWithReport(toFile(bytes), [{ kind: "existing", page: 9, rotation: 0 }])).rejects.toMatchObject({ code: "empty" });
  });
});

describe("lo que se avisa en cada herramienta, para un mismo libro (6 paginas, firmado, etiquetado, con enlaces y marcadores)", () => {
  const book = () => makeRichPdf({ ...RICH, pages: 6 });

  it("Quitar paginas 3 y 5: firma invalidada y lo que apuntaba a ellas; etiquetas y estructura se conservan sin aviso", async () => {
    const { warnings } = await removePdfPagesWithReport(toFile(await book()), { remove: [3, 5] });
    expect(warnings).toEqual(
      expect.arrayContaining([
        { code: "signaturesInvalidated", count: 1 },
        { code: "outlinesRemoved", count: 2 },
        { code: "linksRemoved", count: 1 },
        { code: "namedDestinationsRemoved", count: 1 },
        { code: "formFieldsRemoved", count: 2 },
      ]),
    );
    expect(codes(warnings)).not.toContain("pageLabelsRemoved");
    expect(codes(warnings)).not.toContain("structureRemoved");
    expect(codes(warnings)).not.toContain("structureIncomplete");
  });

  it("Organizar (solo mover y girar): unicamente la firma", async () => {
    const { warnings } = await organizePdfWithReport(toFile(await book()), [
      { kind: "existing", page: 6, rotation: 0 },
      { kind: "existing", page: 1, rotation: 90 },
      { kind: "existing", page: 2, rotation: 0 },
      { kind: "existing", page: 3, rotation: 0 },
      { kind: "existing", page: 4, rotation: 0 },
      { kind: "existing", page: 5, rotation: 0 },
    ]);
    expect(warnings).toEqual([{ code: "signaturesInvalidated", count: 1 }]);
  });

  it("Unir tres archivos: firma del primero, firmas no copiadas y paginas sin etiquetas de accesibilidad", async () => {
    const { warnings } = await mergePdfFilesWithReport([
      toFile(await makeRichPdf({ ...RICH, pages: 3 }), "a.pdf"),
      toFile(await makeRichPdf({ ...RICH, pages: 2 }), "b.pdf"),
      toFile(await makeRichPdf({ ...RICH, pages: 2 }), "c.pdf"),
    ]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        { code: "signaturesInvalidated", count: 1 },
        { code: "signedSignaturesRemoved", count: 2 },
        { code: "structureIncomplete", count: 4 },
        { code: "fieldsRenamed", count: 4 },
      ]),
    );
  });

  it("Extraer un PDF (paginas 2 y 4): la firma esta en la pagina 1 y no sale; se cuentan los campos y marcadores que se quedan fuera", async () => {
    const output = await splitPdf(toFile(await book()), { mode: "extract", pages: [2, 4], separate: false }, "libro");
    expect(output.kind).toBe("pdf");
    expect(codes(output.warnings)).not.toContain("signaturesInvalidated");
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        { code: "outlinesRemoved", count: 4 },
        // 4 campos de texto (paginas 1, 3, 5 y 6) y el campo de firma de la pagina 1.
        { code: "formFieldsRemoved", count: 5 },
      ]),
    );
  });

  it("Dividir en tres partes: cada parte es un documento nuevo", async () => {
    const output = await splitPdf(
      toFile(await book()),
      { mode: "ranges", ranges: [{ from: 1, to: 2 }, { from: 3, to: 4 }, { from: 5, to: 6 }], merge: false },
      "libro",
    );
    expect(output.kind).toBe("zip");
    expect(output.parts).toBe(3);
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        { code: "signedSignaturesRemoved", count: 1 },
        { code: "structureRemoved", count: 1 },
      ]),
    );
    // Los marcadores y las etiquetas SI viajan a la parte que tiene su pagina: no se pierde ningun marcador.
    expect(codes(output.warnings)).not.toContain("outlinesRemoved");
    const zip = await JSZip.loadAsync(await bytesOf(output.blob));
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
    const first = await inspectPdf(await zip.files[names[0]].async("uint8array"));
    expect(first.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2"]);
    expect(first.outlineTargets).toEqual([0, 1]);
  });

  it("un documento sin nada que perder no devuelve avisos en ninguna herramienta", async () => {
    const plain = await makeRichPdf({ pages: 4, title: "Plano" });
    expect((await removePdfPagesWithReport(toFile(plain), { remove: [2] })).warnings).toEqual([]);
    expect((await organizePdfWithReport(toFile(plain), [
      { kind: "existing", page: 2, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
    ])).warnings).toEqual([]);
    expect((await mergePdfFilesWithReport([toFile(plain, "a.pdf"), toFile(plain, "b.pdf")])).warnings).toEqual([]);
    expect((await splitPdf(toFile(plain), { mode: "fixed", size: 2 }, "p")).warnings).toEqual([]);
    expect((await splitPdf(toFile(plain), { mode: "extract", pages: [1, 3], separate: false }, "p")).warnings).toEqual([]);
  });
});
