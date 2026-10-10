import {
  geometryFromPdfJsPage,
  makeMetrics,
  type PageMetrics,
} from "@/app/edit-pdf/editCanvasMath";
import type { SourceFontInfo, TextBlock, TextEdit } from "@/lib/pdf/editTypes";

/**
 * Utilidades SOLO PARA PRUEBAS del editor inline (W5-U4a): bloques y metricas
 * de pagina sinteticos. La aplicacion no importa este archivo.
 */

export const HELVETICA: SourceFontInfo = {
  pdfName: "Helvetica",
  family: "sans",
  bold: false,
  italic: false,
  subset: false,
  embedded: false,
  symbolic: false,
  type3: false,
};

export const CALIBRI: SourceFontInfo = { ...HELVETICA, pdfName: "ABCDEF+Calibri", subset: true, embedded: true };

export function makeBlock(id: string, partial: Partial<TextBlock> = {}): TextBlock {
  const box = partial.box ?? { x: 50, y: 700, width: 200, height: 14 };
  const text = partial.text ?? "Hola mundo";
  return {
    id,
    pageIndex: 0,
    box,
    text,
    lines: [{ text, box, baseline: box.y + 3 }],
    fontSize: 12,
    color: "#000000",
    rotation: 0,
    align: "left",
    font: HELVETICA,
    editable: true,
    origHash: `h-${id}`,
    ...partial,
  };
}

/** Pagina A4 sin giro, 1 px por punto (la geometria sale redonda en las pruebas). */
export function metricsFor(
  view: readonly number[] = [0, 0, 595, 842],
  rotate = 0,
  cssWidth?: number,
): PageMetrics {
  const geometry = geometryFromPdfJsPage({ view, rotate });
  return makeMetrics(geometry, cssWidth ?? geometry.viewWidth);
}

export function makeEdit(partial: Partial<TextEdit> & { id: string }): TextEdit {
  return {
    pageIndex: 0,
    box: { x: 50, y: 700, width: 200, height: 14 },
    text: "Editado",
    fontSize: 12,
    color: "#000000",
    align: "left",
    fontKey: "helvetica",
    bold: false,
    italic: false,
    rotation: 0,
    cover: { color: null, padding: 0 },
    ...partial,
  };
}
