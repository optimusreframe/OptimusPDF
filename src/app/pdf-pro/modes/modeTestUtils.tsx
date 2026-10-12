import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from "@cantoo/pdf-lib";
import { makeFormPdf, makePlainPdf } from "@/lib/pdf/testing/formFixtures";

/**
 * Ayudas SOLO PARA PRUEBAS de los modos Firmar y Rellenar de PDF Pro (Wave 7 · U7): PDF reales, un PNG REAL (la
 * firma se incrusta con pdf-lib, que decodifica el PNG de verdad) y lectores independientes del PDF resultante.
 * La aplicacion no importa este archivo.
 */

/** PNG real (fondo transparente y un trazo negro) como data URL. */
export function realSignaturePng(width = 160, height = 60): string {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(8, Math.round(height / 2) - 3, width - 16, 6);
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

export function toFile(bytes: Uint8Array, name = "contrato.pdf", lastModified = 1_700_000_000_000): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf", lastModified });
}

/** Un contrato de `pages` hojas con texto (sin formulario). */
export async function contractFile(pages = 3, name = "contrato.pdf"): Promise<{ file: File; bytes: Uint8Array }> {
  const bytes = await makePlainPdf(pages);
  return { file: toFile(bytes, name), bytes };
}

/** Un formulario AcroForm de 5 campos (nombre, apellido, notas, casilla y desplegable). */
export async function formFile(name = "formulario.pdf"): Promise<{ file: File; bytes: Uint8Array }> {
  const bytes = await makeFormPdf({
    textFields: ["nombre", "apellido"],
    multiline: true,
    checkbox: true,
    dropdown: true,
  });
  return { file: toFile(bytes, name), bytes };
}

/** Numero de imagenes (XObject de tipo Image) que usa la pagina `index` (0-based). */
export async function pageImageCount(bytes: Uint8Array, index = 0): Promise<number> {
  const document = await PDFDocument.load(bytes);
  const page = document.getPage(index);
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return 0;
  let count = 0;
  for (const [, ref] of xobjects.entries()) {
    const object = document.context.lookup(ref);
    const dict = object instanceof PDFRawStream ? object.dict : object instanceof PDFDict ? object : null;
    if (dict?.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) count += 1;
  }
  return count;
}

export async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}
