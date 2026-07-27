import { PDFDocument } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  loadPdf,
  openPdfDocument,
  readFileBytes,
  renderPageToCanvas,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";

/**
 * Motor de censura.
 *
 * Tapar con un rectangulo negro dibujado ENCIMA no censura nada: el
 * texto sigue en el archivo y se recupera con copiar y pegar o con
 * cualquier extractor. Aqui la pagina afectada se aplana de verdad: se
 * rasteriza con pdf.js, se pintan los rectangulos sobre el mapa de bits
 * y se monta una pagina nueva con esa imagen. Lo que quedaba debajo deja
 * de existir en el archivo de salida.
 *
 * CONSECUENCIA REAL: las paginas censuradas se convierten en imagen (su
 * texto deja de ser seleccionable). Las paginas sin rectangulos se
 * copian intactas, asi que un documento largo con una sola censura
 * conserva el resto tal cual.
 *
 * El render usa SIEMPRE `intent: "print"`: con `"display"` pdf.js
 * encadena los pasos con `requestAnimationFrame` y el proceso se congela
 * si la pestana deja de pintar.
 */

/** Rectangulo normalizado 0..1 sobre la pagina renderizada (origen arriba-izquierda). */
export type RedactBox = {
  /** Identificador estable para React keys. */
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RedactOptions = {
  boxes: RedactBox[];
};

export const DEFAULT_REDACT_OPTIONS: RedactOptions = { boxes: [] };

/** Lado minimo de un rectangulo util, en fraccion de pagina. */
export const MIN_BOX_SIDE = 0.01;

/** Resolucion del aplanado: 2x ~ 144 DPI. */
const RASTER_SCALE = 2;
const MAX_RASTER_SIDE = 4000;
const RASTER_QUALITY = 0.85;

/**
 * Negro puro. No es un color de interfaz sino tinta: se pinta sobre el
 * mapa de bits de la pagina, fuera del sistema de tokens del diseno.
 */
const REDACTION_INK = "#000000";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Descarta rectangulos degenerados y recorta a los limites de la pagina. */
export function sanitizeBox(box: RedactBox): RedactBox | null {
  const x = clamp01(Math.min(box.x, box.x + box.width));
  const y = clamp01(Math.min(box.y, box.y + box.height));
  const width = Math.min(1 - x, Math.abs(box.width));
  const height = Math.min(1 - y, Math.abs(box.height));
  if (width < MIN_BOX_SIDE || height < MIN_BOX_SIDE) return null;
  return { ...box, x, y, width, height };
}

function groupByPage(boxes: RedactBox[]): Map<number, RedactBox[]> {
  const grouped = new Map<number, RedactBox[]>();
  for (const box of boxes) {
    const clean = sanitizeBox(box);
    if (!clean) continue;
    const list = grouped.get(clean.pageIndex) ?? [];
    list.push(clean);
    grouped.set(clean.pageIndex, list);
  }
  return grouped;
}

export async function redactPdf(
  file: File,
  options: RedactOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const boxesByPage = groupByPage(options.boxes);
  if (boxesByPage.size === 0) throw new PdfError("empty");

  let viewer: PDFDocumentProxy | null = null;
  try {
    const source = await loadPdf(file);
    const total = source.getPageCount();
    if (total === 0) throw new PdfError("corrupt");

    viewer = await openPdfDocument(file);
    const output = await PDFDocument.create();

    for (let index = 0; index < total; index += 1) {
      const boxes = boxesByPage.get(index);

      if (!boxes || boxes.length === 0) {
        // Pagina sin censuras: se copia tal cual, sin perder calidad.
        const [copied] = await output.copyPages(source, [index]);
        output.addPage(copied);
      } else {
        const page = await viewer.getPage(index + 1);
        // Viewport a escala 1: puntos PDF con la rotacion ya aplicada.
        const base = page.getViewport({ scale: 1 });
        const longest = Math.max(base.width, base.height, 1);
        const scale = Math.max(
          0.1,
          Math.min(RASTER_SCALE, MAX_RASTER_SIDE / longest),
        );

        const canvas = await renderPageToCanvas(page, {
          scale,
          // Obligatorio: rasterizado fuera de pantalla.
          intent: "print",
        });
        const context = canvas.getContext("2d");
        if (!context) {
          throw new PdfError("unknown", "Canvas 2D context unavailable");
        }

        context.fillStyle = REDACTION_INK;
        for (const box of boxes) {
          context.fillRect(
            box.x * canvas.width,
            box.y * canvas.height,
            box.width * canvas.width,
            box.height * canvas.height,
          );
        }

        const jpeg = await canvasToBlob(canvas, "image/jpeg", RASTER_QUALITY);
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
      }

      onProgress?.(((index + 1) / total) * 0.92);
    }

    const blob = await savePdfToBlob(output);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (viewer) await closePdfDocument(viewer);
  }
}
