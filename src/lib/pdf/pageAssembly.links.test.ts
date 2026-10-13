import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { applyPageAssembly, identityPlan, type PageEntry } from "@/lib/pdf/pageAssembly";
import { splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { mergePdfFilesWithReport } from "@/lib/pdf/merge";
import { removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { inspectPdf, makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";
import { pdfjsLinks, pdfjsOutline, type PdfjsLink } from "@/lib/pdf/testing/pdfjsInspect";

/**
 * Enlaces internos entre paginas. En el documento actual las paginas que se quedan son las MISMAS hojas,
 * asi que sus enlaces siguen valiendo; las paginas de OTRO PDF (Unir) y las partes de una division son
 * documentos nuevos: sus enlaces se reapuntan a las paginas copiadas, y los que llevan a una pagina que
 * no esta se quitan y se cuentan. Todo se lee con pdf.js (lector ajeno al motor).
 *
 * `makeRichPdf({ links: true })`: la pagina 1 lleva tres enlaces — a la ULTIMA pagina, a una URL y, por
 * NOMBRE («destino-tres»), a la pagina 3.
 */

const existing = (sourceIndex: number): PageEntry => ({ kind: "existing", sourceIndex, rotation: 0 });
const external = (sourceId: string, sourceIndex: number): PageEntry => ({
  kind: "external",
  sourceId,
  sourceIndex,
  rotation: 0,
});
const page = (index: number): PdfjsLink => ({ kind: "page", page: index });
const url: PdfjsLink = { kind: "url", url: "https://example.com/" };

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/** Cuantos diccionarios del archivo llevan alguna de las marcas privadas de reapuntado. */
async function leftoverMarks(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  let found = 0;
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : undefined;
    if (dict?.has(PDFName.of("OptimusLinkPage")) || dict?.has(PDFName.of("OptimusLinkTail"))) found += 1;
  }
  return found;
}

describe("enlaces internos de las paginas de otro PDF (Unir)", () => {
  it("se reapuntan a las paginas copiadas: llevan al mismo contenido, ahora en su sitio dentro del resultado", async () => {
    const base = await makeRichPdf({ pages: 2 });
    const other = await makeRichPdf({ pages: 4, links: true });
    const plan = [...identityPlan(2), ...[0, 1, 2, 3].map((index) => external("x", index))];
    const result = await applyPageAssembly(base, plan, { x: other });
    const links = await pdfjsLinks(result.bytes);
    // La pagina 1 del anexo (ahora la 3.ª) llevaba a su ultima pagina (la 6.ª), a una URL y por nombre a su 3.ª (la 5.ª).
    expect(links[2]).toEqual([page(5), url, page(4)]);
    expect(links.slice(0, 2)).toEqual([[], []]);
    expect(result.warnings).toEqual([]);
    expect(await leftoverMarks(result.bytes)).toBe(0);
  });

  it("cada archivo conserva sus enlaces entre SUS paginas (el primero, el segundo y el tercero no se cruzan)", async () => {
    const files = [
      await makeRichPdf({ pages: 3, links: true }),
      await makeRichPdf({ pages: 4, links: true }),
      await makeRichPdf({ pages: 5, links: true }),
    ];
    const result = await mergePdfFilesWithReport(files.map((bytes, index) => toFile(bytes, `f${index}.pdf`)));
    const links = await pdfjsLinks(new Uint8Array(await result.blob.arrayBuffer()));
    // Archivo 1: paginas 0-2; archivo 2: paginas 3-6; archivo 3: paginas 7-11.
    expect(links[0]).toEqual([page(2), url, page(2)]);
    expect(links[3]).toEqual([page(6), url, page(5)]);
    expect(links[7]).toEqual([page(11), url, page(9)]);
    expect(result.warnings).toEqual([]);
  });

  it("paginas del anexo en otro orden: el enlace sigue a la pagina de destino", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    // El anexo entra del reves: [3, 2, 1, 0] -> posiciones 1, 2, 3, 4 del resultado.
    const plan = [existing(0), ...[3, 2, 1, 0].map((index) => external("x", index))];
    const result = await applyPageAssembly(base, plan, { x: other });
    const links = await pdfjsLinks(result.bytes);
    // La pagina 0 del anexo esta ahora en la posicion 4; su ultima pagina (3) en la posicion 1; su 3.ª (2) en la 2.
    expect(links[4]).toEqual([page(1), url, page(2)]);
  });

  it("si solo entran algunas paginas del anexo, los enlaces a las que no entran se quitan y se cuentan", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    // Entran las paginas 0 y 3 del anexo: el enlace a la ultima (3) se queda; el enlace por nombre a la 3.ª (2) no.
    const result = await applyPageAssembly(base, [existing(0), external("x", 0), external("x", 3)], { x: other });
    const links = await pdfjsLinks(result.bytes);
    expect(links[1]).toEqual([page(2), url]);
    expect(result.warnings).toContainEqual({ code: "linksRemoved", count: 1 });
  });

  it("una pagina del anexo repetida (duplicada) lleva los mismos enlaces en las dos copias", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    const plan = [existing(0), ...[0, 1, 2, 3].map((index) => external("x", index)), external("x", 0)];
    const result = await applyPageAssembly(base, plan, { x: other });
    const links = await pdfjsLinks(result.bytes);
    expect(links[1]).toEqual([page(4), url, page(3)]);
    expect(links[5]).toEqual(links[1]);
    expect(await leftoverMarks(result.bytes)).toBe(0);
  });

  it("los enlaces del PRIMER archivo (el documento actual) se quedan como estaban", async () => {
    const base = await makeRichPdf({ pages: 4, links: true });
    const other = await makeRichPdf({ pages: 2 });
    const plan = [...identityPlan(4), external("x", 0), external("x", 1)];
    const links = await pdfjsLinks((await applyPageAssembly(base, plan, { x: other })).bytes);
    expect(links[0]).toEqual([page(3), url, page(2)]);
  });

  it("conserva el rectangulo, el borde y el tramo del destino (/XYZ) del enlace", async () => {
    const baseBytes = await makeRichPdf({ pages: 1 });
    const document = await PDFDocument.load(await makeRichPdf({ pages: 3 }));
    const context = document.context;
    const annot = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [11, 22, 133, 44],
        Border: [0, 0, 2],
        C: [1, 0, 0],
        Dest: [document.getPage(2).ref, PDFName.of("XYZ"), 10, 20, 0],
      }),
    );
    document.getPage(0).node.addAnnot(annot);
    const result = await applyPageAssembly(baseBytes, [existing(0), external("x", 0), external("x", 2)], {
      x: await document.save(),
    });
    const loaded = await PDFDocument.load(result.bytes);
    const annots = loaded.getPage(1).node.Annots()!;
    const link = loaded.context.lookup(annots.get(0), PDFDict);
    expect(link.lookup(PDFName.of("Rect"), PDFArray).asRectangle()).toEqual({ x: 11, y: 22, width: 122, height: 22 });
    expect(link.lookup(PDFName.of("Border"), PDFArray).size()).toBe(3);
    const dest = link.lookup(PDFName.of("Dest"), PDFArray);
    expect(dest.get(0)).toBe(loaded.getPage(2).ref);
    expect(dest.lookup(1, PDFName).decodeText()).toBe("XYZ");
    expect([2, 3, 4].map((index) => (dest.get(index) as PDFNumber).asNumber())).toEqual([10, 20, 0]);
    expect(link.has(PDFName.of("A"))).toBe(false);
    expect(link.get(PDFName.of("P"))).toBe(loaded.getPage(1).ref);
  });

  it("un enlace por nombre se entrega como destino explicito (los nombres del anexo no viajan)", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    const result = await applyPageAssembly(base, [existing(0), external("x", 0), external("x", 2)], { x: other });
    const loaded = await PDFDocument.load(result.bytes);
    const keys = loaded.catalog.keys().map((key) => key.decodeText());
    expect(keys).not.toContain("Names");
    const annots = loaded.getPage(1).node.Annots()!;
    for (let index = 0; index < annots.size(); index += 1) {
      const link = loaded.context.lookup(annots.get(index), PDFDict);
      const action = link.lookupMaybe(PDFName.of("A"), PDFDict);
      expect(action?.has(PDFName.of("D")) ?? false).toBe(false);
    }
    expect((await pdfjsLinks(result.bytes))[1]).toEqual([url, page(2)]);
  });

  it("no queda ninguna marca privada ni pagina huerfana del anexo", async () => {
    const base = await makeRichPdf({ pages: 2 });
    const other = await makeRichPdf({ pages: 8, links: true, outline: true, form: true });
    const result = await applyPageAssembly(base, [...identityPlan(2), external("x", 0), external("x", 4)], { x: other });
    expect(await leftoverMarks(result.bytes)).toBe(0);
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(4);
  });

  it("un enlace a una pagina que no existe en el anexo se quita y se cuenta", async () => {
    const other = await PDFDocument.load(await makeRichPdf({ pages: 3 }));
    const context = other.context;
    const stray = await PDFDocument.create();
    const strayPage = stray.addPage();
    const foreign = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 0, 10, 10],
        Dest: [context.register(strayPage.node.clone()), PDFName.of("Fit")],
      }),
    );
    other.getPage(0).node.addAnnot(foreign);
    const result = await applyPageAssembly(await makeRichPdf({ pages: 1 }), [existing(0), external("x", 0)], {
      x: await other.save(),
    });
    expect((await pdfjsLinks(result.bytes))[1]).toEqual([]);
    expect(result.warnings).toContainEqual({ code: "linksRemoved", count: 1 });
  });
});

describe("enlaces internos al quitar paginas del documento actual", () => {
  it("removePdfPagesWithReport: los enlaces a paginas quitadas se quitan y se cuentan; los demas siguen", async () => {
    const bytes = await makeRichPdf({ pages: 5, links: true });
    // Se quita la pagina 3 (destino del enlace por nombre) y la 5 (destino del enlace directo).
    const result = await removePdfPagesWithReport(toFile(bytes), { remove: [3, 5] });
    const links = await pdfjsLinks(new Uint8Array(await result.blob.arrayBuffer()));
    expect(links[0]).toEqual([url]);
    expect(result.warnings).toContainEqual({ code: "linksRemoved", count: 2 });
  });

  it("los enlaces que llevan a paginas que SI quedan se mueven con ellas (indices nuevos)", async () => {
    const bytes = await makeRichPdf({ pages: 5, links: true });
    const result = await removePdfPagesWithReport(toFile(bytes), { remove: [2, 4] });
    const links = await pdfjsLinks(new Uint8Array(await result.blob.arrayBuffer()));
    // Quedan 1, 3, 5: la pagina 3 es ahora la 2.ª (indice 1) y la 5 la 3.ª (indice 2).
    expect(links[0]).toEqual([page(2), url, page(1)]);
    expect(result.warnings).toEqual([]);
  });
});

describe("enlaces internos al dividir en varias partes", () => {
  async function parts(bytes: Uint8Array, groups: number[][]) {
    const outcome = await splitDocument(bytes, groups, "doc");
    const zip = await JSZip.loadAsync(outcome.bytes);
    const out: Uint8Array[] = [];
    for (const name of outcome.names) out.push(await zip.file(name)!.async("uint8array"));
    return { outcome, out };
  }

  it("dentro de una parte los enlaces se reapuntan a sus paginas; hacia otras partes se quitan y se cuentan", async () => {
    const bytes = await makeRichPdf({ pages: 6, links: true });
    // Parte A: paginas 0-2 (el enlace a la 3.ª por nombre es interno); parte B: 3-5 (sin enlaces).
    const { outcome, out } = await parts(bytes, [[0, 1, 2], [3, 4, 5]]);
    const first = await pdfjsLinks(out[0]);
    // El enlace a la ultima pagina del ORIGINAL (5) cae en la otra parte: se quita. El de nombre (2) se queda.
    expect(first[0]).toEqual([url, page(2)]);
    expect(outcome.warnings).toContainEqual({ code: "linksRemoved", count: 1 });
    expect(await leftoverMarks(out[0])).toBe(0);
    expect(await leftoverMarks(out[1])).toBe(0);
  });

  it("una parte que contiene origen y destino los conserva todos", async () => {
    const bytes = await makeRichPdf({ pages: 6, links: true });
    const { outcome, out } = await parts(bytes, [[0, 1, 2, 3, 4, 5], [1]]);
    const first = await pdfjsLinks(out[0]);
    expect(first[0]).toEqual([page(5), url, page(2)]);
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("linksRemoved");
  });

  it("las paginas que no salen en ninguna parte no cuentan", async () => {
    const bytes = await makeRichPdf({ pages: 6, links: true });
    const { outcome } = await parts(bytes, [[1, 2], [4]]);
    // La pagina 0 (con los tres enlaces) no sale: no hay enlaces que perder.
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("linksRemoved");
  });
});

describe("marcadores al dividir en varias partes (leidos con pdf.js)", () => {
  it("cada parte lleva los marcadores de SUS paginas, anidados y apuntando a la pagina correcta; no se pierde ninguno", async () => {
    // Marcadores: «Capitulo 1» (pagina 1) con «Capitulo 2..6» colgando de el.
    const bytes = await makeRichPdf({ pages: 6, nestedOutline: true });
    const outcome = await splitDocument(bytes, [[0, 1, 2], [3, 4, 5]], "doc");
    const zip = await JSZip.loadAsync(outcome.bytes);
    const first = new Uint8Array(await zip.file(outcome.names[0])!.async("uint8array"));
    const second = new Uint8Array(await zip.file(outcome.names[1])!.async("uint8array"));
    expect((await pdfjsOutline(first)).map((item) => [item.title, item.page, item.depth])).toEqual([
      ["Capitulo 1", 0, 0],
      ["Capitulo 2", 1, 1],
      ["Capitulo 3", 2, 1],
    ]);
    // Los de la segunda parte han perdido a su padre (la pagina 1): suben de nivel, no desaparecen.
    expect((await pdfjsOutline(second)).map((item) => [item.title, item.page, item.depth])).toEqual([
      ["Capitulo 4", 0, 0],
      ["Capitulo 5", 1, 0],
      ["Capitulo 6", 2, 0],
    ]);
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("outlinesRemoved");
  });

  it("los marcadores de paginas que no salen en ninguna parte se cuentan", async () => {
    const outcome = await splitDocument(await makeRichPdf({ pages: 6, outline: true }), [[0, 1], [4]], "doc");
    expect(outcome.warnings).toContainEqual({ code: "outlinesRemoved", count: 3 });
  });
});

describe("referencias a hojas ajenas", () => {
  it("una anotacion de un PDF anadido no arrastra la pagina de origen (/P)", async () => {
    const base = await makeRichPdf({ pages: 1 });
    const other = await makeRichPdf({ pages: 4, links: true });
    const result = await applyPageAssembly(base, [existing(0), external("x", 0)], { x: other });
    const loaded = await PDFDocument.load(result.bytes);
    const refs = loaded.getPages().map((item) => item.ref);
    const annots = loaded.getPage(1).node.Annots()!;
    for (let index = 0; index < annots.size(); index += 1) {
      const link = loaded.context.lookup(annots.get(index), PDFDict);
      const parent = link.get(PDFName.of("P"));
      expect(parent instanceof PDFRef && refs.includes(parent)).toBe(true);
    }
  });
});
