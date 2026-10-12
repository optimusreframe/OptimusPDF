import type { NormalizedRect } from "@/lib/pdf/core";

/**
 * GANCHO `cropOverlay` (Wave 7 · U5 → U3). Puente minimo entre el panel de «Recortar» y el visor continuo:
 * hoy el recorte se define con margenes numericos; cuando el visor tenga su capa de arrastre, solo tiene
 * que hablar con este modulo (sin importar el panel ni al reves):
 *
 *  - El PANEL publica la seleccion actual con `publishCropOverlay({ rect, pageIndex })` cada vez que
 *    cambian los margenes, y la retira con `publishCropOverlay(null)` al cerrarse. `rect` es normalizado
 *    (0..1, origen arriba-izquierda) sobre la pagina `pageIndex` (0-based): el visor pinta el marco.
 *  - El VISOR, cuando la persona arrastra un tirador, llama a `requestCropRect(rect)`; el panel esta
 *    suscrito (`subscribeCropRequests`) y lo convierte de vuelta en margenes (`rectToMargins`).
 *  - `getCropOverlay()` / `subscribeCropOverlay()` permiten al visor leer y reaccionar al estado publicado
 *    (compatibles con `useSyncExternalStore`).
 *
 * Es un store a nivel de modulo, en memoria, sin persistencia.
 */

export type CropOverlayState = {
  /** Area que se CONSERVA, normalizada sobre la pagina `pageIndex`. */
  rect: NormalizedRect;
  /** Pagina de referencia (0-based). */
  pageIndex: number;
};

let state: CropOverlayState | null = null;
const stateListeners = new Set<() => void>();
const requestListeners = new Set<(rect: NormalizedRect) => void>();

/** Publica (o retira con `null`) la seleccion que el visor debe pintar. */
export function publishCropOverlay(next: CropOverlayState | null): void {
  state = next;
  for (const listener of [...stateListeners]) listener();
}

export function getCropOverlay(): CropOverlayState | null {
  return state;
}

export function subscribeCropOverlay(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** El visor pide una seleccion nueva (arrastre de un tirador). Sin panel suscrito no pasa nada. */
export function requestCropRect(rect: NormalizedRect): void {
  for (const listener of [...requestListeners]) listener(rect);
}

export function subscribeCropRequests(listener: (rect: NormalizedRect) => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

/** Solo para pruebas. */
export function __resetCropOverlayForTests(): void {
  state = null;
  stateListeners.clear();
  requestListeners.clear();
}
