import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import { getPageSize, getTextItems } from "../../../e2e/helpers/pdf-inspection";
import { buildScanPdf, type BuildPdfDeps } from "@/lib/scan/buildPdf";
import { estimateScanSize, expectedProcessed, PROCESSED_MAX_SIDE } from "@/lib/scan/estimate";
import { drawTextLayer, imagePlacement, marginPoints } from "@/lib/scan/textLayer";
import type { OcrResult } from "@/lib/scan/ocr";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "@/lib/scan/types";
import { StandardFonts } from "@cantoo/pdf-lib";

/**
 * PDF final del Escaner en Node: una pagina por hoja, A4 / Carta / Ajustar con margen, texto buscable ALINEADO con un OCR de
 * mentira, progreso por pagina y cancelacion. Los JPEG son sinteticos (@napi-rs/canvas).
 */

function jpeg(width: number, height: number, color = "#ddd"): Blob {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#222";
  context.fillRect(width * 0.1, height * 0.1, width * 0.5, height * 0.05);
  return new Blob([new Uint8Array(canvas.toBuffer("image/jpeg", 85))], { type: "image/jpeg" });
}

let n = 0;
function page(width: number, height: number, patch: Partial<ScanPage> = {}): ScanPage {
  n += 1;
  const processed = jpeg(width, height);
  return {
    id: `p-${n}-aaaaaaaa`,
    createdAt: "",
    source: "camera",
    original: processed,
    originalWidth: width,
    originalHeight: height,
    corners: null,
    rotation: 0,
    filter: "auto",
    adjust: { brightness: 0, contrast: 0 },
    processed,
    processedSize: { width, height },
    thumb: null,
    flags: {},
    ...patch,
  };
}

const session = (pages: ScanPage[], searchable = false): ScanSession => ({ id: "sc-test-00000001", createdAt: "", updatedAt: "", name: "t", pages, settings: { ...DEFAULT_SCAN_SETTINGS, searchable } });

const deps = (patch: Partial<BuildPdfDeps> = {}): BuildPdfDeps => ({
  processedBlob: async (p) => p.processed as Blob,
  recognize: async () => {
    throw new Error("no debe leerse");
  },
  ...patch,
});

const ocrOf = (width: number, height: number): OcrResult => ({
  text: "Contrato servicio",
  width,
  height,
  lines: [
    {
      text: "Contrato servicio",
      confidence: 90,
      bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      words: [
        { text: "Contrato", confidence: 92, bbox: { x0: width * 0.1, y0: height * 0.1, x1: width * 0.1 + height * 0.03 * 3.6, y1: height * 0.13 } },
        { text: "servicio", confidence: 92, bbox: { x0: width * 0.5, y0: height * 0.1, x1: width * 0.5 + height * 0.03 * 3.3, y1: height * 0.13 } },
        { text: "dudoso", confidence: 10, bbox: { x0: 5, y0: 5, x1: 60, y1: 20 } },
        { text: "日本", confidence: 95, bbox: { x0: 5, y0: 30, x1: 60, y1: 45 } },
      ],
    },
  ],
});

/** Operadores de la primera pagina (flujos de contenido ya descomprimidos). */
async function contentOf(bytes: Buffer): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((ref) => doc.context.lookup(ref))
    .map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString("latin1"))
    .join("\n");
}

async function pdfPages(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

describe("buildScanPdf — src/lib/scan/buildPdf.ts", () => {
  it("una pagina por hoja, en orden, con el tamano de hoja pedido (A4, Carta, Ajustar con margen)", async () => {
    const pages = [page(600, 800), page(800, 600), page(300, 300)];
    const a4 = Buffer.from(await (await buildScanPdf(session(pages), { preset: "original", pageSize: "a4", margin: "none" }, deps())).arrayBuffer());
    expect((await PDFDocument.load(a4)).getPageCount()).toBe(3);
    const sizes = [await getPageSize(a4, 1), await getPageSize(a4, 2), await getPageSize(a4, 3)];
    expect(Math.round(sizes[0].width)).toBe(595);
    expect(Math.round(sizes[0].height)).toBe(842);
    // La foto horizontal pone la hoja en horizontal (orientacion automatica).
    expect(Math.round(sizes[1].width)).toBe(842);
    const letter = await pdfPages(await buildScanPdf(session([page(600, 800)]), { preset: "original", pageSize: "letter", margin: "none" }, deps()));
    expect(Math.round((await getPageSize(letter, 1)).width)).toBe(612);
    const fit = await pdfPages(await buildScanPdf(session([page(600, 800)]), { preset: "original", pageSize: "fit", margin: "large" }, deps()));
    expect(await getPageSize(fit, 1)).toEqual({ width: 600 + 2 * 56, height: 800 + 2 * 56 });
  });

  it("progreso por pagina (render, incrustar y, con texto buscable, OCR) que termina en total/total; el nuevo preset no rompe", async () => {
    const calls: Array<[number, number]> = [];
    await buildScanPdf(session([page(300, 400), page(300, 400), page(300, 400)]), { preset: "balanced", pageSize: "a4", margin: "small", onProgress: (d, t) => calls.push([d, t]) }, deps());
    expect(calls[0]).toEqual([0, 6]);
    expect(calls.at(-1)).toEqual([6, 6]);
    expect(calls.every(([d, t], i) => t === 6 && (i === 0 || d >= calls[i - 1][0]))).toBe(true);
    const searchable: Array<[number, number]> = [];
    await buildScanPdf(session([page(300, 400), page(300, 400)], true), { preset: "original", pageSize: "a4", margin: "none", onProgress: (d, t) => searchable.push([d, t]) }, deps({ recognize: async () => ocrOf(300, 400) }));
    expect(searchable.at(-1)).toEqual([6, 6]);
  });

  it("sin texto buscable NO se llama al OCR y el PDF no trae texto; con el, el texto es seleccionable y cae sobre la imagen", async () => {
    const recognize = vi.fn(async () => ocrOf(600, 800));
    const plain = await pdfPages(await buildScanPdf(session([page(600, 800)]), { preset: "original", pageSize: "a4", margin: "none" }, deps({ recognize })));
    expect(recognize).not.toHaveBeenCalled();
    expect(await getTextItems(plain, 1)).toEqual([]);
    const found = await pdfPages(await buildScanPdf(session([page(600, 800)], true), { preset: "original", pageSize: "a4", margin: "none" }, deps({ recognize })));
    expect(recognize).toHaveBeenCalledTimes(1);
    // El texto va con el modo de render 3 (invisible): se selecciona y se busca pero no se ve sobre la imagen.
    expect(await contentOf(found)).toMatch(/\b3 Tr\b/);
    expect(await contentOf(plain)).not.toMatch(/\bTr\b/);
    const items = await getTextItems(found, 1);
    expect(items.map((i) => i.str)).toEqual(expect.arrayContaining(["Contrato", "servicio"]));
    // Se omite la palabra de poca confianza.
    expect(items.some((i) => i.str.includes("dudoso"))).toBe(false);
    const word = items.find((i) => i.str === "Contrato") as NonNullable<(typeof items)[number]>;
    // Imagen 600x800 (proporcion 0,75, mas ancha que el A4) sin margen: llena el ANCHO (595) y se centra en vertical.
    const height = 595 / 0.75;
    const y0 = (842 - height) / 2;
    expect(word.x).toBeCloseTo(595 * 0.1, 0);
    // La base de la palabra es el borde inferior de su caja (13 % desde arriba de la imagen).
    expect(word.y).toBeCloseTo(y0 + height * (1 - 0.13), 0);
    const second = items.find((i) => i.str === "servicio") as NonNullable<(typeof items)[number]>;
    expect(second.x).toBeCloseTo(595 * 0.5, 0);
    expect(second.y).toBeCloseTo(word.y, 0);
  });

  it("cancelar: con el AbortSignal ya levantado lanza «cancelled» y, a mitad, tambien", async () => {
    const early = new AbortController();
    early.abort();
    await expect(buildScanPdf(session([page(300, 400)]), { preset: "original", pageSize: "a4", margin: "none", signal: early.signal }, deps())).rejects.toMatchObject({ code: "cancelled" });
    const mid = new AbortController();
    const pages = [page(300, 400), page(300, 400), page(300, 400)];
    await expect(
      buildScanPdf(session(pages), { preset: "original", pageSize: "a4", margin: "none", signal: mid.signal, onProgress: (done) => done >= 2 && mid.abort() }, deps()),
    ).rejects.toMatchObject({ code: "cancelled" });
    const ocrMid = new AbortController();
    await expect(
      buildScanPdf(session([page(300, 400), page(300, 400)], true), { preset: "original", pageSize: "a4", margin: "none", signal: ocrMid.signal }, deps({ recognize: async () => { ocrMid.abort(); return ocrOf(300, 400); } })),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("sin paginas lanza «empty»; un preset desconocido usa el recomendado; el procesado se pide por pagina y en orden", async () => {
    await expect(buildScanPdf(session([]), { preset: "original", pageSize: "a4", margin: "none" }, deps())).rejects.toMatchObject({ code: "empty" });
    const order: string[] = [];
    const pages = [page(300, 400), page(300, 400)];
    await buildScanPdf(session(pages), { preset: "no-existe", pageSize: "a4", margin: "none" }, deps({ processedBlob: async (p) => { order.push(p.id); return p.processed as Blob; } }));
    expect(order).toEqual(pages.map((p) => p.id));
  });

  it("un fallo del OCR (sin red) sale como error clasificado, no como un PDF a medias", async () => {
    await expect(buildScanPdf(session([page(300, 400)], true), { preset: "original", pageSize: "a4", margin: "none" }, deps({ recognize: async () => { throw new Error("boom"); } }))).rejects.toBeDefined();
  });
});

describe("capa de texto — src/lib/scan/textLayer.ts", () => {
  it("imagePlacement centra la imagen sin deformarla dentro del area util", () => {
    // Mas ancha que el A4: llena el ancho. Mas estrecha: llena el alto.
    const wider = imagePlacement(595, 842, 0, 0.75);
    expect(wider.x).toBe(0);
    expect(wider.width).toBeCloseTo(595, 6);
    expect(wider.y).toBeCloseTo((842 - 595 / 0.75) / 2, 6);
    const narrower = imagePlacement(595, 842, 0, 0.5);
    expect(narrower.height).toBeCloseTo(842, 6);
    expect(narrower.x).toBeCloseTo((595 - 421) / 2, 6);
    const wide = imagePlacement(595, 842, 24, 2);
    expect(wide.width).toBeCloseTo(595 - 48, 6);
    expect(wide.height).toBeCloseTo((595 - 48) / 2, 6);
    expect(wide.y).toBeCloseTo((842 - wide.height) / 2, 6);
    expect(marginPoints("none")).toBe(0);
    expect(marginPoints("small")).toBe(24);
    expect(marginPoints("large")).toBe(56);
  });

  it("drawTextLayer cuenta las palabras dibujadas y las omitidas", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const target = doc.addPage([595, 842]);
    const stats = drawTextLayer(target, font, ocrOf(600, 800), 0);
    // Dibuja 3 (la que la fuente estandar no codifica sale como «?»: no se pierde el hueco) y omite la de poca confianza.
    expect(stats.words).toBe(3);
    expect(stats.skipped).toBe(1);
  });
});

describe("estimacion del peso — src/lib/scan/estimate.ts", () => {
  it("sale del peso y las dimensiones del resultado y respeta el orden de los presets", () => {
    const pages = [page(2400, 3200), page(2400, 3200)];
    const high = estimateScanSize(pages, { preset: "high", searchable: false });
    const compact = estimateScanSize(pages, { preset: "compact", searchable: false });
    expect(high.bytes).toBeGreaterThan(0);
    expect(compact.bytes).toBeLessThanOrEqual(high.bytes);
    expect(high.low).toBeLessThan(high.bytes);
    expect(high.high).toBeGreaterThan(high.bytes);
    const searchable = estimateScanSize(pages, { preset: "high", searchable: true });
    expect(searchable.bytes).toBeGreaterThan(high.bytes);
    expect(estimateScanSize([], { preset: "balanced", searchable: false }).bytes).toBe(0);
    expect(estimateScanSize(pages, { preset: "invalido", searchable: false }).bytes).toBe(estimateScanSize(pages, { preset: "balanced", searchable: false }).bytes);
  });

  it("sin resultado procesado se estima por el recorte previsto sobre el original (nunca por encima del tope de lado)", () => {
    const original = new Blob([new Uint8Array(3_000_000)], { type: "image/jpeg" });
    const base = page(4032, 3024, { processed: null, processedSize: undefined, original });
    const full = expectedProcessed(base);
    expect(Math.max(full.width, full.height)).toBeLessThanOrEqual(PROCESSED_MAX_SIDE);
    const cropped = expectedProcessed({ ...base, corners: { topLeft: { x: 0.25, y: 0.25 }, topRight: { x: 0.75, y: 0.25 }, bottomRight: { x: 0.75, y: 0.75 }, bottomLeft: { x: 0.25, y: 0.75 } } });
    expect(cropped.width * cropped.height).toBeLessThan(full.width * full.height / 3);
    // Girar 90 intercambia ancho y alto.
    const turned = expectedProcessed({ ...base, rotation: 90 });
    expect([turned.width, turned.height]).toEqual([full.height, full.width]);
    expect(cropped.bytes).toBeLessThan(full.bytes);
  });
});
