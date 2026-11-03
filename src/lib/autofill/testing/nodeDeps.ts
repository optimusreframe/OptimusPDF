/**
 * Dependencias del motor para las PRUEBAS (Node): pdf.js en su build «legacy», decodificacion de imagenes y rasterizado con
 * `@napi-rs/canvas`, y un OCR simulado. Nada de esto entra en el paquete de la aplicacion (solo lo importan pruebas).
 */

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prepareImage } from "@/lib/autofill/imagePrep";
import { installScanicEnvironment, releaseScanicCanvases } from "@/lib/scan/__fixtures__/testUtils";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { CROP_MAX_SIDE, ocrRasterScale, type EngineDeps, type RecognizeOptions } from "@/lib/autofill/engine";
import { cropRgba, downscaleRgba } from "@/lib/scan/pixels";
import { wrapPdfJs, type PdfSession } from "@/lib/autofill/pdfSession";
import type { CoverageOps } from "@/lib/pdf/pageTextKind";
import type { OcrResult } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
export function legacyPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export const STANDARD_FONTS_DIR = `${process.cwd()}/public/standard_fonts/`;

/** Abre bytes de PDF con pdf.js «legacy»; `rasterize` dibuja la pagina con `@napi-rs/canvas` (OCR de paginas escaneadas). */
export async function openNodePdf(bytes: Uint8Array, rasterize = true): Promise<PdfSession> {
  const pdfjs = await legacyPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: STANDARD_FONTS_DIR });
  const pdf = (await task.promise) as unknown as PDFDocumentProxy;
  return wrapPdfJs(pdf, {
    ops: pdfjs.OPS as unknown as CoverageOps,
    rasterize: rasterize
      ? async (page, side) => {
          // Igual que `browserDeps` del motor.
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: side ? Math.min(4, side / Math.max(base.width, base.height, 1)) : ocrRasterScale(base.width, base.height) });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
          await page.render({ canvasContext: context, viewport } as never).promise;
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          return { data: new Uint8ClampedArray(image.data), width: canvas.width, height: canvas.height };
        }
      : undefined,
    close: async () => {
      await task.destroy();
    },
  });
}

/** PNG/JPEG -> pixeles RGBA. `maxSide` baja el lado mayor (como `decodeToRgba` de la aplicacion, que usa 2 800). */
export async function decodeWithCanvas(bytes: Uint8Array, maxSide = Infinity): Promise<Rgba> {
  const image = await loadImage(Buffer.from(bytes));
  const k = Math.min(1, maxSide / Math.max(image.width, image.height, 1));
  const width = Math.max(1, Math.round(image.width * k));
  const height = Math.max(1, Math.round(image.height * k));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height);
  return { data: new Uint8ClampedArray(data.data), width, height };
}

export type NodeDepsOptions = {
  /** OCR simulado; sin el, el modelo cuenta como no disponible. */
  recognize?: (image: Rgba, options: RecognizeOptions) => Promise<OcrResult>;
  rasterize?: boolean;
  ocrTimeoutMs?: number;
  /** Cuenta de reconocimientos hechos (para comprobar que el OCR solo se usa cuando hace falta). */
  onRecognize?: () => void;
  onReset?: () => void;
  /** Prepara la imagen antes del OCR con las mismas funciones que la aplicacion (`imagePrep.ts`). */
  prepare?: boolean;
  /** `false` = sin la segunda receta del reintento (para medir cuanto aporta). */
  retry?: boolean;
  /** `true` = con recortes de evidencia y segunda lectura de cada valor leido con OCR (por defecto, sin ellos: las pruebas cuentan las llamadas al OCR). */
  snapshots?: boolean;
};

export function nodeDeps(options: NodeDepsOptions = {}): EngineDeps {
  return {
    openPdf: async (file) => openNodePdf(new Uint8Array(await file.arrayBuffer()), options.rasterize ?? true),
    decodeImage: async (file) => decodeWithCanvas(new Uint8Array(await file.arrayBuffer()), 2800),
    ocrAvailable: async () => options.recognize !== undefined,
    recognize: async (image, o) => {
      options.onRecognize?.();
      if (!options.recognize) throw new Error("sin OCR");
      return options.recognize(image, o);
    },
    resetOcr: async () => {
      options.onReset?.();
    },
    ocrTimeoutMs: options.ocrTimeoutMs,
    snapshot: !options.snapshots ? undefined : async (image) => ({
      regions: async (requests) =>
        requests.map(({ box, url }) => {
          const pixels = cropRgba(image, box.x0 * image.width, box.y0 * image.height, (box.x1 - box.x0) * image.width, (box.y1 - box.y0) * image.height);
          if (!url) return { pixels };
          const small = downscaleRgba(pixels, CROP_MAX_SIDE);
          const canvas = createCanvas(small.width, small.height);
          const context = canvas.getContext("2d");
          const data = context.createImageData(small.width, small.height);
          data.data.set(small.data);
          context.putImageData(data, 0, 0);
          return { pixels, url: `data:image/jpeg;base64,${canvas.toBuffer("image/jpeg", 75).toString("base64")}` };
        }),
    }),
    prepare: options.prepare
      ? async (image, o) => {
          if (o.attempt > 1 || (o.attempt === 1 && options.retry === false)) return null;
          // scanic (deteccion de la hoja) necesita `document.createElement('canvas')` e `ImageData`: en Node se instalan solo mientras corre.
          const restore = installScanicEnvironment();
          try {
            return (await prepareImage(image, { kind: o.kind, attempt: o.attempt, signal: o.signal })).image;
          } finally {
            releaseScanicCanvases();
            restore();
          }
        }
      : undefined,
  };
}
