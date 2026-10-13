import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { applyPageAssembly, identityPlan, type PageEntry } from "@/lib/pdf/pageAssembly";
import { splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { mergePdfFilesWithReport } from "@/lib/pdf/merge";
import { organizePdfWithReport } from "@/lib/pdf/organize";
import { removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { inspectPdf, makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";
import { pdfjsStructTree, structContentCount, structRoles } from "@/lib/pdf/testing/pdfjsInspect";

/**
 * PDF etiquetado: al quitar paginas el arbol de estructura se PODA a las paginas que quedan (las etiquetas
 * de accesibilidad de las demas siguen intactas), y solo se quita entero, con aviso, si no se puede podar.
 * Las paginas copiadas (duplicados, paginas de otro PDF) no llevan etiquetas y se avisa.
 *
 * `taggedContent`: Document -> [P (parrafo-N) por pagina, Div (compartido) con contenido en las paginas 1 y 2],
 * con contenido marcado real (MCID), `/StructParents`, `/ParentTree` e `/IDTree`. Se lee con pdf.js
 * (`getStructTree`) y, si esta instalado, con poppler (`pdfinfo -struct`).
 */

const existing = (sourceIndex: number, copy = false): PageEntry => ({
  kind: "existing",
  sourceIndex,
  rotation: 0,
  ...(copy ? { copy: true } : {}),
});
const blank: PageEntry = { kind: "blank", width: 100, height: 100, rotation: 0 };
const external = (sourceId: string, sourceIndex: number): PageEntry => ({
  kind: "external",
  sourceId,
  sourceIndex,
  rotation: 0,
});
const keep = (...indices: number[]): PageEntry[] => indices.map((index) => existing(index));

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

type StructInfo = {
  /** Identificadores (`/ID`) que siguen en el arbol de identificadores. */
  ids: string[];
  /** Claves del arbol de padres. */
  parentKeys: number[];
  /** Elementos de estructura alcanzables desde la raiz, por `/ID` o `/S`. */
  elements: string[];
  /** Hojas de pagina a las que apunta algun `/Pg` del arbol. */
  pgTargets: string[];
};

/** Lectura propia (sin el motor) del arbol de estructura de un archivo. */
async function readStruct(bytes: Uint8Array): Promise<StructInfo> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = document.context;
  const root = document.catalog.lookupMaybe(PDFName.of("StructTreeRoot"), PDFDict);
  const info: StructInfo = { ids: [], parentKeys: [], elements: [], pgTargets: [] };
  if (!root) return info;
  const idTree = root.lookupMaybe(PDFName.of("IDTree"), PDFDict);
  const names = idTree?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      info.ids.push((names.lookup(index, PDFString) as PDFString).decodeText());
    }
  }
  const parentTree = root.lookupMaybe(PDFName.of("ParentTree"), PDFDict);
  const nums = parentTree?.lookupMaybe(PDFName.of("Nums"), PDFArray);
  if (nums) {
    for (let index = 0; index + 1 < nums.size(); index += 2) info.parentKeys.push(nums.lookup(index, PDFNumber).asNumber());
  }
  const seen = new Set<unknown>();
  const visit = (item: unknown) => {
    const dict = item instanceof PDFRef ? context.lookup(item) : item;
    if (!(dict instanceof PDFDict) || seen.has(dict)) return;
    seen.add(dict);
    const pg = dict.get(PDFName.of("Pg"));
    if (pg instanceof PDFRef) info.pgTargets.push(pg.toString());
    const id = dict.lookupMaybe(PDFName.of("ID"), PDFString);
    const type = dict.lookupMaybe(PDFName.of("Type"), PDFName)?.decodeText();
    if (type === "StructElem" || type === undefined) {
      info.elements.push(id ? id.decodeText() : (dict.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText() ?? "?"));
    }
    const k = dict.get(PDFName.of("K"));
    const resolved = k instanceof PDFRef ? context.lookup(k) : k;
    if (resolved instanceof PDFArray) for (let index = 0; index < resolved.size(); index += 1) visit(resolved.get(index));
    else if (resolved instanceof PDFDict) visit(k);
  };
  visit(root.get(PDFName.of("K")));
  return info;
}

let popplerAvailable: boolean | null = null;
function poppler(bytes: Uint8Array): string | null {
  if (popplerAvailable === null) {
    try {
      execFileSync("pdfinfo", ["-v"], { stdio: "ignore" });
      popplerAvailable = true;
    } catch {
      popplerAvailable = false;
    }
  }
  if (!popplerAvailable) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimus-b3-"));
  const file = path.join(dir, "in.pdf");
  fs.writeFileSync(file, bytes);
  try {
    return execFileSync("pdfinfo", ["-struct", file], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("PDF etiquetado: poda del arbol de estructura al quitar paginas", () => {
  it("la fixture etiquetada se lee bien con pdf.js (punto de partida)", async () => {
    const bytes = await makeRichPdf({ pages: 5, taggedContent: true });
    const first = await pdfjsStructTree(bytes, 1);
    expect(structRoles(first)).toEqual(["Document", "P", "Div"]);
    expect(structContentCount(first)).toBe(2);
    expect(structContentCount(await pdfjsStructTree(bytes, 3))).toBe(1);
  });

  it("quitar paginas conserva el arbol y las etiquetas de las que quedan (sin avisar de nada)", async () => {
    const bytes = await makeRichPdf({ pages: 5, taggedContent: true });
    const result = await applyPageAssembly(bytes, keep(1, 3, 4));
    expect(result.warnings).toEqual([]);
    const out = await inspectPdf(result.bytes);
    expect(out.hasStructTree).toBe(true);
    expect(out.pageObjects).toBe(3);
    // La pagina que antes era la 2.ª (con el Div compartido) conserva sus dos contenidos marcados.
    const first = await pdfjsStructTree(result.bytes, 1);
    expect(structRoles(first)).toEqual(["Document", "P", "Div"]);
    expect(structContentCount(first)).toBe(2);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 2))).toBe(1);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 3))).toBe(1);
    const info = await readStruct(result.bytes);
    expect(info.elements.sort()).toEqual(["Document", "compartido", "parrafo-2", "parrafo-4", "parrafo-5"]);
    expect(info.ids.sort()).toEqual(["compartido", "parrafo-2", "parrafo-4", "parrafo-5"]);
    expect(info.parentKeys).toEqual([1, 3, 4]);
  });

  it("un elemento que sigue vivo por otra pagina deja de apuntar a la pagina quitada", async () => {
    const bytes = await makeRichPdf({ pages: 4, taggedContent: true });
    // Se quita la pagina 1: el Div compartido sigue vivo por la pagina 2 y no puede arrastrar la 1.
    const result = await applyPageAssembly(bytes, keep(1, 2, 3));
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(3);
    const info = await readStruct(result.bytes);
    expect(info.elements).toContain("compartido");
    expect(info.ids).not.toContain("parrafo-1");
    expect(structContentCount(await pdfjsStructTree(result.bytes, 1))).toBe(2);
  });

  it("un elemento cuyo contenido esta TODO en paginas quitadas desaparece con su identificador y su clave de padre", async () => {
    const bytes = await makeRichPdf({ pages: 4, taggedContent: true });
    // El Div compartido solo vive en las paginas 1 y 2: quitadas las dos, el Div sobra.
    const result = await applyPageAssembly(bytes, keep(2, 3));
    const info = await readStruct(result.bytes);
    expect(info.elements.sort()).toEqual(["Document", "parrafo-3", "parrafo-4"]);
    expect(info.ids.sort()).toEqual(["parrafo-3", "parrafo-4"]);
    expect(info.parentKeys).toEqual([2, 3]);
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(2);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 1))).toBe(1);
  });

  it("un elemento con un contenido en una pagina quitada y otro en una que queda conserva solo el que queda", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 4, taggedContent: true }));
    const context = document.context;
    // Parrafo 2: su contenido (MCID 0, en su pagina) y, ademas, un contenido marcado de la pagina 4.
    const root = document.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    const top = context.lookup(root.get(PDFName.of("K")) as PDFRef, PDFDict);
    const kids = top.lookup(PDFName.of("K"), PDFArray);
    const second = context.lookup(kids.get(1) as PDFRef, PDFDict);
    second.set(
      PDFName.of("K"),
      context.obj([0, { Type: "MCR", Pg: document.getPage(3).ref, MCID: 7 }]),
    );
    const bytes = await document.save();
    const result = await applyPageAssembly(bytes, keep(0, 2, 3));
    const info = await readStruct(result.bytes);
    expect(info.elements).toContain("parrafo-2");
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(3);
    // Ninguna hoja quitada sigue referenciada desde el arbol.
    const loaded = await PDFDocument.load(result.bytes);
    const alive = new Set(loaded.getPages().map((page) => page.ref.toString()));
    expect(info.pgTargets.every((target) => alive.has(target))).toBe(true);
  });

  it("solo reordenar deja el arbol de estructura tal cual y cada pagina sigue con sus etiquetas", async () => {
    const bytes = await makeRichPdf({ pages: 4, taggedContent: true });
    const result = await applyPageAssembly(bytes, keep(3, 2, 1, 0));
    expect(result.warnings).toEqual([]);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 4))).toBe(2);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 1))).toBe(1);
    expect((await readStruct(result.bytes)).parentKeys).toEqual([0, 1, 2, 3]);
  });

  it("si solo queda una pagina nueva ya no hay etiquetas que conservar: se quita el arbol y se avisa", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 3, taggedContent: true }), [blank]);
    expect((await inspectPdf(result.bytes)).hasStructTree).toBe(false);
    expect(result.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
    expect((await inspectPdf(result.bytes)).pageObjects).toBe(1);
  });

  it("un arbol demasiado profundo para podarlo con seguridad se quita entero y se avisa (nunca arrastra paginas)", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 3, tagged: true }));
    const context = document.context;
    // Una cadena de 500 elementos anidados que acaba en la pagina 1.
    let child = context.register(
      context.obj({ Type: "StructElem", S: "P", Pg: document.getPage(0).ref }),
    );
    for (let depth = 0; depth < 500; depth += 1) {
      child = context.register(context.obj({ Type: "StructElem", S: "Div", K: [child] }));
    }
    const root = context.lookup(document.catalog.get(PDFName.of("StructTreeRoot")) as PDFRef, PDFDict);
    root.set(PDFName.of("K"), context.obj([child]));
    const result = await applyPageAssembly(await document.save(), keep(0, 1));
    const out = await inspectPdf(result.bytes);
    expect(out.hasStructTree).toBe(false);
    expect(out.pageObjects).toBe(2);
    expect(result.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
  });

  it("si algo del arbol que SI se queda sigue llevando a una pagina quitada, se quita el arbol entero (no se arrastra la pagina)", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 4, taggedContent: true }));
    const context = document.context;
    const root = document.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    const top = context.lookup(root.get(PDFName.of("K")) as PDFRef, PDFDict);
    const kids = top.lookup(PDFName.of("K"), PDFArray);
    // Un atributo propio del parrafo de la pagina 4 (que se queda) referencia la hoja de la pagina 2 (que se quita).
    context.lookup(kids.get(3) as PDFRef, PDFDict).set(PDFName.of("Referencia"), document.getPage(1).ref);
    const result = await applyPageAssembly(await document.save(), keep(0, 2, 3));
    const out = await inspectPdf(result.bytes);
    expect(out.hasStructTree).toBe(false);
    expect(out.pageObjects).toBe(3);
    expect(result.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
  });

  it("un arbol de padres ilegible se quita entero y se avisa", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 3, taggedContent: true }));
    const root = document.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    root.set(PDFName.of("ParentTree"), document.context.obj({ Nums: ["no-es-una-clave", []] }));
    const result = await applyPageAssembly(await document.save(), keep(0, 1));
    expect((await inspectPdf(result.bytes)).hasStructTree).toBe(false);
    expect(result.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
  });

  it("referencias a objetos (enlaces etiquetados): se van con su pagina, y su clave del arbol de padres tambien", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 3, taggedContent: true }));
    const context = document.context;
    const annotRef = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 60, 30],
        A: { S: "URI", URI: PDFString.of("https://example.com/") },
        StructParent: 10,
      }),
    );
    document.getPage(1).node.addAnnot(annotRef);
    const linkElement = context.register(
      context.obj({
        Type: "StructElem",
        S: "Link",
        ID: PDFString.of("enlace-2"),
        Pg: document.getPage(1).ref,
        K: { Type: "OBJR", Obj: annotRef },
      }),
    );
    const root = document.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    const top = context.lookup(root.get(PDFName.of("K")) as PDFRef, PDFDict);
    top.lookup(PDFName.of("K"), PDFArray).push(linkElement);
    const tree = root.lookup(PDFName.of("ParentTree"), PDFDict);
    const nums = tree.lookup(PDFName.of("Nums"), PDFArray);
    nums.push(PDFNumber.of(10));
    nums.push(linkElement);
    const bytes = await document.save();
    const before = await readStruct(bytes);
    expect(before.parentKeys).toContain(10);

    const kept = await applyPageAssembly(bytes, keep(0, 1, 2));
    expect((await readStruct(kept.bytes)).parentKeys).toContain(10);

    const removed = await applyPageAssembly(bytes, keep(0, 2));
    const info = await readStruct(removed.bytes);
    expect(info.parentKeys).toEqual([0, 2]);
    expect(info.elements).not.toContain("enlace-2");
    expect(info.ids).not.toContain("enlace-2");
    expect((await inspectPdf(removed.bytes)).pageObjects).toBe(2);
    expect(removed.warnings).toEqual([]);
  });

  it("quitar la ultima pagina: el arbol conserva los identificadores y las claves de las paginas que quedan", async () => {
    const bytes = await makeRichPdf({ pages: 3, taggedContent: true });
    // Se quita la ultima pagina: el parrafo-3 se va, pero el resto del arbol conserva su forma.
    const result = await applyPageAssembly(bytes, keep(0, 1));
    const info = await readStruct(result.bytes);
    expect(info.ids).toEqual(["compartido", "parrafo-1", "parrafo-2"]);
    expect(info.parentKeys).toEqual([0, 1]);
  });

  it("el PDF podado lo abre poppler con el arbol de las paginas que quedan (si poppler esta instalado)", async () => {
    const bytes = await makeRichPdf({ pages: 5, taggedContent: true });
    const result = await applyPageAssembly(bytes, keep(1, 3, 4));
    const printed = poppler(result.bytes);
    if (printed === null) return;
    expect(printed).toContain("parrafo-2");
    expect(printed).toContain("parrafo-5");
    expect(printed).not.toContain("parrafo-1");
    expect(printed).not.toContain("parrafo-3");
  });

  it("removePdfPagesWithReport: sin avisos y el arbol podado", async () => {
    const bytes = await makeRichPdf({ pages: 5, taggedContent: true });
    const result = await removePdfPagesWithReport(toFile(bytes), { remove: [1, 3] });
    expect(result.warnings).toEqual([]);
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect((await readStruct(out)).ids.sort()).toEqual(["compartido", "parrafo-2", "parrafo-4", "parrafo-5"]);
  });
});

describe("PDF etiquetado: paginas que no llevan etiquetas", () => {
  it("duplicar una pagina de un PDF etiquetado avisa de que la copia no lleva etiquetas", async () => {
    const bytes = await makeRichPdf({ pages: 3, taggedContent: true });
    const result = await applyPageAssembly(bytes, [existing(0), existing(0, true), existing(1), existing(2, true), existing(2)]);
    expect(result.warnings).toContainEqual({ code: "structureIncomplete", count: 2 });
    const loaded = await PDFDocument.load(result.bytes);
    // Las originales siguen con sus claves de estructura; las copias, no.
    const keys = loaded.getPages().map((page) => page.node.lookupMaybe(PDFName.of("StructParents"), PDFNumber)?.asNumber());
    expect(keys).toEqual([0, undefined, 1, undefined, 2]);
  });

  it("duplicar en un PDF sin etiquetar no avisa de etiquetas", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 2 }), [existing(0), existing(0, true), existing(1)]);
    expect(result.warnings).toEqual([]);
  });

  it("Unir: las paginas de un PDF etiquetado anadido no llevan etiquetas y se cuentan; sin claves colgando", async () => {
    const base = await makeRichPdf({ pages: 2, taggedContent: true });
    const other = await makeRichPdf({ pages: 3, taggedContent: true });
    const plan = [...identityPlan(2), external("x", 0), external("x", 1), external("x", 2)];
    const result = await applyPageAssembly(base, plan, { x: other });
    expect(result.warnings).toContainEqual({ code: "structureIncomplete", count: 3 });
    const loaded = await PDFDocument.load(result.bytes);
    const keys = loaded.getPages().map((page) => page.node.lookupMaybe(PDFName.of("StructParents"), PDFNumber)?.asNumber());
    // Las 2 del primero conservan su clave; las 3 anadidas NO traen la clave del arbol de OTRO documento.
    expect(keys).toEqual([0, 1, undefined, undefined, undefined]);
    expect((await inspectPdf(result.bytes)).hasStructTree).toBe(true);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 1))).toBe(2);
    expect(structContentCount(await pdfjsStructTree(result.bytes, 3))).toBe(0);
  });

  it("Unir con el PRIMER archivo sin etiquetas y el segundo etiquetado: el resultado no tiene arbol y se avisa", async () => {
    const result = await mergePdfFilesWithReport([
      toFile(await makeRichPdf({ pages: 2 }), "a.pdf"),
      toFile(await makeRichPdf({ pages: 2, taggedContent: true }), "b.pdf"),
    ]);
    expect(result.warnings).toContainEqual({ code: "structureIncomplete", count: 2 });
    expect((await inspectPdf(new Uint8Array(await result.blob.arrayBuffer()))).hasStructTree).toBe(false);
  });

  describe("D7 · la cuenta de paginas sin etiquetas dice la verdad en cada combinacion", () => {
    const merge = (...files: Uint8Array[]) =>
      mergePdfFilesWithReport(files.map((bytes, index) => toFile(bytes, `f${index}.pdf`)));
    const incomplete = (warnings: readonly { code: string; count: number }[]) =>
      warnings.filter((warning) => warning.code === "structureIncomplete").reduce((total, warning) => total + warning.count, 0);

    it("etiquetado + SIN etiquetar: las paginas del segundo llegan sin etiquetas a un resultado que SI lo esta, y se avisa", async () => {
      const result = await merge(
        await makeRichPdf({ pages: 2, taggedContent: true }),
        await makeRichPdf({ pages: 3 }),
      );
      expect(result.warnings).toContainEqual({ code: "structureIncomplete", count: 3 });
    });

    it("etiquetado + sin etiquetar + etiquetado: se cuentan las paginas de los DOS archivos que no traen sus etiquetas", async () => {
      const result = await merge(
        await makeRichPdf({ pages: 6, taggedContent: true }),
        await makeRichPdf({ pages: 3 }),
        await makeRichPdf({ pages: 4, taggedContent: true }),
      );
      expect(incomplete(result.warnings)).toBe(7);
    });

    it("SIN etiquetar + etiquetado: el resultado no tiene arbol y las paginas del segundo pierden las suyas (se avisa)", async () => {
      const result = await merge(await makeRichPdf({ pages: 2 }), await makeRichPdf({ pages: 3, taggedContent: true }));
      expect(incomplete(result.warnings)).toBe(3);
      expect((await inspectPdf(new Uint8Array(await result.blob.arrayBuffer()))).hasStructTree).toBe(false);
    });

    it("ningun archivo etiquetado: no hay etiquetas que perder y no se avisa", async () => {
      const result = await merge(await makeRichPdf({ pages: 2 }), await makeRichPdf({ pages: 3 }), await makeRichPdf({ pages: 1 }));
      expect(result.warnings.map((warning) => warning.code)).not.toContain("structureIncomplete");
    });

    it("etiquetado + una pagina del segundo repetida: cada hoja sin etiquetas cuenta (3 paginas del plan)", async () => {
      const base = await makeRichPdf({ pages: 2, taggedContent: true });
      const other = await makeRichPdf({ pages: 2 });
      const plan: PageEntry[] = [
        ...identityPlan(2),
        { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
        { kind: "external", sourceId: "x", sourceIndex: 0, rotation: 0 },
        { kind: "external", sourceId: "x", sourceIndex: 1, rotation: 0 },
      ];
      const result = await applyPageAssembly(base, plan, { x: other });
      expect(result.warnings).toContainEqual({ code: "structureIncomplete", count: 3 });
    });

    it("etiquetado + paginas en blanco o de imagen: no hay contenido sin etiquetar que contar", async () => {
      const base = await makeRichPdf({ pages: 2, taggedContent: true });
      const blank: PageEntry = { kind: "blank", width: 100, height: 100, rotation: 0 };
      const result = await applyPageAssembly(base, [...identityPlan(2), blank]);
      expect(result.warnings.map((warning) => warning.code)).not.toContain("structureIncomplete");
    });
  });

  it("organizePdfWithReport: reordenar un PDF etiquetado no avisa de nada", async () => {
    const result = await organizePdfWithReport(toFile(await makeRichPdf({ pages: 3, taggedContent: true })), [
      { kind: "existing", page: 3, rotation: 0 },
      { kind: "existing", page: 1, rotation: 90 },
      { kind: "existing", page: 2, rotation: 0 },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("dividir en varias partes: cada parte es un documento nuevo sin estructura y se avisa", async () => {
    const outcome = await splitDocument(await makeRichPdf({ pages: 4, taggedContent: true }), [[0, 1], [2, 3]], "doc");
    expect(outcome.warnings).toContainEqual({ code: "structureRemoved", count: 1 });
    const zip = await JSZip.loadAsync(outcome.bytes);
    for (const name of outcome.names) {
      expect((await inspectPdf(await zip.file(name)!.async("uint8array"))).hasStructTree).toBe(false);
    }
  });
});
