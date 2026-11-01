/**
 * Motor de extraccion del autorrelleno: lee las fuentes (PDF, imagen, texto pegado), reconstruye lineas con celdas, aplica las
 * reglas y devuelve valores con confianza, nivel y evidencia. 100 % local.
 *
 *   - PDF: capa de texto con posiciones (pdf.js). Si una pagina casi no tiene texto legible Y es una imagen, se rasteriza y pasa por
 *     OCR (tesseract.js, `OcrRecognizer` de `src/lib/scan/ocr.ts`); solo cuando hace falta y solo si el modelo ya esta en el dispositivo:
 *     si no, aviso `ocr-unavailable` y se sigue (nunca bloquea ni cuelga: cada reconocimiento tiene plazo y se puede cancelar).
 *   - Imagen: se decodifica derecha (orientacion EXIF) y se reconoce con OCR.
 *   - Texto pegado: directo (un salto de pagina «\f» separa paginas).
 *
 * Las dependencias del navegador (abrir PDF, decodificar, OCR) entran por `EngineDeps`: en las pruebas se sustituyen por dobles y el
 * mismo motor corre en Node. `extract` usa las del navegador, que se importan perezosamente.
 */

import { buildLines, pastedBoxes, type TextBox, type TextOrigin, type TextPage } from "@/lib/autofill/layout";
import { warningMessage } from "@/lib/autofill/reasons";
import { resolveCandidates } from "@/lib/autofill/resolve";
import { collectPage, findBoilerplate, type Candidate } from "@/lib/autofill/rules";
import { wrapPdfJs, type PdfSession } from "@/lib/autofill/pdfSession";
import type { AutofillSource, ExtractEngine, ExtractOptions, ExtractResult, ExtractWarning, ExtractWarningCode } from "@/lib/autofill/types";
import { IMAGE_PAGE_COVERAGE, MAX_ILLEGIBLE_RATIO, decidePageSource, type CoverageOps } from "@/lib/pdf/pageTextKind";
import type { OcrResult } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

export const DEFAULT_MAX_PAGES = 12;
/** Tope absoluto de paginas por fuente, pida lo que pida quien llama. */
const HARD_MAX_PAGES = 60;
/** Texto pegado: caracteres que se leen como mucho. */
export const PASTE_MAX_CHARS = 200_000;
/** Plazo de UN reconocimiento OCR; pasado, se abandona y se avisa. */
export const OCR_TIMEOUT_MS = 90_000;
/** Lado mayor (px) al que se decodifica una foto para el OCR. */
const OCR_MAX_SIDE = 2800;
/** Paginas sin texto ni imagen (en blanco): no se gastan en OCR. */
const BLANK_PAGE_COVERAGE = 0.05;

export type RecognizeOptions = { signal?: AbortSignal; onProgress?: (fraction: number) => void };

export type EngineDeps = {
  /** Abre un PDF (File/Blob). Lanza si esta danado o protegido. */
  openPdf(file: Blob, signal?: AbortSignal): Promise<PdfSession>;
  /** Decodifica una imagen ya derecha (orientacion EXIF aplicada). */
  decodeImage(file: Blob, signal?: AbortSignal): Promise<Rgba>;
  /** ¿El modelo de OCR esta en este dispositivo? (nunca descarga nada) */
  ocrAvailable(): Promise<boolean>;
  recognize(image: Rgba, options: RecognizeOptions): Promise<OcrResult>;
  /** Descarta el reconocedor compartido tras un fallo o un plazo vencido. */
  resetOcr?(): Promise<void>;
  /** Plazo de un reconocimiento (ms); por defecto `OCR_TIMEOUT_MS`. */
  ocrTimeoutMs?: number;
};

function abortError(): DOMException {
  return new DOMException("Autorrelleno cancelado", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError");
}

class OcrTimeout extends Error {
  constructor() {
    super("ocr-timeout");
    this.name = "OcrTimeout";
  }
}

function race<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => reject(new OcrTimeout()), ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = (): void => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error);
      },
    );
  });
}

/**
 * Cede el hilo si lleva mas de ~40 ms sin hacerlo (la interfaz sigue fluida con paginas grandes). Solo cuando hace falta: un
 * `setTimeout` por pagina costaria un segundo entero por pagina en una pestana en segundo plano.
 */
function makeYielder(): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < 40) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = Date.now();
  };
}

/** Espera `promise`, pero rechaza con AbortError en cuanto se cancela (lo que `promise` termine despues lo recoge `onLate`). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onLate: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      settled = true;
      reject(abortError());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) onLate(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) reject(error);
      },
    );
  });
}

/** Resultado del OCR -> cajas de texto (palabras con su confianza; si no hay palabras, lineas; si no, el texto plano). */
export function ocrToBoxes(result: OcrResult): TextBox[] {
  const boxes: TextBox[] = [];
  for (const line of result.lines ?? []) {
    if (line.words && line.words.length > 0) {
      for (const word of line.words) {
        if (word.text.trim() === "") continue;
        boxes.push({ text: word.text, x0: word.bbox.x0, x1: word.bbox.x1, y0: word.bbox.y0, y1: word.bbox.y1, confidence: word.confidence });
      }
    } else if (line.text.trim() !== "") {
      boxes.push({ text: line.text, x0: line.bbox.x0, x1: line.bbox.x1, y0: line.bbox.y0, y1: line.bbox.y1, confidence: line.confidence });
    }
  }
  if (boxes.length === 0 && result.text.trim() !== "") return pastedBoxes(result.text);
  return boxes;
}

type RunState = {
  warnings: ExtractWarning[];
  pagesRead: number;
  usedOcr: boolean;
  ocr: { checked: boolean; available: boolean; broken: boolean };
  warned: Set<string>;
};

export function createExtract(deps: EngineDeps): ExtractEngine {
  return async function extract(sources: readonly AutofillSource[], options: ExtractOptions): Promise<ExtractResult> {
    const locale: "es" | "en" = options.locale === "en" ? "en" : "es";
    const signal = options.signal;
    const maxPages = Math.max(1, Math.min(HARD_MAX_PAGES, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES));
    const timeoutMs = deps.ocrTimeoutMs ?? OCR_TIMEOUT_MS;
    throwIfAborted(signal);

    let lastProgress = 0;
    const report = (fraction: number): void => {
      const value = Math.max(lastProgress, Math.min(1, Math.max(0, fraction)));
      if (value === lastProgress && value !== 1) return;
      lastProgress = value;
      options.onProgress?.(value);
    };

    const state: RunState = { warnings: [], pagesRead: 0, usedOcr: false, ocr: { checked: false, available: false, broken: false }, warned: new Set() };
    const warn = (code: ExtractWarningCode, sourceIndex?: number, detail?: number | string): void => {
      // Un mismo aviso por fuente y codigo (no una linea por pagina).
      const id = `${code}:${sourceIndex ?? "-"}`;
      if (code !== "page-skipped" && state.warned.has(id)) return;
      state.warned.add(id);
      state.warnings.push({ code, sourceIndex, message: warningMessage(code, locale, detail) });
    };

    /** ¿Se puede usar el OCR? Se comprueba una vez; nunca descarga nada. */
    const ocrReady = async (sourceIndex: number): Promise<boolean> => {
      if (!state.ocr.checked) {
        state.ocr.checked = true;
        state.ocr.available = await deps.ocrAvailable().catch(() => false);
      }
      if (!state.ocr.available || state.ocr.broken) {
        warn("ocr-unavailable", sourceIndex);
        return false;
      }
      return true;
    };

    const recognize = async (image: Rgba, sourceIndex: number, onFraction: (f: number) => void): Promise<OcrResult | null> => {
      try {
        const result = await race(deps.recognize(image, { signal, onProgress: onFraction }), timeoutMs, signal);
        state.usedOcr = true;
        return result;
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        // Plazo vencido o fallo del motor: no se insiste en el resto de la corrida.
        state.ocr.broken = true;
        warn("ocr-unavailable", sourceIndex);
        await deps.resetOcr?.().catch(() => undefined);
        return null;
      }
    };

    const maybeYield = makeYielder();
    const sourcePages: TextPage[][] = sources.map(() => []);
    const count = Math.max(1, sources.length);

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      throwIfAborted(signal);
      const source = sources[sourceIndex];
      const at = (fraction: number): void => report(((sourceIndex + Math.min(1, fraction)) / count) * 0.97);
      const pages = sourcePages[sourceIndex];
      try {
        if (source.kind === "text") {
          const text = source.text.slice(0, PASTE_MAX_CHARS);
          const chunks = text.split("\f").slice(0, maxPages);
          if (source.text.length > PASTE_MAX_CHARS || text.split("\f").length > maxPages) warn("too-many-pages", sourceIndex, maxPages);
          chunks.forEach((chunk, index) => {
            const lines = buildLines(pastedBoxes(chunk));
            if (lines.length === 0) return;
            const last = lines[lines.length - 1];
            pages.push({ index, width: Math.max(...lines.map((line) => line.x1), 1), height: last.y1 + 2, lines, origin: "pasted" });
            state.pagesRead += 1;
          });
        } else if (source.kind === "image") {
          if (await ocrReady(sourceIndex)) {
            at(0.05);
            const image = await deps.decodeImage(source.file, signal);
            at(0.15);
            const result = await recognize(image, sourceIndex, (f) => at(0.15 + 0.8 * f));
            if (result) {
              const lines = buildLines(ocrToBoxes(result));
              if (lines.length > 0) {
                pages.push({ index: 0, width: result.width || image.width, height: result.height || image.height, lines, origin: "ocr" });
                state.pagesRead += 1;
              }
            }
          }
        } else {
          await readPdf(source.file, sourceIndex, pages, at);
        }
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        warn("unreadable-source", sourceIndex);
      }
      at(1);
    }

    async function readPdf(file: Blob, sourceIndex: number, pages: TextPage[], at: (fraction: number) => void): Promise<void> {
      // Abrir un PDF grande no se puede interrumpir: se deja de esperar y, si llega tarde, se cierra.
      const session = await abortable(deps.openPdf(file, signal), signal, (late) => void late.close().catch(() => undefined));
      try {
        const total = session.numPages;
        if (!(total > 0)) throw new Error("empty-pdf");
        const limit = Math.min(total, maxPages);
        if (total > limit) warn("too-many-pages", sourceIndex, limit);
        for (let index = 0; index < limit; index += 1) {
          throwIfAborted(signal);
          at(index / limit);
          let text;
          try {
            text = await session.readPage(index);
          } catch (error) {
            if (isAbort(error, signal)) throw abortError();
            warn("page-skipped", sourceIndex, index + 1);
            continue;
          }
          let decision = decidePageSource({ chars: text.chars, legibleChars: text.legible, illegibleChars: text.illegible, ocrFallback: true });
          if (decision === "checkImage") decision = (await text.imageCoverage().catch(() => 1)) >= IMAGE_PAGE_COVERAGE ? "ocr" : "text";
          // Mucho texto pero casi todo ilegible (fuente sin mapa de caracteres): la capa de texto no sirve, se lee la imagen.
          if (decision === "text" && text.illegible + text.legible > 0 && text.illegible / (text.illegible + text.legible) > MAX_ILLEGIBLE_RATIO) decision = "ocr";
          if (decision === "ocr" && text.chars === 0 && (await text.imageCoverage().catch(() => 1)) < BLANK_PAGE_COVERAGE) decision = "empty";

          let origin: TextOrigin = "text-layer";
          let boxes: TextBox[] = [];
          let width = text.width;
          let height = text.height;
          if (decision === "text") {
            boxes = text.boxes;
          } else if (decision === "ocr") {
            let recognized: OcrResult | null = null;
            if (await ocrReady(sourceIndex)) {
              let image: Rgba | null = null;
              try {
                image = await session.rasterize(index);
              } catch (error) {
                // Una pagina que no se puede dibujar se omite; las demas paginas siguen.
                if (isAbort(error, signal)) throw abortError();
                warn("page-skipped", sourceIndex, index + 1);
              }
              if (image) recognized = await recognize(image, sourceIndex, (f) => at((index + 0.2 + 0.75 * f) / limit));
            }
            if (recognized) {
              origin = "ocr";
              boxes = ocrToBoxes(recognized);
              width = recognized.width || width;
              height = recognized.height || height;
            } else if (text.legible > 0) {
              // Sin OCR, la poca capa de texto que hay se conserva (como hace la conversion a Markdown).
              boxes = text.boxes;
            }
          }
          await session.release(index);
          const lines = buildLines(boxes);
          if (lines.length > 0) {
            pages.push({ index, width, height, lines, origin });
            state.pagesRead += 1;
          }
          await maybeYield();
        }
      } finally {
        await session.close();
      }
    }

    // Reglas por fuente: el membrete y el pie que se repiten se detectan entre las paginas de ESA fuente.
    const candidates: Candidate[] = [];
    sourcePages.forEach((pages, sourceIndex) => {
      const boilerplate = findBoilerplate(pages);
      for (const page of pages) candidates.push(...collectPage(page, { sourceIndex, locale, boilerplate }));
    });
    throwIfAborted(signal);
    const values = resolveCandidates(candidates, locale);
    // «Nada que rellenar»: se leyo algo y no habia datos, o no se leyo nada porque estaba en blanco (no por un fallo ya avisado).
    const blocked = state.warnings.some((warning) => warning.code === "ocr-unavailable" || warning.code === "unreadable-source");
    if (values.length === 0 && sources.length > 0 && (state.pagesRead > 0 || !blocked)) warn("no-data");
    report(1);
    return { values, warnings: state.warnings, pagesRead: state.pagesRead, usedOcr: state.usedOcr };
  };
}

/* ------------------------------------------------------------------ *
 * Dependencias del navegador (importaciones perezosas: el motor no carga pdf.js ni el OCR hasta que hace falta)
 * ------------------------------------------------------------------ */

/** Lado mayor (px) del raster de una pagina para el OCR. */
const OCR_PAGE_SIDE = 3000;

export function browserDeps(): EngineDeps {
  return {
    async openPdf(file) {
      const core = await import("@/lib/pdf/core");
      if (file.size > core.MAX_SAFE_FILE_SIZE) throw new Error("file-too-large");
      const pdf = await core.openPdfDocument(file);
      const pdfjs = await core.getPdfJs();
      return wrapPdfJs(pdf, {
        ops: pdfjs.OPS as unknown as CoverageOps,
        rasterize: async (page) => {
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2, OCR_PAGE_SIDE / Math.max(base.width, base.height, 1));
          const canvas = await core.renderPageToCanvas(page, { scale, intent: "print" });
          try {
            const context = canvas.getContext("2d");
            if (!context) return null;
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            return { data: image.data as Uint8ClampedArray<ArrayBuffer>, width: canvas.width, height: canvas.height };
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        },
        close: () => core.closePdfDocument(pdf),
      });
    },
    async decodeImage(file, signal) {
      const { decodeToRgba } = await import("@/lib/scan/renderIO");
      return decodeToRgba(file, OCR_MAX_SIDE, signal);
    },
    async ocrAvailable() {
      const { ocrModelAvailable } = await import("@/lib/scan/ocr");
      return ocrModelAvailable();
    },
    async recognize(image, options) {
      const { withRecognizer } = await import("@/lib/scan/ocr");
      return withRecognizer((recognizer) => recognizer.recognize(image, options), options.signal);
    },
    async resetOcr() {
      const { disposeSharedRecognizer } = await import("@/lib/scan/ocr");
      await disposeSharedRecognizer();
    },
  };
}

/** Motor real (navegador). */
export const extract: ExtractEngine = (sources, options) => createExtract(browserDeps())(sources, options);
