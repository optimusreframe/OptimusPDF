import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import {
  DEFAULT_WATERMARK_OPTIONS,
  addWatermark,
  type WatermarkOptions,
} from "@/lib/pdf/watermark";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` directamente en el
 * test (misma convencion que `unlock.test.ts` / `protect.test.ts`).
 */
async function documentWithPages(count: number): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    document.addPage([300, 300]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "source.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/**
 * `PDFDocument.save()` anade una pagina en blanco por defecto si el
 * documento no tiene ninguna (`addDefaultPage`), asi que un documento
 * realmente sin paginas solo se puede producir desactivando esa opcion.
 */
async function emptyFile(name = "empty.pdf"): Promise<File> {
  const document = await PDFDocument.create();
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/**
 * PNG minimo valido (1x1 pixel) para probar la ruta de marca de agua con
 * imagen sin depender de un archivo externo.
 */
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "stamp.png"): File {
  const bytes = Uint8Array.from(Buffer.from(MINIMAL_PNG_BASE64, "base64"));
  return new File([bytes as unknown as BlobPart], name, { type: "image/png" });
}

/**
 * Una pagina en blanco recien creada no tiene entradas en `/Resources
 * /Font` ni `/Resources/XObject`. Si `addWatermark` dibujo algo en ella,
 * pdf-lib registra ahi la fuente o la imagen incrustada: es una forma de
 * comprobar (sin decodificar el flujo de contenido, que llega comprimido)
 * que el motor SI escribio en esa pagina en concreto.
 */
function hasResource(
  page: ReturnType<PDFDocument["getPage"]>,
  key: "Font" | "XObject",
): boolean {
  const resources = page.node.Resources();
  const dict = resources?.lookupMaybe(PDFName.of(key), PDFDict);
  return (dict?.keys().length ?? 0) > 0;
}

async function fontFlagsOf(blob: Blob): Promise<boolean[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  return result.getPages().map((page) => hasResource(page, "Font"));
}

async function xObjectFlagsOf(blob: Blob): Promise<boolean[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  return result.getPages().map((page) => hasResource(page, "XObject"));
}

describe("addWatermark — src/lib/pdf/watermark.ts", () => {
  it("marca de agua de texto en todas las paginas por defecto", async () => {
    const file = await toFile(await documentWithPages(2));
    const options: WatermarkOptions = { ...DEFAULT_WATERMARK_OPTIONS, text: "CONFIDENTIAL" };

    const blob = await addWatermark(file, options);
    expect(await fontFlagsOf(blob)).toEqual([true, true]);
  });

  it("respeta el rango fromPage/toPage: las paginas fuera de rango no se tocan", async () => {
    const file = await toFile(await documentWithPages(4));
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      text: "BORRADOR",
      fromPage: 2,
      toPage: 3,
    };

    const blob = await addWatermark(file, options);
    expect(await fontFlagsOf(blob)).toEqual([false, true, true, false]);
  });

  it("kind 'text' con texto vacio (o solo espacios) lanza PdfError('empty')", async () => {
    const file = await toFile(await documentWithPages(1));
    const options: WatermarkOptions = { ...DEFAULT_WATERMARK_OPTIONS, text: "   " };

    await expect(addWatermark(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("kind 'image' sin imagen lanza PdfError('empty')", async () => {
    const file = await toFile(await documentWithPages(1));
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      kind: "image",
      image: null,
    };

    await expect(addWatermark(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("kind 'image' con un PNG valido incrusta la imagen como XObject en la pagina", async () => {
    const file = await toFile(await documentWithPages(1));
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      kind: "image",
      image: pngFile(),
    };

    const blob = await addWatermark(file, options);
    expect(await xObjectFlagsOf(blob)).toEqual([true]);
  });

  it("kind 'image' con bytes que no son PNG ni JPG lanza PdfError('invalidType')", async () => {
    const file = await toFile(await documentWithPages(1));
    const garbage = new File(
      [Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]) as unknown as BlobPart],
      "not-an-image.bin",
      { type: "application/octet-stream" },
    );
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      kind: "image",
      image: garbage,
    };

    await expect(addWatermark(file, options)).rejects.toMatchObject({
      code: "invalidType",
    });
  });

  it("tile: true no lanza y sigue marcando todas las paginas del rango", async () => {
    const file = await toFile(await documentWithPages(1));
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      text: "MUESTRA",
      tile: true,
      fontSize: 20,
    };

    const blob = await addWatermark(file, options);
    expect(await fontFlagsOf(blob)).toEqual([true]);
  });

  it("layer 'under' no lanza y produce un PDF valido con la misma cantidad de paginas", async () => {
    const file = await toFile(await documentWithPages(2));
    const options: WatermarkOptions = {
      ...DEFAULT_WATERMARK_OPTIONS,
      text: "COPIA",
      layer: "under",
    };

    const blob = await addWatermark(file, options);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(result.getPageCount()).toBe(2);
  });

  it("un documento sin paginas lanza PdfError('corrupt')", async () => {
    const file = await emptyFile();
    const options: WatermarkOptions = { ...DEFAULT_WATERMARK_OPTIONS, text: "X" };

    await expect(addWatermark(file, options)).rejects.toMatchObject({ code: "corrupt" });
  });
});
