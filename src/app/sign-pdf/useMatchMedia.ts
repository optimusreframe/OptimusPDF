"use client";

import { useSyncExternalStore } from "react";

/**
 * Como `useMediaQuery`, pero con el valor REAL ya en el primer render del cliente: sin el parpadeo de «primero el
 * layout de escritorio y luego el movil» (la paleta se veia abierta un fotograma antes de plegarse; el panel «Opciones»
 * de tablet, antes de desaparecer). En el servidor y sin `matchMedia` (jsdom) vale `false`. Solo para componentes que se
 * pintan en el cliente tras una accion (el lienzo y sus paneles), nunca en el HTML inicial del servidor.
 */
export function useMatchMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}
