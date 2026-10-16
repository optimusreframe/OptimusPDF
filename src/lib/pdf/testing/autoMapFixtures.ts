/*
 * Constructores de `PageData` a mano para probar el analisis de pagina del automapeo sin generar PDFs. Todo en el
 * espacio de vista (puntos, origen ABAJO-izquierda). Una carta tiene 612 x 792 pt.
 */

import type { PageData } from "@/lib/pdf/autoMapCollect";
import type { RawText, Seg } from "@/lib/pdf/detectSlots";

export const LETTER_W = 612;
export const LETTER_H = 792;
/** Tamano de letra de los rotulos de prueba y «em» de disposicion de una carta (1,8 % del ancho). */
export const FONT = 11;

/** Un texto con su posicion: `left`, `baseline` en pt; el ancho se estima (0,5 de la letra por caracter) si no se da. */
export function text(str: string, left: number, baseline: number, size = FONT, width?: number): RawText {
  const w = width ?? str.length * size * 0.5;
  return { text: str.trim(), raw: str, left, right: left + w, baseline, height: size };
}

export function hline(x0: number, x1: number, y: number, thickness = 0.7): Seg {
  return { x0, x1, y, thickness, fromText: -1 };
}

export type PageInput = {
  texts?: RawText[];
  segments?: Seg[];
  verticals?: Array<{ x: number; y0: number; y1: number }>;
  boxes?: Array<{ x0: number; y0: number; x1: number; y1: number; fill?: boolean; stroke?: boolean; shade?: number }>;
  images?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  width?: number;
  height?: number;
  pageIndex?: number;
};

export function pageData(input: PageInput): PageData {
  return {
    pageIndex: input.pageIndex ?? 0,
    width: input.width ?? LETTER_W,
    height: input.height ?? LETTER_H,
    texts: input.texts ?? [],
    segments: input.segments ?? [],
    dashes: [],
    verticals: input.verticals ?? [],
    boxes: input.boxes ?? [],
    images: input.images ?? [],
    opCount: 0,
    truncated: false,
  };
}

/** Parrafo de relleno de `lines` renglones desde `top` (y hacia abajo) para que haya «cuerpo» de contrato. */
export function filler(lines: number, top = 700, left = 72, step = 14): RawText[] {
  return Array.from({ length: lines }, (_, index) =>
    text("The parties agree that the services described herein will be performed in a workmanlike manner and in accordance with law.", left, top - index * step, FONT, 468),
  );
}
