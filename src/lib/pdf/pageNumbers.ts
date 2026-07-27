import { degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  hexToPdfColor,
  loadPdf,
  originForCenter,
  savePdfToBlob,
  standardFontFor,
  toPdfError,
  toWinAnsiSafe,
  viewPointToUser,
  type PdfFontFamily,
  type ProgressCallback,
} from "@/lib/pdf/core";
import type { GridAnchor } from "@/lib/pdf/watermark";

/**
 * Motor de numeracion de paginas: escribe un texto por pagina con
 * `drawText` respetando ancla, margen, rango y formato.
 */

export type PageNumberMode = "single" | "facing";
export type PageNumberMargin = "small" | "recommended" | "large";

/** Distancia del texto al borde visible, en puntos. */
export const MARGIN_POINTS: Record<PageNumberMargin, number> = {
  small: 18,
  recommended: 34,
  large: 56,
};

export type PageNumbersOptions = {
  mode: PageNumberMode;
  anchor: GridAnchor;
  margin: PageNumberMargin;
  /** Numero impreso en la primera pagina del rango. */
  firstNumber: number;
  /** Rango 1..N inclusive. 0 en `toPage` significa "hasta el final". */
  fromPage: number;
  toPage: number;
  /** Plantilla con los marcadores {n} (numero) y {p} (total). */
  template: string;
  fontFamily: PdfFontFamily;
  fontSize: number;
  color: string;
};

export const NUMBER_TEMPLATE = "{n}";

export const DEFAULT_PAGE_NUMBERS_OPTIONS: PageNumbersOptions = {
  mode: "single",
  anchor: "bottom-center",
  margin: "recommended",
  firstNumber: 1,
  fromPage: 1,
  toPage: 0,
  template: NUMBER_TEMPLATE,
  fontFamily: "helvetica",
  fontSize: 12,
  color: "#000000",
};

/** Sustituye {n} y {p}. Cualquier otro texto se respeta tal cual. */
export function formatPageLabel(
  template: string,
  current: number,
  total: number,
): string {
  const safe = template.trim().length === 0 ? NUMBER_TEMPLATE : template;
  return safe.replaceAll("{n}", String(current)).replaceAll("{p}", String(total));
}

/**
 * En modo "paginas enfrentadas" el lado horizontal se invierte en las
 * paginas pares (las de la izquierda de un pliego). El centro no cambia.
 */
function anchorForPage(
  anchor: GridAnchor,
  mode: PageNumberMode,
  physicalPageNumber: number,
): GridAnchor {
  if (mode !== "facing" || physicalPageNumber % 2 !== 0) return anchor;
  if (anchor.endsWith("-left")) {
    return anchor.replace("-left", "-right") as GridAnchor;
  }
  if (anchor.endsWith("-right")) {
    return anchor.replace("-right", "-left") as GridAnchor;
  }
  return anchor;
}

export async function addPageNumbers(
  file: File,
  options: PageNumbersOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const document = await loadPdf(file);
    onProgress?.(0.15);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const from = Math.min(
      Math.max(1, Math.floor(options.fromPage) || 1),
      pages.length,
    );
    const rawTo = Math.floor(options.toPage) || pages.length;
    const to = Math.min(Math.max(from, rawTo), pages.length);

    const font = await document.embedFont(
      standardFontFor(options.fontFamily, false, false),
    );
    const color = hexToPdfColor(options.color);
    const size = Math.min(96, Math.max(5, options.fontSize));
    const margin = MARGIN_POINTS[options.margin];
    const start = Math.max(0, Math.floor(options.firstNumber));
    const count = to - from + 1;
    /**
     * El total {p} es el ultimo numero asignado, no el total de paginas
     * del documento: asi "3 de 10" sigue siendo cierto cuando el usuario
     * numera solo una parte o empieza en otro numero.
     */
    const total = start + count - 1;

    onProgress?.(0.25);

    for (let index = from - 1; index <= to - 1; index += 1) {
      const page = pages[index];
      const geometry = getPageGeometry(page);
      const label = toWinAnsiSafe(
        formatPageLabel(options.template, start + (index - (from - 1)), total),
      );
      if (label.length === 0) continue;

      const width = font.widthOfTextAtSize(label, size);
      const height = font.heightAtSize(size);
      const baselineOffset =
        height - font.heightAtSize(size, { descender: false });

      const anchor = anchorForPage(options.anchor, options.mode, index + 1);
      const [vertical, horizontal] = anchor.split("-");

      let vx: number;
      if (horizontal === "left") vx = margin + width / 2;
      else if (horizontal === "right") {
        vx = geometry.viewWidth - margin - width / 2;
      } else vx = geometry.viewWidth / 2;

      let vy: number;
      if (vertical === "top") vy = geometry.viewHeight - margin - height / 2;
      else if (vertical === "bottom") vy = margin + height / 2;
      else vy = geometry.viewHeight / 2;

      const center = viewPointToUser(geometry, vx, vy);
      const origin = originForCenter(
        center.x,
        center.y,
        width,
        height,
        baselineOffset,
        geometry.rotation,
      );

      page.drawText(label, {
        x: origin.x,
        y: origin.y,
        size,
        font,
        color,
        rotate: degrees(geometry.rotation),
      });

      onProgress?.(0.25 + ((index - from + 1) / count) * 0.7);
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
