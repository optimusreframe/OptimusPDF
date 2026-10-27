/**
 * Preparacion del documento para BUSCAR sin decodificar las fotos enormes (H11, verificacion independiente): con 3 imagenes de 40 MP el
 * arbol del navegador llegaba a ~1,9 GB porque pdf.js decodifica cada imagen entera en su worker (RGBA = 160 MB cada una) y se queda con
 * ella hasta `page.cleanup()`, y el motor recorre cada pagina tres veces. Aqui, antes de abrir el documento con pdf.js:
 *
 *  1. se leen con pdf-lib las imagenes del PDF (la misma pasada que ya hacia `buildJpegIndex` para el JPEG original);
 *  2. las GRANDES (`BIG_ANALYSIS_PX`, 12 MP: un unico `/DCTDecode`, o cualquier filtro por encima del tope de 50 MP) se sustituyen en una
 *     COPIA del documento por un punto gris de 1 x 1 pixel (`analysisBytes`): pdf.js sigue viendo la misma pagina, las mismas pinturas y la
 *     misma referencia de objeto, pero no decodifica nada;
 *  3. el motor de imagenes recupera la imagen real: miniatura y clasificacion salen de una version REDUCIDA (<= 1024 px) que decodifica
 *     el navegador directamente del JPEG original (`createImageBitmap` con `resizeWidth/resizeHeight`: no pasa de unos MB), y los pixeles
 *     completos solo se piden al descargar o guardar, de uno en uno (`renderImageAsset`, desde el JPEG original).
 *
 * Si pdf-lib no puede abrir el PDF (cifrado, danado, > 120 MB) no se toca nada: `analysisBytes` es el archivo original y se sigue como antes.
 */

import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFRef } from "@cantoo/pdf-lib";
import type { FlateSpec } from "./imagesFlate";
import { MAX_JPEG_SCAN_BYTES, indexImageObjects, refKey, type JpegIndex, type JpegOriginal } from "./imagesJpeg";

/** Una imagen de mas pixeles que esto (JPEG) no se decodifica entera para buscar: se reduce al decodificar. */
export const BIG_ANALYSIS_PX = 12_000_000;

export type BigImage = {
  /** Referencia en el formato de pdf.js (`12R`). */
  key: string;
  /** Medidas reales del diccionario de la imagen. */
  width: number;
  height: number;
  /** El flujo es un unico `/DCTDecode`: se puede reducir al decodificar. */
  jpeg: Uint8Array | null;
  /** El mismo JPEG, si ademas es descargable tal cual (`jpg-original`). */
  original: JpegOriginal | null;
  /** Imagen RGB / gris de 8 bits con un unico `/FlateDecode`: se reduce en streaming (`imagesFlate.ts`). */
  flate: FlateSpec | null;
};

export type ImagePrep = {
  jpegIndex: JpegIndex;
  big: Map<string, BigImage>;
  /** Bytes con los que se abre el documento para buscar (copia con las fotos grandes sustituidas, o el original). */
  analysisBytes: Uint8Array;
};

/** Tope de imagen del motor en pixeles (50 MP), para quien prepara sin pasar por el orquestador. */
export const MAX_IMAGE_PIXELS = 50_000_000;

const cache = new WeakMap<object, Promise<ImagePrep>>();
/** `prepareImages` guardado por archivo (la miniatura del selector y la busqueda comparten UNA lectura del PDF). */
export function prepareImagesFor(key: object, bytes: Uint8Array, maxPixels: number): Promise<ImagePrep> {
  let prep = cache.get(key);
  if (!prep) {
    prep = prepareImages(bytes, maxPixels);
    cache.set(key, prep);
  }
  return prep;
}

function numberOf(object: unknown): number {
  return object instanceof PDFNumber ? object.asNumber() : 0;
}

function singleDct(filter: unknown): boolean {
  if (filter instanceof PDFName) return filter.asString() === "/DCTDecode";
  return filter instanceof PDFArray && filter.size() === 1 && filter.get(0) instanceof PDFName && (filter.get(0) as PDFName).asString() === "/DCTDecode";
}

/** `/Image` en algun sitio del archivo (el diccionario de un XObject de imagen va siempre en claro, tambien en un PDF con flujos de objetos). */
export function mentionsImages(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x49, 0x6d, 0x61, 0x67, 0x65]; // "/Image"
  const last = bytes.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    if (bytes[i] !== 0x2f) continue;
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle[k]) k += 1;
    if (k === needle.length) return true;
  }
  return false;
}

function singleFlate(filter: unknown): boolean {
  if (filter instanceof PDFName) return filter.asString() === "/FlateDecode" || filter.asString() === "/Fl";
  return filter instanceof PDFArray && filter.size() === 1 && filter.get(0) instanceof PDFName && ["/FlateDecode", "/Fl"].includes((filter.get(0) as PDFName).asString());
}

/** Componentes de un espacio de color simple (gris / RGB de 8 bits); `null` si es indexado, CMYK, Lab... */
function componentsOf(colorSpace: unknown, lookup: (object: unknown) => unknown): 1 | 3 | null {
  if (colorSpace instanceof PDFName) {
    const name = colorSpace.asString();
    if (name === "/DeviceGray" || name === "/G" || name === "/CalGray") return 1;
    if (name === "/DeviceRGB" || name === "/RGB" || name === "/CalRGB") return 3;
    return null;
  }
  if (colorSpace instanceof PDFArray && colorSpace.size() >= 2) {
    const head = colorSpace.get(0);
    if (!(head instanceof PDFName)) return null;
    if (head.asString() === "/CalGray") return 1;
    if (head.asString() === "/CalRGB") return 3;
    if (head.asString() === "/ICCBased") {
      const profile = lookup(colorSpace.get(1));
      const n = profile instanceof PDFRawStream ? numberOf(profile.dict.lookup(PDFName.of("N"))) : 0;
      return n === 1 ? 1 : n === 3 ? 3 : null;
    }
  }
  return null;
}

/** `/Predictor` de los `/DecodeParms`: 1 (ninguno) o 10-15 (PNG); `null` si lleva otro (TIFF) o columnas/colores que no cuadran. */
function predictorOf(dict: PDFDict, width: number, comps: number): "none" | "png" | null {
  let params = dict.lookup(PDFName.of("DecodeParms"));
  if (params instanceof PDFArray) params = params.size() === 1 ? params.lookup(0) : undefined;
  if (!(params instanceof PDFDict)) return "none";
  const predictor = numberOf(params.lookup(PDFName.of("Predictor"))) || 1;
  if (predictor === 1) return "none";
  if (predictor < 10) return null;
  const columns = numberOf(params.lookup(PDFName.of("Columns"))) || 1;
  const colors = numberOf(params.lookup(PDFName.of("Colors"))) || 1;
  const bpc = numberOf(params.lookup(PDFName.of("BitsPerComponent"))) || 8;
  return columns === width && colors === comps && bpc === 8 ? "png" : null;
}

function flateSpecOf(object: PDFRawStream, dict: PDFDict, width: number, lookup: (object: unknown) => unknown): FlateSpec | null {
  if (!singleFlate(dict.lookup(PDFName.of("Filter")))) return null;
  if (dict.has(PDFName.of("Decode"))) return null;
  if (numberOf(dict.lookup(PDFName.of("BitsPerComponent"))) !== 8) return null;
  const comps = componentsOf(dict.lookup(PDFName.of("ColorSpace")), lookup);
  if (!comps) return null;
  const predictor = predictorOf(dict, width, comps);
  if (!predictor) return null;
  return { bytes: object.getContents(), comps, png: predictor === "png" };
}

function stubStream(doc: PDFDocument): PDFRawStream {
  const dict = doc.context.obj({ Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8, Length: 1 }) as PDFDict;
  return PDFRawStream.of(dict, new Uint8Array([0x80]));
}

/**
 * Indice de JPEG originales, imagenes grandes y bytes de analisis, con UNA lectura del PDF. Nunca lanza. `maxPixels` es el tope de
 * imagen del motor (50 MP): por encima de el tampoco se decodifica nada.
 */
export async function prepareImages(pdfBytes: Uint8Array, maxPixels: number, options: { keep?: string } = {}): Promise<ImagePrep> {
  const fallback: ImagePrep = { jpegIndex: new Map(), big: new Map(), analysisBytes: pdfBytes };
  if (pdfBytes.byteLength > MAX_JPEG_SCAN_BYTES || !mentionsImages(pdfBytes)) return fallback;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false, warnOnInvalidObjects: false });
  } catch {
    return fallback;
  }
  if (doc.isEncrypted) return fallback;
  const jpegIndex = indexImageObjects(doc);
  const big = new Map<string, BigImage>();
  const refs: PDFRef[] = [];
  try {
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      const dict = object.dict;
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
      const imageMask = dict.get(PDFName.of("ImageMask"));
      if (imageMask instanceof PDFBool && imageMask.asBoolean()) continue;
      const width = numberOf(dict.lookup(PDFName.of("Width")));
      const height = numberOf(dict.lookup(PDFName.of("Height")));
      const pixels = width * height;
      if (!(pixels > BIG_ANALYSIS_PX)) continue;
      // Con /SMask o /Mask la transparencia solo la compone pdf.js: no se reduce a mano (se decodifica como siempre, salvo por encima del tope).
      const masked = dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask"));
      const dct = !masked && singleDct(dict.lookup(PDFName.of("Filter")));
      const flate = dct || masked ? null : flateSpecOf(object, dict, width, (value) => doc.context.lookup(value as never));
      // Solo lo que el motor sabe reducir (un JPEG, o un RGB/gris de 8 bits con Flate) o que esta por encima del tope (se omite).
      if (!dct && !flate && pixels <= maxPixels) continue;
      const key = refKey(ref);
      big.set(key, { key, width, height, jpeg: dct ? object.getContents() : null, original: jpegIndex.get(key) ?? null, flate });
      if (key !== options.keep) refs.push(ref);
    }
  } catch {
    return { jpegIndex, big: new Map(), analysisBytes: pdfBytes };
  }
  if (big.size === 0) return { jpegIndex, big, analysisBytes: pdfBytes };
  try {
    for (const ref of refs) doc.context.assign(ref, stubStream(doc));
    const analysisBytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    return { jpegIndex, big, analysisBytes };
  } catch {
    // No se pudo guardar la copia: se sigue con el original (mas memoria, mismo resultado).
    return { jpegIndex, big: new Map(), analysisBytes: pdfBytes };
  }
}
