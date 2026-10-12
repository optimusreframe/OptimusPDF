"use client";

import { useSyncExternalStore } from "react";

/** Desde `md` (768 px) la suite usa paneles laterales; por debajo, hojas y barra inferior. */
export const PRO_DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(PRO_DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  // Sin `matchMedia` (jsdom, navegadores muy viejos) se asume escritorio.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(PRO_DESKTOP_QUERY).matches;
}

/** `true` con el ancho de escritorio; reacciona a girar el telefono o redimensionar la ventana. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
