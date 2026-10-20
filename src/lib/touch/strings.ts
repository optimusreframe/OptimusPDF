"use client";

import { useOptionalLanguage, type Language } from "@/lib/i18n";

/**
 * Textos de las piezas tactiles compartidas (unidad M3). Viven aqui, no en `sign-pdf/strings.ts` ni en `locales/*`,
 * porque las usan a la vez Firmar y PDF Pro (duenos distintos) y el contrato `DocumentCanvasProps` no cambia.
 */
export type TouchStrings = {
  /** Interruptor visible del lienzo: con una herramienta armada, el dedo dibuja en vez de desplazar. */
  drawWithFingerLabel: string;
  drawWithFingerHint: string;
  drawWithFingerOnStatus: string;
  drawWithFingerOffStatus: string;
};

const es: TouchStrings = {
  drawWithFingerLabel: "Dibujar con el dedo",
  drawWithFingerHint:
    "Activado: arrastrar sobre la hoja dibuja el recuadro. Apagado: arrastrar desplaza la página y mantener pulsado antes de arrastrar dibuja.",
  drawWithFingerOnStatus: "Dibujar con el dedo activado: arrastrar sobre la hoja dibuja.",
  drawWithFingerOffStatus: "Dibujar con el dedo apagado: arrastrar desplaza la página.",
};

const en: TouchStrings = {
  drawWithFingerLabel: "Draw with finger",
  drawWithFingerHint:
    "On: dragging on the sheet draws the box. Off: dragging scrolls the page, and pressing and holding before dragging draws.",
  drawWithFingerOnStatus: "Draw with finger on: dragging on the sheet draws.",
  drawWithFingerOffStatus: "Draw with finger off: dragging scrolls the page.",
};

export const TOUCH_STRINGS: Record<Language, TouchStrings> = { es, en };

export function useTouchStrings(): TouchStrings {
  return TOUCH_STRINGS[useOptionalLanguage()];
}
