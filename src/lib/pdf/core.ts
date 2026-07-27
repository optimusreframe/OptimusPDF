import { PDFDocument, EncryptedPDFError } from "@cantoo/pdf-lib";
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
  | "unknown";

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

/** `informe.pdf` + `unido` -> `informe-unido.pdf` */
export function withSuffix(
  filename: string,
  suffix: string,
  extension = "pdf",
): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const safeBase = base.trim() || "documento";
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
