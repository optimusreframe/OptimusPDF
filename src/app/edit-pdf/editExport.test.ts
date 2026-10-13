import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import {
  countsOf,
  countWarnings,
  exportEditedPdf,
  exportNotices,
  summarizeCounts,
} from "@/app/edit-pdf/editExport";
import {
  applyOp,
  createEditSession,
  flattenItem,
  newTextEdit,
  shapeItem,
  splitForExport,
  textItem,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { fontNotice } from "@/app/edit-pdf/EditFloatingBar";
import { CALIBRI, makeBlock } from "@/app/edit-pdf/editTestUtils";
import { draftEditForBlock } from "@/app/edit-pdf/editCanvasMath";
import type { RectElement } from "@/lib/pdf/editPdf";
import type { PageRasterizer } from "@/lib/pdf/editTextExport";
import type { TextEdit } from "@/lib/pdf/editTypes";

/**
 * Exportacion completa del editor (W5-U5) sobre PDFs reales: texto -> imagenes y
 * formas -> aplanar. La salida se comprueba con pdf.js (texto extraible) y con
 * pixeles (lo anadido esta dentro de la imagen de la pagina aplanada).
 */

const STANDARD_FONTS_URL = path.join(process.cwd(), "public", "standard_fonts") + "/";
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
const getPdfjs = () => (pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

async function openPdf(bytes: Uint8Array) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_URL, verbosity: 0 }).promise;
}

async function textOfPage(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const pdf = await openPdf(bytes);
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.map((item) => ("str" in item ? item.str : "")).join("|");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function createNodeRasterizer(bytes: Uint8Array): Promise<PageRasterizer> {
  const pdf = await openPdf(bytes);
  return {
    async rasterize(pageIndex, scale, quality) {
      const page = await pdf.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      await page.render({ canvasContext: context, viewport } as never).promise;
      return {
        bytes: new Uint8Array(canvas.toBuffer("image/jpeg", Math.round(quality * 100))),
        format: "jpeg",
        width: base.width,
        height: base.height,
      };
    },
    close: async () => {
      await pdf.loadingTask.destroy();
    },
  };
}

/** Cuenta los pixeles de la pagina que cumplen el predicado (render a escala 1). */
async function countPixels(bytes: Uint8Array, pageNumber: number, predicate: (r: number, g: number, b: number) => boolean) {
  const pdf = await openPdf(bytes);
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    await page.render({ canvasContext: context, viewport } as never).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) if (predicate(data[i], data[i + 1], data[i + 2])) total += 1;
    return total;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const isRed = (r: number, g: number, b: number) => r > 200 && g < 60 && b < 60;
const isBlue = (r: number, g: number, b: number) => b > 200 && r < 60 && g < 60;

async function sourcePdf(): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText("ORIGINAL uno", { x: 20, y: 200, size: 18, font });
  doc.addPage([300, 300]).drawText("ORIGINAL dos", { x: 20, y: 200, size: 18, font });
  const bytes = await doc.save();
  return new File([bytes as BlobPart], "doc.pdf", { type: "application/pdf" });
}

function replaceEdit(overrides: Partial<TextEdit> = {}): TextEdit {
  return newTextEdit({
    id: "e1",
    blockId: "p0-b0",
    pageIndex: 0,
    box: { x: 18, y: 196, width: 150, height: 24 },
    coverBox: { x: 18, y: 196, width: 150, height: 24 },
    fontKey: "helvetica",
    text: "NUEVO",
    fontSize: 18,
    color: "#0000ff",
    cover: { color: "#ffffff", padding: 2 },
    ...overrides,
  });
}

const redRect: RectElement = {
  type: "rect",
  id: "r1",
  pageIndex: 0,
  x: 0.1,
  y: 0.6,
  width: 0.5,
  height: 0.2,
  strokeColor: "#ff0000",
  strokeWidth: 2,
  fill: true,
  fillColor: "#ff0000",
  fillOpacity: 1,
};

function sessionWith(...ops: Parameters<typeof applyOp>[1][]): EditSession {
  return ops.reduce((session, op) => applyOp(session, op), createEditSession());
}

describe("paridad editor <-> descarga (W5-U5 · N4)", () => {
  const block = makeBlock("p0-b0", { text: "ORIGINAL uno", font: CALIBRI, mixedStyle: true, box: { x: 18, y: 196, width: 150, height: 24 } });

  it("la sesion conserva la fuente original y los estilos mezclados del bloque (antes se descartaban al sanear)", () => {
    const edit = draftEditForBlock(block, { coverColor: "#ffffff" });
    const session = applyOp(createEditSession(), { type: "add", item: textItem(edit) });
    const kept = splitForExport(session).textEdits[0];
    expect(kept.sourceFont).toEqual(CALIBRI);
    expect(kept.mixedStyle).toBe(true);
  });

  it("todo aviso que el editor muestra para el bloque sale en la lista de descarga (fuente parecida, estilos mezclados, el original)", async () => {
    const edit = draftEditForBlock(block, { coverColor: "#ffffff" });
    // Lo que ve el editor en «Más»:
    expect(fontNotice({ ...edit, coverColor: "#ffffff", sourceFont: edit.sourceFont, mixedStyle: true }).similar).toBe(true);
    const session = applyOp(createEditSession(), { type: "add", item: textItem(edit) });
    const result = await exportEditedPdf(await sourcePdf(), session);
    // Wave 8 · F2: el original se quita del flujo, asi que ya no "permanece".
    expect(result.warnings).toMatchObject({ fontSubstituted: 1, mixedStyle: 1, originalRemains: 0, originalRemoved: 1 });
    const es = EDIT_FLOW_STRINGS.es;
    const en = EDIT_FLOW_STRINGS.en;
    const context = { signatures: "none" as const, wasEncrypted: false, flattenedPages: 0 };
    expect(exportNotices(result.warnings, context, es)).toEqual(
      expect.arrayContaining([es.noticeFont(1), es.noticeMixed(1), es.noticeRemoved(1)]),
    );
    expect(exportNotices(result.warnings, context, en)).toEqual(
      expect.arrayContaining([en.noticeFont(1), en.noticeMixed(1), en.noticeRemoved(1)]),
    );
  });

  it("un texto nuevo (sin bloque) no cuenta estilos mezclados ni fuente parecida", async () => {
    const edit = replaceEdit({ blockId: undefined, mixedStyle: true, sourceFont: CALIBRI, fontKey: "liberation-sans" });
    const session = applyOp(createEditSession(), { type: "add", item: textItem(edit) });
    const result = await exportEditedPdf(await sourcePdf(), session);
    expect(result.warnings.mixedStyle).toBe(0);
    expect(result.warnings.fontSubstituted).toBe(0);
  });
});

describe("exportEditedPdf", () => {
  it("sin cambios lanza nothingSelected", async () => {
    await expect(exportEditedPdf(await sourcePdf(), createEditSession())).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("texto editado: el PDF lleva el nuevo texto y se cuenta como editado; el original se elimino (F2)", async () => {
    const session = sessionWith({ type: "add", item: textItem(replaceEdit()) });
    const result = await exportEditedPdf(await sourcePdf(), session);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(await textOfPage(bytes, 1)).toContain("NUEVO");
    expect(result.counts).toMatchObject({ editedTexts: 1, addedTexts: 0, images: 0, shapes: 0, flattenedPages: 0 });
    expect(result.warnings.originalRemains).toBe(0);
    expect(result.warnings.originalRemoved).toBe(1);
  });

  it("texto nuevo + forma: ambos entran y los conteos los distinguen", async () => {
    const session = sessionWith(
      {
        type: "add",
        item: textItem(newTextEdit({ id: "n", pageIndex: 1, box: { x: 10, y: 10, width: 120, height: 20 }, fontKey: "helvetica", text: "AÑADIDO" })),
      },
      { type: "add", item: shapeItem(redRect) },
    );
    const result = await exportEditedPdf(await sourcePdf(), session);
    expect(result.counts).toMatchObject({ editedTexts: 0, addedTexts: 1, shapes: 1 });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(await textOfPage(bytes, 2)).toContain("AÑADIDO");
    expect(await countPixels(bytes, 1, isRed)).toBeGreaterThan(500);
  });

  it("fondo no uniforme: la cobertura anotada produce el aviso background-not-uniform", async () => {
    const session = sessionWith({
      type: "add",
      item: textItem(replaceEdit({ cover: { color: "#eeeeee", padding: 2, uniform: false } })),
    });
    const result = await exportEditedPdf(await sourcePdf(), session);
    expect(result.warnings.backgroundNotUniform).toBe(1);
  });

  it("un color de cobertura elegido a mano (sin la marca) no avisa de fondo no uniforme", async () => {
    const session = sessionWith({ type: "add", item: textItem(replaceEdit()) });
    expect((await exportEditedPdf(await sourcePdf(), session)).warnings.backgroundNotUniform).toBe(0);
  });

  it("APLANAR va el ULTIMO: el texto original ya no se extrae, y lo anadido esta dentro de la imagen", async () => {
    const session = sessionWith(
      { type: "add", item: textItem(replaceEdit()) },
      { type: "add", item: shapeItem(redRect) },
      { type: "add", item: { ...flattenItem(0), id: "f0" } },
    );
    const result = await exportEditedPdf(await sourcePdf(), session, { createRasterizer: createNodeRasterizer });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    // Pagina 1 aplanada: sin texto extraible (ni el original ni el nuevo).
    expect(await textOfPage(bytes, 1)).toBe("");
    // La pagina 2 NO se aplano: conserva su texto.
    expect(await textOfPage(bytes, 2)).toContain("ORIGINAL dos");
    // La forma roja y el texto azul nuevo estan en los pixeles de la pagina aplanada.
    expect(await countPixels(bytes, 1, isRed)).toBeGreaterThan(500);
    expect(await countPixels(bytes, 1, isBlue)).toBeGreaterThan(20);
    expect(result.counts.flattenedPages).toBe(1);
  });

  it("aplanar sin otros cambios tambien exporta (solo una pagina aplanada)", async () => {
    const session = sessionWith({ type: "add", item: { ...flattenItem(1), id: "f1" } });
    const result = await exportEditedPdf(await sourcePdf(), session, { createRasterizer: createNodeRasterizer });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(await textOfPage(bytes, 1)).toContain("ORIGINAL uno");
    expect(await textOfPage(bytes, 2)).toBe("");
  });

  it("el original-text-remains NO se cuenta si la pagina de esa edicion se aplana", async () => {
    const session = sessionWith(
      { type: "add", item: textItem(replaceEdit()) },
      { type: "add", item: { ...flattenItem(0), id: "f0" } },
    );
    const result = await exportEditedPdf(await sourcePdf(), session, { createRasterizer: createNodeRasterizer });
    expect(result.warnings.originalRemains).toBe(0);
  });

  it("el progreso solo avanza y termina en 1", async () => {
    const seen: number[] = [];
    const session = sessionWith(
      { type: "add", item: textItem(replaceEdit()) },
      { type: "add", item: shapeItem(redRect) },
      { type: "add", item: { ...flattenItem(0), id: "f0" } },
    );
    await exportEditedPdf(await sourcePdf(), session, {
      createRasterizer: createNodeRasterizer,
      onProgress: (value) => seen.push(value),
    });
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-9);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("cancelar (AbortSignal) lanza cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = sessionWith({ type: "add", item: textItem(replaceEdit()) });
    await expect(exportEditedPdf(await sourcePdf(), session, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});

describe("resumen y avisos de la descarga", () => {
  const es = EDIT_FLOW_STRINGS.es;
  const en = EDIT_FLOW_STRINGS.en;

  it("resume solo lo que hubo, con plurales", () => {
    const counts = { editedTexts: 3, addedTexts: 0, images: 1, shapes: 0, flattenedPages: 1 };
    expect(summarizeCounts(counts, es)).toBe("3 textos editados, 1 imagen añadida, 1 página aplanada.");
    expect(summarizeCounts(counts, en)).toBe("3 texts edited, 1 image added, 1 page flattened.");
    expect(summarizeCounts({ editedTexts: 0, addedTexts: 0, images: 0, shapes: 0, flattenedPages: 0 }, es)).toBe("");
  });

  it("countsOf cuenta un texto nuevo vacio como nada", () => {
    const session = sessionWith({
      type: "add",
      item: textItem(newTextEdit({ id: "v", pageIndex: 0, box: { x: 1, y: 1, width: 10, height: 10 }, fontKey: "helvetica", text: "  " })),
    });
    expect(countsOf(splitForExport(session)).addedTexts).toBe(0);
  });

  it("lista los avisos del motor, las firmas, la contrasena y el aplanado, sin repetir", () => {
    const warnings = { fontSubstituted: 2, glyphMissing: 1, originalRemains: 1, originalRemoved: 2, backgroundNotUniform: 3, overlap: 2, mixedStyle: 1, coverOverlaps: 1, flattenDrops: null, skipped: 1 };
    const items = exportNotices(warnings, { signatures: "active", wasEncrypted: true, flattenedPages: 1 }, es);
    expect(items).toEqual([
      es.noticeFont(2),
      es.noticeGlyph(1),
      es.noticeRemains(1),
      es.noticeRemoved(2),
      es.noticeBackground(3),
      es.noticeMixed(1),
      es.noticeOverlap(2),
      es.noticeCoverOverlap(1),
      es.noticeSkipped(1),
      es.noticeSignatures,
      es.noticeProtected,
      es.noticeFlattened,
    ]);
    expect(new Set(items).size).toBe(items.length);
  });

  it("sin nada que avisar la lista esta vacia", () => {
    const warnings = { fontSubstituted: 0, glyphMissing: 0, originalRemains: 0, originalRemoved: 0, backgroundNotUniform: 0, overlap: 0, mixedStyle: 0, coverOverlaps: 0, flattenDrops: null, skipped: 0 };
    expect(exportNotices(warnings, { signatures: "none", wasEncrypted: false, flattenedPages: 0 }, es)).toEqual([]);
  });

  it("una comprobacion de firmas dudosa (unknown) tambien se avisa", () => {
    const warnings = { fontSubstituted: 0, glyphMissing: 0, originalRemains: 0, originalRemoved: 0, backgroundNotUniform: 0, overlap: 0, mixedStyle: 0, coverOverlaps: 0, flattenDrops: null, skipped: 0 };
    expect(exportNotices(warnings, { signatures: "unknown", wasEncrypted: false, flattenedPages: 0 }, en)).toEqual([
      en.noticeSignatures,
    ]);
  });

  it("countWarnings cuenta por texto aunque un texto tenga varios avisos", () => {
    const counts = countWarnings(
      {
        a: [{ kind: "font-substituted", from: "x", to: "helvetica" }, { kind: "glyph-missing", chars: ["€"] }],
        b: [{ kind: "original-text-remains" }],
      },
      0,
    );
    expect(counts).toMatchObject({ fontSubstituted: 1, glyphMissing: 1, originalRemains: 1 });
  });

  it("countWarnings cuenta los textos que se solapan con otro bloque (overlap), una vez por texto", () => {
    const counts = countWarnings(
      { a: [{ kind: "overlap", with: "x" }, { kind: "overlap", with: "y" }], b: [{ kind: "overlap" }], c: [] },
      0,
    );
    expect(counts.overlap).toBe(2);
    expect(exportNotices(counts, { signatures: "none", wasEncrypted: false, flattenedPages: 0 }, es)).toEqual([es.noticeOverlap(2)]);
  });
});

describe("aplanar descarta formularios y marcadores (flatten-drops-forms)", () => {
  const es = EDIT_FLOW_STRINGS.es;

  async function formPdf(withOutlines = false): Promise<File> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);
    page.drawText("ORIGINAL", { x: 20, y: 200, size: 18, font });
    doc.addPage([300, 300]);
    doc.getForm().createTextField("nombre").addToPage(page, { x: 20, y: 100, width: 120, height: 20 });
    if (withOutlines) {
      const ctx = doc.context;
      const item = PDFDict.withContext(ctx);
      item.set(PDFName.of("Title"), ctx.obj("Capitulo"));
      const itemRef = ctx.register(item);
      const root = PDFDict.withContext(ctx);
      root.set(PDFName.of("Type"), PDFName.of("Outlines"));
      root.set(PDFName.of("First"), itemRef);
      root.set(PDFName.of("Last"), itemRef);
      doc.catalog.set(PDFName.of("Outlines"), ctx.register(root));
    }
    return new File([(await doc.save()) as BlobPart], "form.pdf", { type: "application/pdf" });
  }

  it("un PDF con AcroForm: la exportacion con una pagina aplanada lo informa y el aviso sale en la lista de descarga", async () => {
    const session = sessionWith({ type: "add", item: { ...flattenItem(0), id: "f0" } });
    const result = await exportEditedPdf(await formPdf(), session, { createRasterizer: createNodeRasterizer });
    expect(result.warnings.flattenDrops).toEqual({ forms: true, outlines: false });
    const items = exportNotices(result.warnings, { signatures: "none", wasEncrypted: false, flattenedPages: 1 }, es);
    expect(items).toContain(es.noticeFlattenDrops(true, false));
    expect(es.noticeFlattenDrops(true, true)).toBe(
      "Aplanar convierte la página en imagen: se pierden campos de formulario y marcadores del documento.",
    );
  });

  it("con formulario y marcadores, informa de los dos", async () => {
    const session = sessionWith({ type: "add", item: { ...flattenItem(1), id: "f1" } });
    const result = await exportEditedPdf(await formPdf(true), session, { createRasterizer: createNodeRasterizer });
    expect(result.warnings.flattenDrops).toEqual({ forms: true, outlines: true });
  });

  it("un PDF sin formularios ni marcadores no avisa de nada de eso", async () => {
    const session = sessionWith({ type: "add", item: { ...flattenItem(0), id: "f0" } });
    const result = await exportEditedPdf(await sourcePdf(), session, { createRasterizer: createNodeRasterizer });
    expect(result.warnings.flattenDrops).toBeNull();
    expect(exportNotices(result.warnings, { signatures: "none", wasEncrypted: false, flattenedPages: 1 }, es)).toEqual([es.noticeFlattened]);
  });

  it("sin aplanar no hay aviso aunque haya formulario", async () => {
    const session = sessionWith({ type: "add", item: shapeItem(redRect) });
    const result = await exportEditedPdf(await formPdf(), session);
    expect(result.warnings.flattenDrops).toBeNull();
  });
});

describe("cover-overlaps-neighbor en los avisos de la exportacion (W5-U5)", () => {
  it("se cuenta una vez por texto y sale en la lista con la frase del producto", () => {
    const counts = countWarnings(
      { a: [{ kind: "cover-overlaps-neighbor", with: "p0-b1" }, { kind: "cover-overlaps-neighbor", with: "p0-b2" }], b: [] },
      0,
    );
    expect(counts.coverOverlaps).toBe(1);
    const es = EDIT_FLOW_STRINGS.es;
    const en = EDIT_FLOW_STRINGS.en;
    expect(exportNotices(counts, { signatures: "none", wasEncrypted: false, flattenedPages: 0 }, es)).toEqual([
      "1 texto girado cruza otro texto: parte del original puede quedar visible.",
    ]);
    expect(en.noticeCoverOverlap(2)).toContain("rotated texts cross other texts");
  });
});
