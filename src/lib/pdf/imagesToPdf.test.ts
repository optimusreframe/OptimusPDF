import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  DEFAULT_IMAGES_TO_PDF_OPTIONS,
  imagesToPdf,
  uniquePdfEntryName,
  type ImagesToPdfOptions,
} from "@/lib/pdf/imagesToPdf";

/**
 * Fixtures reales: PNG validos generados a mano (firma + IHDR + IDAT + IEND,
 * sin depender de canvas) para poder variar ancho/alto y asi verificar
 * orden y layout por comportamiento, no por inspeccion de bytes.
 *
 * `embedImage` (imagesToPdf.ts) detecta el formato por los bytes magicos y
 * llama a `document.embedJpg`/`embedPng` de pdf-lib directamente: no toca
 * `canvas`/`createImageBitmap`, asi que PNG y JPEG reales se pueden probar
 * de punta a punta en Node sin DOM. Solo el formato "other" (WEBP/AVIF...)
 * pasa por `rasterizeToPng`, que si necesita canvas — ver limitaciones.
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

/** PNG valido de un solo color, sin interlace, RGB de 8 bits. */
function makeSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // sin filtro
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
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
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

/** JPEG minimo (1x1) valido, para probar la deteccion por bytes magicos. */
const MINIMAL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

function pngFile(
  name: string,
  width: number,
  height: number,
  rgb: [number, number, number] = [255, 0, 0],
): File {
  const bytes = makeSolidPng(width, height, rgb);
  return new File([bytes as unknown as BlobPart], name, { type: "image/png" });
}

function jpegFile(name = "photo.jpg"): File {
  const bytes = Buffer.from(MINIMAL_JPEG_BASE64, "base64");
  return new File([bytes as unknown as BlobPart], name, {
    type: "image/jpeg",
  });
}

const FIT: ImagesToPdfOptions = {
  merge: true,
  orientation: "auto",
  pageSize: "fit",
  margin: "none",
};

async function loadResult(blob: Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false });
}

describe("imagesToPdf — src/lib/pdf/imagesToPdf.ts", () => {
  it("une 2 imagenes PNG en un unico PDF con una pagina por imagen, en el orden de subida", async () => {
    const files = [pngFile("a.png", 4, 2), pngFile("b.png", 8, 6)];

    const result = await imagesToPdf(files, FIT);
    expect(result.kind).toBe("pdf");
    expect(result.count).toBe(1);

    const document = await loadResult(result.blob);
    expect(document.getPageCount()).toBe(2);
    // pageSize "fit" + margin "none": la pagina mide exactamente la imagen.
    expect(document.getPage(0).getWidth()).toBe(4);
    expect(document.getPage(0).getHeight()).toBe(2);
    expect(document.getPage(1).getWidth()).toBe(8);
    expect(document.getPage(1).getHeight()).toBe(6);
  });

  it("respeta 'order' para reordenar (y submuestrear) las paginas", async () => {
    const files = [pngFile("a.png", 4, 2), pngFile("b.png", 8, 6)];

    const result = await imagesToPdf(files, { ...FIT, order: [1, 0] });
    const document = await loadResult(result.blob);

    expect(document.getPageCount()).toBe(2);
    expect(document.getPage(0).getWidth()).toBe(8);
    expect(document.getPage(1).getWidth()).toBe(4);
  });

  it("'order' descarta indices fuera de rango en vez de fallar", async () => {
    const files = [pngFile("a.png", 4, 2), pngFile("b.png", 8, 6)];

    const result = await imagesToPdf(files, { ...FIT, order: [5, 0, -1] });
    const document = await loadResult(result.blob);

    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBe(4);
  });

  it("con 0 archivos, lanza PdfError('empty')", async () => {
    await expect(imagesToPdf([], FIT)).rejects.toMatchObject({ code: "empty" });
  });

  it("con 'order' vacio (plan explicito sin imagenes), lanza PdfError('empty')", async () => {
    const files = [pngFile("a.png", 4, 2)];
    await expect(imagesToPdf(files, { ...FIT, order: [] })).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("pageSize 'a4' + orientation 'auto': imagen ancha -> pagina apaisada; imagen alta -> vertical", async () => {
    const wide = pngFile("wide.png", 20, 10);
    const tall = pngFile("tall.png", 10, 20);

    const wideResult = await imagesToPdf([wide], {
      merge: true,
      orientation: "auto",
      pageSize: "a4",
      margin: "none",
    });
    const wideDoc = await loadResult(wideResult.blob);
    // A4 apaisado: ancho (841.89) > alto (595.28).
    expect(wideDoc.getPage(0).getWidth()).toBeCloseTo(841.89, 1);
    expect(wideDoc.getPage(0).getHeight()).toBeCloseTo(595.28, 1);

    const tallResult = await imagesToPdf([tall], {
      merge: true,
      orientation: "auto",
      pageSize: "a4",
      margin: "none",
    });
    const tallDoc = await loadResult(tallResult.blob);
    expect(tallDoc.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
    expect(tallDoc.getPage(0).getHeight()).toBeCloseTo(841.89, 1);
  });

  it("margin 'large' amplia la pagina 'fit' en 56pt por lado", async () => {
    const file = pngFile("a.png", 10, 10);
    const result = await imagesToPdf([file], {
      merge: true,
      orientation: "auto",
      pageSize: "fit",
      margin: "large",
    });
    const document = await loadResult(result.blob);
    expect(document.getPage(0).getWidth()).toBe(10 + 56 * 2);
    expect(document.getPage(0).getHeight()).toBe(10 + 56 * 2);
  });

  // `merge: false` hace zip.file(name, blob) con Blobs reales (ver
  // imagesToPdf.ts:332, via savePdfToBlob en core.ts). JSZip funciona con
  // Blob real solo en navegador (usa FileReader internamente); en Node
  // `JSZip.support.blob` da `true` (falso positivo: solo detecta que el
  // global `Blob` existe) pero al leerlo de verdad lanza "Can't read the
  // data of...". Confirmado en un script standalone (throw limpio y
  // catcheable), pero DENTRO de un worker fork de Vitest el mismo camino
  // no lanza una excepcion JS normal: revienta el proceso del worker
  // entero ("Worker exited unexpectedly"), lo que arruina el resto de la
  // suite si este test corre junto a otros. No es un bug de produccion:
  // este mismo motor esta verificado en navegador real como una de las 21
  // herramientas en produccion (jpg-to-pdf). Se omite aqui en vez de
  // forzarlo, siguiendo el mismo criterio que otros archivos de este
  // paquete usan para partes que dependen de un DOM real (compress.test.ts,
  // redact.test.ts, compare.test.ts, core.test.ts).
  it.skip("merge=false produce un ZIP con un PDF por imagen y evita colisiones de nombre (requiere navegador real: JSZip + Blob no funciona en el worker de Vitest/Node)", async () => {
    const files = [
      pngFile("foo.png", 4, 2),
      pngFile("foo.jpg", 4, 2), // mismo nombre base tras reemplazar extension
    ];

    const result = await imagesToPdf(files, { ...FIT, merge: false });
    expect(result.kind).toBe("zip");
    expect(result.count).toBe(2);

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["foo (2).pdf", "foo.pdf"]);
  });

  // Regresion (W6-D): `replaceExtension("foto.jpg-2")` volvia a dar "foto.pdf" y el `while` no terminaba
  // nunca (pestana colgada con «foto.jpg» + «foto.png» sin unir). El Set corta el bucle con un error.
  it("uniquePdfEntryName: foto.jpg y foto.png dan foto.pdf y foto (2).pdf sin bucles", () => {
    class BudgetSet extends Set<string> {
      private calls = 0;
      override has(value: string): boolean {
        this.calls += 1;
        if (this.calls > 1000) throw new Error("bucle sin fin");
        return super.has(value);
      }
    }
    const used = new BudgetSet();
    expect(uniquePdfEntryName("foto.jpg", used)).toBe("foto.pdf");
    expect(uniquePdfEntryName("foto.png", used)).toBe("foto (2).pdf");
    expect(uniquePdfEntryName("FOTO.JPEG", used)).toBe("FOTO (3).pdf");
    expect(uniquePdfEntryName("sin extension", used)).toBe("sin extension.pdf");
    expect(uniquePdfEntryName("sin extension", used)).toBe("sin extension (2).pdf");
  });

  it("detecta JPEG por los bytes magicos aunque el nombre/MIME no lo declare", async () => {
    const bytes = Buffer.from(MINIMAL_JPEG_BASE64, "base64");
    const misnamed = new File([bytes as unknown as BlobPart], "no-extension", {
      type: "application/octet-stream",
    });

    const result = await imagesToPdf([misnamed], FIT);
    const document = await loadResult(result.blob);
    expect(document.getPageCount()).toBe(1);
  });

  it("un archivo vacio (0 bytes) da PdfError('invalidType')", async () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    await expect(imagesToPdf([empty], FIT)).rejects.toMatchObject({
      code: "invalidType",
    });
  });

  it("un formato no reconocido por los bytes magicos da PdfError('invalidType')", async () => {
    // Firma GIF89a: ni JPEG ni PNG -> "other". En navegador se rasterizaria
    // con canvas; en Node (sin `createImageBitmap`/`document`) el motor
    // recae en el mismo codigo de error que un formato realmente invalido.
    const gifBytes = Buffer.from("GIF89a" + "resto-de-bytes-sin-sentido");
    const gif = new File([gifBytes as unknown as BlobPart], "a.gif", {
      type: "image/gif",
    });

    await expect(imagesToPdf([gif], FIT)).rejects.toMatchObject({
      code: "invalidType",
    });
  });

  it("reporta progreso hasta 1 al terminar", async () => {
    const files = [pngFile("a.png", 4, 2), jpegFile()];
    const seen: number[] = [];

    await imagesToPdf(files, FIT, (value) => seen.push(value));

    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it("DEFAULT_IMAGES_TO_PDF_OPTIONS: valores por defecto documentados", () => {
    expect(DEFAULT_IMAGES_TO_PDF_OPTIONS).toEqual({
      orientation: "auto",
      pageSize: "a4",
      margin: "none",
      // Calidad de imagen recomendada y una foto por pagina (ver `imagesToPdf.quality.test.ts`).
      photosPerPage: 1,
      merge: true,
      quality: "balanced",
    });
  });
});
