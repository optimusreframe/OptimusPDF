import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  DHASH_GRID,
  dhashFromGray,
  grayFromRgba,
  hasUsefulText,
  minhashOf,
  normalizeText,
  resizeGray,
  wordShingles,
} from "./fingerprintCore";
import {
  FINGERPRINT_VERSION,
  FingerprintError,
  LIBRARY_LIMITS,
  type Fingerprint,
  type PageFingerprint,
  type PageSize,
} from "./types";

/**
 * Motor de la huella: abre el PDF con pdf.js, saca el texto de cada página (o rasteriza las que no tienen) y calcula
 * `Fingerprint`. NO sabe dónde corre: todo lo que depende del entorno (pdf.js, lienzos, SHA-256, ceder el control)
 * llega en `FingerprintEnv`, de modo que el MISMO código sirve en el worker (`fingerprint.worker.ts`), en el hilo
 * principal (respaldo) y en Node (pruebas, pdf.js «legacy» + `@napi-rs/canvas`).
 */

/** Lo mínimo que se usa de pdf.js (el tipo real `typeof import("pdfjs-dist")` lo cumple). */
export type PdfjsLike = {
  getDocument(source: Record<string, unknown>): { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> };
};

/** Una superficie donde pdf.js puede dibujar y de la que se pueden leer los píxeles. */
export type RenderSurface = {
  context: {
    fillStyle: unknown;
    fillRect(x: number, y: number, width: number, height: number): void;
    getImageData(x: number, y: number, width: number, height: number): { data: ArrayLike<number> };
  };
};

export interface FingerprintEnv {
  getPdfjs(): Promise<PdfjsLike>;
  createCanvas(width: number, height: number): RenderSurface;
  sha256(bytes: Uint8Array): Promise<string>;
  /** Parámetros extra de `getDocument` (fuentes estándar, fábricas de lienzo…). */
  documentParams?: Record<string, unknown>;
  /** Cede el control al hilo principal (solo tiene sentido allí). */
  yieldToMain?: () => Promise<void>;
}

export type ComputeOptions = {
  signal?: AbortSignal;
  /** Se llama tras cada página: `done` de `total`. */
  onProgress?: (done: number, total: number) => void;
  /** Páginas máximas; más → huella parcial (solo `exact` y `pageCount`). Por defecto `LIBRARY_LIMITS.maxFingerprintPages`. */
  maxPages?: number;
};

/** Lado (px) mayor del render del que sale el dHash; luego se reduce a 32×32 por promedio de áreas. */
export const DHASH_RENDER_SIDE = DHASH_GRID * 4;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FingerprintError("aborted");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Traduce el error de pdf.js al código estable de la huella. */
function toFingerprintError(error: unknown): FingerprintError {
  if (error instanceof FingerprintError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (name === "PasswordException" || /password/i.test(message)) return new FingerprintError("encrypted");
  if (name === "AbortException") return new FingerprintError("aborted");
  return new FingerprintError("corrupt");
}

export async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items as Array<{ str?: unknown; hasEOL?: unknown }>) {
    if (typeof item.str !== "string") continue; // marcas de contenido
    text += item.str;
    if (item.hasEOL === true) text += "\n";
  }
  return text;
}

/** Huella de TEXTO de una página, o `null` si no tiene texto útil (entonces se compara por imagen). */
export async function fingerprintOfText(
  text: string,
  sha256: (bytes: Uint8Array) => Promise<string>,
): Promise<PageFingerprint | null> {
  const normalized = normalizeText(text);
  if (!hasUsefulText(normalized)) return null;
  return { textHash: await sha256(new TextEncoder().encode(normalized)), minhash: minhashOf(wordShingles(normalized)) };
}

/** La página rasterizada y reducida a `DHASH_GRID × DHASH_GRID` en gris (0..255). */
export async function renderGrayGrid(page: PDFPageProxy, env: FingerprintEnv, base: PageSize): Promise<Float32Array> {
  const scale = DHASH_RENDER_SIDE / Math.max(base.width, base.height, 1);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const surface = env.createCanvas(width, height);
  surface.context.fillStyle = "#ffffff";
  surface.context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: surface.context, viewport, intent: "print" } as never).promise;
  const pixels = surface.context.getImageData(0, 0, width, height);
  return resizeGray(grayFromRgba(pixels.data, width, height), width, height, DHASH_GRID, DHASH_GRID);
}

async function pageDhash(page: PDFPageProxy, env: FingerprintEnv, base: PageSize): Promise<string> {
  return dhashFromGray(await renderGrayGrid(page, env, base), DHASH_GRID, DHASH_GRID);
}

/**
 * Calcula la huella de un PDF. `bytes` no se modifica ni se transfiere (pdf.js recibe una copia).
 * Errores: `FingerprintError` con `code` `empty | corrupt | encrypted | aborted | unavailable`.
 * Una página que no se puede leer no tumba el cálculo: queda sin texto y sin dHash (no coincide con nada).
 */
export async function computeFingerprintWith(
  bytes: Uint8Array,
  env: FingerprintEnv,
  options: ComputeOptions = {},
): Promise<Fingerprint> {
  const { signal, onProgress } = options;
  const maxPages = options.maxPages ?? LIBRARY_LIMITS.maxFingerprintPages;
  if (bytes.length === 0) throw new FingerprintError("empty");
  throwIfAborted(signal);

  const exact = await env.sha256(bytes);
  throwIfAborted(signal);

  let pdfjs: PdfjsLike;
  try {
    pdfjs = await env.getPdfjs();
  } catch {
    throw new FingerprintError("unavailable");
  }
  throwIfAborted(signal);

  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    ...env.documentParams,
  });
  const onAbort = () => {
    task.destroy().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let doc: PDFDocumentProxy | null = null;
  try {
    try {
      doc = await task.promise;
    } catch (error) {
      if (signal?.aborted) throw new FingerprintError("aborted");
      throw toFingerprintError(error);
    }
    throwIfAborted(signal);

    const pageCount = doc.numPages;
    if (pageCount > maxPages) {
      return { version: FINGERPRINT_VERSION, exact, pageCount, pageSizes: [], pages: [], partial: "tooManyPages" };
    }

    const pageSizes: PageSize[] = [];
    const pages: PageFingerprint[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      throwIfAborted(signal);
      let size: PageSize = { width: 0, height: 0 };
      let fingerprint: PageFingerprint = { textHash: "", minhash: [] };
      try {
        const page = await doc.getPage(index + 1);
        try {
          const viewport = page.getViewport({ scale: 1 });
          size = { width: round2(viewport.width), height: round2(viewport.height) };
          const textual = await fingerprintOfText(await pageText(page), env.sha256);
          if (textual) {
            fingerprint = textual;
          } else {
            throwIfAborted(signal);
            fingerprint = { textHash: "", minhash: [], dhash: await pageDhash(page, env, size) };
          }
        } finally {
          page.cleanup();
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof FingerprintError && error.code === "aborted")) {
          throw new FingerprintError("aborted");
        }
        // Página ilegible: sin texto ni dHash (nunca coincide), el resto sigue.
      }
      pageSizes.push(size);
      pages.push(fingerprint);
      onProgress?.(index + 1, pageCount);
      if (env.yieldToMain) await env.yieldToMain();
    }
    return { version: FINGERPRINT_VERSION, exact, pageCount, pageSizes, pages };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await task.destroy();
    } catch {
      // Ya estaba destruido.
    }
  }
}
