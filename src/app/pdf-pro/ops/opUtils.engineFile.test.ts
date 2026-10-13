import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { asEngineFile, asPdfFile } from "@/app/pdf-pro/ops/opUtils";
import { loadPdf } from "@/lib/pdf/core";
import { rotatePdf } from "@/lib/pdf/rotate";
import { addWatermark, DEFAULT_WATERMARK_OPTIONS } from "@/lib/pdf/watermark";
import { addPageNumbers, DEFAULT_PAGE_NUMBERS_OPTIONS } from "@/lib/pdf/pageNumbers";
import { addHeaderFooter, DEFAULT_HEADER_FOOTER_OPTIONS } from "@/lib/pdf/headerFooter";
import { cropPdf } from "@/lib/pdf/crop";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";

/**
 * `asEngineFile` (Wave 9): un `File` de solo lectura que sirve los bytes del snapshot SIN copiarlos. La salida de cada
 * motor con el debe ser IDENTICA byte a byte a la que da con el `File` de siempre, y los bytes del snapshot deben
 * quedar intactos (ni modificados ni transferidos).
 */

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("asEngineFile", () => {
  it("es un File con nombre, tipo y tamaño verdaderos", async () => {
    const bytes = await makePdfBytes(2);
    const file = asEngineFile(bytes, "informe.pdf");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("informe.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(bytes.byteLength);
  });

  it("arrayBuffer() devuelve el MISMO buffer del snapshot (sin copiar) cuando los bytes ocupan el buffer entero", async () => {
    const bytes = await makePdfBytes(1);
    const whole = bytes.buffer.byteLength === bytes.byteLength ? bytes : bytes.slice();
    const file = asEngineFile(whole);
    const buffer = await file.arrayBuffer();
    expect(buffer).toBe(whole.buffer);
    expect(buffer.byteLength).toBe(whole.byteLength);
  });

  it("si los bytes son una vista de un buffer mayor, arrayBuffer() devuelve la copia EXACTA de su tramo", async () => {
    const pdf = await makePdfBytes(1);
    const padded = new Uint8Array(pdf.byteLength + 20);
    padded.set(pdf, 10);
    const view = padded.subarray(10, 10 + pdf.byteLength);
    const buffer = await asEngineFile(view).arrayBuffer();
    expect(buffer).not.toBe(padded.buffer);
    expect(buffer.byteLength).toBe(pdf.byteLength);
    expect(same(new Uint8Array(buffer), pdf)).toBe(true);
    // Y el motor lo lee igual.
    const document = await loadPdf(asEngineFile(view));
    expect(document.getPageCount()).toBe(1);
  });

  it("slice, stream y text leen los mismos bytes (nada que vea el archivo vacio por una via distinta)", async () => {
    const bytes = new Uint8Array(Array.from({ length: 200 }, (_, i) => (i * 7) & 255));
    const file = asEngineFile(bytes);
    expect(same(new Uint8Array(await file.slice(10, 50).arrayBuffer()), bytes.subarray(10, 50))).toBe(true);
    expect(same(new Uint8Array(await file.slice().arrayBuffer()), bytes)).toBe(true);
    const chunks: Uint8Array[] = [];
    const reader = file.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(same(new Uint8Array(await new Blob(chunks as unknown as BlobPart[]).arrayBuffer()), bytes)).toBe(true);
    expect((await file.text()).length).toBeGreaterThan(0);
  });

  it("loadPdf lo abre igual que un File real (mismas paginas) y no toca los bytes", async () => {
    const bytes = await makePdfBytes(4);
    const before = bytes.slice();
    const viaEngine = await loadPdf(asEngineFile(bytes));
    const viaFile = await loadPdf(asPdfFile(bytes));
    expect(viaEngine.getPageCount()).toBe(viaFile.getPageCount());
    expect(same(bytes, before)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("asEngineFile · cada motor da EXACTAMENTE la misma salida que con el File de siempre", () => {
  it("rotar todo y rotar un rango", async () => {
    const bytes = await makePdfBytes(5);
    for (const plan of [{ base: 90 }, { base: 0, byPage: { 2: 180, 4: 90 } }]) {
      const a = await bytesOf(await rotatePdf(asPdfFile(bytes), plan));
      const b = await bytesOf(await rotatePdf(asEngineFile(bytes), plan));
      expect(same(a, b)).toBe(true);
    }
  });

  it("marca de agua", async () => {
    const bytes = await makePdfBytes(3);
    const options = { ...DEFAULT_WATERMARK_OPTIONS, text: "BORRADOR" };
    const a = await bytesOf(await addWatermark(asPdfFile(bytes), options));
    const b = await bytesOf(await addWatermark(asEngineFile(bytes), options));
    expect(same(a, b)).toBe(true);
  });

  it("numerar paginas", async () => {
    const bytes = await makePdfBytes(3);
    const a = await bytesOf(await addPageNumbers(asPdfFile(bytes), DEFAULT_PAGE_NUMBERS_OPTIONS));
    const b = await bytesOf(await addPageNumbers(asEngineFile(bytes), DEFAULT_PAGE_NUMBERS_OPTIONS));
    expect(same(a, b)).toBe(true);
  });

  it("encabezado y pie", async () => {
    const bytes = await makePdfBytes(3);
    const options = { ...DEFAULT_HEADER_FOOTER_OPTIONS, header: { left: "Informe", center: "", right: "{fecha}" }, footer: { left: "", center: "{n} de {p}", right: "" }, date: new Date(Date.UTC(2026, 0, 2)) };
    const a = await bytesOf(await addHeaderFooter(asPdfFile(bytes), options));
    const b = await bytesOf(await addHeaderFooter(asEngineFile(bytes), options));
    expect(same(a, b)).toBe(true);
  });

  it("recortar", async () => {
    const bytes = await makePdfBytes(3);
    const options = { rect: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, scope: "all" as const, pageIndex: 0, fromPage: 1, toPage: 0 };
    const a = await bytesOf(await cropPdf(asPdfFile(bytes), options));
    const b = await bytesOf(await cropPdf(asEngineFile(bytes), options));
    expect(same(a, b)).toBe(true);
  });

  it("tras todos los motores los bytes del snapshot siguen intactos y legibles", async () => {
    const bytes = await makePdfBytes(3);
    const before = bytes.slice();
    await rotatePdf(asEngineFile(bytes), { base: 90 });
    await addWatermark(asEngineFile(bytes), { ...DEFAULT_WATERMARK_OPTIONS, text: "X" });
    await addPageNumbers(asEngineFile(bytes), DEFAULT_PAGE_NUMBERS_OPTIONS);
    expect(same(bytes, before)).toBe(true);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
  });
});
