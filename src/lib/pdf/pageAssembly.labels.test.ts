import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { applyPageAssembly, identityPlan, type PageEntry } from "@/lib/pdf/pageAssembly";
import {
  compressLabels,
  defaultLabel,
  labelAt,
  readPageLabels,
  sameRanges,
  type LabelRange,
} from "@/lib/pdf/pageAssemblyLabels";
import { extractPages, splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { mergePdfFilesWithReport } from "@/lib/pdf/merge";
import { organizePdfWithReport } from "@/lib/pdf/organize";
import { removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { splitPdf } from "@/lib/pdf/split";
import { inspectPdf, makeRichPdf, marker } from "@/lib/pdf/testing/pageAssemblyFixtures";
import { pdfjsPageLabels } from "@/lib/pdf/testing/pdfjsInspect";

/**
 * Etiquetas de pagina (`/PageLabels`): la etiqueta SIGUE A LA PAGINA. Cada caso se comprueba con pdf.js
 * (`getPageLabels`), un lector ajeno al motor, ademas de la estructura que se escribe.
 */

const existing = (sourceIndex: number, rotation = 0, copy = false): PageEntry => ({
  kind: "existing",
  sourceIndex,
  rotation,
  ...(copy ? { copy: true } : {}),
});
const blank: PageEntry = { kind: "blank", width: 100, height: 100, rotation: 0 };
const external = (sourceId: string, sourceIndex: number): PageEntry => ({
  kind: "external",
  sourceId,
  sourceIndex,
  rotation: 0,
});

/** Un libro: romanos (i, ii, iii), cuerpo (1, 2, 3) y apendice (A-1, A-2). */
const BOOK = {
  pages: 8,
  labelRanges: [
    { start: 0, style: "r" },
    { start: 3, style: "D" },
    { start: 6, style: "D", prefix: "A-" },
  ],
} as const;
const BOOK_LABELS = ["i", "ii", "iii", "1", "2", "3", "A-1", "A-2"];

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Tramos tal como quedan escritos en el archivo: `[inicio, estilo, prefijo, St]`. */
async function rawRanges(bytes: Uint8Array): Promise<(string | number | undefined)[][]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const root = document.catalog.lookup(PDFName.of("PageLabels"), PDFDict);
  const out: (string | number | undefined)[][] = [];
  const visit = (node: PDFDict) => {
    const nums = node.lookupMaybe(PDFName.of("Nums"), PDFArray);
    if (nums) {
      for (let index = 0; index + 1 < nums.size(); index += 2) {
        const key = nums.lookup(index, PDFNumber).asNumber();
        const dict = nums.lookup(index + 1, PDFDict);
        const style = dict.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
        const rawPrefix = dict.lookup(PDFName.of("P"));
        const prefix =
          rawPrefix instanceof PDFString || rawPrefix instanceof PDFHexString ? rawPrefix.decodeText() : undefined;
        const st = dict.lookupMaybe(PDFName.of("St"), PDFNumber)?.asNumber();
        out.push([key, style, prefix, st]);
      }
    }
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids) for (let index = 0; index < kids.size(); index += 1) visit(kids.lookup(index, PDFDict));
  };
  visit(root);
  return out;
}

describe("etiquetas de pagina: lectura y calculo (puro)", () => {
  const ranges: LabelRange[] = [
    { start: 0, style: "r", prefix: "", first: 1 },
    { start: 3, style: "D", prefix: "", first: 1 },
    { start: 6, style: "D", prefix: "A-", first: 4 },
  ];

  it("labelAt da estilo, prefijo y numero de cada pagina", () => {
    expect(labelAt(ranges, 0)).toEqual({ style: "r", prefix: "", value: 1 });
    expect(labelAt(ranges, 2)).toEqual({ style: "r", prefix: "", value: 3 });
    expect(labelAt(ranges, 3)).toEqual({ style: "D", prefix: "", value: 1 });
    expect(labelAt(ranges, 7)).toEqual({ style: "D", prefix: "A-", value: 5 });
  });

  it("antes del primer tramo (o sin tramos) vale la numeracion por defecto", () => {
    expect(labelAt([{ start: 2, style: "r", prefix: "", first: 1 }], 0)).toEqual(defaultLabel(0));
    expect(labelAt([], 4)).toEqual({ style: "D", prefix: "", value: 5 });
  });

  it("compressLabels reconstruye los tramos minimos y es la inversa de labelAt", () => {
    const labels = Array.from({ length: 8 }, (_, index) => labelAt(ranges, index));
    expect(compressLabels(labels)).toEqual(ranges);
    expect(compressLabels(labels.slice(2))).toEqual([
      { start: 0, style: "r", prefix: "", first: 3 },
      { start: 1, style: "D", prefix: "", first: 1 },
      { start: 4, style: "D", prefix: "A-", first: 4 },
    ]);
  });

  it("un hueco en la numeracion abre un tramo nuevo; las paginas sin estilo comparten tramo por prefijo", () => {
    const labels = [
      { style: "D", prefix: "", value: 1 },
      { style: "D", prefix: "", value: 2 },
      { style: "D", prefix: "", value: 4 },
      { style: undefined, prefix: "", value: 0 },
      { style: undefined, prefix: "", value: 0 },
      { style: undefined, prefix: "Anexo", value: 0 },
    ];
    expect(compressLabels(labels)).toEqual([
      { start: 0, style: "D", prefix: "", first: 1 },
      { start: 2, style: "D", prefix: "", first: 4 },
      { start: 3, style: undefined, prefix: "", first: 1 },
      { start: 5, style: undefined, prefix: "Anexo", first: 1 },
    ]);
  });

  it("sameRanges ignora el numero inicial cuando no hay estilo", () => {
    expect(
      sameRanges(
        [{ start: 0, style: undefined, prefix: "x", first: 1 }],
        [{ start: 0, style: undefined, prefix: "x", first: 9 }],
      ),
    ).toBe(true);
    expect(
      sameRanges(
        [{ start: 0, style: "D", prefix: "", first: 1 }],
        [{ start: 0, style: "D", prefix: "", first: 2 }],
      ),
    ).toBe(false);
  });

  it("readPageLabels lee un arbol partido en /Kids y detecta uno ilegible", async () => {
    const tree = await PDFDocument.load(await makeRichPdf({ ...BOOK, labelsAsTree: true }));
    const read = readPageLabels(tree.context, tree.catalog);
    expect(read.kind).toBe("ranges");
    if (read.kind === "ranges") expect(read.ranges.map((range) => range.start)).toEqual([0, 3, 6]);

    const broken = await PDFDocument.load(await makeRichPdf({ pages: 3 }));
    broken.catalog.set(PDFName.of("PageLabels"), broken.context.obj({ Nums: ["x", { S: "D" }] }));
    expect(readPageLabels(broken.context, broken.catalog).kind).toBe("unreadable");
    expect(readPageLabels((await PDFDocument.load(await makeRichPdf({ pages: 2 }))).context, tree.catalog).kind).not.toBe("none");
    const none = await PDFDocument.load(await makeRichPdf({ pages: 2 }));
    expect(readPageLabels(none.context, none.catalog).kind).toBe("none");
  });
});

describe("etiquetas de pagina: quitar, reordenar, duplicar, insertar", () => {
  it("el documento de partida se lee como se espera (pdf.js)", async () => {
    expect(await pdfjsPageLabels(await makeRichPdf(BOOK))).toEqual(BOOK_LABELS);
  });

  it("rotar y anadir al final no mueve las etiquetas de las paginas que ya estaban", async () => {
    const bytes = await makeRichPdf(BOOK);
    const rotated = await applyPageAssembly(bytes, identityPlan(8).map((entry) => ({ ...entry, rotation: 90 })));
    expect(await pdfjsPageLabels(rotated.bytes)).toEqual(BOOK_LABELS);
    // Sin cambios de numeracion no se reescribe el arbol: los tramos son los de siempre.
    expect(await rawRanges(rotated.bytes)).toEqual([
      [0, "r", undefined, undefined],
      [3, "D", undefined, undefined],
      [6, "D", "A-", undefined],
    ]);
    expect(rotated.warnings).toEqual([]);
  });

  it("quitar una pagina del medio: cada pagina conserva SU etiqueta (la del 2 desaparece)", async () => {
    const bytes = await makeRichPdf(BOOK);
    const plan = identityPlan(8).filter((_, index) => index !== 4);
    const result = await applyPageAssembly(bytes, plan);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "ii", "iii", "1", "3", "A-1", "A-2"]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
    expect((await inspectPdf(result.bytes)).markers).toEqual([0, 1, 2, 3, 5, 6, 7].map(marker));
  });

  it("quitar las primeras paginas: el tramo romano empieza en la etiqueta que le toca", async () => {
    const bytes = await makeRichPdf(BOOK);
    const result = await applyPageAssembly(bytes, identityPlan(8).slice(1));
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["ii", "iii", "1", "2", "3", "A-1", "A-2"]);
    expect(await rawRanges(result.bytes)).toEqual([
      [0, "r", undefined, 2],
      [2, "D", undefined, undefined],
      [5, "D", "A-", undefined],
    ]);
  });

  it("quitar paginas de la cola no cambia nada", async () => {
    const bytes = await makeRichPdf(BOOK);
    const result = await applyPageAssembly(bytes, identityPlan(8).slice(0, 5));
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "ii", "iii", "1", "2"]);
  });

  it("invertir el orden invierte las etiquetas con las paginas", async () => {
    const bytes = await makeRichPdf(BOOK);
    const plan = Array.from({ length: 8 }, (_, index) => existing(7 - index));
    const result = await applyPageAssembly(bytes, plan);
    expect(await pdfjsPageLabels(result.bytes)).toEqual([...BOOK_LABELS].reverse());
    expect((await inspectPdf(result.bytes)).markers).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map(marker));
  });

  it("mover una pagina: la etiqueta viaja con ella", async () => {
    const bytes = await makeRichPdf(BOOK);
    // La pagina «1» (indice 3) pasa al principio.
    const plan = [existing(3), existing(0), existing(1), existing(2), ...[4, 5, 6, 7].map((i) => existing(i))];
    const result = await applyPageAssembly(bytes, plan);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["1", "i", "ii", "iii", "2", "3", "A-1", "A-2"]);
  });

  it("duplicar una pagina: el duplicado lleva la misma etiqueta que la original", async () => {
    const bytes = await makeRichPdf(BOOK);
    const plan = [...identityPlan(4), existing(3, 0, true), ...[4, 5, 6, 7].map((i) => existing(i))];
    const result = await applyPageAssembly(bytes, plan);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "ii", "iii", "1", "1", "2", "3", "A-1", "A-2"]);
  });

  it("una pagina en blanco en medio no lleva etiqueta y no desplaza las demas", async () => {
    const bytes = await makeRichPdf(BOOK);
    const plan = [...identityPlan(3), blank, ...[3, 4, 5, 6, 7].map((i) => existing(i))];
    const result = await applyPageAssembly(bytes, plan);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "ii", "iii", "", "1", "2", "3", "A-1", "A-2"]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
  });

  it("una pagina en blanco al final tampoco lleva etiqueta", async () => {
    const bytes = await makeRichPdf(BOOK);
    const result = await applyPageAssembly(bytes, [...identityPlan(8), blank]);
    expect(await pdfjsPageLabels(result.bytes)).toEqual([...BOOK_LABELS, ""]);
  });

  it("si solo quedan paginas nuevas ya no hay etiquetas que conservar y no se avisa", async () => {
    const bytes = await makeRichPdf(BOOK);
    const result = await applyPageAssembly(bytes, [blank]);
    expect(await pdfjsPageLabels(result.bytes)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("numero inicial (/St) y prefijo se respetan al quitar paginas", async () => {
    const bytes = await makeRichPdf({
      pages: 5,
      labelRanges: [{ start: 0, style: "D", prefix: "Cap-", st: 10 }],
    });
    expect(await pdfjsPageLabels(bytes)).toEqual(["Cap-10", "Cap-11", "Cap-12", "Cap-13", "Cap-14"]);
    const result = await applyPageAssembly(bytes, [existing(1), existing(2), existing(4)]);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["Cap-11", "Cap-12", "Cap-14"]);
  });

  it("letras (A, a): se conservan al reordenar", async () => {
    const bytes = await makeRichPdf({
      pages: 4,
      labelRanges: [
        { start: 0, style: "A" },
        { start: 2, style: "a", st: 3 },
      ],
    });
    expect(await pdfjsPageLabels(bytes)).toEqual(["A", "B", "c", "d"]);
    const result = await applyPageAssembly(bytes, [existing(3), existing(0), existing(2), existing(1)]);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["d", "A", "c", "B"]);
  });

  it("un arbol de etiquetas partido en /Kids se lee y se conserva", async () => {
    const bytes = await makeRichPdf({ ...BOOK, labelsAsTree: true });
    expect(await pdfjsPageLabels(bytes)).toEqual(BOOK_LABELS);
    const result = await applyPageAssembly(bytes, identityPlan(8).filter((_, index) => index !== 1));
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "iii", "1", "2", "3", "A-1", "A-2"]);
  });

  it("un documento sin etiquetas no las gana al reordenar ni al quitar", async () => {
    const bytes = await makeRichPdf({ pages: 4 });
    const result = await applyPageAssembly(bytes, [existing(3), existing(0)]);
    expect(await pdfjsPageLabels(result.bytes)).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("encadenar operaciones sigue siendo coherente (quitar, mover y quitar de nuevo)", async () => {
    const bytes = await makeRichPdf(BOOK);
    const first = await applyPageAssembly(bytes, identityPlan(8).filter((_, index) => index !== 0));
    const second = await applyPageAssembly(first.bytes, [existing(4), existing(0), existing(1), existing(2), existing(3), existing(5), existing(6)]);
    const third = await applyPageAssembly(second.bytes, identityPlan(7).filter((_, index) => index !== 1));
    expect(await pdfjsPageLabels(third.bytes)).toEqual(["3", "iii", "1", "2", "A-1", "A-2"]);
  });

  it("un documento largo con muchos tramos (una etiqueta distinta por pagina) se invierte sin perder ninguna", async () => {
    const pages = 400;
    const labelRanges = Array.from({ length: pages }, (_, start) => ({
      start,
      style: "D" as const,
      prefix: `P${start % 7}-`,
      st: start + 1,
    }));
    const bytes = await makeRichPdf({ pages, labelRanges });
    const started = Date.now();
    const result = await applyPageAssembly(bytes, Array.from({ length: pages }, (_, index) => existing(pages - 1 - index)));
    const labels = (await pdfjsPageLabels(result.bytes)) ?? [];
    expect(labels).toHaveLength(pages);
    expect(labels[0]).toBe(`P${(pages - 1) % 7}-${pages}`);
    expect(labels[pages - 1]).toBe("P0-1");
    expect(labels[100]).toBe(`P${(pages - 1 - 100) % 7}-${pages - 100}`);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("etiquetas ilegibles: con las primeras paginas en su sitio se dejan; si no, se quitan y se avisa", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 4 }));
    document.catalog.set(PDFName.of("PageLabels"), document.context.obj({ Nums: ["no-es-un-numero", { S: "D" }] }));
    const bytes = await document.save();
    const kept = await applyPageAssembly(bytes, [existing(0), existing(1)]);
    expect(kept.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
    const moved = await applyPageAssembly(bytes, [existing(1), existing(0)]);
    expect(moved.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 1 });
    expect((await inspectPdf(moved.bytes)).hasPageLabels).toBe(false);
  });
});

describe("etiquetas de pagina: Unir (concatenar tramos respetando el desplazamiento)", () => {
  it("un documento con etiquetas y otro con etiquetas propias: cada pagina conserva la suya", async () => {
    const base = await makeRichPdf(BOOK);
    const other = await makeRichPdf({ pages: 3, labelRanges: [{ start: 0, style: "A" }, { start: 2, style: "D", prefix: "B-" }] });
    const plan = [...identityPlan(8), external("x", 0), external("x", 1), external("x", 2)];
    const result = await applyPageAssembly(base, plan, { x: other });
    expect(await pdfjsPageLabels(result.bytes)).toEqual([...BOOK_LABELS, "A", "B", "B-1"]);
  });

  it("el documento anadido sin etiquetas numera 1, 2, 3 como en su archivo (no continua la numeracion del primero)", async () => {
    const base = await makeRichPdf(BOOK);
    const other = await makeRichPdf({ pages: 2 });
    const result = await applyPageAssembly(base, [...identityPlan(8), external("x", 0), external("x", 1)], { x: other });
    expect(await pdfjsPageLabels(result.bytes)).toEqual([...BOOK_LABELS, "1", "2"]);
  });

  it("el primer documento sin etiquetas y el segundo con ellas: las del primero numeran 1, 2...", async () => {
    const base = await makeRichPdf({ pages: 2 });
    const other = await makeRichPdf({ pages: 3, labelRanges: [{ start: 0, style: "r" }] });
    const plan = [...identityPlan(2), external("x", 0), external("x", 1), external("x", 2)];
    const result = await applyPageAssembly(base, plan, { x: other });
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["1", "2", "i", "ii", "iii"]);
  });

  it("un documento externo cuyas paginas se mezclan con las del primero conserva cada etiqueta", async () => {
    const base = await makeRichPdf(BOOK);
    const other = await makeRichPdf({ pages: 4, labelRanges: [{ start: 0, style: "A", prefix: "X" }] });
    const plan = [existing(0), external("x", 2), existing(1), external("x", 0), existing(5)];
    const result = await applyPageAssembly(base, plan, { x: other });
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["i", "XC", "ii", "XA", "3"]);
  });

  it("sin etiquetas en ninguno no se crean", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 2 }), [existing(0), external("x", 0)], {
      x: await makeRichPdf({ pages: 2 }),
    });
    expect(await pdfjsPageLabels(result.bytes)).toBeNull();
  });

  it("etiquetas ilegibles en el documento anadido: se numera por defecto y se avisa", async () => {
    const other = await PDFDocument.load(await makeRichPdf({ pages: 2 }));
    other.catalog.set(PDFName.of("PageLabels"), other.context.obj({ Nums: [0.5, { S: "D" }] }));
    const result = await applyPageAssembly(
      await makeRichPdf(BOOK),
      [...identityPlan(8), external("x", 0)],
      { x: await other.save() },
    );
    expect(result.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 1 });
    expect(await pdfjsPageLabels(result.bytes)).toEqual([...BOOK_LABELS, "1"]);
  });

  describe("base con /PageLabels ilegible y las primeras paginas en su sitio (D2)", () => {
    async function unreadableBase(pages = 2): Promise<Uint8Array> {
      const document = await PDFDocument.load(await makeRichPdf({ pages }));
      document.catalog.set(PDFName.of("PageLabels"), document.context.obj({ Nums: ["no-es-un-numero", { S: "D" }] }));
      return new Uint8Array(await document.save());
    }

    it("las etiquetas del documento anadido se pierden y SE AVISA (antes se perdian en silencio)", async () => {
      const other = await makeRichPdf({ pages: 3, labelRanges: [{ start: 0, style: "r" }] });
      const plan = [...identityPlan(2), external("x", 0), external("x", 1)];
      const result = await applyPageAssembly(await unreadableBase(), plan, { x: other });
      expect(result.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 1 });
      expect(result.pageCount).toBe(4);
    });

    it("tres documentos con etiquetas: cada uno cuenta una vez", async () => {
      const labelled = await makeRichPdf({ pages: 2, labelRanges: [{ start: 0, style: "A" }] });
      const plain = await makeRichPdf({ pages: 2 });
      const plan = [...identityPlan(2), external("a", 0), external("b", 0), external("c", 0)];
      const result = await applyPageAssembly(await unreadableBase(), plan, { a: labelled, b: plain, c: labelled });
      expect(result.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 2 });
    });

    it("el documento anadido ilegible tambien pierde su numeracion y se avisa", async () => {
      const other = await PDFDocument.load(await makeRichPdf({ pages: 2 }));
      other.catalog.set(PDFName.of("PageLabels"), other.context.obj({ Nums: [0.5, { S: "D" }] }));
      const result = await applyPageAssembly(
        await unreadableBase(),
        [...identityPlan(2), external("x", 0)],
        { x: new Uint8Array(await other.save()) },
      );
      expect(result.warnings).toContainEqual({ code: "pageLabelsRemoved", count: 1 });
    });

    it("sin etiquetas en lo anadido no hay nada que perder: no se avisa", async () => {
      const plain = await makeRichPdf({ pages: 2 });
      const result = await applyPageAssembly(await unreadableBase(), [...identityPlan(2), external("x", 0)], { x: plain });
      expect(result.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
    });

    it("con paginas en blanco o quitando las ultimas tampoco se avisa (no se pierde ninguna etiqueta)", async () => {
      const added = await applyPageAssembly(await unreadableBase(), [...identityPlan(2), blank]);
      expect(added.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
      const trimmed = await applyPageAssembly(await unreadableBase(4), [existing(0), existing(1)]);
      expect(trimmed.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
    });

    it("moviendo las paginas el arbol se quita y se avisa una sola vez, aunque tambien se anada un documento con etiquetas", async () => {
      const other = await makeRichPdf({ pages: 2, labelRanges: [{ start: 0, style: "r" }] });
      const result = await applyPageAssembly(await unreadableBase(), [existing(1), existing(0), external("x", 0)], { x: other });
      expect(result.warnings.filter((warning) => warning.code === "pageLabelsRemoved")).toEqual([
        { code: "pageLabelsRemoved", count: 1 },
      ]);
    });
  });

  it("mergePdfFilesWithReport: tres archivos, con paginas desmarcadas, conservan sus etiquetas", async () => {
    const a = await makeRichPdf({ pages: 3, labelRanges: [{ start: 0, style: "r" }] });
    const b = await makeRichPdf({ pages: 3, labelRanges: [{ start: 0, style: "D", prefix: "B" }] });
    const c = await makeRichPdf({ pages: 2, labelRanges: [{ start: 0, style: "A" }] });
    const files = [toFile(a, "a.pdf"), toFile(b, "b.pdf"), toFile(c, "c.pdf")];
    const pages = files.flatMap((_, fileIndex) =>
      Array.from({ length: fileIndex === 2 ? 2 : 3 }, (_unused, pageIndex) => ({
        id: `${fileIndex}:${pageIndex}`,
        fileIndex,
        pageIndex,
        rotation: 0,
        selected: !(fileIndex === 1 && pageIndex === 1),
      })),
    );
    const result = await mergePdfFilesWithReport(files, { pages });
    expect(await pdfjsPageLabels(await bytesOf(result.blob))).toEqual(["i", "ii", "iii", "B1", "B3", "A", "B"]);
    expect(result.pageCount).toBe(7);
  });
});

describe("etiquetas de pagina: las cuatro herramientas sueltas", () => {
  it("removePdfPagesWithReport conserva las etiquetas de las paginas que quedan", async () => {
    const result = await removePdfPagesWithReport(toFile(await makeRichPdf(BOOK)), { remove: [2, 3, 4] });
    expect(await pdfjsPageLabels(await bytesOf(result.blob))).toEqual(["i", "2", "3", "A-1", "A-2"]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("pageLabelsRemoved");
  });

  it("organizePdfWithReport: mover, girar y anadir una pagina en blanco", async () => {
    const result = await organizePdfWithReport(toFile(await makeRichPdf(BOOK)), [
      { kind: "existing", page: 4, rotation: 90 },
      { kind: "blank" },
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "existing", page: 8, rotation: 0 },
    ]);
    expect(await pdfjsPageLabels(await bytesOf(result.blob))).toEqual(["1", "", "i", "A-2"]);
  });

  it("extractPages (un PDF): las paginas extraidas llevan su etiqueta", async () => {
    const result = await extractPages(await makeRichPdf(BOOK), [2, 3, 6]);
    expect(await pdfjsPageLabels(result.bytes)).toEqual(["iii", "1", "A-1"]);
  });

  it("splitPdf con un solo grupo usa el mismo camino y conserva las etiquetas", async () => {
    const output = await splitPdf(
      toFile(await makeRichPdf(BOOK)),
      { mode: "extract", pages: [4, 5], separate: false },
      "libro",
    );
    expect(await pdfjsPageLabels(await bytesOf(output.blob))).toEqual(["1", "2"]);
  });

  it("dividir en varias partes: cada parte lleva las etiquetas de SUS paginas", async () => {
    const outcome = await splitDocument(await makeRichPdf(BOOK), [[0, 1, 2], [3, 4, 5], [6, 7]], "libro");
    expect(outcome.kind).toBe("zip");
    const zip = await JSZip.loadAsync(outcome.bytes);
    const parts: (string[] | null)[] = [];
    for (const name of outcome.names) {
      parts.push(await pdfjsPageLabels(await zip.file(name)!.async("uint8array")));
    }
    // La parte del cuerpo ya se numera 1, 2, 3 por si sola: no necesita etiquetas.
    expect(parts).toEqual([["i", "ii", "iii"], null, ["A-1", "A-2"]]);
  });

  it("dividir: una parte con la numeracion por defecto no escribe etiquetas innecesarias", async () => {
    const outcome = await splitDocument(
      await makeRichPdf({ pages: 4, labelRanges: [{ start: 0, style: "D" }] }),
      [[0, 1], [2, 3]],
      "doc",
    );
    const zip = await JSZip.loadAsync(outcome.bytes);
    const first = await zip.file(outcome.names[0])!.async("uint8array");
    const second = await zip.file(outcome.names[1])!.async("uint8array");
    expect((await inspectPdf(first)).hasPageLabels).toBe(false);
    expect(await pdfjsPageLabels(second)).toEqual(["3", "4"]);
  });
});
