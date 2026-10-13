import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { PageRef } from "@/lib/pdf/core";
import { mergePdfFiles, mergeOutlineTitle } from "@/lib/pdf/merge";
import { organizePdf, type OrganizePage } from "@/lib/pdf/organize";
import { keptPagesPlan, removePdfPages } from "@/lib/pdf/removePages";
import { splitPdf } from "@/lib/pdf/split";
import {
  legacyMergePdfFiles,
  legacyOrganizePdf,
  legacyRemovePdfPages,
} from "@/lib/pdf/testing/legacyPageEngines";
import {
  allStreamsText,
  inspectPdf,
  makeRichPdf,
  marker,
  pageDrawFingerprints,
} from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Wave 8 · migracion de las herramientas sueltas de paginas (Unir, Organizar, Quitar paginas) al
 * motor en sitio `pageAssembly`. Tres garantias, cada una medida contra el motor VIEJO (oraculos
 * en `testing/legacyPageEngines.ts`):
 *
 *  1. EQUIVALENCIA: mismas paginas, mismo orden, misma huella de dibujo (flujos de contenido,
 *     cajas y rotacion) que el motor viejo, para los mismos planes.
 *  2. CONSERVACION: lo que el motor viejo perdia (titulo/autor, AcroForm con valores, marcadores,
 *     enlaces) ahora se conserva.
 *  3. LIMPIEZA: el texto de las paginas quitadas (o no seleccionadas) ya no esta en el archivo y
 *     el archivo adelgaza.
 */

const RICH = {
  title: "Informe anual",
  author: "Ana Perez",
  subject: "Resultados",
  keywords: ["finanzas", "2026"],
  form: true,
  outline: true,
  links: true,
} as const;

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

const ref = (fileIndex: number, pageIndex: number, rotation = 0, selected = true): PageRef => ({
  id: `${fileIndex}:${pageIndex}`,
  fileIndex,
  pageIndex,
  rotation,
  selected,
});

/* ------------------------------------------------------------------ *
 * Quitar paginas
 * ------------------------------------------------------------------ */

describe("Quitar paginas: equivalencia con el motor viejo", () => {
  const plans = [
    { remove: [3] },
    { remove: [2, 4] },
    { remove: [1, 2, 3, 4, 5, 6, 7, 8] },
    { remove: [0, -1, 99, 2, 2, 2] },
    { remove: [] },
  ];

  for (const plan of plans) {
    it(`mismas paginas, orden y huella de dibujo para remove=[${plan.remove.join(",")}]`, async () => {
      const bytes = await makeRichPdf({ pages: 9, rotations: { 1: 90, 6: 270 }, cropBoxes: { 4: [10, 10, 100, 100] } });
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
  }

  it("quitar todas (o todas mas fuera de rango) sigue lanzando `empty`; un archivo vacio, `corrupt`", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    await expect(removePdfPages(toFile(bytes), { remove: [1, 2] })).rejects.toMatchObject({ code: "empty" });
    await expect(removePdfPages(toFile(bytes), { remove: [1, 2, 500] })).rejects.toMatchObject({ code: "empty" });
    await expect(removePdfPages(new File([], "e.pdf"), { remove: [1] })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("`keptPagesPlan` es exacto en los bordes (primera, ultima, todas)", () => {
    expect(keptPagesPlan([1], 3)?.map((e) => (e.kind === "existing" ? e.sourceIndex : -1))).toEqual([1, 2]);
    expect(keptPagesPlan([3], 3)?.map((e) => (e.kind === "existing" ? e.sourceIndex : -1))).toEqual([0, 1]);
    expect(keptPagesPlan([1, 2, 3], 3)).toBeNull();
    expect(keptPagesPlan([4], 3)?.length).toBe(3);
  });
});

describe("Quitar paginas: lo que el motor viejo no hacia", () => {
  it("conserva titulo, autor, formulario con valores, marcadores y enlaces de las paginas que quedan", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 6 });
    const mine = await bytesOf(await removePdfPages(toFile(bytes), { remove: [2, 4] }));
    const out = await inspectPdf(mine);
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-3", "campo-5", "campo-6"]);
    expect((await PDFDocument.load(mine)).getForm().getTextField("campo-5").getText()).toBe("valor-5");
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 3", "Capitulo 5", "Capitulo 6"]);
    expect(out.outlineTargets).toEqual([0, 1, 2, 3]);
    // Pagina 1 enlazaba a la ultima (sigue) y por nombre a la 3.ª (sigue); el enlace web se queda.
    expect(out.links[0]).toEqual(["page:3", "uri", "page:1"]);
  });

  it("el texto de las paginas quitadas desaparece del archivo (en el viejo seguia) y el archivo adelgaza", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 30 });
    const remove = { remove: Array.from({ length: 27 }, (_, i) => i + 2) };
    const legacy = await bytesOf(await legacyRemovePdfPages(toFile(bytes), remove));
    const mine = await bytesOf(await removePdfPages(toFile(bytes), remove));
    const legacyText = await allStreamsText(legacy);
    const mineText = await allStreamsText(mine);
    expect(legacyText).toContain(marker(10));
    for (let index = 1; index < 28; index += 1) expect(mineText).not.toContain(marker(index));
    expect(mineText).toContain(marker(0));
    expect(mineText).toContain(marker(28));
    expect(mineText).toContain(marker(29));
    expect(mine.length).toBeLessThan(legacy.length / 3);
    expect((await inspectPdf(mine)).pageObjects).toBe(3);
  });

  it("un marcador a una pagina quitada se va; en el viejo quedaba apuntando a nada", async () => {
    const bytes = await makeRichPdf({ pages: 4, outline: true });
    const legacy = await inspectPdf(await bytesOf(await legacyRemovePdfPages(toFile(bytes), { remove: [2] })));
    expect(legacy.outlineTargets).toContain(-1);
    const mine = await inspectPdf(await bytesOf(await removePdfPages(toFile(bytes), { remove: [2] })));
    expect(mine.outlineTitles).toEqual(["Capitulo 1", "Capitulo 3", "Capitulo 4"]);
    expect(mine.outlineTargets).toEqual([0, 1, 2]);
  });
});

/* ------------------------------------------------------------------ *
 * Organizar
 * ------------------------------------------------------------------ */

const ex = (page: number, rotation = 0): OrganizePage => ({ kind: "existing", page, rotation });
const blank: OrganizePage = { kind: "blank" };

describe("Organizar: equivalencia con el motor viejo", () => {
  const plans: { name: string; plan: OrganizePage[] }[] = [
    { name: "invertir", plan: [ex(5), ex(4), ex(3), ex(2), ex(1)] },
    { name: "quitar y girar", plan: [ex(1, 90), ex(3, 180), ex(5, 270)] },
    { name: "duplicar", plan: [ex(2), ex(2), ex(2, 90), ex(1)] },
    { name: "blancos intercalados", plan: [ex(1), blank, ex(2, 90), blank, blank, ex(3)] },
    { name: "blanco al principio hereda de la siguiente", plan: [blank, ex(4, 90), ex(5)] },
    { name: "todo blancos", plan: [blank, blank] },
    { name: "plan vacio = intacto", plan: [] },
    { name: "fuera de rango se descarta", plan: [ex(0), ex(99), ex(2), ex(-1)] },
  ];

  for (const { name, plan } of plans) {
    it(`${name}: mismas paginas, orden, tamanos, rotaciones y huella de dibujo`, async () => {
      const bytes = await makeRichPdf({ pages: 5, rotations: { 1: 90, 3: 270 }, cropBoxes: { 2: [5, 5, 50, 60] } });
      const legacy = await bytesOf(await legacyOrganizePdf(toFile(bytes), plan));
      const mine = await bytesOf(await organizePdf(toFile(bytes), plan));
      const a = await inspectPdf(legacy);
      const b = await inspectPdf(mine);
      expect(b.pageCount).toBe(a.pageCount);
      expect(b.markers).toEqual(a.markers);
      expect(b.widths).toEqual(a.widths);
      expect(b.rotations).toEqual(a.rotations);
      const loadedA = await PDFDocument.load(legacy);
      const loadedB = await PDFDocument.load(mine);
      expect(loadedB.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual(
        loadedA.getPages().map((p) => [p.getWidth(), p.getHeight()]),
      );
      expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
    });
  }

  it("un plan sin ninguna entrada valida lanza `empty`, como antes", async () => {
    const bytes = await makeRichPdf({ pages: 2 });
    await expect(organizePdf(toFile(bytes), [ex(0), ex(9)])).rejects.toMatchObject({ code: "empty" });
  });
});

describe("Organizar: lo que el motor viejo perdia", () => {
  it("reordenar conserva metadatos, formulario (valores), marcadores (apuntando bien) y enlaces", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 5 });
    const mine = await bytesOf(await organizePdf(toFile(bytes), [ex(5), ex(4), ex(3), ex(2), ex(1)]));
    const out = await inspectPdf(mine);
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
    expect(out.subject).toBe("Resultados");
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3", "campo-4", "campo-5"]);
    expect((await PDFDocument.load(mine)).getForm().getTextField("campo-2").getText()).toBe("valor-2");
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 3", "Capitulo 4", "Capitulo 5"]);
    expect(out.outlineTargets).toEqual([4, 3, 2, 1, 0]);
    expect(out.links[4]).toEqual(["page:0", "uri", "page:2"]);
    const legacy = await inspectPdf(await bytesOf(await legacyOrganizePdf(toFile(bytes), [ex(5), ex(4), ex(3), ex(2), ex(1)])));
    expect(legacy.title).toBeUndefined();
    expect(legacy.fieldNames).toEqual([]);
    expect(legacy.outlineTitles).toEqual([]);
  });

  it("duplicar una pagina con campo: el duplicado comparte el campo (mismo valor), sin perder el formulario", async () => {
    const bytes = await makeRichPdf({ pages: 2, form: true });
    const mine = await bytesOf(await organizePdf(toFile(bytes), [ex(1), ex(1), ex(2)]));
    const loaded = await PDFDocument.load(mine);
    expect(loaded.getForm().getTextField("campo-1").acroField.getWidgets().length).toBe(2);
    expect((await inspectPdf(mine)).fieldNames.sort()).toEqual(["campo-1", "campo-2"]);
  });

  it("las paginas quitadas no quedan dentro del archivo", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 8 });
    const mine = await bytesOf(await organizePdf(toFile(bytes), [ex(8), ex(1)]));
    const text = await allStreamsText(mine);
    expect(text).toContain(marker(7));
    expect(text).toContain(marker(0));
    for (let index = 1; index < 7; index += 1) expect(text).not.toContain(marker(index));
    expect((await inspectPdf(mine)).pageObjects).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Unir
 * ------------------------------------------------------------------ */

describe("Unir: equivalencia con el motor viejo", () => {
  it("sin plan: todas las paginas de todos los archivos, en orden, con la misma huella de dibujo", async () => {
    const a = await makeRichPdf({ pages: 3, baseWidth: 300, rotations: { 1: 90 } });
    const b = await makeRichPdf({ pages: 2, baseWidth: 400, cropBoxes: { 0: [1, 2, 30, 40] } });
    const c = await makeRichPdf({ pages: 1, baseWidth: 500 });
    const files = () => [toFile(a, "a.pdf"), toFile(b, "b.pdf"), toFile(c, "c.pdf")];
    const legacy = await bytesOf(await legacyMergePdfFiles(files()));
    const mine = await bytesOf(await mergePdfFiles(files()));
    const x = await inspectPdf(legacy);
    const y = await inspectPdf(mine);
    expect(y.pageCount).toBe(6);
    expect(y.markers).toEqual(x.markers);
    expect(y.widths).toEqual(x.widths);
    expect(y.widths).toEqual([300, 301, 302, 400, 401, 500]);
    expect(y.rotations).toEqual(x.rotations);
    expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
  });

  it("con plan: orden mezclado, paginas desmarcadas, rotaciones y repeticion de un archivo", async () => {
    const a = await makeRichPdf({ pages: 3, baseWidth: 300 });
    const b = await makeRichPdf({ pages: 3, baseWidth: 400, rotations: { 2: 90 } });
    const plan = [ref(1, 2, 90), ref(0, 0), ref(1, 0, 0, false), ref(0, 2, 180), ref(1, 1), ref(0, 1, 0, false), ref(1, 2)];
    const files = () => [toFile(a, "a.pdf"), toFile(b, "b.pdf")];
    const legacy = await bytesOf(await legacyMergePdfFiles(files(), { pages: plan }));
    const mine = await bytesOf(await mergePdfFiles(files(), { pages: plan }));
    const x = await inspectPdf(legacy);
    const y = await inspectPdf(mine);
    expect(y.widths).toEqual([402, 300, 302, 401, 402]);
    expect(y.markers).toEqual(x.markers);
    expect(y.widths).toEqual(x.widths);
    expect(y.rotations).toEqual(x.rotations);
    expect(y.rotations).toEqual([180, 0, 180, 0, 90]);
    expect(await pageDrawFingerprints(mine)).toEqual(await pageDrawFingerprints(legacy));
  });

  it("el primer archivo puede no aportar ninguna pagina", async () => {
    const a = await makeRichPdf({ pages: 2, baseWidth: 300, title: "A" });
    const b = await makeRichPdf({ pages: 2, baseWidth: 400 });
    const plan = [ref(1, 1), ref(1, 0)];
    const mine = await inspectPdf(await bytesOf(await mergePdfFiles([toFile(a), toFile(b)], { pages: plan })));
    expect(mine.widths).toEqual([401, 400]);
    expect(mine.pageObjects).toBe(2);
  });

  it("errores de siempre: sin archivos `empty`, uno solo `needTwo`, todo desmarcado `empty`", async () => {
    const a = await makeRichPdf({ pages: 1 });
    await expect(mergePdfFiles([])).rejects.toMatchObject({ code: "empty" });
    await expect(mergePdfFiles([toFile(a)])).rejects.toMatchObject({ code: "needTwo" });
    await expect(mergePdfFiles([toFile(a), toFile(a)], { pages: [ref(0, 0, 0, false)] })).rejects.toMatchObject({ code: "empty" });
  });

  it("mas de 10 archivos (tope de PDF Pro) se unen igual", async () => {
    const docs = await Promise.all(Array.from({ length: 12 }, (_, i) => makeRichPdf({ pages: 1, baseWidth: 100 + i })));
    const out = await inspectPdf(await bytesOf(await mergePdfFiles(docs.map((d, i) => toFile(d, `d${i}.pdf`)))));
    expect(out.widths).toEqual(docs.map((_, i) => 100 + i));
  });
});

describe("Unir: lo que el motor viejo perdia (metadatos, formulario, marcadores)", () => {
  it("los metadatos son los del PRIMER archivo", async () => {
    const a = await makeRichPdf({ pages: 1, title: "Primero", author: "Autor 1" });
    const b = await makeRichPdf({ pages: 1, title: "Segundo", author: "Autor 2" });
    const out = await inspectPdf(await bytesOf(await mergePdfFiles([toFile(a), toFile(b)])));
    expect(out.title).toBe("Primero");
    expect(out.author).toBe("Autor 1");
    const legacy = await inspectPdf(await bytesOf(await legacyMergePdfFiles([toFile(a), toFile(b)])));
    expect(legacy.title).toBeUndefined();
  });

  it("formulario: campos de todos los archivos; los repetidos se renombran y cada uno conserva SU valor", async () => {
    const a = await makeRichPdf({ pages: 2, form: true });
    const b = await PDFDocument.load(await makeRichPdf({ pages: 2, form: true }));
    b.getForm().getTextField("campo-1").setText("otro-valor");
    const bBytes = await b.save({ useObjectStreams: false });
    const merged = await bytesOf(await mergePdfFiles([toFile(a, "a.pdf"), toFile(bBytes, "b.pdf")]));
    expect((await inspectPdf(merged)).fieldNames.sort()).toEqual(["campo-1", "campo-1_2", "campo-2", "campo-2_2"]);
    const form = (await PDFDocument.load(merged)).getForm();
    expect(form.getTextField("campo-1").getText()).toBe("valor-1");
    expect(form.getTextField("campo-1_2").getText()).toBe("otro-valor");
    expect(form.getTextField("campo-2_2").getText()).toBe("valor-2");
  });

  it("marcadores: los de cada archivo quedan bajo un marcador con su nombre y apuntan a la pagina correcta", async () => {
    const a = await makeRichPdf({ pages: 2, outline: true });
    const b = await makeRichPdf({ pages: 3, outline: true });
    const c = await makeRichPdf({ pages: 1 });
    const merged = await bytesOf(
      await mergePdfFiles([toFile(a, "Informe (final).pdf"), toFile(c, "sin-marcadores.pdf"), toFile(b, "Anexo.PDF")]),
    );
    const out = await inspectPdf(merged);
    expect(out.outlineTitles).toEqual([
      "Informe (final)",
      "Capitulo 1",
      "Capitulo 2",
      "Anexo",
      "Capitulo 1",
      "Capitulo 2",
      "Capitulo 3",
    ]);
    expect(out.outlineTargets).toEqual([0, 0, 1, 3, 3, 4, 5]);
    const legacy = await inspectPdf(await bytesOf(await legacyMergePdfFiles([toFile(a), toFile(c), toFile(b)])));
    expect(legacy.outlineTitles).toEqual([]);
  });

  it("marcadores con plan parcial: solo entran los de paginas unidas; el grupo lleva a la primera pagina unida de ese archivo", async () => {
    const a = await makeRichPdf({ pages: 1 });
    const b = await makeRichPdf({ pages: 4, nestedOutline: true });
    const plan = [ref(0, 0), ref(1, 3), ref(1, 1)];
    const out = await inspectPdf(await bytesOf(await mergePdfFiles([toFile(a, "a.pdf"), toFile(b, "b.pdf")], { pages: plan })));
    // «Capitulo 1» (raiz anidada, pagina 1 de b) no viene: sus hijos vivos suben al grupo.
    expect(out.outlineTitles).toEqual(["b", "Capitulo 2", "Capitulo 4"]);
    expect(out.outlineTargets).toEqual([1, 2, 1]);
  });

  it("el /Count de los marcadores unidos es coherente y pdf-lib y el lector independiente los recorren igual", async () => {
    const a = await makeRichPdf({ pages: 2, nestedOutline: true });
    const b = await makeRichPdf({ pages: 2, outline: true });
    const merged = await bytesOf(await mergePdfFiles([toFile(a, "a.pdf"), toFile(b, "b.pdf")]));
    const loaded = await PDFDocument.load(merged);
    const outlines = loaded.catalog.lookup(loaded.context.obj("Outlines") as never);
    // a: grupo + «Capitulo 1» (abierto) + «Capitulo 2» = 3 visibles; b: grupo + 2 = 3.
    expect(String(outlines)).toContain("/Count 6");
    expect((await inspectPdf(merged)).outlineTitles).toEqual(["a", "Capitulo 1", "Capitulo 2", "b", "Capitulo 1", "Capitulo 2"]);
  });

  it("un archivo sin marcadores no gana un marcador vacio", async () => {
    const a = await makeRichPdf({ pages: 1 });
    const b = await makeRichPdf({ pages: 1 });
    expect((await inspectPdf(await bytesOf(await mergePdfFiles([toFile(a), toFile(b)])))).outlineTitles).toEqual([]);
  });

  it("las paginas desmarcadas no quedan dentro del archivo", async () => {
    const a = await makeRichPdf({ pages: 4, outline: true, form: true });
    const b = await makeRichPdf({ pages: 4, outline: true, form: true });
    const plan = [ref(0, 0), ref(1, 3)];
    const merged = await bytesOf(await mergePdfFiles([toFile(a), toFile(b)], { pages: plan }));
    const text = await allStreamsText(merged);
    expect(text).toContain(marker(0));
    expect(text).toContain(marker(3));
    for (const index of [1, 2]) expect(text).not.toContain(marker(index));
    expect((await inspectPdf(merged)).pageObjects).toBe(2);
  });

  it("`mergeOutlineTitle` quita la extension y no deja titulos vacios", () => {
    expect(mergeOutlineTitle(new File([], "Informe 2026.PDF"), 0)).toBe("Informe 2026");
    expect(mergeOutlineTitle(new File([], ".pdf"), 2)).toBe("Documento 3");
  });
});

/* ------------------------------------------------------------------ *
 * Dividir / Extraer (capa fina sobre pageAssemblyExport)
 * ------------------------------------------------------------------ */

describe("Dividir y Extraer: sobre pageAssemblyExport", () => {
  it("extraer a UN PDF conserva titulo, formulario y marcadores de las paginas extraidas, y no arrastra las demas", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 6 });
    const output = await splitPdf(toFile(bytes), { mode: "extract", pages: [2, 5], separate: false }, "doc");
    expect(output.kind).toBe("pdf");
    const mine = await bytesOf(output.blob);
    const out = await inspectPdf(mine);
    expect(out.markers).toEqual([marker(1), marker(4)]);
    expect(out.title).toBe("Informe anual");
    expect(out.outlineTitles).toEqual(["Capitulo 2", "Capitulo 5"]);
    expect(out.outlineTargets).toEqual([0, 1]);
    expect(out.fieldNames.sort()).toEqual(["campo-2", "campo-5"]);
    expect(out.pageObjects).toBe(2);
    const text = await allStreamsText(mine);
    for (const index of [0, 2, 3, 5]) expect(text).not.toContain(marker(index));
  });

  it("dividir en varias partes: cada parte conserva los metadatos y los campos de sus paginas", async () => {
    const bytes = await makeRichPdf({ ...RICH, pages: 4 });
    const output = await splitPdf(toFile(bytes), { mode: "fixed", size: 2 }, "doc");
    expect(output.kind).toBe("zip");
    expect(output.parts).toBe(2);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["doc-1-2.pdf", "doc-3-4.pdf"]);
    const second = await inspectPdf(await zip.files["doc-3-4.pdf"].async("uint8array"));
    expect(second.markers).toEqual([marker(2), marker(3)]);
    expect(second.title).toBe("Informe anual");
    expect(second.fieldNames.sort()).toEqual(["campo-3", "campo-4"]);
  });
});

/* ------------------------------------------------------------------ *
 * Rendimiento y tamano (cifras en consola; umbrales holgados para no ser fragiles)
 * ------------------------------------------------------------------ */

describe("rendimiento y tamano frente al motor viejo", () => {
  it("quitar 90 de 100 paginas: el resultado nuevo es mas pequeno y no mas de 3x mas lento", async () => {
    const bytes = await makeRichPdf({ pages: 100, form: true, outline: true, links: true });
    const remove = { remove: Array.from({ length: 90 }, (_, i) => i + 6) };
    const t0 = performance.now();
    const legacy = await bytesOf(await legacyRemovePdfPages(toFile(bytes), remove));
    const t1 = performance.now();
    const mine = await bytesOf(await removePdfPages(toFile(bytes), remove));
    const t2 = performance.now();
    console.info(
      `[wave8] quitar 90/100: viejo ${Math.round(t1 - t0)} ms / ${legacy.length} B · nuevo ${Math.round(t2 - t1)} ms / ${mine.length} B`,
    );
    expect(mine.length).toBeLessThan(legacy.length);
    expect(t2 - t1).toBeLessThan(Math.max(1500, (t1 - t0) * 3));
  }, 30_000);

  it("unir 20 PDF de 25 paginas: mismo numero de paginas, tamano comparable (<= 1,15x) y tiempo <= 3x", async () => {
    const docs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => makeRichPdf({ pages: 25, form: true, outline: true, baseWidth: 200 + i })),
    );
    const files = () => docs.map((d, i) => toFile(d, `doc-${i}.pdf`));
    const t0 = performance.now();
    const legacy = await bytesOf(await legacyMergePdfFiles(files()));
    const t1 = performance.now();
    const mine = await bytesOf(await mergePdfFiles(files()));
    const t2 = performance.now();
    console.info(
      `[wave8] unir 20x25: viejo ${Math.round(t1 - t0)} ms / ${legacy.length} B · nuevo ${Math.round(t2 - t1)} ms / ${mine.length} B`,
    );
    expect((await inspectPdf(mine)).pageCount).toBe(500);
    expect(mine.length).toBeLessThanOrEqual(legacy.length * 1.15);
    expect(t2 - t1).toBeLessThan(Math.max(3000, (t1 - t0) * 3));
  }, 60_000);
});
