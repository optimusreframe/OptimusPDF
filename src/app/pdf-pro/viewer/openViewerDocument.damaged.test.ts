import { randomBytes } from "node:crypto";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openPdfDocument = vi.fn();
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, openPdfDocument: (...args: unknown[]) => openPdfDocument(...args) };
});

import {
  VIEWER_RANGE_OPEN_BUDGET_MS,
  VIEWER_STARTXREF_WINDOW_BYTES,
  hasStartXrefNearEnd,
  openViewerDocument,
  rangeOpenBudgetMs,
  type OpenViewerOptions,
} from "@/app/pdf-pro/viewer/openViewerDocument";

/**
 * D-B4-1 (Wave 9 · lote 2): un PDF grande SIN `startxref` valido (dañado, cortado) se abria por rangos 4–50 veces mas lento
 * (20 MB: 3,4–3,9 s en vez de 0,86 s; 100 MB: 69 s en vez de 1,4 s) porque pdf.js, con el archivo troceado, vuelve a empezar la
 * busqueda de `startxref` hacia atras por cada trozo que le falta; la caida a la apertura de siempre solo ocurria si FALLABA, no
 * si iba lento. Dos defensas, probadas aqui con pdf.js real (build «legacy», en Node) y con un pdf.js falso:
 *  1. sin `startxref` en la cola del archivo ni se intenta abrir por rangos;
 *  2. si por rangos el documento (y su primera pagina) no llegan en su plazo, se abandonan los rangos: se destruye la tarea y se
 *     abre de siempre, una sola vez, sin dejar nada vivo.
 */

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;
type Legacy = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function noisyPdf(pages: number, noiseKb: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Pagina ${i + 1} de ${pages}`, { x: 20, y: 350, size: 14, font });
    const stream = doc.context.stream(randomBytes(noiseKb * 1024), { Type: "XObject", Subtype: "Image", Width: 32, Height: 32, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Im0: doc.context.register(stream) }));
  }
  return doc.save({ useObjectStreams: false });
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** El mismo PDF sin su ultimo `startxref` (y lo que le sigue): lo que dejaba un archivo cortado o dañado al final. */
function withoutStartXref(bytes: Uint8Array): Uint8Array {
  const at = latin1(bytes).lastIndexOf("startxref");
  return new Uint8Array(Buffer.concat([Buffer.from(bytes.subarray(0, at)), Buffer.from("\n%%EOF\n")]));
}

let legacy: Legacy;
beforeEach(async () => {
  legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  openPdfDocument.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** `pdfjs` real con espias: cuantas veces se llamo a `getDocument` con un transporte de rangos, y la ultima tarea. */
function spiedPdfjs(options: { delayRangesMs?: number } = {}) {
  const seen = { rangeOpens: 0, requests: 0, tasks: [] as { destroyed: boolean }[] };
  const pdfjs = {
    ...legacy,
    getDocument: (src: Parameters<Legacy["getDocument"]>[0]) => {
      const range = (src as { range?: { requestDataRange: (begin: number, end: number) => void } }).range;
      if (range) {
        seen.rangeOpens += 1;
        const original = range.requestDataRange;
        range.requestDataRange = (begin, end) => {
          seen.requests += 1;
          if (options.delayRangesMs) setTimeout(() => original(begin, end), options.delayRangesMs);
          else original(begin, end);
        };
      }
      const task = legacy.getDocument(src);
      seen.tasks.push(task);
      return task;
    },
  } as unknown as NonNullable<OpenViewerOptions["pdfjs"]>;
  return { pdfjs, seen };
}

describe("hasStartXrefNearEnd", () => {
  const ascii = (text: string) => new TextEncoder().encode(text);

  it("lo encuentra al final de un PDF sano, con relleno despues del %%EOF y justo en el borde de la ventana", async () => {
    const good = await noisyPdf(2, 1);
    expect(hasStartXrefNearEnd(good)).toBe(true);
    expect(hasStartXrefNearEnd(new Uint8Array(Buffer.concat([Buffer.from(good), Buffer.alloc(900, 0x0a)])))).toBe(true);
    // El archivo acaba justo en la marca, sin salto de linea ni numero detras (cortado ahi).
    expect(hasStartXrefNearEnd(ascii("%PDF-1.7 startxref"))).toBe(true);
    expect(hasStartXrefNearEnd(ascii("startxref"))).toBe(true);
    const window = 4096;
    const edge = new Uint8Array(window + 100);
    edge.set(ascii("startxref"), edge.byteLength - window);
    expect(hasStartXrefNearEnd(edge, window)).toBe(true);
    edge.fill(0);
    edge.set(ascii("startxref"), edge.byteLength - window - 1);
    expect(hasStartXrefNearEnd(edge, window)).toBe(false);
  });

  it("no lo encuentra si el archivo no lo lleva, esta cortado a medias o solo aparece antes de la ventana", async () => {
    expect(hasStartXrefNearEnd(withoutStartXref(await noisyPdf(2, 1)))).toBe(false);
    expect(hasStartXrefNearEnd(ascii("%PDF-1.7 ... startx"))).toBe(false);
    expect(hasStartXrefNearEnd(ascii("%PDF-1.7 ... startxre"))).toBe(false);
    expect(hasStartXrefNearEnd(new Uint8Array(0))).toBe(false);
    expect(hasStartXrefNearEnd(new Uint8Array(4))).toBe(false);
    const far = new Uint8Array(VIEWER_STARTXREF_WINDOW_BYTES + 5000);
    far.set(ascii("startxref"), 100);
    expect(hasStartXrefNearEnd(far)).toBe(false);
    expect(hasStartXrefNearEnd(far, far.byteLength)).toBe(true);
  });

  it("la ventana por defecto es de 1 MB", () => {
    expect(VIEWER_STARTXREF_WINDOW_BYTES).toBe(1024 * 1024);
  });
});

describe("rangeOpenBudgetMs", () => {
  it("el plazo base es de 2,5 s hasta el umbral de rangos (16 MB) y crece 10 ms por MB por encima", () => {
    expect(VIEWER_RANGE_OPEN_BUDGET_MS).toBe(2500);
    expect(rangeOpenBudgetMs(1)).toBe(2500);
    expect(rangeOpenBudgetMs(16 * 1024 * 1024)).toBe(2500);
    expect(rangeOpenBudgetMs(100 * 1024 * 1024)).toBe(3340);
    expect(rangeOpenBudgetMs(1000 * 1024 * 1024)).toBe(12340);
  });
});

describe("openViewerDocument · sin startxref no se abre por rangos", () => {
  it("un PDF cortado (sin startxref) se abre de siempre con pdf.js real, sin tocar el transporte de rangos", async () => {
    const fake = { numPages: 4 };
    openPdfDocument.mockResolvedValue(fake);
    const bytes = withoutStartXref(await noisyPdf(8, 80));
    const { pdfjs, seen } = spiedPdfjs();
    await expect(openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS })).resolves.toBe(fake);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledWith(bytes);
    expect(seen.rangeOpens).toBe(0);
    expect(seen.requests).toBe(0);
  });

  it("basura sin forma de PDF, y un archivo vacio, tambien: apertura de siempre (la que da el error tipado)", async () => {
    const failure = Object.assign(new Error("corrupt"), { code: "corrupt" });
    openPdfDocument.mockRejectedValue(failure);
    const { pdfjs, seen } = spiedPdfjs();
    await expect(openViewerDocument(new Uint8Array(5000).fill(7), { pdfjs, rangeMinBytes: 0 })).rejects.toBe(failure);
    await expect(openViewerDocument(new Uint8Array(0), { pdfjs, rangeMinBytes: 0 })).rejects.toBe(failure);
    expect(seen.rangeOpens).toBe(0);
  });

  it("con startxref (aunque haya relleno despues del %%EOF) SI se abre por rangos, y se lee igual que de siempre", async () => {
    const good = await noisyPdf(6, 120);
    const padded = new Uint8Array(Buffer.concat([Buffer.from(good), Buffer.alloc(900, 0x0a)]));
    const { pdfjs, seen } = spiedPdfjs();
    const document = await openViewerDocument(padded, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    expect(openPdfDocument).not.toHaveBeenCalled();
    expect(seen.rangeOpens).toBe(1);
    expect(document.numPages).toBe(6);
    await document.loadingTask.destroy();
  });

  it("un startxref que apunta a basura NO se desvia: pdf.js reconstruye de golpe (2 peticiones) y el visor lo abre por rangos", async () => {
    const good = await noisyPdf(5, 100);
    const text = latin1(good);
    const at = text.lastIndexOf("startxref");
    const wrong = new Uint8Array(Buffer.from(`${text.slice(0, at)}startxref\n12345\n%%EOF\n`, "latin1"));
    const { pdfjs, seen } = spiedPdfjs();
    const document = await openViewerDocument(wrong, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    expect(seen.rangeOpens).toBe(1);
    expect(document.numPages).toBe(5);
    await document.loadingTask.destroy();
  });
});

describe("openViewerDocument · plazo de la apertura por rangos", () => {
  /** Un pdf.js falso: `getDocument` devuelve la tarea dada y `PDFDataRangeTransport` no hace nada. */
  function fakePdfjs(task: { promise: Promise<unknown>; destroy: () => Promise<void> }) {
    return {
      PDFDataRangeTransport: class {
        requestDataRange = () => undefined;
        onDataRange = () => undefined;
      },
      getDocument: () => task,
    } as unknown as NonNullable<OpenViewerOptions["pdfjs"]>;
  }
  const withStart = (size = 4096) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode("startxref\n0\n%%EOF\n"), size - 18);
    return bytes;
  };

  it("si el documento no llega en el plazo se abandonan los rangos: se destruye la tarea, se abre de siempre UNA vez y no queda ningun temporizador", async () => {
    vi.useFakeTimers();
    const fallback = { numPages: 3 };
    openPdfDocument.mockResolvedValue(fallback);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const bytes = withStart();
    const pending = openViewerDocument(bytes, { pdfjs: fakePdfjs({ promise: new Promise(() => undefined), destroy }), rangeMinBytes: 0, rangeBudgetMs: 400 });
    await vi.advanceTimersByTimeAsync(399);
    expect(openPdfDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(fallback);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledWith(bytes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sin plazo indicado manda el de siempre: 2,5 s para un archivo en el umbral", async () => {
    vi.useFakeTimers();
    openPdfDocument.mockResolvedValue({ numPages: 1 });
    const destroy = vi.fn().mockResolvedValue(undefined);
    const pending = openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: new Promise(() => undefined), destroy }), rangeMinBytes: 0 });
    await vi.advanceTimersByTimeAsync(2499);
    expect(openPdfDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });

  it("si el documento llega pero su primera pagina no, tambien se abandona (la primera pagina cuenta)", async () => {
    vi.useFakeTimers();
    openPdfDocument.mockResolvedValue({ numPages: 3 });
    const destroy = vi.fn().mockResolvedValue(undefined);
    const document = { numPages: 9, getPage: vi.fn(() => new Promise(() => undefined)) };
    const pending = openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: Promise.resolve(document), destroy }), rangeMinBytes: 0, rangeBudgetMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(document.getPage).toHaveBeenCalledWith(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });

  it("si la primera pagina FALLA, tambien se cae a la apertura de siempre (cerrando la tarea)", async () => {
    openPdfDocument.mockResolvedValue({ numPages: 3 });
    const destroy = vi.fn().mockResolvedValue(undefined);
    const document = { numPages: 2, getPage: vi.fn().mockRejectedValue(new Error("pagina rota")) };
    await openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: Promise.resolve(document), destroy }), rangeMinBytes: 0 });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });

  it("si el resultado de rangos llega TARDE (despues del plazo) no se usa ni se abre nada mas", async () => {
    vi.useFakeTimers();
    const fallback = { numPages: 3 };
    openPdfDocument.mockResolvedValue(fallback);
    const destroy = vi.fn().mockResolvedValue(undefined);
    let resolveLate: (document: unknown) => void = () => undefined;
    const late = new Promise((resolve) => {
      resolveLate = resolve;
    });
    const pending = openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: late, destroy }), rangeMinBytes: 0, rangeBudgetMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe(fallback);
    resolveLate({ numPages: 7, getPage: vi.fn().mockResolvedValue({}) });
    await vi.advanceTimersByTimeAsync(10);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("un documento rapido se devuelve tal cual: no se abre de siempre, no se destruye y no deja temporizador", async () => {
    vi.useFakeTimers();
    const destroy = vi.fn().mockResolvedValue(undefined);
    const document = { numPages: 3, getPage: vi.fn().mockResolvedValue({}) };
    const opened = await openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: Promise.resolve(document), destroy }), rangeMinBytes: 0, rangeBudgetMs: 400 });
    expect(opened).toBe(document);
    expect(document.getPage).toHaveBeenCalledWith(1);
    expect(openPdfDocument).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un documento sin paginas no pide la primera", async () => {
    const document = { numPages: 0, getPage: vi.fn() };
    const opened = await openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: Promise.resolve(document), destroy: vi.fn() }), rangeMinBytes: 0 });
    expect(opened).toBe(document);
    expect(document.getPage).not.toHaveBeenCalled();
  });

  it("dos aperturas a la vez son independientes: la lenta cae a la de siempre y la rapida se queda con la suya", async () => {
    vi.useFakeTimers();
    const fallback = { numPages: 1 };
    openPdfDocument.mockResolvedValue(fallback);
    const slowDestroy = vi.fn().mockResolvedValue(undefined);
    const fastDestroy = vi.fn().mockResolvedValue(undefined);
    const fastDocument = { numPages: 2, getPage: vi.fn().mockResolvedValue({}) };
    const slow = openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: new Promise(() => undefined), destroy: slowDestroy }), rangeMinBytes: 0, rangeBudgetMs: 200 });
    const fast = openViewerDocument(withStart(), { pdfjs: fakePdfjs({ promise: Promise.resolve(fastDocument), destroy: fastDestroy }), rangeMinBytes: 0, rangeBudgetMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(slow).resolves.toBe(fallback);
    await expect(fast).resolves.toBe(fastDocument);
    expect(slowDestroy).toHaveBeenCalledTimes(1);
    expect(fastDestroy).not.toHaveBeenCalled();
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });

  it("con pdf.js REAL y un transporte de rangos LENTO: pasado el plazo se destruye la tarea real y se abre de siempre", async () => {
    const fallback = { numPages: 12 };
    openPdfDocument.mockResolvedValue(fallback);
    const bytes = await noisyPdf(12, 60);
    const { pdfjs, seen } = spiedPdfjs({ delayRangesMs: 300 });
    const started = Date.now();
    await expect(openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS, rangeBudgetMs: 80 })).resolves.toBe(fallback);
    expect(Date.now() - started).toBeLessThan(700);
    expect(seen.rangeOpens).toBe(1);
    expect(seen.tasks[0].destroyed).toBe(true);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
    expect(openPdfDocument).toHaveBeenCalledWith(bytes);
  });

  it("con pdf.js REAL y un transporte rapido, el plazo no molesta: abre por rangos y no abre de siempre", async () => {
    const bytes = await noisyPdf(12, 60);
    const { pdfjs, seen } = spiedPdfjs();
    const document = await openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS, rangeBudgetMs: 5000 });
    expect(openPdfDocument).not.toHaveBeenCalled();
    expect(document.numPages).toBe(12);
    expect(seen.tasks[0].destroyed).toBe(false);
    await document.loadingTask.destroy();
  });
});
