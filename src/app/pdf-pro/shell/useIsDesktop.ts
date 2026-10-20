"use client";

import { useSyncExternalStore } from "react";

/** Desde `md` (768 px) la suite usa paneles laterales; por debajo, hojas y barra inferior. */
export const PRO_DESKTOP_QUERY = "(min-width: 768px)";
/**
 * Un movil horizontal (852×393, 800×360) mide mas de 768 px pero no tiene alto para tres filas de pestañas, barras y
 * paneles: por debajo de este alto la suite usa el reparto movil (hojas) con el dock como raíl lateral.
 */
export const PRO_SHORT_QUERY = "(max-height: 479.98px)";
/** Por debajo de este alto (SE, horizontales, Android pequeños) las barras de un modo arrancan plegadas. */
export const PRO_COMPACT_HEIGHT_QUERY = "(max-height: 719.98px)";
/** Dedo (o lapiz) como puntero principal: iPhone, iPad, Android. Ahi no hay Esc, ni clic, ni hover. */
export const PRO_COARSE_QUERY = "(pointer: coarse)";

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribeTo(queries: readonly string[]) {
  return (onChange: () => void): (() => void) => {
    if (!hasMatchMedia()) return () => {};
    const lists = queries.map((query) => window.matchMedia(query));
    for (const list of lists) list.addEventListener("change", onChange);
    return () => {
      for (const list of lists) list.removeEventListener("change", onChange);
    };
  };
}

const subscribeDesktop = subscribeTo([PRO_DESKTOP_QUERY, PRO_SHORT_QUERY]);
const subscribeShort = subscribeTo([PRO_SHORT_QUERY]);
const subscribeCompact = subscribeTo([PRO_COMPACT_HEIGHT_QUERY]);
const subscribeCoarse = subscribeTo([PRO_COARSE_QUERY]);

function matches(query: string): boolean {
  return hasMatchMedia() && window.matchMedia(query).matches === true;
}

function desktopSnapshot(): boolean {
  // Sin `matchMedia` (jsdom, navegadores muy viejos) se asume escritorio.
  if (!hasMatchMedia()) return true;
  return matches(PRO_DESKTOP_QUERY) && !matches(PRO_SHORT_QUERY);
}

/** `true` con el ancho Y el alto de escritorio; reacciona a girar el telefono o redimensionar la ventana. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => true);
}

/** `true` en un movil horizontal (poco alto): ahi el dock pasa a un raíl lateral y las barras se compactan. */
export function useIsShortViewport(): boolean {
  return useSyncExternalStore(subscribeShort, () => matches(PRO_SHORT_QUERY), () => false);
}

/** `true` si el alto es de movil pequeño u horizontal: las barras de un modo arrancan plegadas. */
export function useIsCompactHeight(): boolean {
  return useSyncExternalStore(subscribeCompact, () => matches(PRO_COMPACT_HEIGHT_QUERY), () => false);
}

/** `true` si el puntero principal es un dedo: los textos de ayuda hablan de «toca», no de «haz clic» ni de «Esc». */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, () => matches(PRO_COARSE_QUERY), () => false);
}
