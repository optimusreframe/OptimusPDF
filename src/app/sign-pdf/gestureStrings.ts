"use client";

import { useOptionalLanguage, type Language } from "@/lib/i18n";

/*
 * Textos (ES/EN) de la herramienta que se queda armada y de los gestos del lienzo (W3-A3): el interruptor «Un dedo
 * dibuja», su pista de la primera vez, la etiqueta de la herramienta activa y el aviso al colocar. Un modulo propio para no
 * mezclarse con `strings.ts` (compartido por otros constructores). Las piezas compartidas con la paleta
 * (`toolSelect`, `toolArmedStatus`...) siguen viniendo de `SignStrings`.
 */
export type GestureStrings = {
  /** Interruptor visible del lienzo (puntero grueso, herramienta de creacion armada). */
  fingerSwitchLabel: string;
  fingerSwitchHint: string;
  fingerOnStatus: string;
  fingerOffStatus: string;
  /** Pista de la primera vez (y texto que lee la region viva al activarse). */
  fingerHint: string;
  /** Etiqueta de la herramienta activa junto a la paleta ("Herramienta: Iniciales"). */
  armedLabel: (tool: string) => string;
  armedHint: string;
  /**
   * Nombre accesible del boton que sale de la herramienta armada: EMPIEZA por su texto visible ("Seleccionar") y se distingue
   * del boton «Seleccionar» de la paleta, que hace lo mismo (WCAG 2.5.3 y nombres unicos).
   */
  exitToolLabel: (select: string) => string;
  /** Anuncio al colocar con la herramienta aun armada. */
  placedStillArmed: (tool: string) => string;
};

const es: GestureStrings = {
  fingerSwitchLabel: "Un dedo dibuja",
  fingerSwitchHint:
    "Activado: un dedo dibuja sobre la hoja y dos dedos mueven la página. Apagado: un dedo desplaza la página y, si lo mantienes quieto un momento antes de arrastrar, dibuja. El lápiz siempre dibuja.",
  fingerOnStatus: "Un dedo dibuja. Para mover la página usa dos dedos.",
  fingerOffStatus:
    "Un dedo desplaza la página. Mantén el dedo quieto un momento antes de arrastrar para dibujar.",
  fingerHint: "Un dedo dibuja · dos dedos mueven la página",
  armedLabel: (tool) => `Herramienta: ${tool}`,
  armedHint: "Toca la hoja para añadir. Sigue activa hasta que elijas otra.",
  exitToolLabel: (select) => `${select}: dejar de añadir con esta herramienta`,
  placedStillArmed: (tool) =>
    `Añadido: ${tool}. La herramienta sigue activa; elige Seleccionar para terminar.`,
};

const en: GestureStrings = {
  fingerSwitchLabel: "One finger draws",
  fingerSwitchHint:
    "On: one finger draws on the sheet and two fingers move the page. Off: one finger scrolls the page and, if you hold it still for a moment before dragging, draws. The pencil always draws.",
  fingerOnStatus: "One finger draws. Use two fingers to move the page.",
  fingerOffStatus: "One finger scrolls the page. Hold still for a moment before dragging to draw.",
  fingerHint: "One finger draws · two fingers move the page",
  armedLabel: (tool) => `Tool: ${tool}`,
  armedHint: "Tap the sheet to add. It stays on until you pick another.",
  exitToolLabel: (select) => `${select}: stop adding with this tool`,
  placedStillArmed: (tool) => `Added: ${tool}. The tool stays on; choose Select to finish.`,
};

export const GESTURE_STRINGS: Record<Language, GestureStrings> = { es, en };

export function useGestureStrings(): GestureStrings {
  return GESTURE_STRINGS[useOptionalLanguage()];
}
