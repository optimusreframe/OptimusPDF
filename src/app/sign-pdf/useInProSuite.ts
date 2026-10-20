"use client";

import { useSyncExternalStore } from "react";

function subscribe(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pro-suite"] });
  return () => observer.disconnect();
}

/**
 * `true` cuando Firmar se monta DENTRO de la suite de PDF Pro (`ProToolClient` escribe `data-pro-suite` en `<html>`): ahi
 * el desplazamiento es el de su region central, no hay barra «Opciones/Procesar» ni tab bar fijas, y el layout de tablet y
 * de movil lo gobierna esa suite. Se lee en el primer render del cliente (sin parpadeo); en el servidor, `false`.
 */
export function useInProSuite(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.hasAttribute("data-pro-suite"),
    () => false,
  );
}
