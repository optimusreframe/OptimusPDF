"use client";

import { useSyncExternalStore } from "react";

/**
 * Niveles de ancho de la interfaz (contrato de la unidad M3 para Firmar y Pro).
 *
 *  - `phone`   : menos de 768 px (iPhone, iPad mini en vertical con Split View...): hojas, barra inferior, una columna.
 *  - `tablet`  : de 768 a 1023 px (iPad Pro 11" en VERTICAL, 834 px; tabletas Android de 800 px): una columna ancha de
 *                documento con el panel de opciones en una hoja, no al lado. Con tres columnas la hoja se quedaba en
 *                ~300 px de 834 (GE-02).
 *  - `desktop` : 1024 px o mas: paneles laterales.
 *
 * Ademas `coarse` (puntero grueso: dedo o Pencil) permite plegar la barra lateral global en un iPad HORIZONTAL (1194 px)
 * sin tocar el escritorio con raton (GE-04): `useViewportTier().compact` es `true` con dedo y menos de 1280 px.
 */
export type ViewportTier = "phone" | "tablet" | "desktop";

export const TABLET_MIN_WIDTH = 768;
export const DESKTOP_MIN_WIDTH = 1024;
/** Por debajo de este ancho, con puntero grueso, la suite plegaria la barra lateral global. */
export const COMPACT_CHROME_MAX_WIDTH = 1280;

export const TABLET_QUERY = `(min-width: ${TABLET_MIN_WIDTH}px)`;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
export const WIDE_QUERY = `(min-width: ${COMPACT_CHROME_MAX_WIDTH}px)`;
export const COARSE_QUERY = "(pointer: coarse)";

/** Nivel de un ancho (px): la regla, sin DOM. */
export function viewportTierOf(width: number): ViewportTier {
  if (width < TABLET_MIN_WIDTH) return "phone";
  if (width < DESKTOP_MIN_WIDTH) return "tablet";
  return "desktop";
}

export type ViewportInfo = {
  tier: ViewportTier;
  /** Puntero grueso (dedo / Pencil). */
  coarse: boolean;
  /** Dedo y menos de 1280 px: conviene plegar la barra lateral global y dar el ancho a la hoja. */
  compact: boolean;
};

const QUERIES = [TABLET_QUERY, DESKTOP_QUERY, WIDE_QUERY, COARSE_QUERY] as const;

function matches(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

/** Instantanea en un solo texto estable (`useSyncExternalStore` compara por `Object.is`). */
function getSnapshot(): string {
  // Sin `matchMedia` (jsdom) se asume escritorio con raton.
  return [matches(TABLET_QUERY, true), matches(DESKTOP_QUERY, true), matches(WIDE_QUERY, true), matches(COARSE_QUERY, false)]
    .map((value) => (value ? "1" : "0"))
    .join("");
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const lists = QUERIES.map((query) => window.matchMedia(query));
  lists.forEach((list) => list.addEventListener("change", onChange));
  return () => lists.forEach((list) => list.removeEventListener("change", onChange));
}

export function parseViewportSnapshot(snapshot: string): ViewportInfo {
  const [tablet, desktop, wide, coarse] = snapshot.split("").map((flag) => flag === "1");
  const tier: ViewportTier = desktop ? "desktop" : tablet ? "tablet" : "phone";
  return { tier, coarse, compact: coarse && !wide };
}

/** Nivel de ancho vigente; reacciona a girar el aparato o a cambiar el ancho de la ventana (Split View). */
export function useViewportTier(): ViewportInfo {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => "1110");
  return parseViewportSnapshot(snapshot);
}
