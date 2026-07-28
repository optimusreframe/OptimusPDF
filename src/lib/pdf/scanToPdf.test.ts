import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  CameraError,
  DEFAULT_SCAN_OPTIONS,
  applyScanFilter,
  scanToPdf,
  startCameraStream,
  stopCameraStream,
  type ScanToPdfOptions,
} from "@/lib/pdf/scanToPdf";

/**
 * `scanToPdf` reutiliza `buildPdfFromImages` de `imagesToPdf.ts`, que solo
 * necesita `document.embedJpg/embedPng` de pdf-lib (sin canvas) para PNG y
 * JPEG reales — ver el razonamiento completo en `imagesToPdf.test.ts`. Por
 * eso el flujo completo de composicion SI se puede probar de punta a punta
 * aqui con fixtures reales.
 *
 * `applyScanFilter`, en cambio, solo transforma pixeles cuando el entorno
 * tiene `createImageBitmap` (navegador). En Node (`environment: "node"`,
 * sin `createImageBitmap` ni `document`) la propia funcion detecta la
 * ausencia y devuelve el Blob de entrada sin tocarlo — ese es el camino
 * real que se prueba aqui. El recorte de contraste pixel a pixel en si
 * (rama que exige `createImageBitmap`/Canvas 2D) no es ejercitable en este
 * entorno; ver limitaciones.
 */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number] = [10, 20, 30],
): Buffer {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = rgb[0];
      raw[px + 1] = rgb[1];
      raw[px + 2] = rgb[2];
    }
  }
  const idatData = zlib.deflateSync(raw);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", idatData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngBlob(width: number, height: number): Blob {
  return new Blob([makeSolidPng(width, height) as unknown as BlobPart], {
    type: "image/png",
  });
}

const FIT_OPTIONS: ScanToPdfOptions = {
  filter: "color",
  orientation: "auto",
  pageSize: "fit",
  margin: "none",
};

describe("scanToPdf — src/lib/pdf/scanToPdf.ts", () => {
  it("compone un PDF con una pagina por captura, en el orden recibido", async () => {
    const captures = [pngBlob(4, 2), pngBlob(8, 6)];

    const blob = await scanToPdf(captures, FIT_OPTIONS);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const document = await PDFDocument.load(bytes, { updateMetadata: false });

    expect(document.getPageCount()).toBe(2);
    expect(document.getPage(0).getWidth()).toBe(4);
    expect(document.getPage(1).getWidth()).toBe(8);
  });

  it("con 0 capturas, lanza PdfError('empty')", async () => {
    await expect(scanToPdf([], FIT_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("reporta progreso hasta 1 al terminar", async () => {
    const seen: number[] = [];
    await scanToPdf([pngBlob(2, 2)], FIT_OPTIONS, (value) => seen.push(value));
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("filter 'color' devuelve el mismo Blob de entrada, sin tocarlo", async () => {
    const source = pngBlob(3, 3);
    const output = await applyScanFilter(source, "color");
    expect(output).toBe(source);
  });

  it("filter 'bw' sin createImageBitmap (entorno Node) recae en devolver el Blob de entrada intacto", async () => {
    expect(typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap).toBe(
      "undefined",
    );

    const source = pngBlob(3, 3);
    const output = await applyScanFilter(source, "bw");

    // No es un cambio de identidad garantizado por contrato, pero si de
    // contenido: sin `createImageBitmap` la funcion devuelve el mismo Blob.
    expect(output).toBe(source);
  });

  it("scanToPdf con filter 'bw' no falla y produce el mismo numero de paginas que 'color' (recorte de contraste no ejercitable sin Canvas)", async () => {
    const captures = [pngBlob(4, 4)];
    const bwBlob = await scanToPdf(captures, { ...FIT_OPTIONS, filter: "bw" });
    const bytes = new Uint8Array(await bwBlob.arrayBuffer());
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(document.getPageCount()).toBe(1);
  });

  it("startCameraStream lanza CameraError('unsupported') cuando no hay navigator.mediaDevices (entorno Node)", async () => {
    // Node 24+ define un `navigator` global propio (APIs de plataforma web),
    // pero sin `mediaDevices` — es ese caso el que este test ejercita, no la
    // ausencia total del global.
    expect(navigator.mediaDevices?.getUserMedia).toBeUndefined();
    await expect(startCameraStream()).rejects.toBeInstanceOf(CameraError);
    await expect(startCameraStream()).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("stopCameraStream(null) no lanza (no-op)", () => {
    expect(() => stopCameraStream(null)).not.toThrow();
  });

  it("stopCameraStream detiene todas las pistas del stream", () => {
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stop1 }, { stop: stop2 }],
    } as unknown as MediaStream;

    stopCameraStream(fakeStream);

    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledTimes(1);
  });

  it("stopCameraStream ignora una pista que lanza al detenerse (ya cerrada)", () => {
    const fakeStream = {
      getTracks: () => [
        {
          stop: () => {
            throw new Error("ya estaba cerrada");
          },
        },
      ],
    } as unknown as MediaStream;

    expect(() => stopCameraStream(fakeStream)).not.toThrow();
  });

  it("DEFAULT_SCAN_OPTIONS: valores por defecto documentados", () => {
    expect(DEFAULT_SCAN_OPTIONS).toEqual({
      filter: "color",
      orientation: "auto",
      pageSize: "a4",
      margin: "none",
    });
  });
});
