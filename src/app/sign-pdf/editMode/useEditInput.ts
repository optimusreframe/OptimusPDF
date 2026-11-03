"use client";

import { useEffect, type RefObject } from "react";

/*
 * Entradas SIN dedos del modo «Editar campos» (W3-B1): rueda y trackpad (Ctrl + rueda, el pellizco del trackpad de Safari) y
 * teclado (+ − 0, flechas, Re Pag / Av Pag, deshacer, copiar, pegar, duplicar, ayuda). Todo se escucha aqui, una sola vez, y
 * se resuelve contra las funciones VIVAS del lienzo (`api`), que se refrescan en cada pintado: el hook nunca lee un cierre
 * viejo. Los dedos y el lapiz los gobierna el propio lienzo (`DocumentCanvas`, ver `canvasGestures.ts`).
 */

export type EditInputApi = {
  /** Multiplica el zoom por `factor` manteniendo quieto el punto de pantalla `anchor` (o el centro de lo libre si es `null`). */
  zoomBy: (factor: number, anchor: { x: number; y: number } | null) => void;
  zoomStep: (direction: 1 | -1) => void;
  zoomFit: () => void;
  /** Mueve la hoja (px de pantalla). Devuelve `true` si se movio algo. */
  panBy: (dx: number, dy: number) => boolean;
  hasSelection: () => boolean;
  /** Mueve el elemento seleccionado (fracciones de pagina). */
  nudge: (dx: number, dy: number) => void;
  stepPage: (direction: 1 | -1) => void;
  undo: () => void;
  redo: () => void;
  copy: () => void;
  paste: () => void;
  duplicate: () => void;
  help: () => void;
};

/** Cuanto se mueve la hoja con una flecha (px) y cuanto un elemento (fraccion de pagina). */
const PAN_STEP_PX = 60;
const NUDGE_STEP = 0.004;
const NUDGE_STEP_FAST = 0.02;

function isTypingTarget(target: Element | null): boolean {
  if (!target) return false;
  if (/^(input|textarea|select)$/i.test(target.tagName)) return true;
  if ((target as HTMLElement).isContentEditable) return true;
  const role = target.getAttribute("role");
  return role === "textbox" || role === "combobox" || role === "searchbox" || role === "spinbutton";
}

/** El foco esta en un control que usa las flechas para lo suyo (barra de herramientas, pestanas, deslizador...). */
function ownsArrowKeys(target: Element | null): boolean {
  if (!target) return false;
  return Boolean(
    target.closest(
      '[role="toolbar"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="listbox"], [data-edit-dock], input, select, textarea',
    ),
  );
}

export function useEditInput({
  enabled,
  surfaceRef,
  apiRef,
  containerRef,
}: {
  enabled: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  apiRef: RefObject<EditInputApi | null>;
  /** Nodo del modo (para saber si una tecla viene de dentro o de una hoja que se abrio encima). */
  containerRef: RefObject<HTMLElement | null>;
}) {
  /* Rueda y trackpad. */
  useEffect(() => {
    if (!enabled) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    const onWheel = (event: WheelEvent) => {
      const api = apiRef.current;
      if (!api) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        // Pellizco del trackpad (llega como Ctrl + rueda) o Ctrl + rueda: zoom alrededor del puntero.
        event.preventDefault();
        api.zoomBy(Math.exp((-event.deltaY * unit) / 240), { x: event.clientX, y: event.clientY });
        return;
      }
      // La rueda mueve la hoja (dos dedos en el trackpad); si no hay donde moverla, no se traga el gesto.
      if (api.panBy(-event.deltaX * unit, -event.deltaY * unit)) event.preventDefault();
    };

    // Safari de escritorio manda el pellizco del trackpad como eventos propios de gesto, no como Ctrl + rueda.
    let lastScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale ?? 1;
      const point = event as Event & { clientX?: number; clientY?: number };
      apiRef.current?.zoomBy(
        scale / lastScale,
        typeof point.clientX === "number" && typeof point.clientY === "number" ? { x: point.clientX, y: point.clientY } : null,
      );
      lastScale = scale;
    };
    const onGestureEnd = (event: Event) => event.preventDefault();

    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("gesturestart", onGestureStart);
    surface.addEventListener("gesturechange", onGestureChange);
    surface.addEventListener("gestureend", onGestureEnd);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("gesturestart", onGestureStart);
      surface.removeEventListener("gesturechange", onGestureChange);
      surface.removeEventListener("gestureend", onGestureEnd);
    };
  }, [enabled, surfaceRef, apiRef]);

  /* Teclado. Escape lo atiende el lienzo (cierra editor, panel, herramienta, seleccion y, al final, sale). */
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const api = apiRef.current;
      if (!api || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isTypingTarget(target)) return;
      // Una hoja o un dialogo abierto encima manda sobre estas teclas.
      const dialog = target?.closest('[role="dialog"], [aria-modal="true"]');
      if (dialog && dialog !== containerRef.current) return;
      if (document.querySelector('[data-sheet-scrim]')) return;

      const mod = event.ctrlKey || event.metaKey;
      const key = event.key;

      if (mod && !event.altKey) {
        const lower = key.toLowerCase();
        if (lower === "z") {
          event.preventDefault();
          if (event.shiftKey) api.redo();
          else api.undo();
        } else if (lower === "y") {
          event.preventDefault();
          api.redo();
        } else if (lower === "c" && api.hasSelection()) {
          event.preventDefault();
          api.copy();
        } else if (lower === "v") {
          event.preventDefault();
          api.paste();
        } else if (lower === "d" && api.hasSelection()) {
          event.preventDefault();
          api.duplicate();
        }
        return;
      }
      if (event.altKey) return;

      if (key === "+" || key === "=") {
        event.preventDefault();
        api.zoomStep(1);
      } else if (key === "-" || key === "_") {
        event.preventDefault();
        api.zoomStep(-1);
      } else if (key === "0") {
        event.preventDefault();
        api.zoomFit();
      } else if (key === "?") {
        event.preventDefault();
        api.help();
      } else if (key === "PageUp" || key === "PageDown") {
        if (ownsArrowKeys(target)) return;
        event.preventDefault();
        api.stepPage(key === "PageDown" ? 1 : -1);
      } else if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        if (ownsArrowKeys(target)) return;
        const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
        const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
        if (api.hasSelection()) {
          event.preventDefault();
          const step = event.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
          api.nudge(dx * step, dy * step);
        } else if (api.panBy(-dx * PAN_STEP_PX, -dy * PAN_STEP_PX)) {
          event.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, apiRef, containerRef]);
}
