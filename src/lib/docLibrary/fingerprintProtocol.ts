import type { Fingerprint, FingerprintErrorCode } from "./types";

/** Mensajes entre el hilo principal y `fingerprint.worker.ts`. Todo se copia (no se comparte memoria). */
export type FingerprintWorkerRequest = {
  type: "compute";
  id: number;
  /** Bytes del PDF (una COPIA transferida: el llamador conserva los suyos). */
  bytes: Uint8Array;
  maxPages: number;
  /** URLs ABSOLUTAS (el worker puede nacer de un blob: y no resolvería rutas relativas). */
  pdfjsWorkerSrc: string;
  standardFontDataUrl: string;
};

export type FingerprintWorkerResponse =
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "result"; id: number; fingerprint: Fingerprint }
  | { type: "error"; id: number; code: FingerprintErrorCode };

/** Ruta pública del worker de pdf.js (la misma que usa `core.ts`). */
export const PDFJS_WORKER_PATH = "/pdf.worker.min.mjs";
export const PDFJS_FONTS_PATH = "/standard_fonts/";
