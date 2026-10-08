"use client";

import { useSyncExternalStore } from "react";

/*
 * Estado "hay contenido desplazado bajo la barra" para el efecto de borde
 * de scroll (utilidades `scroll-edge-bottom` / `scroll-edge-top` en
 * globals.css). Un unico listener de scroll/resize compartido por todas
 * las barras; cada una lee el borde que le interesa:
 *   - "top": la barra esta pegada arriba -> hay contenido por encima del
 *     viewport (scrollY > 0).
 *   - "bottom": la barra esta pegada abajo -> hay contenido por debajo
 *     del viewport (no se ha llegado al final).
 * Snapshot del servidor: false (sin borde hasta hidratar).
 *
 * Rendimiento: `scrollHeight` NO se lee en cada evento de scroll -- con
 * estilos pendientes (una transicion de hover en marcha) esa lectura
 * fuerza un layout sincrono por evento y se notaba en frames largos a
 * CPU x4. Se cachea y se recalcula solo cuando cambia el tamaño del
 * documento (ResizeObserver sobre body) o de la ventana. `scrollY` e
 * `innerHeight` no fuerzan layout.
 */

type Edge = "top" | "bottom";

const listeners = new Set<() => void>();
let attached = false;
let documentHeight = 0;
let resizeObserver: ResizeObserver | null = null;

function measureDocument(): void {
  documentHeight = document.documentElement.scrollHeight;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onResize(): void {
  measureDocument();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!attached && typeof window !== "undefined") {
    attached = true;
    measureDocument();
    window.addEventListener("scroll", notify, { passive: true });
    window.addEventListener("resize", onResize);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(document.body);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && attached) {
      attached = false;
      window.removeEventListener("scroll", notify);
      window.removeEventListener("resize", onResize);
      resizeObserver?.disconnect();
      resizeObserver = null;
    }
  };
}

/** Alto del documento cacheado (0 antes de montar); lo comparte el scroll-spy. */
export function getDocumentHeight(): number {
  if (documentHeight === 0 && typeof document !== "undefined") measureDocument();
  return documentHeight;
}

function readTop(): boolean {
  return window.scrollY > 0;
}

function readBottom(): boolean {
  return window.scrollY + window.innerHeight < getDocumentHeight() - 1;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useScrollEdge(edge: Edge): boolean {
  return useSyncExternalStore(
    subscribe,
    edge === "top" ? readTop : readBottom,
    getServerSnapshot,
  );
}
