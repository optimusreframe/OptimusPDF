/**
 * JPEG ORIGINAL de un PDF: el flujo `/DCTDecode` tal cual esta en el archivo, sin decodificar ni recomprimir (mismos
 * bytes, misma calidad, tamano minimo). Se lee con pdf-lib porque pdf.js solo entrega pixeles.
 *
 * Solo se ofrece cuando el archivo resultante se vera igual que la imagen del PDF:
 *  - un unico filtro `/DCTDecode` (si hay otro delante, p. ej. ASCII85, el flujo no es un JPEG),
 *  - sin `/SMask` ni `/Mask` (la transparencia no cabe en un JPEG),
 *  - sin `/Decode` (invierte los valores) ni `/ImageMask`,
 *  - JPEG de 1 (gris) o 3 (RGB) componentes: un CMYK/YCCK de Adobe se veria con los colores invertidos fuera del PDF,
 *  - documento SIN cifrar (con cifrado, los bytes del archivo son ilegibles hasta descifrarlos).
 * El indice se construye UNA vez por documento y solo guarda referencias a los bytes.
 */

import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef } from "@cantoo/pdf-lib";

/** Por encima de este tamano no se abre el PDF con pdf-lib (duplicaria la memoria): no se ofrece el original. */
export const MAX_JPEG_SCAN_BYTES = 120 * 1024 * 1024;

export type JpegOriginal = {
  /** Referencia de objeto en el formato de pdf.js (`12R`, `12R3`). */
  key: string;
  width: number;
  height: number;
  /** 1 = gris, 3 = RGB. */
  components: 1 | 3;
  /** Bytes del archivo JPEG (referencia, sin copiar). */
  bytes: Uint8Array;
};

export type JpegIndex = Map<string, JpegOriginal>;

/** Misma cadena que `Ref.toString()` de pdf.js: `${num}R` y, si la generacion no es 0, `${num}R${gen}`. */
export function refKey(ref: Pick<PDFRef, "objectNumber" | "generationNumber">): string {
  return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;
}

/** Medidas y numero de componentes del marcador SOF de un JPEG; `null` si no parece un JPEG valido. */
export function readJpegHeader(bytes: Uint8Array): { width: number; height: number; components: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Marcadores sin longitud.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 >= bytes.length) return null;
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8], components: bytes[i + 9] };
    }
    i += 2 + length;
  }
  return null;
}

function singleFilterIsDct(filter: unknown): boolean {
  if (filter instanceof PDFName) return filter.asString() === "/DCTDecode";
  if (filter instanceof PDFArray) return filter.size() === 1 && filter.get(0) instanceof PDFName && (filter.get(0) as PDFName).asString() === "/DCTDecode";
  return false;
}

/**
 * Indice de los JPEG originales aprovechables de un PDF. Nunca lanza: si pdf-lib no puede abrirlo (cifrado, dañado,
 * enorme) devuelve un indice vacio y el motor simplemente no ofrece `jpg-original`.
 */
export async function buildJpegIndex(pdfBytes: Uint8Array): Promise<JpegIndex> {
  const index: JpegIndex = new Map();
  if (pdfBytes.byteLength > MAX_JPEG_SCAN_BYTES) return index;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false, warnOnInvalidObjects: false });
  } catch {
    return index;
  }
  if (doc.isEncrypted) return index;
  try {
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      const dict = object.dict;
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
      if (!singleFilterIsDct(dict.get(PDFName.of("Filter")))) continue;
      if (dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask")) || dict.has(PDFName.of("Decode"))) continue;
      const imageMask = dict.get(PDFName.of("ImageMask"));
      if (imageMask instanceof PDFBool && imageMask.asBoolean()) continue;
      const bytes = object.getContents();
      const header = readJpegHeader(bytes);
      if (!header || (header.components !== 1 && header.components !== 3)) continue;
      index.set(refKey(ref), { key: refKey(ref), width: header.width, height: header.height, components: header.components, bytes });
    }
  } catch {
    // Un objeto raro no debe tirar abajo la extraccion: lo ya indexado se queda.
  }
  return index;
}
