import { computeFingerprintWith, type FingerprintEnv, type PdfjsLike } from "./fingerprintEngine";
import type { FingerprintWorkerRequest, FingerprintWorkerResponse } from "./fingerprintProtocol";
import { sha256Hex } from "../crypto/sha256";
import { FingerprintError } from "./types";

/**
 * Worker de la huella: todo el cálculo (SHA-256, pdf.js, texto, MinHash, rasterizado del dHash) fuera del hilo
 * principal. pdf.js, dentro de un worker, no puede crear su propio worker (no tiene `window`) y cae a su modo «sin
 * worker»: corre en ESTE hilo, que es justo lo que se quiere. Sin DOM: el lienzo es `OffscreenCanvas`, y como pdf.js
 * por defecto usaría `document` para fábricas de lienzo y de filtros, se le dan versiones sin DOM.
 */

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FingerprintWorkerRequest>) => void) | null;
  postMessage(message: FingerprintWorkerResponse): void;
};

type OffscreenSurface = { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D };

class OffscreenCanvasFactory {
  create(width: number, height: number): OffscreenSurface {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2d context unavailable");
    return { canvas, context };
  }
  reset(surface: OffscreenSurface, width: number, height: number): void {
    surface.canvas.width = width;
    surface.canvas.height = height;
  }
  destroy(surface: { canvas: OffscreenCanvas | null; context: unknown }): void {
    if (surface.canvas) surface.canvas.width = surface.canvas.height = 0;
    surface.canvas = null;
    surface.context = null;
  }
}

/** pdf.js pide filtros SVG (alto contraste, funciones de transferencia) a un DOM que aquí no existe: sin filtros. */
class NoFilterFactory {
  addFilter(): string {
    return "none";
  }
  addHCMFilter(): string {
    return "none";
  }
  addAlphaFilter(): string {
    return "none";
  }
  addLuminosityFilter(): string {
    return "none";
  }
  addHighlightHCMFilter(): string {
    return "none";
  }
  destroy(): void {}
}

async function loadPdfjs(workerSrc: string): Promise<PdfjsLike> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjs as unknown as PdfjsLike;
}

function post(message: FingerprintWorkerResponse): void {
  scope.postMessage(message);
}

scope.onmessage = async (event) => {
  const request = event.data;
  if (!request || request.type !== "compute") return;
  const env: FingerprintEnv = {
    getPdfjs: () => loadPdfjs(request.pdfjsWorkerSrc),
    createCanvas: (width, height) => new OffscreenCanvasFactory().create(width, height),
    sha256: sha256Hex,
    documentParams: {
      standardFontDataUrl: request.standardFontDataUrl,
      CanvasFactory: OffscreenCanvasFactory,
      FilterFactory: NoFilterFactory,
    },
  };
  try {
    const fingerprint = await computeFingerprintWith(request.bytes, env, {
      maxPages: request.maxPages,
      onProgress: (done, total) => post({ type: "progress", id: request.id, done, total }),
    });
    post({ type: "result", id: request.id, fingerprint });
  } catch (error) {
    const code = error instanceof FingerprintError ? error.code : "unavailable";
    post({ type: "error", id: request.id, code });
  }
};

export {};
