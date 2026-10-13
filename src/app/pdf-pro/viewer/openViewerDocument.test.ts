import { randomBytes } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openPdfDocument = vi.fn();
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, openPdfDocument: (...args: unknown[]) => openPdfDocument(...args) };
});

import { VIEWER_RANGE_MIN_BYTES, openViewerDocument, type OpenViewerOptions } from "@/app/pdf-pro/viewer/openViewerDocument";

/**
 * Apertura del visor por RANGOS (Wave 9): con pdf.js real (build «legacy», en Node) se comprueba que lo que se lee es
 * identico a la apertura de siempre, que no se copia el archivo entero, que los bytes del snapshot quedan intactos
 * (pdf.js transfiere los buffers que recibe) y que cualquier fallo cae a la apertura de siempre.
 */

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;

function getGc(): (() => void) | null {
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    return typeof gc === "function" ? gc : null;
  } catch {
    return null;
  }
}
const gc = getGc();
/** Cede el turno (para que se vacien los `WeakRef` y los avisos de cierre) y recoge la basura. */
async function collectGarbage(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  gc?.();
}
type Legacy = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** PDF de `pages` paginas con texto, cada una con un flujo de ruido incompresible (para que pese y no se pueda leer de golpe). */
async function noisyPdf(pages: number, noiseKb: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Pagina ${i + 1} de ${pages}`, { x: 20, y: 350, size: 14, font });
    const data = randomBytes(noiseKb * 1024);
    const stream = doc.context.stream(data, { Type: "XObject", Subtype: "Image", Width: 32, Height: 32, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    const ref = doc.context.register(stream);
    page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Im0: ref }));
  }
  return doc.save({ useObjectStreams: false });
}

async function textsOf(document: { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> }): Promise<string[]> {
  const out: string[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    out.push(content.items.map((item) => (item as { str?: string }).str ?? "").join(" "));
  }
  return out;
}

/** Los mismos bytes pero acabando en `startxref 0 %%EOF`: un archivo que, por lo que se ve en la cola, podria ser un PDF sano. */
function withStartXref(bytes: Uint8Array): Uint8Array {
  const tail = new TextEncoder().encode("startxref\n0\n%%EOF\n");
  bytes.set(tail, bytes.byteLength - tail.byteLength);
  return bytes;
}

let legacy: Legacy;
beforeEach(async () => {
  legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  openPdfDocument.mockReset();
});
afterEach(() => vi.restoreAllMocks());

/** `pdfjs` con espias: cuantas peticiones de rango y cuantos bytes se sirvieron. */
function spiedPdfjs() {
  const served = { requests: 0, bytes: 0 };
  const pdfjs = {
    ...legacy,
    getDocument: (src: Parameters<Legacy["getDocument"]>[0]) => {
      const range = (src as { range?: { requestDataRange: (begin: number, end: number) => void } }).range;
      if (range) {
        const original = range.requestDataRange;
        range.requestDataRange = (begin, end) => {
          served.requests += 1;
          served.bytes += end - begin;
          original(begin, end);
        };
      }
      return legacy.getDocument(src);
    },
  } as unknown as NonNullable<OpenViewerOptions["pdfjs"]>;
  return { pdfjs, served };
}

describe("openViewerDocument", () => {
  it("el umbral es de 16 MB", () => {
    expect(VIEWER_RANGE_MIN_BYTES).toBe(16 * 1024 * 1024);
  });

  it("por debajo del umbral abre como siempre (openPdfDocument) y no toca pdf.js", async () => {
    const fake = { numPages: 1 };
    openPdfDocument.mockResolvedValue(fake);
    const bytes = new Uint8Array(1000);
    await expect(openViewerDocument(bytes)).resolves.toBe(fake);
    expect(openPdfDocument).toHaveBeenCalledWith(bytes);
  });

  it("por rangos: mismo numero de paginas y mismo texto que la apertura normal, y NO se sirve el archivo entero", async () => {
    const bytes = await noisyPdf(30, 400);
    expect(bytes.byteLength).toBeGreaterThan(11 * 1024 * 1024);
    const reference = await legacy.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS }).promise;
    const expected = await textsOf(reference as never);
    await reference.loadingTask.destroy();

    const { pdfjs, served } = spiedPdfjs();
    const document = await openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    expect(openPdfDocument).not.toHaveBeenCalled();
    expect(document.numPages).toBe(30);
    // Se lee el texto de las 3 primeras paginas: coincide con la apertura normal.
    for (let index = 1; index <= 3; index += 1) {
      const page = await document.getPage(index);
      const text = (await page.getTextContent()).items.map((item) => (item as { str?: string }).str ?? "").join(" ");
      expect(text).toBe(expected[index - 1]);
    }
    expect(served.requests).toBeGreaterThan(0);
    // Solo lo necesario: muy por debajo del archivo entero (los flujos de ruido de las demas paginas no se leen).
    expect(served.bytes).toBeLessThan(bytes.byteLength * 0.25);
    await document.loadingTask.destroy();
  });

  it("los bytes del snapshot quedan INTACTOS tras abrir, leer y cerrar (pdf.js transfiere lo que recibe)", async () => {
    const bytes = await noisyPdf(12, 80);
    const before = bytes.slice();
    const { pdfjs } = spiedPdfjs();
    const document = await openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      await page.getTextContent();
      await page.getOperatorList();
    }
    await document.loadingTask.destroy();
    expect(bytes.buffer.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBe(before.byteLength);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(before))).toBe(0);
  });

  it("un PDF diminuto (todo cabe en el primer trozo que se entrega) tambien deja intactos los bytes del snapshot", async () => {
    // Si ese primer trozo fuera una vista del propio buffer, pdf.js lo TRANSFERIRIA al worker (lo hace con un buffer entero).
    const made = await noisyPdf(2, 1);
    const bytes = made.buffer.byteLength === made.byteLength ? made : made.slice();
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    const before = bytes.slice();
    const { pdfjs } = spiedPdfjs();
    const document = await openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    const page = await document.getPage(1);
    await page.getTextContent();
    await document.loadingTask.destroy();
    expect(bytes.byteLength).toBe(before.byteLength);
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(before))).toBe(0);
  });

  it("al CERRAR el documento sus bytes se pueden liberar aunque algo siga referenciando el documento cerrado", async () => {
    // Los bytes solo viven dentro de esta funcion: fuera solo quedan el documento y una referencia DEBIL.
    const openIt = async () => {
      const bytes = await noisyPdf(10, 300);
      const { pdfjs } = spiedPdfjs();
      const document = await openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
      const page = await document.getPage(1);
      await page.getTextContent();
      return { document, ref: new WeakRef(bytes) };
    };
    const { document, ref } = await openIt();
    // Abierto: el documento los necesita (los pide por rangos).
    await collectGarbage();
    expect(ref.deref()).toBeDefined();
    await document.loadingTask.destroy();
    // Cerrado, pero el documento sigue referenciado (`document`): sus bytes ya no pesan.
    for (let attempt = 0; attempt < 15 && ref.deref() !== undefined; attempt += 1) await collectGarbage();
    expect(document.numPages).toBe(10);
    expect(ref.deref()).toBeUndefined();
  });

  it("cada documento abierto es independiente: cerrar uno no estropea el otro (cambio de snapshot)", async () => {
    const a = await noisyPdf(6, 60);
    const b = await noisyPdf(9, 60);
    const { pdfjs } = spiedPdfjs();
    const first = await openViewerDocument(a, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    const second = await openViewerDocument(b, { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS });
    await first.loadingTask.destroy();
    expect(second.numPages).toBe(9);
    const page = await second.getPage(9);
    expect(((await page.getTextContent()).items[0] as { str: string }).str).toContain("Pagina 9");
    await second.loadingTask.destroy();
  });

  it("si la apertura por rangos falla, cae a openPdfDocument (la apertura de siempre)", async () => {
    const fake = { numPages: 7 };
    openPdfDocument.mockResolvedValue(fake);
    const pdfjs = {
      ...legacy,
      getDocument: () => ({ promise: Promise.reject(new Error("fallo de rangos")), destroy: vi.fn().mockResolvedValue(undefined) }),
    } as never;
    // Con `startxref` al final: sin esa marca ni se intenta abrir por rangos (ver `openViewerDocument.damaged.test.ts`).
    const bytes = withStartXref(new Uint8Array(2048));
    await expect(openViewerDocument(bytes, { pdfjs, rangeMinBytes: 0 })).resolves.toBe(fake);
    expect(openPdfDocument).toHaveBeenCalledWith(bytes);
  });

  it("un PDF invalido: tras fallar por rangos, el error es el tipado de siempre (el de openPdfDocument)", async () => {
    const failure = Object.assign(new Error("corrupt"), { code: "corrupt" });
    openPdfDocument.mockRejectedValue(failure);
    const { pdfjs } = spiedPdfjs();
    await expect(openViewerDocument(withStartXref(new Uint8Array(5000).fill(7)), { pdfjs, rangeMinBytes: 0, standardFontDataUrl: FONTS })).rejects.toBe(failure);
  });
});
