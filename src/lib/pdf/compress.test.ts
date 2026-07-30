import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
  StandardFonts,
} from "@cantoo/pdf-lib";
import {
  COMPRESSION_LEVELS,
  COMPRESSION_PRESETS,
  DEFAULT_COMPRESS_OPTIONS,
  compressPdf,
  reductionPercent,
} from "@/lib/pdf/compress";

/**
 * LIMITACION DE ENTORNO (leer antes de tocar este archivo):
 *
 * Este proyecto ejecuta Vitest con `environment: "node"` (ver
 * `vitest.config.ts`) y SIN `jsdom`/`canvas` (paquete npm) instalados.
 * Dos APIs de navegador que el motor real necesita no existen aqui:
 *
 *  - pdf.js (`openPdfDocument`) exige `DOMMatrix`, asi que el modo
 *    "flatten" (rasterizado de pagina completa, el comportamiento previo
 *    ahora movido detras de un opt-in explicito) no se puede ejercitar de
 *    punta a punta en este entorno. Es la MISMA limitacion que ya
 *    bloqueaba toda esta suite antes de esta version.
 *  - `createImageBitmap` no existe en Node, asi que el modo "recompress"
 *    (el nuevo por defecto) tampoco puede DEMOSTRAR un ahorro real de
 *    bytes en una imagen JPEG: decodificar la imagen es el primer paso de
 *    `tryRecompressImage` y aqui siempre falla.
 *
 * La diferencia real frente a la version anterior de este archivo: antes
 * `compressPdf` abria SIEMPRE el documento con pdf.js como primera linea,
 * asi que NINGUNA llamada real a `compressPdf` se podia ejercitar aqui, ni
 * siquiera para comprobar sus rutas de validacion. Ahora, el modo
 * "recompress" (el nuevo por defecto) carga el documento con pdf-lib
 * (`loadPdf`, puro) y solo toca pdf.js/canvas para las imagenes JPEG que
 * SI califican para recompresion. Eso significa que un PDF vectorial/de
 * texto puro (cero imagenes) y la deteccion de "esta imagen no se debe
 * tocar" (SMask, tamano insuficiente, imagen que no se puede decodificar
 * en este runtime) SI se pueden probar de punta a punta, sin mocks: son
 * los casos (b) y (c) de la especificacion de este workstream. El caso
 * (a) ("un PDF con muchas fotos JPEG pesa menos de verdad") y el caso (d)
 * ("el modo flatten tambien respeta el limite de nunca pesar mas") siguen
 * bloqueados por las dos APIs de arriba: verificarlos de verdad exige
 * `jsdom` + el paquete `canvas` como devDependency, cambio que excede el
 * alcance de "anadir archivos de test" de esta tarea (se reporta como
 * bloqueador, no se simula con mocks que darian una falsa sensacion de
 * cobertura). La red de seguridad final ("nunca devolver algo mas
 * pesado") es la MISMA funcion (`finalizeWithSizeGuard`) para los dos
 * modos, asi que las pruebas de mas abajo si prueban esa garantia de
 * verdad, aunque sea a traves del modo "recompress".
 */

/** Documento de una pagina, listo para que cada test lo mute a su gusto. */
async function createDocument(pageSize: [number, number] = [200, 200]) {
  const pdfDocument = await PDFDocument.create();
  const page = pdfDocument.addPage(pageSize);
  return { pdfDocument, page };
}

async function toFile(
  pdfDocument: PDFDocument,
  name = "test.pdf",
): Promise<{ file: File; bytes: Uint8Array }> {
  const bytes = await pdfDocument.save({ useObjectStreams: true });
  const file = new File([bytes as unknown as BlobPart], name, {
    type: "application/pdf",
  });
  return { file, bytes };
}

/** JPEG minimo (1x1) valido, el mismo fixture que ya usa `imagesToPdf.test.ts`. */
const MINIMAL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

function minimalJpegBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(MINIMAL_JPEG_BASE64, "base64"));
}

/** Busca el primer XObject de imagen en cualquier pagina del documento. */
function findFirstImage(pdfDocument: PDFDocument): PDFStream | null {
  const xObjectKey = PDFName.of("XObject");
  const subtypeKey = PDFName.of("Subtype");
  for (const page of pdfDocument.getPages()) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const xObjects = resources.lookupMaybe(xObjectKey, PDFDict);
    if (!xObjects) continue;
    for (const [, entry] of xObjects.entries()) {
      const resolved = xObjects.context.lookup(entry);
      if (!(resolved instanceof PDFStream)) continue;
      if (resolved.dict.lookupMaybe(subtypeKey, PDFName)?.asString() === "/Image") {
        return resolved;
      }
    }
  }
  return null;
}

/** Como `findFirstImage`, pero solo la imagen que ademas tiene `/SMask`. */
function findImageWithSmask(
  pdfDocument: PDFDocument,
): { image: PDFStream; smask: PDFStream } | null {
  const xObjectKey = PDFName.of("XObject");
  const subtypeKey = PDFName.of("Subtype");
  const smaskKey = PDFName.of("SMask");
  for (const page of pdfDocument.getPages()) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const xObjects = resources.lookupMaybe(xObjectKey, PDFDict);
    if (!xObjects) continue;
    for (const [, entry] of xObjects.entries()) {
      const resolved = xObjects.context.lookup(entry);
      if (!(resolved instanceof PDFStream)) continue;
      if (resolved.dict.lookupMaybe(subtypeKey, PDFName)?.asString() !== "/Image") continue;
      const smaskEntry = resolved.dict.get(smaskKey);
      if (!smaskEntry) continue;
      const smask = xObjects.context.lookup(smaskEntry);
      if (smask instanceof PDFStream) return { image: resolved, smask };
    }
  }
  return null;
}

describe("reductionPercent — src/lib/pdf/compress.ts", () => {
  it("calcula el porcentaje de reduccion cuando el resultado pesa menos", () => {
    expect(reductionPercent(1000, 250)).toBe(75);
  });

  it("da un porcentaje negativo cuando el resultado pesa MAS que el original", () => {
    expect(reductionPercent(1000, 1500)).toBe(-50);
  });

  it("da 0 cuando el tamano no cambia", () => {
    expect(reductionPercent(1000, 1000)).toBe(0);
  });

  it("da 0 si el tamano original es 0 (evita division por cero)", () => {
    expect(reductionPercent(0, 500)).toBe(0);
  });

  it("da 0 si el tamano original es negativo o no finito", () => {
    expect(reductionPercent(-10, 5)).toBe(0);
    expect(reductionPercent(Number.NaN, 5)).toBe(0);
    expect(reductionPercent(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });

  it("redondea al entero mas cercano", () => {
    // (1000 - 667) / 1000 = 0.333 -> 33%
    expect(reductionPercent(1000, 667)).toBe(33);
  });
});

describe("COMPRESSION_PRESETS / COMPRESSION_LEVELS — src/lib/pdf/compress.ts", () => {
  it("expone exactamente los 3 niveles documentados, en orden de mas a menos agresivo", () => {
    expect(COMPRESSION_LEVELS).toEqual(["extreme", "recommended", "low"]);
  });

  it("cada nivel de COMPRESSION_LEVELS tiene un preset definido", () => {
    for (const level of COMPRESSION_LEVELS) {
      expect(COMPRESSION_PRESETS[level]).toBeDefined();
    }
  });

  it("'extreme' es estrictamente mas agresivo que 'recommended', y este que 'low' (escala, calidad y limite de imagen crecientes)", () => {
    const { extreme, recommended, low } = COMPRESSION_PRESETS;

    expect(extreme.scale).toBeLessThan(recommended.scale);
    expect(recommended.scale).toBeLessThan(low.scale);

    expect(extreme.quality).toBeLessThan(recommended.quality);
    expect(recommended.quality).toBeLessThan(low.quality);

    expect(extreme.imageMaxDimension).toBeLessThan(recommended.imageMaxDimension);
    expect(recommended.imageMaxDimension).toBeLessThan(low.imageMaxDimension);
  });

  it("la calidad JPEG de cada preset esta en el rango valido (0, 1]", () => {
    for (const level of COMPRESSION_LEVELS) {
      const { quality } = COMPRESSION_PRESETS[level];
      expect(quality).toBeGreaterThan(0);
      expect(quality).toBeLessThanOrEqual(1);
    }
  });

  it("la escala y el limite de dimension de cada preset son positivos", () => {
    for (const level of COMPRESSION_LEVELS) {
      expect(COMPRESSION_PRESETS[level].scale).toBeGreaterThan(0);
      expect(COMPRESSION_PRESETS[level].imageMaxDimension).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_COMPRESS_OPTIONS usa el nivel 'recommended' y el modo 'recompress' (recompresion in-place, NUNCA rasterizado por defecto)", () => {
    expect(DEFAULT_COMPRESS_OPTIONS).toEqual({
      level: "recommended",
      mode: "recompress",
    });
  });
});

describe("compressPdf (modo 'recompress', por defecto) — src/lib/pdf/compress.ts", () => {
  it("un PDF vectorial/de solo texto nunca pesa mas tras comprimir, y NO se rasteriza (cero XObject de imagen en la salida)", async () => {
    const { pdfDocument, page } = await createDocument([300, 300]);
    const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
    page.drawText("Documento de texto real, nada de imagenes.", {
      x: 20,
      y: 260,
      size: 12,
      font,
    });
    const { file, bytes } = await toFile(pdfDocument, "texto.pdf");

    const result = await compressPdf(file, DEFAULT_COMPRESS_OPTIONS);

    // La red de seguridad no negociable: nunca mas pesado que el original.
    expect(result.pages).toBe(1);
    expect(result.compressedSize).toBeLessThanOrEqual(result.originalSize);

    if (result.alreadyOptimized) {
      // Cuando no hay ganancia real se devuelven los bytes ORIGINALES sin
      // tocar, no una reserializacion "equivalente": verificable byte a
      // byte, no solo por tamano.
      expect(result.compressedSize).toBe(result.originalSize);
      const outputBytes = new Uint8Array(await result.blob.arrayBuffer());
      expect(outputBytes).toEqual(bytes);
    } else {
      expect(result.compressedSize).toBeLessThan(result.originalSize);
    }

    // Regresion directa del bug real: con el motor anterior, ESTE mismo
    // documento habria terminado con exactamente una imagen JPEG por
    // pagina (rasterizado incondicional). Aqui debe seguir en cero.
    const outputDocument = await PDFDocument.load(
      new Uint8Array(await result.blob.arrayBuffer()),
      { updateMetadata: false },
    );
    expect(findFirstImage(outputDocument)).toBeNull();
  });

  it("una imagen JPEG con /SMask (transparencia) se deja completamente intacta: los bytes de la imagen y los del SMask no cambian", async () => {
    const { pdfDocument, page } = await createDocument([100, 100]);
    const image = await pdfDocument.embedJpg(minimalJpegBytes());
    page.drawImage(image, { x: 0, y: 0, width: 50, height: 50 });
    // `embedJpg` solo reserva la referencia; el XObject no se registra de
    // verdad en el contexto hasta `embed()` (que `save()` llama por su
    // cuenta al final). Se fuerza aqui para poder mutar su dict antes.
    await image.embed();

    const context = pdfDocument.context;
    const imageStream = context.lookup(image.ref, PDFStream);
    const smaskStream = context.flateStream(new Uint8Array([10, 20, 30, 40]), {
      Type: "XObject",
      Subtype: "Image",
      Width: 2,
      Height: 2,
      ColorSpace: "DeviceGray",
      BitsPerComponent: 8,
    });
    imageStream.dict.set(PDFName.of("SMask"), context.register(smaskStream));

    const originalImageBytes = Uint8Array.from(imageStream.getContents());
    const originalSmaskBytes = Uint8Array.from(smaskStream.getContents());

    const { file } = await toFile(pdfDocument, "con-smask.pdf");
    const result = await compressPdf(file, DEFAULT_COMPRESS_OPTIONS);

    expect(result.compressedSize).toBeLessThanOrEqual(result.originalSize);

    const outputDocument = await PDFDocument.load(
      new Uint8Array(await result.blob.arrayBuffer()),
      { updateMetadata: false },
    );
    const found = findImageWithSmask(outputDocument);
    expect(found).not.toBeNull();
    expect(Uint8Array.from(found!.image.getContents())).toEqual(originalImageBytes);
    expect(Uint8Array.from(found!.smask.getContents())).toEqual(originalSmaskBytes);
  });

  it("una imagen JPEG que califica para recompresion pero no se puede decodificar en este entorno (Node, sin createImageBitmap) se deja intacta sin lanzar", async () => {
    const { pdfDocument, page } = await createDocument([100, 100]);
    // Bytes de sobra tras el JPEG minimo para superar el umbral de "icono
    // minusculo" (MIN_RECOMPRESSIBLE_IMAGE_BYTES): JpegEmbedder solo lee
    // la cabecera para detectar dimensiones/canales, asi que el relleno
    // final no le impide incrustar la imagen.
    const padded = new Uint8Array(
      Buffer.concat([Buffer.from(minimalJpegBytes()), Buffer.alloc(8300, 0)]),
    );
    const image = await pdfDocument.embedJpg(padded);
    page.drawImage(image, { x: 0, y: 0, width: 50, height: 50 });
    await image.embed();

    const context = pdfDocument.context;
    const imageStream = context.lookup(image.ref, PDFStream);
    const originalBytes = Uint8Array.from(imageStream.getContents());
    expect(originalBytes.byteLength).toBeGreaterThan(8192);

    const { file } = await toFile(pdfDocument, "grande.pdf");
    const result = await compressPdf(file, DEFAULT_COMPRESS_OPTIONS);

    expect(result.compressedSize).toBeLessThanOrEqual(result.originalSize);

    const outputDocument = await PDFDocument.load(
      new Uint8Array(await result.blob.arrayBuffer()),
      { updateMetadata: false },
    );
    const outputImage = findFirstImage(outputDocument);
    expect(outputImage).not.toBeNull();
    expect(Uint8Array.from(outputImage!.getContents())).toEqual(originalBytes);
  });

  it("rechaza un PDF vacio (0 bytes) como corrupto, sin tocar pdf.js/canvas", async () => {
    const file = new File([], "vacio.pdf", { type: "application/pdf" });
    await expect(compressPdf(file, DEFAULT_COMPRESS_OPTIONS)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
