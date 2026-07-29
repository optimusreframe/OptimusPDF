import {
  PDFDocument,
  EncryptedPDFError,
  StandardFonts,
  rgb,
  type Color,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * Utilidades compartidas del motor PDF.
 *
 * Este modulo es puro (sin React) y se ejecuta siempre en el navegador:
 * ningun byte de los archivos del usuario sale del dispositivo.
 */

export const MAX_SAFE_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export type PdfErrorCode =
  | "encrypted"
  | "invalidType"
  | "corrupt"
  | "tooLarge"
  | "empty"
  | "needTwo"
  | "cancelled"
  | "unknown"
  | "wrongPassword"
  /** El documento no tiene ninguna proteccion que retirar. */
  | "notProtected"
  /** Cifrado por certificado digital (`/Adobe.PubSec`). */
  | "certificateEncryption"
  /** Manejador de seguridad distinto de `/Standard` que no reconocemos. */
  | "unsupportedSecurityHandler"
  /** La operacion invalida firmas y falta el consentimiento explicito. */
  | "consentRequired"
  /**
   * La estructura del documento no se pudo comprobar con seguridad
   * (referencia rota, tipo inesperado, arbol de campos sin terminar de
   * recorrer, u objetos invalidos tras descifrar). Nunca se interpreta
   * como "sin restriccion".
   */
  | "inspectionIncomplete"
  | "nothingSelected";

/** Error tipado del motor: la UI traduce `code` mediante i18n. */
export class PdfError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PdfError";
    this.code = code;
  }
}

export function toPdfError(error: unknown): PdfError {
  if (error instanceof PdfError) return error;
  if (error instanceof EncryptedPDFError) return new PdfError("encrypted");
  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    if (text.includes("password") || text.includes("encrypt")) {
      return new PdfError("encrypted", error.message);
    }
    if (
      text.includes("invalid pdf") ||
      text.includes("no pdf header") ||
      text.includes("failed to parse")
    ) {
      return new PdfError("corrupt", error.message);
    }
    return new PdfError("unknown", error.message);
  }
  return new PdfError("unknown");
}

/**
 * Referencia a una pagina concreta dentro del conjunto de archivos
 * cargados. Es el contrato que comparten `PageThumbnailGrid` y los
 * motores de `lib/pdf/` para respetar orden, rotacion y seleccion.
 */
export type PageRef = {
  /** Identificador estable para React keys y drag & drop. */
  id: string;
  fileIndex: number;
  pageIndex: number;
  /** Rotacion adicional aplicada por el usuario, en grados (0/90/180/270). */
  rotation: number;
  selected: boolean;
};

/** Progreso normalizado 0..1. */
export type ProgressCallback = (progress: number) => void;

/**
 * Corta el trabajo en curso si el usuario ya ha cancelado.
 *
 * Se llama al principio de cada iteracion de los bucles largos (una
 * pagina = una unidad de trabajo cara). Lanza `PdfError("cancelled")`,
 * el mismo codigo que `ToolShell` ya muestra al cancelar, asi que la
 * interfaz no necesita distinguir entre "cancelado por el usuario antes
 * de empezar" y "cancelado a mitad".
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfError("cancelled");
}

/* ------------------------------------------------------------------ *
 * Lectura de archivos
 * ------------------------------------------------------------------ */

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

export function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

export function matchesAccept(
  file: File,
  accept: string[],
  extensions: string[],
): boolean {
  if (accept.length === 0) return true;
  if (file.type && accept.includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

/* ------------------------------------------------------------------ *
 * pdf-lib (escritura / manipulacion)
 * ------------------------------------------------------------------ */

export type LoadPdfOptions = {
  password?: string;
  /** Permite abrir un PDF cifrado sin descifrarlo (solo lectura parcial). */
  ignoreEncryption?: boolean;
};

/**
 * Carga un PDF con pdf-lib. Si el documento esta cifrado y no se aporta
 * contrasena valida, lanza `PdfError("encrypted")`.
 */
export async function loadPdf(
  source: Blob | ArrayBuffer | Uint8Array,
  options: LoadPdfOptions = {},
): Promise<PDFDocument> {
  let bytes: Uint8Array;
  if (source instanceof Uint8Array) {
    bytes = source;
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    bytes = await readFileBytes(source);
  }

  if (bytes.byteLength === 0) {
    throw new PdfError("corrupt");
  }

  try {
    return await PDFDocument.load(bytes, {
      password: options.password,
      ignoreEncryption: options.ignoreEncryption ?? false,
      updateMetadata: false,
    });
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Serializa un documento pdf-lib a Blob descargable. */
export async function savePdfToBlob(document: PDFDocument): Promise<Blob> {
  const bytes = await document.save({ useObjectStreams: true });
  // `bytes` es un Uint8Array respaldado por un ArrayBuffer propio.
  return new Blob([bytes as unknown as BlobPart], {
    type: "application/pdf",
  });
}

/* ------------------------------------------------------------------ *
 * pdf.js (lectura / render)
 * ------------------------------------------------------------------ */

/**
 * El worker se sirve como asset estatico desde `public/`. Se copia de
 * `pdfjs-dist/build/pdf.worker.min.mjs` y debe refrescarse al subir de
 * version la libreria.
 */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

type PdfJsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** Carga perezosa de pdf.js con el worker ya configurado. */
export async function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((module) => {
      module.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return module;
    });
  }
  return pdfjsPromise;
}

/**
 * Abre un documento con pdf.js. Copia los bytes porque pdf.js transfiere
 * (y deja inutilizable) el buffer que recibe.
 */
export async function openPdfDocument(
  source: Blob | Uint8Array,
  password?: string,
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  const original =
    source instanceof Uint8Array ? source : await readFileBytes(source);
  const copy = new Uint8Array(original);

  try {
    const task = pdfjs.getDocument({ data: copy, password });
    return await task.promise;
  } catch (error) {
    // pdf.js usa PasswordException para documentos protegidos.
    if (
      error instanceof Error &&
      (error.name === "PasswordException" ||
        error.message.toLowerCase().includes("password"))
    ) {
      throw new PdfError("encrypted", error.message);
    }
    throw toPdfError(error);
  }
}

/** Libera el documento y el worker asociado. */
export async function closePdfDocument(
  document: PDFDocumentProxy,
): Promise<void> {
  try {
    await document.loadingTask.destroy();
  } catch {
    // Ya estaba destruido: nada que hacer.
  }
}

export type RenderOptions = {
  /** Escala base del render. Por defecto 1. */
  scale?: number;
  /** Limita el ancho en pixeles CSS del canvas resultante. */
  maxWidth?: number;
  /**
   * Intencion de render de pdf.js.
   *
   * "display" encadena los pasos con `requestAnimationFrame`, asi que se
   * detiene mientras la pestana esta en segundo plano: correcto para un
   * preview visible. "print" avanza con microtareas y termina aunque la
   * pestana no este pintando, que es lo que necesita cualquier rasterizado
   * fuera de pantalla (miniaturas, PDF a imagen, aplanado).
   */
  intent?: "display" | "print";
};

/** Renderiza una pagina de pdf.js sobre un canvas nuevo. */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  options: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const baseViewport = page.getViewport({ scale: options.scale ?? 1 });
  const scale = options.maxWidth
    ? Math.min(1, options.maxWidth / baseViewport.width) * (options.scale ?? 1)
    : (options.scale ?? 1);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }

  await page.render({
    canvas,
    viewport,
    intent: options.intent ?? "display",
  }).promise;
  return canvas;
}

/** Renderiza una pagina y devuelve un data URL (miniaturas). */
export async function renderPageToDataUrl(
  page: PDFPageProxy,
  options: RenderOptions = {},
): Promise<string> {
  const canvas = await renderPageToCanvas(page, {
    // Rasterizado fuera de pantalla: no debe depender de que la pestana pinte.
    intent: "print",
    ...options,
  });
  const url = canvas.toDataURL("image/jpeg", 0.72);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

/* ------------------------------------------------------------------ *
 * Geometria de pagina (compartida por los motores de edicion)
 * ------------------------------------------------------------------ */

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Relacion entre el espacio de usuario del PDF (origen abajo-izquierda,
 * sin rotacion aplicada) y el espacio "de vista": lo que el lector
 * muestra en pantalla despues de aplicar `/Rotate`, tambien con origen
 * abajo-izquierda.
 */
export type PageGeometry = {
  /** CropBox en espacio de usuario (o MediaBox si no hay CropBox). */
  box: Box;
  /** `/Rotate` normalizado a 0, 90, 180 o 270 grados (horario). */
  rotation: number;
  /** Ancho tal y como lo ve el usuario. */
  viewWidth: number;
  /** Alto tal y como lo ve el usuario. */
  viewHeight: number;
};

function normalizeAngle(angle: number): number {
  const value = Math.round(angle / 90) * 90;
  return ((value % 360) + 360) % 360;
}

export function getPageGeometry(page: PDFPage): PageGeometry {
  const box = page.getCropBox();
  const rotation = normalizeAngle(page.getRotation().angle);
  const swapped = rotation === 90 || rotation === 270;
  return {
    box,
    rotation,
    viewWidth: swapped ? box.height : box.width,
    viewHeight: swapped ? box.width : box.height,
  };
}

/**
 * Convierte un punto del espacio de vista (lo que el usuario ve) al
 * espacio de usuario del PDF, deshaciendo `/Rotate`.
 */
export function viewPointToUser(
  geometry: PageGeometry,
  vx: number,
  vy: number,
): { x: number; y: number } {
  const { box, rotation } = geometry;
  switch (rotation) {
    case 90:
      return { x: box.x + box.width - vy, y: box.y + vx };
    case 180:
      return { x: box.x + box.width - vx, y: box.y + box.height - vy };
    case 270:
      return { x: box.x + vy, y: box.y + box.height - vx };
    default:
      return { x: box.x + vx, y: box.y + vy };
  }
}

/**
 * Convierte un rectangulo normalizado (0..1) medido sobre la vista
 * renderizada, con origen ARRIBA-izquierda como en el DOM, en la caja
 * equivalente del espacio de usuario del PDF.
 */
export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function normalizedRectToUserBox(
  geometry: PageGeometry,
  rect: NormalizedRect,
): Box {
  const vx = rect.x * geometry.viewWidth;
  const vw = rect.width * geometry.viewWidth;
  // El DOM mide desde arriba; el espacio de vista, desde abajo.
  const vy = (1 - rect.y - rect.height) * geometry.viewHeight;
  const vh = rect.height * geometry.viewHeight;

  const corners = [
    viewPointToUser(geometry, vx, vy),
    viewPointToUser(geometry, vx + vw, vy),
    viewPointToUser(geometry, vx, vy + vh),
    viewPointToUser(geometry, vx + vw, vy + vh),
  ];

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * Punto de dibujo (`x`/`y` de pdf-lib) para que un elemento de tamano
 * `width` x `height` quede centrado en (`cx`, `cy`) despues de rotarlo
 * `angle` grados en sentido antihorario alrededor de ese mismo punto de
 * dibujo. `baselineOffset` es la distancia entre el borde inferior de la
 * caja y el origen de dibujo (0 para imagenes, el descendente para texto).
 */
export function originForCenter(
  cx: number,
  cy: number,
  width: number,
  height: number,
  baselineOffset: number,
  angle: number,
): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = width / 2;
  const localY = height / 2 - baselineOffset;
  return {
    x: cx - (localX * cos - localY * sin),
    y: cy - (localX * sin + localY * cos),
  };
}

/** Tamano de la caja envolvente de un rectangulo `w` x `h` rotado. */
export function rotatedBounds(
  width: number,
  height: number,
  angle: number,
): { width: number; height: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

/* ------------------------------------------------------------------ *
 * Tipografia y color del documento (compartido por los motores)
 * ------------------------------------------------------------------ */

export type PdfFontFamily = "helvetica" | "times" | "courier";

export const PDF_FONT_FAMILIES: readonly PdfFontFamily[] = [
  "helvetica",
  "times",
  "courier",
] as const;

export function standardFontFor(
  family: PdfFontFamily,
  bold: boolean,
  italic: boolean,
): StandardFonts {
  if (family === "times") {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === "courier") {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * Tintas disponibles para texto del documento. NO son tokens de la
 * interfaz: son datos que el usuario elige y que acaban impresos en el
 * PDF, por eso viven aqui como valores hexadecimales y no en el CSS.
 */
export const INK_COLORS = [
  "#000000",
  "#5b6470",
  "#c0c6cf",
  "#0d4bff",
  "#0f9d68",
  "#e11d48",
  "#f59e0b",
  "#ffffff",
] as const;

export type InkColor = (typeof INK_COLORS)[number];

export function hexToPdfColor(hex: string): Color {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(value)) return rgb(0, 0, 0);
  return rgb(
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  );
}

/**
 * Los tipos estandar de PDF solo codifican WinAnsi. Se sustituye todo lo
 * que quede fuera para que un caracter exotico no aborte el proceso
 * entero (los acentos del espanol si estan cubiertos).
 */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function toWinAnsiSafe(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code === 13) {
      out += " ";
    } else if ((code >= 32 && code <= 255) || WIN_ANSI_EXTRA.has(code)) {
      out += char;
    } else {
      out += "?";
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Salida
 * ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Se libera en el siguiente tick para no cortar la descarga en Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function formatFileSize(bytes: number, locale = "es-ES"): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value)} ${units[unit]}`;
}

/** Marcas diacriticas combinantes U+0300..U+036F. */
const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

/** "Unir PDF" -> "unir-pdf" */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `informe.pdf` -> `informe`. Sin extension no cambia nada. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** `informe.pdf` + `unido` -> `informe-unido.pdf` */
export function withSuffix(
  filename: string,
  suffix: string,
  extension = "pdf",
): string {
  const safeBase = stripExtension(filename).trim() || "documento";
  return `${safeBase}-${suffix}.${extension}`;
}

/** Reparte un progreso 0..1 de un paso dentro de un rango global. */
export function scaleProgress(
  value: number,
  from: number,
  to: number,
): number {
  const clamped = Math.min(1, Math.max(0, value));
  return from + (to - from) * clamped;
}
