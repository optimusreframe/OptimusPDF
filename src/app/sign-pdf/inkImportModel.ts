import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  isValidVaultImage,
  readPngSize,
  type VaultEntryInput,
  type VaultImage,
} from "@/app/sign-pdf/signVault";
import type { InkOptions, InkRect } from "@/lib/image/inkCore";

/**
 * Logica PURA de la hoja «Subir firma o iniciales» (`SignatureImportSheet.tsx`, F6 · U6.2): ajustes -> opciones del
 * motor `inkExtract`, recorte manual en fracciones, el deslizador «Limpiar fondo», el mapa de errores del motor a
 * mensajes y la construccion del guardado en el baul (siempre con `origin: "uploaded"`). Sin DOM ni React, para
 * probarla (y mutarla) aparte de la interfaz. Solo importa TIPOS del motor: no arrastra su codigo al paquete principal.
 */

export type InkColorChoice = "original" | "black" | "blue";

/** Recorte manual en fracciones 0..1 de la imagen ORIGINAL (no depende de la resolucion con que se muestre). */
export type CropFraction = { x: number; y: number; width: number; height: number };

export type InkSettings = {
  /** `"auto"` = Otsu; numero = luminancia (1..254) donde la tinta queda al 50 %. */
  threshold: "auto" | number;
  /** «Igualar iluminacion (fotos)». */
  evenLighting: boolean;
  /** «Quitar motas»; apagado = `cleanSpecks: 0` (un punto legitimo no se pierde). */
  removeSpecks: boolean;
  ink: InkColorChoice;
  /** `null` = recorte automatico a la tinta. */
  crop: CropFraction | null;
};

export const DEFAULT_INK_SETTINGS: InkSettings = {
  threshold: "auto",
  evenLighting: true,
  removeSpecks: true,
  ink: "original",
  crop: null,
};

/** Lado minimo (fraccion) de un recorte manual: por debajo no hay nada que analizar. */
export const CROP_MIN_FRACTION = 0.05;
/** Un recorte que ya cubre casi toda la imagen equivale a «automatico». */
const CROP_FULL_EPSILON = 0.01;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Recorte valido dentro de la imagen y con lado minimo; `null` si cubre (casi) todo o no es un recorte. */
export function normalizeCrop(crop: CropFraction | null | undefined): CropFraction | null {
  if (!crop) return null;
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  const width = clamp(crop.width, CROP_MIN_FRACTION, 1);
  const height = clamp(crop.height, CROP_MIN_FRACTION, 1);
  const x = clamp(crop.x, 0, 1 - width);
  const y = clamp(crop.y, 0, 1 - height);
  const coversAll =
    x <= CROP_FULL_EPSILON &&
    y <= CROP_FULL_EPSILON &&
    width >= 1 - CROP_FULL_EPSILON &&
    height >= 1 - CROP_FULL_EPSILON;
  return coversAll ? null : { x, y, width, height };
}

/** Rectangulo en pixeles de la imagen decodificada (siempre dentro de ella, al menos 8 x 8 px). */
export function cropToRect(
  crop: CropFraction | null,
  size: { width: number; height: number },
): InkRect | null {
  const normalized = normalizeCrop(crop);
  if (!normalized) return null;
  const width = clamp(Math.round(normalized.width * size.width), Math.min(8, size.width), size.width);
  const height = clamp(Math.round(normalized.height * size.height), Math.min(8, size.height), size.height);
  const x = clamp(Math.round(normalized.x * size.width), 0, size.width - width);
  const y = clamp(Math.round(normalized.y * size.height), 0, size.height - height);
  return { x, y, width, height };
}

/** Ajustes de pantalla -> opciones del motor. */
export function settingsToInkOptions(
  settings: InkSettings,
  size: { width: number; height: number },
): InkOptions {
  const rect = cropToRect(settings.crop, size);
  return {
    threshold: settings.threshold,
    ink: settings.ink,
    cleanSpecks: settings.removeSpecks ? "auto" : 0,
    evenLighting: settings.evenLighting,
    crop: rect ?? "auto",
    margin: "auto",
  };
}

/** Clave estable de los ajustes: dos claves iguales dan el mismo resultado (reutilizar el calculo). */
export function settingsKey(settings: InkSettings): string {
  const crop = normalizeCrop(settings.crop);
  return JSON.stringify([
    settings.threshold,
    settings.evenLighting,
    settings.removeSpecks,
    settings.ink,
    crop ? [crop.x, crop.y, crop.width, crop.height].map((value) => Math.round(value * 1000)) : null,
  ]);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* «Limpiar fondo»: deslizador 0-100 <-> umbral de luminancia                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

export const CLEAN_MIN = 0;
export const CLEAN_MAX = 100;
const THRESHOLD_MAX = 254;
const THRESHOLD_MIN = 34;

/**
 * Mas limpieza = umbral mas bajo (solo sobrevive lo mas oscuro). 0 -> 254 (conserva casi todo el gris) y
 * 100 -> 34 (solo la tinta mas negra).
 */
export function thresholdFromCleaning(cleaning: number): number {
  const level = clamp(Math.round(cleaning), CLEAN_MIN, CLEAN_MAX);
  return Math.round(THRESHOLD_MAX - ((THRESHOLD_MAX - THRESHOLD_MIN) * level) / CLEAN_MAX);
}

export function cleaningFromThreshold(threshold: number): number {
  const level = ((THRESHOLD_MAX - clamp(threshold, THRESHOLD_MIN, THRESHOLD_MAX)) * CLEAN_MAX) / (THRESHOLD_MAX - THRESHOLD_MIN);
  return clamp(Math.round(level), CLEAN_MIN, CLEAN_MAX);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Errores del motor                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** Clave del mensaje (ES/EN) de cada fallo; `heic` y `generic` no son codigos del motor. */
export type InkErrorKey =
  | "empty"
  | "tooLargeFile"
  | "unsupported"
  | "decode"
  | "heic"
  | "tooManyPixels"
  | "invalid"
  | "noInk"
  | "tooDark"
  | "encode"
  | "generic";

/** `InkError` sin importar el motor: se reconoce por su nombre y su `code`. */
export function inkErrorCode(error: unknown): string | null {
  if (error instanceof Error && error.name === "InkError") {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export function isAbortError(error: unknown): boolean {
  return inkErrorCode(error) === "aborted";
}

/**
 * Mensaje de un fallo al leer/limpiar la imagen. HEIC (foto del iPhone en el formato por defecto) que este navegador
 * no abre llega como `decode-failed`: con el formato ya detectado por quien llama se pide JPG o PNG.
 */
export function inkErrorKey(error: unknown, format?: string | null): InkErrorKey {
  const code = inkErrorCode(error);
  switch (code) {
    case "empty-file":
      return "empty";
    case "file-too-large":
      return "tooLargeFile";
    case "unsupported-format":
      return format === "heic" ? "heic" : "unsupported";
    case "decode-failed":
      return format === "heic" ? "heic" : "decode";
    case "too-many-pixels":
      return "tooManyPixels";
    case "invalid-image":
      return "invalid";
    case "no-ink":
      return "noInk";
    case "too-dark":
      return "tooDark";
    case "encode-failed":
      return "encode";
    default:
      return "generic";
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Guardado en el baul                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** Lo preparado por el usuario para una de las dos imagenes de la firma. */
export type PreparedInk = {
  png: Uint8Array;
  width: number;
  height: number;
};

/** PNG de tinta -> imagen del baul; `null` si no cabe en sus topes (600 KB, 4096 px) o no es un PNG. */
export function vaultImageFromPng(png: Uint8Array): VaultImage | null {
  if (png.byteLength === 0 || png.byteLength > MAX_VAULT_IMAGE_BYTES) return null;
  const size = readPngSize(png);
  if (!size || size.width < 1 || size.height < 1) return null;
  // Lado maximo (4096 px) y forma: las valida `isValidVaultImage`, el validador del propio baul.
  const image: VaultImage = {
    png,
    ratio: size.height / size.width,
    width: size.width,
    height: size.height,
  };
  return isValidVaultImage(image) ? image : null;
}

export type UploadSaveParts = {
  signerName: string;
  role?: string;
  signature: PreparedInk | null;
  initials: PreparedInk | null;
};

/**
 * Entrada del baul para lo subido: `origin: "uploaded"`, sin documento de origen (la imagen original NO se guarda ni
 * deja rastro: solo el PNG de tinta). `null` si falta el nombre, no hay ninguna imagen o una no cabe en los topes.
 */
export function buildUploadEntry(parts: UploadSaveParts): VaultEntryInput | null {
  const signerName = parts.signerName.trim();
  if (!signerName) return null;
  const signature = parts.signature ? vaultImageFromPng(parts.signature.png) : null;
  const initials = parts.initials ? vaultImageFromPng(parts.initials.png) : null;
  if ((parts.signature && !signature) || (parts.initials && !initials)) return null;
  if (!signature && !initials) return null;
  const role = parts.role?.trim();
  return {
    signerName,
    ...(role ? { role } : {}),
    origin: "uploaded",
    sourceDocument: "",
    signature,
    initials,
  };
}

/** `true` si el baul ya esta en el tope de firmas (guardar una nueva se rechazaria, salvo ampliar una existente). */
export function vaultIsFull(entryCount: number): boolean {
  return entryCount >= MAX_VAULT_ENTRIES;
}

/** Que imagen falta para completar el par firma + iniciales (`null` si estan las dos). */
export function missingKind(parts: Pick<UploadSaveParts, "signature" | "initials">): "signature" | "initials" | null {
  if (!parts.signature) return "signature";
  if (!parts.initials) return "initials";
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Geometria del recorte manual                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

export type CropCorner = "nw" | "ne" | "sw" | "se";

/** Recorte que cubre toda la imagen (punto de partida de la edicion a mano). */
export const FULL_CROP: CropFraction = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Mueve UNA esquina a `(px, py)` (fracciones de la imagen); la opuesta no se mueve. Nunca deja un lado por debajo de
 * `CROP_MIN_FRACTION` ni fuera de la imagen: la esquina se detiene antes de cruzar a la opuesta.
 */
export function moveCorner(crop: CropFraction, corner: CropCorner, px: number, py: number): CropFraction {
  const left = crop.x;
  const top = crop.y;
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const nextX = clamp(px, 0, 1);
  const nextY = clamp(py, 0, 1);
  const newLeft = west ? Math.min(nextX, right - CROP_MIN_FRACTION) : left;
  const newRight = west ? right : Math.max(nextX, left + CROP_MIN_FRACTION);
  const newTop = north ? Math.min(nextY, bottom - CROP_MIN_FRACTION) : top;
  const newBottom = north ? bottom : Math.max(nextY, top + CROP_MIN_FRACTION);
  return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
}

/** Mueve una esquina `(dx, dy)` desde donde esta (teclado). */
export function nudgeCorner(crop: CropFraction, corner: CropCorner, dx: number, dy: number): CropFraction {
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const cornerX = west ? crop.x : crop.x + crop.width;
  const cornerY = north ? crop.y : crop.y + crop.height;
  return moveCorner(crop, corner, cornerX + dx, cornerY + dy);
}

/** Desplaza todo el recorte sin cambiar su tamano; no se sale de la imagen. */
export function shiftCrop(crop: CropFraction, dx: number, dy: number): CropFraction {
  return {
    ...crop,
    x: clamp(crop.x + dx, 0, 1 - crop.width),
    y: clamp(crop.y + dy, 0, 1 - crop.height),
  };
}

/** Recorte inicial a mano: la caja de la tinta del ultimo resultado (con un respiro) o un 10 % de margen. */
export function initialManualCrop(
  inkBounds: InkRect | null | undefined,
  size: { width: number; height: number },
): CropFraction {
  if (!inkBounds || inkBounds.width <= 0 || inkBounds.height <= 0 || size.width <= 0 || size.height <= 0) {
    return { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  }
  const padX = inkBounds.width * 0.08;
  const padY = inkBounds.height * 0.15;
  const x = clamp((inkBounds.x - padX) / size.width, 0, 1);
  const y = clamp((inkBounds.y - padY) / size.height, 0, 1);
  const right = clamp((inkBounds.x + inkBounds.width + padX) / size.width, 0, 1);
  const bottom = clamp((inkBounds.y + inkBounds.height + padY) / size.height, 0, 1);
  const crop = { x, y, width: right - x, height: bottom - y };
  return normalizeCrop(crop) ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
}
