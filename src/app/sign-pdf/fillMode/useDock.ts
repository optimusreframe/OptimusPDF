"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/*
 * Colocacion de un panel acoplado al borde de abajo que NO se queda debajo del teclado virtual.
 *
 * En iOS el teclado achica la VENTANA VISUAL (`visualViewport`) pero no la ventana de maquetacion: un elemento `fixed; bottom: 0`
 * queda detras del teclado. El panel se sube lo que mide el hueco entre el borde de abajo de la ventana visual y el de la
 * ventana (`innerHeight - (offsetTop + height)`). Sin teclado, o en un navegador sin `visualViewport`, vale 0.
 */

/** Diferencia (px) entre la ventana y la ventana visual a partir de la cual hay un teclado virtual abierto (como `SuggestionBar`). */
const KEYBOARD_MIN_PX = 120;

/** Hueco (px) entre el borde de abajo de la ventana visual y el de la ventana; 0 sin teclado. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Menos de ~120 px no es un teclado (la barra de Safari que se encoge, el recorte de la pantalla): no se sube el panel.
    const update = () => {
      const gap = Math.round(window.innerHeight - (viewport.offsetTop + viewport.height));
      setInset(gap >= KEYBOARD_MIN_PX ? gap : 0);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return inset;
}

/** Variable CSS con la altura del panel: otros avisos fijos (p. ej. «Rellenado en N campos») se colocan por encima de ella. */
export const DOCK_HEIGHT_VAR = "--fill-dock-h";

/**
 * Mide el panel y publica su altura en `--fill-dock-h` (con un respiro de 12 px) mientras esta montado. Devuelve la altura medida
 * para que quien lo monta deje un hueco al final de la pagina (y se pueda desplazar hasta el ultimo campo).
 */
export function useDockHeight(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0);
  const heightRef = useRef(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    const measure = () => {
      const next = Math.ceil(node.getBoundingClientRect().height);
      if (next === heightRef.current) return;
      heightRef.current = next;
      setHeight(next);
      document.documentElement.style.setProperty(DOCK_HEIGHT_VAR, `${next + 12}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return () => document.documentElement.style.removeProperty(DOCK_HEIGHT_VAR);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      heightRef.current = 0;
      document.documentElement.style.removeProperty(DOCK_HEIGHT_VAR);
    };
  }, [ref, active]);
  return active ? height : 0;
}
