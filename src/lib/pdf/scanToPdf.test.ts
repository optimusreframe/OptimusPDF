import { afterEach, describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  CameraError,
  DEFAULT_SCAN_OPTIONS,
  applyScanFilter,
  normalizeImageOrientation,
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

/* ------------------------------------------------------------------ *
 * Orientacion EXIF
 * ------------------------------------------------------------------ */

/**
 * Cabecera JPEG con un bloque EXIF que declara `Orientation = 6` (girada
 * 90°), como la que produce la app de Camara de un iPhone con la foto en
 * vertical. No es una imagen decodificable —no lleva scan— y no hace
 * falta que lo sea: lo que se ejercita aqui es el camino que sigue el
 * Blob, no el decodificador.
 */
function jpegWithOrientation6(): Blob {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii"); // little endian
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset del IFD0
  tiff.writeUInt16LE(1, 8); // una sola entrada
  tiff.writeUInt16LE(0x0112, 10); // tag Orientation
  tiff.writeUInt16LE(3, 12); // tipo SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(6, 18); // valor: 6 = rotar 90°
  tiff.writeUInt32LE(0, 22); // no hay IFD siguiente

  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);

  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
  return new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" });
}

/**
 * Sustituye el decodificador del navegador por uno que devuelve el
 * bitmap ya enderezado, que es justo lo que hace un navegador real al
 * pedirle `imageOrientation: "from-image"` (ver limitaciones).
 */
function stubBrowserDecoder(oriented: { width: number; height: number }) {
  const seen: {
    options?: ImageBitmapOptions;
    canvas?: { width: number; height: number };
    decoded: number;
  } = { decoded: 0 };

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (callback: (blob: Blob | null) => void) => {
      seen.canvas = { width: canvas.width, height: canvas.height };
      callback(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
      );
    },
  };

  vi.stubGlobal(
    "createImageBitmap",
    (_source: Blob, options?: ImageBitmapOptions) => {
      seen.decoded += 1;
      seen.options = options;
      return Promise.resolve({ ...oriented, close: () => {} });
    },
  );
  vi.stubGlobal("document", { createElement: () => canvas });

  return seen;
}

describe("normalizeImageOrientation — src/lib/pdf/scanToPdf.ts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("un JPEG con EXIF se decodifica con imageOrientation 'from-image' y se re-exporta con las dimensiones ya enderezadas", async () => {
    // Una foto de 60x40 con Orientation=6 se ve como 40x60 al aplicar el
    // tag: es ese tamano el que tiene que acabar en el lienzo de salida.
    const seen = stubBrowserDecoder({ width: 40, height: 60 });
    const source = jpegWithOrientation6();

    const output = await normalizeImageOrientation(source);

    expect(seen.options?.imageOrientation).toBe("from-image");
    expect(seen.canvas).toEqual({ width: 40, height: 60 });
    expect(output).not.toBe(source);
    expect(output.type).toBe("image/jpeg");
  });

  it("un PNG se devuelve intacto: no hay EXIF que aplicar ni motivo para recomprimir", async () => {
    const seen = stubBrowserDecoder({ width: 10, height: 10 });
    const source = pngBlob(4, 4);

    expect(await normalizeImageOrientation(source)).toBe(source);
    expect(seen.decoded).toBe(0);
  });

  it("si el decodificador falla, devuelve el original en vez de romper el flujo", async () => {
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("nope")));
    const source = jpegWithOrientation6();

    expect(await normalizeImageOrientation(source)).toBe(source);
  });

  it("sin createImageBitmap (entorno Node) devuelve el Blob de entrada intacto", async () => {
    expect(
      typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap,
    ).toBe("undefined");

    const source = jpegWithOrientation6();
    expect(await normalizeImageOrientation(source)).toBe(source);
  });
});

/**
 * Limitaciones conocidas
 *
 * - Que el tag EXIF `Orientation` se aplique de verdad al decodificar es
 *   trabajo del navegador: en Node no hay decodificador que lo haga, asi
 *   que aqui se comprueba el contrato del lado del codigo propio —pedir
 *   `imageOrientation: "from-image"`, dimensionar el lienzo con el bitmap
 *   ya enderezado y re-exportar un JPEG nuevo— con un decodificador de
 *   prueba. La rotacion real esta cubierta a mano en un dispositivo.
 * - Igual que en `applyScanFilter`, el paso por Canvas 2D (dibujado y
 *   `toBlob`) no es ejercitable con un lienzo real en este entorno.
 */
