import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "@cantoo/pdf-lib";
import type { PDFObject } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  loadPdf,
  openPdfDocument,
  readFileBytes,
  renderPageToCanvas,
  savePdfToBlob,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/canvasBlob";

/**
 * Motor de compresion.
 *
 * Dos estrategias, una por defecto y una de activacion explicita, con la
 * MISMA red de seguridad final en ambas: el tamano de salida se compara
 * siempre contra el original, y si no pesa menos se devuelven los bytes
 * ORIGINALES sin tocar (`alreadyOptimized: true`). Esto es lo que
 * elimina de raiz el bug real que motivo esta version: un PDF de texto
 * puro que acababa pesando un 174%-540% MAS que el original porque la
 * unica estrategia disponible era rasterizar cada pagina si o si.
 *
 * MODO POR DEFECTO ("recompress"): el documento se carga con pdf-lib
 * (`loadPdf`, como ya hace `redact.ts`) y se conserva intacto: texto,
 * vectores, formularios, enlaces y marcadores sobreviven. Solo se toca lo
 * que de verdad pesa en un PDF con fotos: las imagenes JPEG (`DCTDecode`)
 * incrustadas como `/XObject` en cada pagina (`page.node.Resources()` ->
 * `/XObject`, el mismo recorrido de bajo nivel del grafo de objetos que
 * `unlock.ts` ya usa para el arbol de AcroForm). Cada imagen candidata se
 * decodifica (`createImageBitmap`), se reduce de tamano si excede el
 * limite del nivel elegido, se recodifica como JPEG con la calidad de ese
 * nivel (`canvasToBlob`, el mismo helper de `imagesToPdf.ts`) y sustituye
 * el stream original (`PDFRawStream.updateContents`) UNICAMENTE si el
 * resultado pesa menos bytes; si no, esa imagen concreta se deja tal
 * cual. No hay poda de objetos no referenciados: esta bifurcacion de
 * pdf-lib no expone una API de recoleccion basada en alcanzabilidad, y
 * construir una es un proyecto aparte con riesgo real de corromper
 * grupos de contenido opcional o arboles de estructura.
 *
 * Alcance v1, deliberadamente estrecho: solo imagenes con un UNICO filtro
 * `/DCTDecode` (JPEG). Se deja la imagen intacta -sin ni siquiera
 * intentar decodificarla- si tiene `/SMask` o `/Mask` (recodificar a JPEG
 * tira la transparencia sin avisar, un bug de correccion, no solo una
 * compresion perdida), si es un `/ImageMask`, si el `/Filter` no es
 * exactamente el nombre `/DCTDecode` (esto ya excluye por construccion
 * `/JPXDecode`, `/CCITTFaxDecode`, `/JBIG2Decode` y cualquier cadena de
 * varios filtros: el navegador no tiene decodificador para los tres
 * primeros, y una cadena como `[/ASCII85Decode /DCTDecode]` queda fuera
 * de alcance), y si el `/ColorSpace` no es exactamente el nombre
 * `/DeviceGray` o `/DeviceRGB`. Esa ultima comprobacion es intencionadamente
 * mas estricta que "solo Indexed/Separation": CUALQUIER `/ColorSpace` que
 * no sea uno de esos dos nombres directos -un array (`Indexed`,
 * `Separation`, `DeviceN`, `ICCBased`, `Lab`...) o un nombre indirecto que
 * remite al diccionario de recursos de la pagina- se descarta sin
 * intentar resolverlo. Esto cierra ademas un riesgo real que la lista de
 * exclusiones original no nombraba: un JPEG con `/ColorSpace /DeviceCMYK`
 * (4 componentes, habitual en flujos de impresion de Adobe) decodificado
 * con `createImageBitmap` se reinterpretaria como RGB y saldria con los
 * colores rotos; con esta comprobacion esa imagen tambien se deja
 * intacta. El precio de esta cautela: un JPEG con perfil ICC de sRGB
 * (`/ColorSpace [/ICCBased ...]`, nada raro en fotos reales) tampoco se
 * recomprime en v1 aunque sea inofensivo, porque distinguirlo con
 * seguridad exigiria leer el `/N` del stream del perfil ICC, algo que se
 * deja fuera para no ampliar el alcance de esta version.
 *
 * MODO EXPLICITO ("flatten"): el comportamiento previo intacto -rasterizar
 * cada pagina completa con pdf.js y remontarla como imagen JPEG-, ahora
 * solo accesible si el usuario lo activa a proposito (pensado para
 * documentos escaneados, donde no hay texto ni vectores reales que
 * conservar). Sigue pasando por la misma red de seguridad de tamano.
 *
 * El render de "flatten" usa SIEMPRE `intent: "print"`: con `"display"`
 * pdf.js encadena los pasos con `requestAnimationFrame` y el proceso se
 * congela si la pestana deja de pintar.
 */

export const COMPRESSION_LEVELS = ["extreme", "recommended", "low"] as const;
export type CompressionLevel = (typeof COMPRESSION_LEVELS)[number];

export type CompressionPreset = {
  /** Multiplicador de resolucion sobre el tamano de pagina (1 ~ 72 DPI). Solo se usa en modo "flatten". */
  scale: number;
  /** Calidad JPEG 0..1. Se usa tanto en "flatten" como al recodificar imagenes en modo "recompress". */
  quality: number;
  /** Lado maximo (px) para una imagen JPEG recomprimida in-place antes de reducirla. Solo modo "recompress". */
  imageMaxDimension: number;
};

export const COMPRESSION_PRESETS: Record<CompressionLevel, CompressionPreset> = {
  extreme: { scale: 1, quality: 0.5, imageMaxDimension: 1600 },
  recommended: { scale: 1.5, quality: 0.75, imageMaxDimension: 2000 },
  low: { scale: 2, quality: 0.9, imageMaxDimension: 2600 },
};

/**
 * "recompress" (por defecto): recomprime en el sitio solo las imagenes
 * JPEG que califican, preservando texto/vectores/formularios.
 * "flatten": modo explicito de "aplanar documento escaneado", el
 * comportamiento antiguo de rasterizar cada pagina completa.
 */
export const COMPRESSION_MODES = ["recompress", "flatten"] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];

export type CompressOptions = {
  level: CompressionLevel;
  mode: CompressionMode;
};

export const DEFAULT_COMPRESS_OPTIONS: CompressOptions = {
  level: "recommended",
  mode: "recompress",
};

export type CompressResult = {
  blob: Blob;
  /** Peso del archivo de entrada, en bytes. */
  originalSize: number;
  /** Peso del archivo generado, en bytes. Igual a `originalSize` si `alreadyOptimized`. */
  compressedSize: number;
  pages: number;
  /**
   * `true` cuando el resultado no pesaba menos que el original: se
   * devolvieron los bytes de entrada sin ningun cambio. La interfaz debe
   * mostrar "ya estaba optimizado", nunca un porcentaje de ahorro falso.
   */
  alreadyOptimized: boolean;
};

/**
 * Lado maximo del canvas por pagina en modo "flatten". Los navegadores
 * limitan el area de un canvas (Safari iOS es el mas estricto) y una
 * pagina A0 a 2x se saldria del limite: se recorta la escala antes de
 * rasterizar.
 */
const MAX_RASTER_SIDE = 4000;

/**
 * Bajo este peso una imagen no se toca: recodificar un icono minusculo
 * apenas ahorra bytes y el riesgo de artefactos JPEG relativo a su tamano
 * es mayor que la ganancia.
 */
const MIN_RECOMPRESSIBLE_IMAGE_BYTES = 8 * 1024;

function presetFor(level: CompressionLevel): CompressionPreset {
  return COMPRESSION_PRESETS[level] ?? COMPRESSION_PRESETS.recommended;
}

/** Porcentaje de reduccion (negativo si el resultado pesa mas). */
export function reductionPercent(original: number, compressed: number): number {
  if (!Number.isFinite(original) || original <= 0) return 0;
  return Math.round(((original - compressed) / original) * 100);
}

/* ------------------------------------------------------------------ *
 * Modo "recompress": recorrido del grafo de objetos + recompresion in-place
 * ------------------------------------------------------------------ */

const XOBJECT_KEY = PDFName.of("XObject");
const SUBTYPE_KEY = PDFName.of("Subtype");
const FILTER_KEY = PDFName.of("Filter");
const SMASK_KEY = PDFName.of("SMask");
const MASK_KEY = PDFName.of("Mask");
const IMAGE_MASK_KEY = PDFName.of("ImageMask");
const COLOR_SPACE_KEY = PDFName.of("ColorSpace");
const WIDTH_KEY = PDFName.of("Width");
const HEIGHT_KEY = PDFName.of("Height");

/** `PDFName.asString()` devuelve el nombre con su barra: "/Image". */
const IMAGE_SUBTYPE = "/Image";
const DCT_DECODE_FILTER = "/DCTDecode";
// Solo /DeviceRGB: el canvas del navegador siempre decodifica a RGBA y su
// encoder de JPEG no garantiza emitir un JPEG de un solo componente para
// contenido que empezo en escala de grises -- si emitiera 3 componentes,
// el /ColorSpace original (/DeviceGray) quedaria inconsistente con el
// flujo re-escrito. /DeviceGray se deja fuera del alcance por eso mismo
// (no es una imagen insegura, solo una que no podemos re-etiquetar bien).
const SAFE_COLOR_SPACES = new Set(["/DeviceRGB"]);

/**
 * Decide si un XObject califica para recompresion in-place. Cualquier
 * excepcion durante la inspeccion (referencia rota, tipo inesperado,
 * `/ColorSpace`/`/Filter` con forma no soportada) se trata como "no se
 * puede confirmar que sea seguro" y por tanto como "no califica": el
 * unico efecto de un `false` aqui es dejar esa imagen intacta, nunca
 * tocarla a ciegas.
 */
function isRecompressibleJpegImage(object: PDFObject): object is PDFRawStream {
  if (!(object instanceof PDFRawStream)) return false;

  try {
    const dict = object.dict;

    if (dict.lookupMaybe(SUBTYPE_KEY, PDFName)?.asString() !== IMAGE_SUBTYPE) {
      return false;
    }

    // Alpha: recodificar a JPEG no puede conservar transparencia. Se deja
    // intacta cualquier imagen con SMask o Mask, sea cual sea su forma.
    if (dict.has(SMASK_KEY) || dict.has(MASK_KEY)) return false;

    // Mascara de bits (1 bpc, sin color propio), no una foto: fuera de alcance.
    if (dict.lookupMaybe(IMAGE_MASK_KEY, PDFBool)?.asBoolean() === true) {
      return false;
    }

    // Un unico filtro `/DCTDecode`. Cualquier otro nombre, un array (cadena
    // de filtros) o ausencia total del `/Filter` no encaja aqui y lanza o
    // no cumple el `===`, así que cae directo a "no califica".
    if (dict.lookupMaybe(FILTER_KEY, PDFName)?.asString() !== DCT_DECODE_FILTER) {
      return false;
    }

    // Colorspace: SOLO los dos nombres directos mas simples. Un array
    // (Indexed/Separation/DeviceN/ICCBased/Lab/CalRGB-array...) o un
    // nombre indirecto que remite al diccionario de recursos de la
    // pagina (p. ej. "/CS0") no calzan con ninguno de los dos strings
    // exactos de abajo, asi que tambien caen a "no califica" sin
    // necesidad de resolverlos.
    const colorSpace = dict.lookupMaybe(COLOR_SPACE_KEY, PDFName)?.asString();
    if (!colorSpace || !SAFE_COLOR_SPACES.has(colorSpace)) return false;

    if (object.contents.byteLength < MIN_RECOMPRESSIBLE_IMAGE_BYTES) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Recorre todas las paginas y devuelve, sin duplicados, los streams de
 * imagen que califican para recompresion. Una misma imagen compartida
 * entre varias paginas (mismo objeto indirecto) se procesa una sola vez.
 */
function collectRecompressibleImages(pdfDocument: PDFDocument): PDFRawStream[] {
  const seen = new Set<PDFObject>();
  const candidates: PDFRawStream[] = [];

  for (const page of pdfDocument.getPages()) {
    let resources: PDFDict | undefined;
    try {
      resources = page.node.Resources();
    } catch {
      continue;
    }
    if (!resources) continue;

    let xObjects: PDFDict | undefined;
    try {
      xObjects = resources.lookupMaybe(XOBJECT_KEY, PDFDict);
    } catch {
      continue;
    }
    if (!xObjects) continue;

    for (const [, entry] of xObjects.entries()) {
      let resolved: PDFObject | undefined;
      try {
        resolved = xObjects.context.lookup(entry);
      } catch {
        continue;
      }
      if (!resolved || seen.has(resolved)) continue;
      if (isRecompressibleJpegImage(resolved)) {
        seen.add(resolved);
        candidates.push(resolved);
      }
    }
  }

  return candidates;
}

/**
 * Decodifica, reduce si hace falta y recodifica una imagen JPEG. Sustituye
 * el stream SOLO si el resultado pesa menos que el original; en cualquier
 * otro caso (fallo de decodificacion, recodificado igual o mas pesado)
 * la imagen se deja exactamente como estaba.
 */
async function tryRecompressImage(
  stream: PDFRawStream,
  preset: CompressionPreset,
): Promise<void> {
  const original = stream.contents;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([original as BlobPart], { type: "image/jpeg" }),
    );
  } catch {
    // JPEG que el decodificador del navegador no admite (progresivo no
    // soportado, cabecera exotica...): se deja intacto.
    return;
  }

  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const longest = Math.max(sourceWidth, sourceHeight, 1);
  const scale = Math.min(1, preset.imageMaxDimension / longest);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  const reencoded = await canvasToBlob(canvas, "image/jpeg", preset.quality);
  canvas.width = 0;
  canvas.height = 0;
  const reencodedBytes = await readFileBytes(reencoded);

  if (reencodedBytes.byteLength >= original.byteLength) {
    // Recomprimir no ayudo en esta imagen concreta: se deja intacta.
    return;
  }

  stream.updateContents(reencodedBytes);
  if (targetWidth !== sourceWidth || targetHeight !== sourceHeight) {
    stream.dict.set(WIDTH_KEY, PDFNumber.of(targetWidth));
    stream.dict.set(HEIGHT_KEY, PDFNumber.of(targetHeight));
  }
}

async function recompressPdf(
  file: File,
  originalBytes: Uint8Array,
  preset: CompressionPreset,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<CompressResult> {
  const pdfDocument = await loadPdf(originalBytes);
  const pages = pdfDocument.getPageCount();
  if (pages === 0) throw new PdfError("corrupt");

  const candidates = collectRecompressibleImages(pdfDocument);
  const total = candidates.length;

  for (let index = 0; index < total; index += 1) {
    throwIfAborted(signal);
    await tryRecompressImage(candidates[index], preset);
    onProgress?.(((index + 1) / total) * 0.92);
  }
  if (total === 0) onProgress?.(0.92);

  const result = await finalizeWithSizeGuard(pdfDocument, originalBytes, file, pages);
  onProgress?.(1);
  return result;
}

/* ------------------------------------------------------------------ *
 * Modo "flatten": rasterizado de pagina completa (comportamiento previo)
 * ------------------------------------------------------------------ */

async function flattenPdf(
  file: File,
  originalBytes: Uint8Array,
  preset: CompressionPreset,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<CompressResult> {
  let source: PDFDocumentProxy | null = null;
  try {
    source = await openPdfDocument(originalBytes);
    const total = source.numPages;
    if (total === 0) throw new PdfError("corrupt");

    const output = await PDFDocument.create();

    for (let index = 0; index < total; index += 1) {
      throwIfAborted(signal);
      const page = await source.getPage(index + 1);
      // Viewport a escala 1: ancho y alto en puntos PDF, con la
      // rotacion de la pagina ya aplicada.
      const base = page.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height, 1);
      const scale = Math.max(
        0.1,
        Math.min(preset.scale, MAX_RASTER_SIDE / longest),
      );

      const canvas = await renderPageToCanvas(page, {
        scale,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });
      const jpeg = await canvasToBlob(canvas, "image/jpeg", preset.quality);
      // Libera la memoria del canvas antes de la siguiente pagina.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      const image = await output.embedJpg(await readFileBytes(jpeg));
      const target = output.addPage([base.width, base.height]);
      target.drawImage(image, {
        x: 0,
        y: 0,
        width: base.width,
        height: base.height,
      });

      onProgress?.(((index + 1) / total) * 0.92);
    }

    const result = await finalizeWithSizeGuard(output, originalBytes, file, total);
    onProgress?.(1);
    return result;
  } finally {
    if (source) await closePdfDocument(source);
  }
}

/* ------------------------------------------------------------------ *
 * Red de seguridad compartida: nunca devolver un resultado mas pesado
 * ------------------------------------------------------------------ */

async function finalizeWithSizeGuard(
  pdfDocument: PDFDocument,
  originalBytes: Uint8Array,
  originalFile: File,
  pages: number,
): Promise<CompressResult> {
  const blob = await savePdfToBlob(pdfDocument);
  const originalSize = originalBytes.byteLength;

  if (blob.size >= originalSize) {
    return {
      blob: originalFile,
      originalSize,
      compressedSize: originalSize,
      pages,
      alreadyOptimized: true,
    };
  }

  return {
    blob,
    originalSize,
    compressedSize: blob.size,
    pages,
    alreadyOptimized: false,
  };
}

/* ------------------------------------------------------------------ *
 * API publica
 * ------------------------------------------------------------------ */

export async function compressPdf(
  file: File,
  options: CompressOptions = DEFAULT_COMPRESS_OPTIONS,
  onProgress?: ProgressCallback,
  /**
   * Cancelacion real: recomprimir imagenes o rasterizar paginas cuesta lo
   * suyo, asi que se comprueba antes de empezar cada unidad de trabajo
   * en vez de dejar que el trabajo siga consumiendo CPU despues de
   * cancelar.
   */
  signal?: AbortSignal,
): Promise<CompressResult> {
  const preset = presetFor(options.level);

  try {
    const originalBytes = await readFileBytes(file);
    if (originalBytes.byteLength === 0) throw new PdfError("corrupt");

    if (options.mode === "flatten") {
      return await flattenPdf(file, originalBytes, preset, onProgress, signal);
    }
    return await recompressPdf(file, originalBytes, preset, onProgress, signal);
  } catch (error) {
    throw toPdfError(error);
  }
}
