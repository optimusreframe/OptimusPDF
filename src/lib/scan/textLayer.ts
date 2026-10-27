import { TextRenderingMode, type PDFDocument, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { toWinAnsiSafe } from "@/lib/pdf/core";
import { MARGIN_POINTS } from "@/lib/pdf/photoGrid";
import type { OcrResult } from "@/lib/scan/ocr";

/**
 * Capa de texto INVISIBLE (modo de render 3 del estandar PDF) alineada con la imagen de una pagina escaneada: el PDF se ve
 * igual pero el texto se puede buscar y seleccionar. Mismo enfoque que `src/lib/pdf/ocr.ts` pero para paginas que son una
 * imagen centrada dentro del area util (A4 / Carta / Ajustar con margen).
 */

/** Proporcion de la altura de la caja que se usa como cuerpo de letra. */
const FONT_SIZE_RATIO = 0.8;
const MIN_WORD_CONFIDENCE = 30;

export type ImagePlacement = { x: number; y: number; width: number; height: number };

/** Donde queda la imagen (de proporcion `aspect` = ancho/alto) en una pagina de `pw` x `ph` con margen `margin`: centrada, sin deformar. */
export function imagePlacement(pageWidth: number, pageHeight: number, margin: number, aspect: number): ImagePlacement {
  const boxW = Math.max(1, pageWidth - margin * 2);
  const boxH = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(boxW / aspect, boxH);
  const height = scale;
  const width = scale * aspect;
  return { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height };
}

export type TextLayerStats = { words: number; skipped: number };

/** Dibuja las palabras reconocidas sobre la pagina `page` (ya con su imagen). */
export function drawTextLayer(page: PDFPage, font: PDFFont, ocr: OcrResult, margin: number): TextLayerStats {
  const { width: pw, height: ph } = page.getSize();
  const place = imagePlacement(pw, ph, margin, ocr.width / ocr.height);
  const kx = place.width / ocr.width;
  const ky = place.height / ocr.height;
  let words = 0;
  let skipped = 0;
  for (const line of ocr.lines) {
    for (const word of line.words) {
      if (word.confidence < MIN_WORD_CONFIDENCE) {
        skipped += 1;
        continue;
      }
      const text = toWinAnsiSafe(word.text).trim();
      const w = (word.bbox.x1 - word.bbox.x0) * kx;
      const h = (word.bbox.y1 - word.bbox.y0) * ky;
      if (text.length === 0 || w <= 0 || h <= 0) {
        skipped += 1;
        continue;
      }
      const size = Math.min(200, Math.max(1, h * FONT_SIZE_RATIO));
      const x = place.x + word.bbox.x0 * kx;
      const y = place.y + place.height - word.bbox.y1 * ky;
      let characterSpacing = 0;
      try {
        characterSpacing = (w - font.widthOfTextAtSize(text, size)) / text.length;
      } catch {
        skipped += 1;
        continue;
      }
      const limit = size * 0.5;
      characterSpacing = Math.min(limit, Math.max(-limit, characterSpacing));
      try {
        page.drawText(text, { x, y, size, font, characterSpacing, renderMode: TextRenderingMode.Invisible });
        words += 1;
      } catch {
        // Caracter no codificable por la fuente estandar: se omite la palabra, no el documento.
        skipped += 1;
      }
    }
  }
  return { words, skipped };
}

/** Margen en puntos de una opcion de margen del PDF. */
export function marginPoints(margin: "none" | "small" | "large"): number {
  return MARGIN_POINTS[margin];
}

export type { PDFDocument };
