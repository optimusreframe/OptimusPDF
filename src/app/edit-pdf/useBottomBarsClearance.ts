"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/*
 * Espacio que ocupan, medido desde el borde inferior de la ventana, las barras FIJAS de abajo de la pagina (Wave 10 ·
 * C-A3): la barra de «Procesar» de `ToolShell` y la pestana movil. La paleta de «Editar PDF» en el movil es una banda
 * fija (`position: fixed`) que se coloca JUSTO ENCIMA de ellas.
 *
 * Antes la distancia era una constante (`9.25rem` = 4,5 de la pestana + 4,75 de la barra) que supone una barra de 4,75
 * rem. Con el motivo de «Procesar» desactivado («Haz un cambio en el documento para poder exportarlo.», que es lo
 * PRIMERO que se ve al abrir el editor) la barra mide 6 rem, o mas si el texto da dos lineas (360 px, WebKit): la barra
 * (`z-30`) se comia la fila de abajo de la paleta (`z-20`), 20-40 px de botones tapados.
 *
 * Se mide en vez de suponer: se recorren los hermanos de cada antepasado del editor buscando las barras `fixed` pegadas
 * abajo y a todo el ancho (la pestana, la barra de la herramienta) y se toma la mas alta. No se acopla a ninguna clase
 * ni atributo de esas barras.
 */

/** Una barra de abajo ocupa casi todo el ancho de la ventana. */
const MIN_WIDTH_RATIO = 0.9;

export type BottomBar = {
  element: Element;
  /** Distancia (px) del borde inferior de la ventana al borde SUPERIOR de la barra: `bottom` + alto. */
  reach: number;
};

/** Barras `fixed` pegadas abajo y a todo el ancho que hay en la pagina alrededor de `root` (hermanos de sus antepasados). */
export function findBottomBars(root: Element, win: Window = window): BottomBar[] {
  const doc = root.ownerDocument;
  const bars: BottomBar[] = [];
  for (let node: Element | null = root; node && node !== doc.body; node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      const style = win.getComputedStyle(sibling);
      if (style.position !== "fixed" || style.display === "none" || style.visibility === "hidden") continue;
      const bottom = Number.parseFloat(style.bottom);
      if (!Number.isFinite(bottom) || bottom < 0) continue;
      const rect = sibling.getBoundingClientRect();
      if (rect.height <= 0 || rect.width < win.innerWidth * MIN_WIDTH_RATIO) continue;
      // Anclada abajo de verdad: su parte alta cae en la mitad de abajo (un velo `inset-0` o una cabecera, no).
      if (rect.top < win.innerHeight / 2) continue;
      bars.push({ element: sibling, reach: bottom + rect.height });
    }
  }
  return bars;
}

/** Alto (px) de la pila de barras fijas de abajo (la barra mas alta); 0 si no hay ninguna. */
export function measureBottomBars(root: Element, win: Window = window): number {
  return findBottomBars(root, win).reduce((max, bar) => Math.max(max, bar.reach), 0);
}

/**
 * Distancia (px) a la que colocar la paleta movil sobre las barras de abajo, o `null` si no hay que medirla
 * (`enabled = false`, escritorio, sin barras): entonces vale la distancia de siempre. Se vuelve a medir en cada render
 * (el motivo de «Procesar» aparece y desaparece con las ediciones), al cambiar el tamano de las barras y de la ventana.
 */
export function useBottomBarsClearance(rootRef: RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [clearance, setClearance] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const update = useRef<() => void>(() => undefined);

  // Cada render: el motivo de «Procesar» (y con el la altura de la barra) cambia con la sesion de edicion.
  useLayoutEffect(() => {
    update.current = () => {
      const root = rootRef.current;
      // Escritorio: la paleta es una columna pegajosa, no una banda fija.
      const phone = typeof window.matchMedia !== "function" || window.matchMedia("(max-width: 767.98px)").matches;
      const bars = enabled && root && phone ? findBottomBars(root) : [];
      // Se observan las barras halladas (cambian de alto sin que el editor se vuelva a pintar: texto que envuelve).
      if (observer.current) {
        for (const bar of bars) {
          if (observed.current.has(bar.element)) continue;
          observed.current.add(bar.element);
          observer.current.observe(bar.element);
        }
      }
      const reach = bars.reduce((max, bar) => Math.max(max, bar.reach), 0);
      setClearance(reach > 0 ? Math.ceil(reach) : null);
    };
    update.current();
  });

  useEffect(() => {
    if (!enabled) return;
    const run = () => update.current();
    const seen = observed.current;
    observer.current = typeof ResizeObserver === "function" ? new ResizeObserver(run) : null;
    window.addEventListener("resize", run);
    window.visualViewport?.addEventListener("resize", run);
    run();
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      seen.clear();
      window.removeEventListener("resize", run);
      window.visualViewport?.removeEventListener("resize", run);
    };
  }, [enabled]);

  return clearance;
}
