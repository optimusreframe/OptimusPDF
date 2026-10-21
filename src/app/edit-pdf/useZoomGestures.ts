"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/*
 * Zoom del editor inline (W5-U4b): botones, Ctrl+rueda (tambien el pellizco del
 * trackpad, que llega como rueda con Ctrl) y pellizco con dos dedos. Todos pasan
 * por `applyZoom`, que recuerda QUE punto de la hoja esta bajo el ancla (el
 * cursor, el centro del pellizco, el centro de la parte visible) y, tras el
 * render con el zoom nuevo, desplaza el contenedor y la ventana para que ese
 * punto siga bajo el ancla: acercar no manda al usuario a otro sitio.
 *
 * El pellizco se escucha en la fase de CAPTURA del anfitrion de la hoja, sin
 * robar el puntero a nadie: con el segundo dedo se traga el evento (nadie empieza
 * un arrastre con el) y `isPinching()` avisa al resto para que cancele el
 * arrastre del primero. `isPinching` sigue siendo cierto hasta levantar el
 * ultimo dedo, asi el dedo que queda no se convierte en un arrastre.
 */

/** Evento de `window` al empezar un pellizco: cualquier arrastre en curso se cancela. */
export const PINCH_START_EVENT = "edit-pinch-start";
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
/** Tope de la rueda: una rueda de raton da saltos de 100; el pellizco del trackpad, de 1 a 15. */
const WHEEL_STEP_CAP = 30;
const WHEEL_SENSITIVITY = 0.01;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** Zoom resultante de un evento de rueda con Ctrl (puro). */
export function zoomFromWheel(zoom: number, deltaY: number, deltaMode = 0): number {
  const lines = deltaMode === 1 ? deltaY * 16 : deltaY;
  const capped = Math.max(-WHEEL_STEP_CAP, Math.min(WHEEL_STEP_CAP, lines));
  return clampZoom(zoom * Math.exp(-capped * WHEEL_SENSITIVITY));
}

export type ZoomAnchor = { clientX: number; clientY: number };

type Pending = { fx: number; fy: number; clientX: number; clientY: number };

export type UseZoomGesturesOptions = {
  stageRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
  zoom: number;
  setZoom: (zoom: number) => void;
  /** Apaga los gestos (p. ej. sin documento). */
  enabled?: boolean;
  /** (W7-U6) Region con desplazamiento propio (PDF Pro): el ajuste vertical va a ella y no a la ventana. */
  scrollRef?: RefObject<HTMLElement | null>;
};

export type UseZoomGestures = {
  /** Cambia el zoom manteniendo el punto de la hoja que esta bajo `anchor`. */
  applyZoom: (next: number, anchor?: ZoomAnchor) => void;
  isPinching: () => boolean;
  /** Props de CAPTURA para el anfitrion de la hoja. */
  pinchProps: {
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancelCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  };
};

export function useZoomGestures({
  stageRef,
  hostRef,
  clipRef,
  zoom,
  setZoom,
  enabled = true,
  scrollRef,
}: UseZoomGesturesOptions): UseZoomGestures {
  const zoomRef = useRef(zoom);
  const pendingRef = useRef<Pending | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  /** Centro de los dos dedos en el ultimo movimiento y si hay que desplazar a mano (herramienta armada: `touch-action: none`). */
  const panRef = useRef<{ x: number; y: number; manual: boolean } | null>(null);
  const pinchingRef = useRef(false);
  const frameRef = useRef(0);
  const queuedRef = useRef<{ zoom: number; anchor: ZoomAnchor } | null>(null);
  useEffect(() => {
    zoomRef.current = zoom;
  });

  const applyZoom = useCallback(
    (next: number, anchor?: ZoomAnchor) => {
      const target = clampZoom(next);
      if (Math.abs(target - zoomRef.current) < 0.001) return;
      const host = hostRef.current;
      if (host && anchor) {
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pendingRef.current = {
            fx: (anchor.clientX - rect.left) / rect.width,
            fy: (anchor.clientY - rect.top) / rect.height,
            clientX: anchor.clientX,
            clientY: anchor.clientY,
          };
        }
      }
      zoomRef.current = target;
      setZoom(target);
    },
    [hostRef, setZoom],
  );

  /* Tras pintar el zoom nuevo: el punto anclado vuelve a quedar bajo el ancla. */
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    const host = hostRef.current;
    if (!pending || !host) return;
    const rect = host.getBoundingClientRect();
    const dx = rect.left + pending.fx * rect.width - pending.clientX;
    const dy = rect.top + pending.fy * rect.height - pending.clientY;
    const clip = clipRef.current;
    if (clip && Math.abs(dx) > 0.5) clip.scrollLeft += dx;
    const scroller = scrollRef?.current ?? null;
    if (Math.abs(dy) > 0.5 && scroller && typeof scroller.scrollBy === "function") {
      scroller.scrollBy({ top: dy, behavior: "instant" });
    } else if (Math.abs(dy) > 0.5 && typeof window.scrollBy === "function") {
      try {
        window.scrollBy(0, dy);
      } catch {
        // jsdom no implementa el desplazamiento.
      }
    }
  }, [zoom, hostRef, clipRef, scrollRef]);

  /* Ctrl + rueda: el navegador acercaria TODA la pagina; aqui acerca la hoja. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      applyZoom(zoomFromWheel(zoomRef.current, event.deltaY, event.deltaMode), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stageRef, enabled, applyZoom]);

  useEffect(
    () => () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const flush = useCallback(() => {
    frameRef.current = 0;
    const queued = queuedRef.current;
    queuedRef.current = null;
    if (queued) applyZoom(queued.zoom, queued.anchor);
  }, [applyZoom]);

  const isPinching = useCallback(() => pinchingRef.current, []);

  /** Mueve la hoja con el centro de los dos dedos (el contenido sigue a los dedos): vertical a la region/ventana, horizontal a la tarjeta con zoom. */
  const scrollByFingers = useCallback(
    (dx: number, dy: number) => {
      const clip = clipRef.current;
      if (clip && dx !== 0) clip.scrollLeft -= dx;
      if (dy === 0) return;
      const scroller = scrollRef?.current ?? null;
      if (scroller && typeof scroller.scrollBy === "function") {
        scroller.scrollBy({ top: -dy, behavior: "instant" });
      } else if (typeof window.scrollBy === "function") {
        try {
          window.scrollBy(0, -dy);
        } catch {
          // jsdom no implementa el desplazamiento.
        }
      }
    },
    [clipRef, scrollRef],
  );

  const pinchProps = useMemo(() => {
    const measure = () => {
      const [a, b] = [...pointersRef.current.values()];
      if (!a || !b) return null;
      return {
        distance: Math.hypot(b.x - a.x, b.y - a.y),
        mid: { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 },
      };
    };
    const end = (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
        panRef.current = null;
      }
      if (pointersRef.current.size === 0) pinchingRef.current = false;
    };
    return {
      onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || event.pointerType !== "touch") return;
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointersRef.current.size === 2) {
          const m = measure();
          if (m && m.distance > 0) {
            pinchRef.current = { distance: m.distance, zoom: zoomRef.current };
            pinchingRef.current = true;
            // (M5 · GE-01) Con una herramienta armada la hoja lleva `touch-action: none` (el dedo dibuja): el navegador NO desplaza
            // con dos dedos, asi que el desplazamiento se hace aqui. Sin herramienta armada lo hace el propio navegador.
            const host = hostRef.current;
            const manual = !!host && window.getComputedStyle(host).touchAction === "none";
            panRef.current = { x: m.mid.clientX, y: m.mid.clientY, manual };
            window.dispatchEvent(new Event(PINCH_START_EVENT));
          }
        }
        // Un dedo mas de los dos: nadie empieza nada con el.
        if (pointersRef.current.size >= 2) event.stopPropagation();
      },
      onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || event.pointerType !== "touch") return;
        if (!pointersRef.current.has(event.pointerId)) return;
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (!pinchingRef.current) return;
        const pinch = pinchRef.current;
        const m = measure();
        const pan = panRef.current;
        if (pan && m) {
          const dx = m.mid.clientX - pan.x;
          const dy = m.mid.clientY - pan.y;
          pan.x = m.mid.clientX;
          pan.y = m.mid.clientY;
          if (pan.manual && (dx !== 0 || dy !== 0)) scrollByFingers(dx, dy);
        }
        if (pinch && m && m.distance > 0) {
          queuedRef.current = { zoom: pinch.zoom * (m.distance / pinch.distance), anchor: m.mid };
          if (!frameRef.current) frameRef.current = window.requestAnimationFrame(flush);
        }
        event.stopPropagation();
      },
      onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => {
        const wasPinching = pinchingRef.current;
        end(event);
        // El gesto que termina un pellizco no debe seleccionar ni deseleccionar nada.
        if (wasPinching && event.pointerType === "touch") event.stopPropagation();
      },
      onPointerCancelCapture: (event: ReactPointerEvent<HTMLElement>) => {
        end(event);
      },
    };
  }, [enabled, flush, hostRef, scrollByFingers]);

  return { applyZoom, isPinching, pinchProps };
}
