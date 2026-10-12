"use client";

import { useEffect, type RefObject } from "react";
import { zoomFromPinch, zoomFromWheel } from "@/app/pdf-pro/viewer/viewerLayout";
import type { ProViewerApi } from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Gestos de zoom del visor (Wave 7 · U3): Ctrl/Cmd + rueda (el pellizco del trackpad llega como rueda con
 * Ctrl) y pellizco con dos dedos. Los dos pasan por `api.setZoom(zoom, ancla)`, que recuerda que punto de la
 * hoja esta bajo el cursor o el centro del pellizco y lo mantiene en su sitio tras el nuevo zoom.
 *
 * El pellizco usa eventos TACTILES (no de puntero): el navegador cancela los eventos de puntero en cuanto
 * empieza a desplazar la pagina con un dedo, y el segundo dedo ya no llegaria. `touch-action: pan-x pan-y`
 * en el visor evita que el navegador haga su propio zoom de pagina.
 */
export function useViewerGestures(
  scrollerRef: RefObject<HTMLElement | null>,
  api: Pick<ProViewerApi, "getZoom" | "setZoom">,
  enabled = true,
): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !enabled) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      // Sin esto el navegador acercaria TODA la pagina.
      event.preventDefault();
      api.setZoom(zoomFromWheel(api.getZoom(), event.deltaY, event.deltaMode), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    let pinch: { distance: number; zoom: number } | null = null;
    const measure = (touches: TouchList) => {
      const a = touches[0];
      const b = touches[1];
      return {
        distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 },
      };
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        const { distance } = measure(event.touches);
        pinch = distance > 0 ? { distance, zoom: api.getZoom() } : null;
      } else if (event.touches.length > 2) {
        pinch = null;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      const { distance, mid } = measure(event.touches);
      if (event.cancelable) event.preventDefault();
      api.setZoom(zoomFromPinch(pinch.zoom, pinch.distance, distance), mid);
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [scrollerRef, api, enabled]);
}
