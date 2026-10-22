import { readJpegOrientation, type ExifOrientation } from "@/lib/pdf/jpegOrientation";
import { readImageSize, sniffImageFormat } from "@/lib/image/inkDecode";

/**
 * Preparacion de fotos para meterlas en un PDF («Imagenes a PDF», «Escanear a PDF», PDF Pro...).
 *
 * Problema que resuelve: las fotos del movil pesan 3-15 MB y el PDF las incrustaba TAL CUAL (un JPEG pasa sin tocar; un
 * PNG/WebP se reconvertia a PNG, aun mas pesado): 39 fotos daban un PDF de 335 MB, inviable por WhatsApp o correo. Aqui se
 * decide, foto a foto, si vale la pena reducirla y como, SIN ampliar nunca y SIN tocar el archivo original del usuario
 * (este modulo solo lee bytes y devuelve bytes nuevos o los mismos).
 *
 * Todo lo que no depende del navegador es PURO y se prueba en Node:
 *   - `readImageHeader`  formato, dimensiones, orientacion EXIF y posible transparencia, leidos de la CABECERA.
 *   - `planPreparation`  la POLITICA: conservar tal cual o transcodificar (a que tamano, a que formato).
 *   - `scanRaster`       foto o grafico, transparencia real o trivial, mirando pixeles por bandas.
 *   - `chooseOutcome`    la regla «solo si ahorra >= 15 %».
 *   - `estimatePreparedBytes` estimacion barata del tamano final a partir de cabeceras.
 * Lo que toca pixeles (decodificar, reducir, codificar) va detras de `PrepareBackend`: el navegador lo implementa en
 * `prepareBrowser.ts` (con Web Worker + OffscreenCanvas cuando existen) y las pruebas con `@napi-rs/canvas`.
 *
 * Presets:
 *   original    bytes intactos (un JPEG/PNG pasa sin cambios; el resto se reconvierte a PNG como siempre, con los topes
 *               de lienzo de iOS para que no salga en blanco).
 *   high        lado largo <= 4096 px, JPEG calidad 0,92.
 *   balanced    lado largo <= 3000 px, JPEG calidad 0,87 (recomendada).
 *   compact     lado largo <= 2200 px, JPEG calidad 0,80 (correo / WhatsApp).
 *
 * Color: el lienzo del navegador trabaja en sRGB. Una foto Display P3 del iPhone se CONVIERTE a sRGB al reducirla (los
 * colores fuera de sRGB se recortan; a ojo es casi imperceptible) y el JPEG nuevo lleva sRGB sin perfil. En `original` no
 * cambia nada: el JPEG viaja con sus bytes (y su perfil, que los visores de PDF suelen ignorar).
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Presets                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export const IMAGE_PRESET_IDS = ["original", "high", "balanced", "compact"] as const;
export type ImagePresetId = (typeof IMAGE_PRESET_IDS)[number];

/** El recomendado: se ve igual a ojo y pesa mucho menos. */
export const DEFAULT_IMAGE_PRESET: ImagePresetId = "balanced";

export type ImagePreset = {
  readonly id: ImagePresetId;
  /** Lado largo maximo en pixeles (`null` = no se reduce, salvo por los topes de lienzo). */
  readonly maxSide: number | null;
  /** Calidad JPEG 0..1 del reencodado (`1` en `original`: no se usa). */
  readonly quality: number;
  /**
   * Bytes por pixel de una foto reencodada a esta calidad cuando el origen NO es un JPEG (PNG/WebP/HEIC de foto): solo se
   * usa para estimar el tamano (medido con fotos sinteticas y con fotos de referencia: es una mediana, hay mucha variacion).
   */
  readonly targetBytesPerPixel: number;
  /**
   * Un JPEG que ya cabe en el tope y pesa MENOS bytes por pixel que esto pasa intacto sin decodificarlo: ni la foto mas
   * lisa baja del 85 % de esto al reencodarla a esta calidad, asi que no ahorraria el 15 %.
   */
  readonly keepBytesPerPixel: number;
  /**
   * Peso del JPEG reencodado respecto al del JPEG de origen cuando NO se reduce el tamano (medido con fotos de referencia:
   * ~0,75 a calidad 0,92; ~0,60 a 0,87; ~0,45 a 0,80). Si se reduce, el peso baja ademas con (pixeles nuevos / viejos)^0,75.
   */
  readonly sizeRatio: number;
  /**
   * Puntos por pulgada a los que se quiere ver la foto cuando va en una celda pequena (varias fotos por hoja): los
   * pixeles de una foto se acotan a lo que su celda necesita a esta densidad. `0` = no se acota por celda.
   */
  readonly cellPpi: number;
};

export const IMAGE_PRESETS: Readonly<Record<ImagePresetId, ImagePreset>> = {
  original: { id: "original", maxSide: null, quality: 1, targetBytesPerPixel: 0, keepBytesPerPixel: 0, sizeRatio: 1, cellPpi: 0 },
  high: { id: "high", maxSide: 4096, quality: 0.92, targetBytesPerPixel: 0.36, keepBytesPerPixel: 0.17, sizeRatio: 0.75, cellPpi: 300 },
  balanced: { id: "balanced", maxSide: 3000, quality: 0.87, targetBytesPerPixel: 0.28, keepBytesPerPixel: 0.14, sizeRatio: 0.6, cellPpi: 250 },
  compact: { id: "compact", maxSide: 2200, quality: 0.8, targetBytesPerPixel: 0.23, keepBytesPerPixel: 0.11, sizeRatio: 0.45, cellPpi: 200 },
};

/** Lado largo minimo al que se acota una foto por su celda (por debajo, una miniatura se veria borrosa al ampliar). */
export const MIN_FIT_SIDE = 640;

/** Una foto reducida a su celda (varias por hoja) sube la calidad JPEG en este margen: ver `withFitMaxSide`. */
export const CELL_QUALITY_BOOST = 0.07;
/** La calidad JPEG nunca pasa de aqui con el refuerzo por celda. */
export const CELL_QUALITY_MAX = 0.95;

/**
 * El preset con el lado largo acotado ademas por `fitMaxSide` (lo que pide la celda de la foto en una hoja con varias
 * fotos). NUNCA sube el tope del preset y `original` no se acota: no toca ningun byte. Cuando la celda SI reduce la foto
 * por debajo del tope, la calidad JPEG sube `CELL_QUALITY_BOOST` (hasta `CELL_QUALITY_MAX`): una foto de 2500 px reducida a
 * 1000 px concentra mas detalle por pixel y a la misma calidad pierde mas (medido con fotos de referencia: SSIM minimo
 * 0,914 -> 0,974 con 10 fotos por hoja), y como la foto ya es pequena el peso extra es de ~+35 % de unos pocos cientos de KB.
 */
export function withFitMaxSide(preset: ImagePreset, fitMaxSide: number | undefined): ImagePreset {
  if (preset.id === "original" || fitMaxSide === undefined || preset.maxSide === null) return preset;
  const side = Math.min(preset.maxSide, Math.max(MIN_FIT_SIDE, Math.round(fitMaxSide)));
  if (side === preset.maxSide) return preset;
  return {
    ...preset,
    maxSide: side,
    quality: Math.min(CELL_QUALITY_MAX, preset.quality + CELL_QUALITY_BOOST),
    sizeRatio: preset.sizeRatio * 1.35,
  };
}

export function isImagePresetId(value: unknown): value is ImagePresetId {
  return typeof value === "string" && (IMAGE_PRESET_IDS as readonly string[]).includes(value);
}

/** Solo se sustituye la imagen si el resultado pesa al menos un 15 % menos que el original. */
export const MIN_SAVING = 0.15;

/**
 * Topes de lienzo seguros para iOS/Safari: un canvas de mas de ~16,7 Mpx o de mas de 4096 px de lado puede salir EN BLANCO
 * (sin error). Ningun lienzo de este modulo los supera, tampoco con `original`.
 */
export const CANVAS_SAFE_MAX_SIDE = 4096;
export const CANVAS_SAFE_MAX_PIXELS = 16_000_000;

/** Un PNG que ya cabe y pesa menos de esto es un icono/logo/captura pequena: pasa intacto sin decodificarlo. */
export const SMALL_PNG_BYTES = 256 * 1024;
/** Un PNG que ya cabe y pesa menos bytes/pixel que esto es un grafico (las fotos en PNG pasan de ~1,2 B/px). */
export const GRAPHIC_PNG_BYTES_PER_PIXEL = 0.8;
/** Colores distintos (muestreados) por debajo de los cuales una imagen es un grafico/captura y no una foto. */
export const GRAPHIC_COLOR_LIMIT = 4096;
/** Fraccion de pixeles no opacos a partir de la cual la transparencia es REAL (hay que conservarla en PNG). */
export const REAL_ALPHA_FRACTION = 0.001;

/* ------------------------------------------------------------------------------------------------------------ */
/* Cabecera                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

export type ImageKind = "jpeg" | "png" | "webp" | "heic" | "avif" | "gif" | "bmp" | "unknown";

export type ImageHeader = {
  readonly kind: ImageKind;
  /** Dimensiones GUARDADAS (sin aplicar la orientacion), o `null` si no se pudieron leer de la cabecera. */
  readonly width: number | null;
  readonly height: number | null;
  /** Dimensiones tal como se VE la imagen (con la orientacion EXIF aplicada). */
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  /** Orientacion EXIF de un JPEG (1 para los demas formatos: el navegador la aplica al decodificar). */
  readonly orientation: ExifOrientation;
  /** `false` solo si la cabecera garantiza que no hay canal alfa (JPEG, PNG sin alfa ni tRNS). */
  readonly mayHaveAlpha: boolean;
};

const ASCII = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let index = start; index < end && index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
};

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function detectKind(bytes: Uint8Array): ImageKind {
  const sniffed = sniffImageFormat(bytes);
  if (sniffed === "jpeg" || sniffed === "png" || sniffed === "webp" || sniffed === "heic") return sniffed;
  if (bytes.length >= 12 && ASCII(bytes, 4, 8) === "ftyp") {
    const brand = ASCII(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "avif";
  }
  if (bytes.length >= 6 && ASCII(bytes, 0, 3) === "GIF") return "gif";
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return "unknown";
}

/** PNG: tipo de color (4 y 6 llevan alfa) y chunk `tRNS` (transparencia de paleta / color clave). */
function pngMayHaveAlpha(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return true;
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  // `tRNS` va antes de `IDAT`: se recorren los chunks hasta el primer IDAT.
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32(bytes, offset);
    const type = ASCII(bytes, offset + 4, offset + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}

/** AVIF/HEIC: el giro `irot` (cuartos de vuelta) cambia ancho por alto; `ispe` da las dimensiones SIN girar. */
function heifQuarterTurns(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length - 9, 512 * 1024);
  for (let index = 4; index < limit; index += 1) {
    if (bytes[index] === 0x69 && bytes[index + 1] === 0x72 && bytes[index + 2] === 0x6f && bytes[index + 3] === 0x74) {
      return bytes[index + 4] & 3;
    }
  }
  return 0;
}

/**
 * Lee de los PRIMEROS bytes de un archivo (basta un trozo de unos cientos de KB para estimar; para decidir se pasa el
 * archivo entero) lo que se sabe de la imagen sin decodificarla. Nunca lanza: lo ilegible es `null`/`unknown`.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const kind = detectKind(bytes);
  let size: { width: number; height: number } | null = null;
  try {
    if (kind === "jpeg" || kind === "png" || kind === "webp") size = readImageSize(bytes, kind);
    else if (kind === "heic" || kind === "avif") size = readImageSize(bytes, "heic");
    else if (kind === "gif" && bytes.length >= 10) size = { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
    else if (kind === "bmp" && bytes.length >= 26) {
      const le32 = (at: number): number => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) | 0;
      size = { width: Math.abs(le32(18)), height: Math.abs(le32(22)) };
    }
  } catch {
    size = null;
  }
  if (size && !(size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height))) size = null;

  const orientation: ExifOrientation = kind === "jpeg" ? readJpegOrientation(bytes) : 1;
  let swap = orientation >= 5;
  if ((kind === "heic" || kind === "avif") && heifQuarterTurns(bytes) % 2 === 1) swap = true;
  const display = size ? (swap ? { width: size.height, height: size.width } : size) : null;
  const mayHaveAlpha = kind === "jpeg" ? false : kind === "png" ? pngMayHaveAlpha(bytes) : true;
  return {
    kind,
    width: size?.width ?? null,
    height: size?.height ?? null,
    displayWidth: display?.width ?? null,
    displayHeight: display?.height ?? null,
    orientation,
    mayHaveAlpha,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Geometria                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** Tamano final que cabe en el tope de lado y de area. NUNCA amplia. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number | null,
  maxPixels: number = CANVAS_SAFE_MAX_PIXELS,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let scale = 1;
  if (maxSide !== null) scale = Math.min(scale, maxSide / Math.max(w, h));
  scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));
  if (!(scale < 1)) return { width: w, height: h, scale: 1 };
  const limit = maxSide ?? Number.POSITIVE_INFINITY;
  return {
    width: Math.min(limit, Math.max(1, Math.round(w * scale))),
    height: Math.min(limit, Math.max(1, Math.round(h * scale))),
    scale,
  };
}

/**
 * Lienzos intermedios para reducir una imagen muy grande SIN pasar de golpe (un `drawImage` de 8000 px a 3000 px de una
 * vez alisa mal en algunos motores): cada paso reduce como mucho a la mitad y NINGUN lienzo supera los topes de iOS. El
 * primero ya respeta `CANVAS_SAFE_MAX_SIDE`/`CANVAS_SAFE_MAX_PIXELS` aunque la imagen sea de 100 Mpx.
 */
export function planDownscaleSteps(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  maxSide: number = CANVAS_SAFE_MAX_SIDE,
  maxPixels: number = CANVAS_SAFE_MAX_PIXELS,
): Array<{ width: number; height: number }> {
  const steps: Array<{ width: number; height: number }> = [];
  let w = sourceWidth;
  let h = sourceHeight;
  // Primer lienzo: lo mas grande que cabe en los topes sin pasarse del objetivo.
  const first = fitWithin(w, h, maxSide, maxPixels);
  if (first.scale < 1) {
    w = Math.max(first.width, targetWidth);
    h = Math.max(first.height, targetHeight);
    steps.push({ width: w, height: h });
  }
  let guard = 0;
  while ((w > targetWidth || h > targetHeight) && guard < 32) {
    guard += 1;
    const nextW = Math.max(targetWidth, Math.round(w / 2));
    const nextH = Math.max(targetHeight, Math.round(h / 2));
    if (nextW === w && nextH === h) break;
    w = nextW;
    h = nextH;
    steps.push({ width: w, height: h });
  }
  if (steps.length === 0 || steps[steps.length - 1].width !== targetWidth || steps[steps.length - 1].height !== targetHeight) {
    steps.push({ width: targetWidth, height: targetHeight });
  }
  return steps;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Politica                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

export type KeepReason = "original-preset" | "already-small" | "small-png" | "graphic-png" | "unreadable";

export type TranscodePlan = {
  readonly action: "transcode";
  /** Lado largo maximo y area maxima del resultado (en pixeles VISTOS, ya con la orientacion aplicada). */
  readonly maxSide: number | null;
  readonly maxPixels: number;
  /** `jpeg` fuerza JPEG (un JPEG de origen); `auto` decide mirando pixeles (foto -> JPEG, grafico/alfa -> PNG). */
  readonly output: "jpeg" | "auto";
  readonly quality: number;
  /** El formato de origen no se puede incrustar tal cual (WebP/AVIF/HEIC/GIF...): hay que convertir si o si. */
  readonly mustConvert: boolean;
  /** Hay que mirar el canal alfa de los pixeles (el origen puede tenerlo). */
  readonly checkAlpha: boolean;
  /** Dimensiones vistas segun la cabecera (pista para decodificar ya reducido), o `null`. */
  readonly hint: { width: number; height: number } | null;
  readonly orientation: ExifOrientation;
};

export type PreparationPlan = { readonly action: "keep"; readonly reason: KeepReason } | TranscodePlan;

/**
 * La POLITICA. Decide, solo con la cabecera y el peso del archivo, que hacer con una imagen:
 *  - `original`: JPEG/PNG intactos; el resto se convierte (no hay alternativa) con los topes de lienzo seguros.
 *  - JPEG que ya cabe en el tope y pesa pocos bytes por pixel: intacto (reencodarlo no ahorraria el 15 %).
 *  - JPEG grande: se reduce y se reencoda a JPEG (luego `chooseOutcome` descarta el resultado si no ahorra el 15 %).
 *  - PNG pequeno, o que ya cabe y pesa pocos bytes por pixel (grafico/captura): intacto.
 *  - PNG grande: se mira si es foto (-> JPEG) o grafico/transparencia real (-> PNG, solo se reduce si excede el tope).
 *  - WebP/AVIF/HEIC/GIF y lo ilegible: se convierte siempre (foto -> JPEG, grafico/alfa -> PNG).
 */
export function planPreparation(header: ImageHeader, byteLength: number, preset: ImagePreset): PreparationPlan {
  const isOriginal = preset.id === "original";
  const hint = header.displayWidth !== null && header.displayHeight !== null ? { width: header.displayWidth, height: header.displayHeight } : null;
  const maxSide = isOriginal ? CANVAS_SAFE_MAX_SIDE : preset.maxSide;
  const cap = (dims: { width: number; height: number } | null): boolean =>
    dims !== null && fitWithin(dims.width, dims.height, maxSide).scale === 1;

  if (header.kind === "jpeg") {
    if (isOriginal) return { action: "keep", reason: "original-preset" };
    if (hint === null) return { action: "keep", reason: "unreadable" };
    const stored = { width: header.width as number, height: header.height as number };
    const bytesPerPixel = byteLength / (stored.width * stored.height);
    // «Ya cabe»: comparar con las dimensiones vistas (la orientacion no cambia el area ni el lado largo).
    if (cap(hint) && bytesPerPixel <= preset.keepBytesPerPixel) return { action: "keep", reason: "already-small" };
    return transcode(preset, hint, header, { output: "jpeg", mustConvert: false, checkAlpha: false });
  }

  if (header.kind === "png") {
    if (isOriginal) return { action: "keep", reason: "original-preset" };
    if (hint !== null) {
      const bytesPerPixel = byteLength / (hint.width * hint.height);
      if (cap(hint) && byteLength <= SMALL_PNG_BYTES) return { action: "keep", reason: "small-png" };
      if (cap(hint) && bytesPerPixel <= GRAPHIC_PNG_BYTES_PER_PIXEL) return { action: "keep", reason: "graphic-png" };
    } else if (byteLength <= SMALL_PNG_BYTES) {
      return { action: "keep", reason: "small-png" };
    }
    return transcode(preset, hint, header, { output: "auto", mustConvert: false, checkAlpha: header.mayHaveAlpha });
  }

  // WebP, AVIF, HEIC, GIF, BMP y lo no reconocido: siempre se convierte (pdf-lib solo incrusta JPEG y PNG).
  return transcode(preset, hint, header, { output: "auto", mustConvert: true, checkAlpha: header.mayHaveAlpha }, isOriginal);
}

function transcode(
  preset: ImagePreset,
  hint: { width: number; height: number } | null,
  header: ImageHeader,
  options: { output: "jpeg" | "auto"; mustConvert: boolean; checkAlpha: boolean },
  original = false,
): TranscodePlan {
  return {
    action: "transcode",
    maxSide: original ? CANVAS_SAFE_MAX_SIDE : preset.maxSide,
    maxPixels: CANVAS_SAFE_MAX_PIXELS,
    output: options.output,
    // Con `original` y un formato que obliga a convertir, la calidad no se usa si sale PNG; si saliera JPEG (foto) se
    // usa la mas alta: no se pierde nada visible, solo se evita un PNG de decenas de MB.
    quality: original ? 0.95 : preset.quality,
    mustConvert: options.mustConvert,
    checkAlpha: options.checkAlpha,
    hint,
    orientation: header.orientation,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Pixeles: backend, clasificacion y transcodificado                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** Imagen decodificada (ya derecha y ya reducida) con la que trabaja el motor. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA de las filas `[from, to)`. */
  rows(from: number, to: number): Uint8ClampedArray;
  /** Codifica la imagen. `flatten` pinta un fondo BLANCO detras de la transparencia (para JPEG). */
  encode(format: "jpeg" | "png", quality: number, flatten: boolean): Promise<Uint8Array>;
  /** Libera la memoria (`canvas.width = 0`, `bitmap.close()`). Idempotente. */
  release(): void;
}

export type DecodeRequest = {
  maxSide: number | null;
  maxPixels: number;
  hint: { width: number; height: number } | null;
  orientation: ExifOrientation;
  /** Se van a leer pixeles (clasificacion): el lienzo se crea pensado para `getImageData`. */
  willRead: boolean;
};

export interface PrepareBackend {
  /** `null` si no se puede decodificar (formato desconocido, imagen danada, API ausente). Nunca lanza. */
  decode(source: Blob, request: DecodeRequest, signal?: AbortSignal): Promise<Raster | null>;
}

export class ImagePrepareError extends Error {
  readonly code: "cancelled" | "undecodable";
  constructor(code: "cancelled" | "undecodable") {
    super(code);
    this.name = "ImagePrepareError";
    this.code = code;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImagePrepareError("cancelled");
}

export type RasterScan = {
  /** Hay pixeles no opacos en cantidad apreciable: la transparencia es real. */
  realAlpha: boolean;
  /** Hay algun pixel no opaco (aunque sea trivial): para ir a JPEG hay que aplanar sobre blanco. */
  anyAlpha: boolean;
  /** Pocos colores distintos: captura de pantalla, logo, dibujo. */
  graphic: boolean;
  distinctColors: number;
};

const SCAN_BAND_ROWS = 256;

/**
 * Mira los pixeles POR BANDAS (memoria acotada): cuenta los no opacos (solo si `checkAlpha`) y los colores distintos
 * de una muestra (1 de cada 4 pixeles; en cuanto pasan de `GRAPHIC_COLOR_LIMIT` es una foto y se deja de contar).
 */
export function scanRaster(raster: Raster, checkAlpha: boolean): RasterScan {
  const { width, height } = raster;
  const total = width * height;
  const alphaLimit = Math.max(1, Math.floor(total * REAL_ALPHA_FRACTION));
  const colors = new Set<number>();
  let photo = false;
  let nonOpaque = 0;
  let realAlpha = false;
  for (let y0 = 0; y0 < height; y0 += SCAN_BAND_ROWS) {
    const y1 = Math.min(height, y0 + SCAN_BAND_ROWS);
    const needColors = !photo;
    const needAlpha = checkAlpha && !realAlpha;
    if (!needColors && !needAlpha) break;
    const data = raster.rows(y0, y1);
    const bandRows = y1 - y0;
    if (needAlpha) {
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] < 255) {
          nonOpaque += 1;
          if (nonOpaque > alphaLimit) {
            realAlpha = true;
            break;
          }
        }
      }
    }
    if (needColors) {
      for (let row = 0; row < bandRows && !photo; row += 2) {
        const base = row * width * 4;
        for (let x = 0; x < width; x += 2) {
          const at = base + x * 4;
          colors.add((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
        }
        if (colors.size > GRAPHIC_COLOR_LIMIT) photo = true;
      }
    }
  }
  return {
    realAlpha,
    anyAlpha: nonOpaque > 0,
    graphic: !photo,
    distinctColors: colors.size,
  };
}

export type TranscodeResult = {
  format: "jpeg" | "png";
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Se reencodo manteniendo transparencia real o por ser un grafico (PNG). */
  scanned: RasterScan | null;
};

/**
 * Decodifica ya reducido, decide el formato (si `output === "auto"`) y codifica. Libera siempre el raster. `null` si el
 * navegador no pudo decodificar la imagen.
 */
export async function transcodeImage(
  source: Blob,
  plan: TranscodePlan,
  backend: PrepareBackend,
  signal?: AbortSignal,
): Promise<TranscodeResult | null> {
  throwIfAborted(signal);
  const raster = await backend.decode(
    source,
    {
      maxSide: plan.maxSide,
      maxPixels: plan.maxPixels,
      hint: plan.hint,
      orientation: plan.orientation,
      willRead: plan.output === "auto",
    },
    signal,
  );
  if (!raster) return null;
  try {
    throwIfAborted(signal);
    let format: "jpeg" | "png" = "jpeg";
    let flatten = false;
    let scanned: RasterScan | null = null;
    if (plan.output === "auto") {
      scanned = scanRaster(raster, plan.checkAlpha);
      if (scanned.realAlpha || scanned.graphic) format = "png";
      else flatten = scanned.anyAlpha;
    }
    throwIfAborted(signal);
    const bytes = await raster.encode(format, plan.quality, flatten);
    return { format, bytes, width: raster.width, height: raster.height, scanned };
  } finally {
    raster.release();
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Resultado                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

export type PrepareReason =
  | KeepReason
  | "recompressed"
  | "converted"
  | "resized-png"
  | "not-smaller"
  | "unavailable";

export type PreparedImage = {
  format: "jpeg" | "png";
  bytes: Uint8Array;
  /** Orientacion EXIF a aplicar al dibujar: solo un JPEG conservado puede traer una distinta de 1. */
  orientation: ExifOrientation;
  /** Dimensiones de los pixeles de `bytes` (las GUARDADAS, sin orientacion). `null` si no se pudieron leer. */
  width: number | null;
  height: number | null;
  /** `false` = son exactamente los bytes del archivo original. */
  changed: boolean;
  originalBytes: number;
  reason: PrepareReason;
};

/**
 * La regla «solo si ahorra >= 15 %». `transcoded` es el resultado de `transcodeImage` (o `null` si no se pudo).
 * Devuelve `"original"` para conservar los bytes del archivo o `"transcoded"` para usar el resultado nuevo.
 */
export function chooseOutcome(
  plan: TranscodePlan,
  sourceKind: ImageKind,
  originalBytes: number,
  transcoded: TranscodeResult | null,
): { use: "original" | "transcoded"; reason: PrepareReason } {
  if (!transcoded) return { use: "original", reason: "unavailable" };
  if (plan.mustConvert) return { use: "transcoded", reason: "converted" };
  const smaller = transcoded.bytes.byteLength <= originalBytes * (1 - MIN_SAVING);
  if (sourceKind === "png" && transcoded.format === "png") {
    // Un PNG que sigue siendo PNG solo se sustituye si se REDUJO y el ahorro es real.
    return smaller ? { use: "transcoded", reason: "resized-png" } : { use: "original", reason: "not-smaller" };
  }
  return smaller ? { use: "transcoded", reason: "recompressed" } : { use: "original", reason: "not-smaller" };
}

export type PrepareOptions = {
  signal?: AbortSignal;
  /** Lado largo que necesita la foto por el sitio que ocupa en la hoja (ver `withFitMaxSide`). */
  fitMaxSide?: number;
  /**
   * Para quien incrusta el JPEG SIN poder aplicar la orientacion EXIF al dibujar (insertar una imagen en Editar): un JPEG
   * con orientacion distinta de 1 se reencoda siempre ya derecho, aunque pase intacto por la politica y aunque el preset
   * sea `original` (la foto saldria girada o deformada).
   */
  bakeOrientation?: boolean;
};

/**
 * Transcodifica una imagen. La implementan `prepareBrowser.ts` (Web Worker con respaldo en el hilo principal) y las
 * pruebas (un backend de Node). Devuelve `null` si no se pudo decodificar.
 */
export type TranscodeRunner = (source: Blob, plan: TranscodePlan, signal?: AbortSignal) => Promise<TranscodeResult | null>;

/**
 * Prepara UNA imagen para el PDF. No toca el archivo original: lee sus bytes y devuelve los mismos (conservados) o unos
 * nuevos. `run` es quien decodifica/codifica; sin el (`null`: entorno sin canvas) la imagen se conserva tal cual cuando es
 * JPEG/PNG y las demas fallan con `undecodable`, que es lo que ya hacia `imagesToPdf` sin navegador.
 */
export async function prepareImage(
  source: Blob,
  presetId: ImagePresetId,
  run: TranscodeRunner | null,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  throwIfAborted(options.signal);
  const preset = withFitMaxSide(IMAGE_PRESETS[presetId] ?? IMAGE_PRESETS[DEFAULT_IMAGE_PRESET], options.fitMaxSide);
  const bytes = new Uint8Array(await source.arrayBuffer());
  throwIfAborted(options.signal);
  if (bytes.byteLength === 0) throw new ImagePrepareError("undecodable");
  const header = readImageHeader(bytes);
  let plan = planPreparation(header, bytes.byteLength, preset);
  if (
    plan.action === "keep" &&
    options.bakeOrientation &&
    header.kind === "jpeg" &&
    header.orientation !== 1 &&
    header.displayWidth !== null &&
    header.displayHeight !== null
  ) {
    // Sin `original`: se usa la calidad alta (la orientacion hay que hornearla si o si).
    const baking = preset.id === "original" ? IMAGE_PRESETS.high : preset;
    plan = transcode(baking, { width: header.displayWidth, height: header.displayHeight }, header, {
      output: "jpeg",
      mustConvert: true,
      checkAlpha: false,
    });
  }

  const keep = (reason: PrepareReason): PreparedImage => {
    if (header.kind !== "jpeg" && header.kind !== "png") throw new ImagePrepareError("undecodable");
    return {
      format: header.kind,
      bytes,
      orientation: header.kind === "jpeg" ? header.orientation : 1,
      width: header.width,
      height: header.height,
      changed: false,
      originalBytes: bytes.byteLength,
      reason,
    };
  };

  if (plan.action === "keep") return keep(plan.reason);

  let result: TranscodeResult | null = null;
  if (run) {
    try {
      // Un Blob NUEVO (copia de los bytes ya leidos) y no el `File` del usuario: WebKit guarda en cache la imagen decodificada
      // de cada Blob mientras exista (con 40 fotos de 12 Mpx son cientos de MB que no se liberan hasta el final).
      const scratch = new Blob([bytes as BlobPart], { type: source.type });
      result = await run(scratch, plan, options.signal);
    } catch (error) {
      if (error instanceof ImagePrepareError && error.code === "cancelled") throw error;
      if (options.signal?.aborted) throw new ImagePrepareError("cancelled");
      result = null;
    }
  }
  throwIfAborted(options.signal);
  const outcome = chooseOutcome(plan, header.kind, bytes.byteLength, result);
  if (outcome.use === "original" || !result) return keep(outcome.reason);
  return {
    format: result.format,
    bytes: result.bytes,
    orientation: 1,
    width: result.width,
    height: result.height,
    changed: true,
    originalBytes: bytes.byteLength,
    reason: outcome.reason,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Estimacion                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Cuanto se lee de cada archivo para estimar (y para componer las hojas): suficiente para la cabecera de casi cualquier foto. */
export const ESTIMATE_HEAD_BYTES = 512 * 1024;

/**
 * Bytes que se espera que ocupe esta imagen en el PDF. BARATO (solo cabecera y peso, sin decodificar) y por tanto
 * aproximado: la estimacion sirve para decidir antes de generar. `unoptimized` es lo que pesaria con la politica anterior
 * (todo tal cual; un WebP/HEIC se reconvertia a PNG, de ~2,4 bytes por pixel).
 *
 * Un JPEG de origen se estima por su propio peso: `sizeRatio` (segun la calidad) x (pixeles finales / iniciales)^0,75,
 * acotado a [0,08 ; 0,45] bytes por pixel final. El resto (PNG/WebP/HEIC de foto) por `targetBytesPerPixel`.
 */
export function estimatePreparedBytes(
  header: ImageHeader | null,
  byteLength: number,
  preset: ImagePreset,
): { optimized: number; unoptimized: number } {
  const pixels = header && header.width !== null && header.height !== null ? header.width * header.height : null;
  const convertsToPng = header ? header.kind !== "jpeg" && header.kind !== "png" : false;
  const unoptimized = convertsToPng ? (pixels !== null ? pixels * 2.4 : byteLength * 4) : byteLength;
  if (!header || header.kind === "unknown") return { optimized: byteLength, unoptimized };
  const plan = planPreparation(header, byteLength, preset);
  if (plan.action === "keep") return { optimized: convertsToPng ? unoptimized : byteLength, unoptimized };
  if (pixels === null || !header.displayWidth || !header.displayHeight) return { optimized: byteLength, unoptimized };
  const out = fitWithin(header.displayWidth, header.displayHeight, plan.maxSide, plan.maxPixels);
  const outPixels = out.width * out.height;
  let encoded: number;
  if (header.kind === "jpeg") {
    const ratio = Math.min(1, outPixels / pixels);
    encoded = Math.min(Math.max(preset.sizeRatio * byteLength * ratio ** 0.75, outPixels * 0.08), outPixels * 0.45);
  } else {
    encoded = outPixels * (preset.id === "original" ? 0.5 : preset.targetBytesPerPixel);
  }
  // Una foto que ya pesa menos que lo estimado se conserva (regla del 15 %): nunca se estima mas que el original.
  const optimized = plan.mustConvert ? Math.min(encoded, unoptimized) : Math.min(encoded, byteLength);
  return { optimized, unoptimized };
}
