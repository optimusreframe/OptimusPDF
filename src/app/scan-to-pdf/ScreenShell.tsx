"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";

/**
 * Pantalla de la herramienta: cabecera, zona con desplazamiento propia y la barra de la accion primaria SIEMPRE visible abajo
 * (al alcance del pulgar, por encima de la barra de pestañas del movil), sin que la barra tape nada.
 *
 * Antes la barra era `sticky` sobre el desplazamiento de la pagina: tapaba miniaturas y asas a medias (objetivos tactiles
 * parcialmente cubiertos), se despegaba del borde al llegar al final de la lista y, al cambiar de paso, la pagina conservaba su
 * desplazamiento y el paso nuevo salia con el titulo fuera de pantalla. Aqui el alto se mide (de donde empieza la pantalla hasta
 * el borde de la ventana visible, menos la barra de pestañas) y la pagina no se desplaza mientras la pantalla esta abierta: lo que
 * se desplaza es SOLO la zona del medio, con `overscroll-behavior: contain`.
 *
 * Tres modos, elegidos midiendo (la cabecera y la barra se miden ellas mismas, no se adivinan por el ancho):
 *  - holgado: la cabecera se queda arriba (`sticky` dentro de la zona) y la lista se desplaza debajo;
 *  - justo (movil pequeño, letra grande, horizontal): la cabecera se desplaza con la lista para que quede sitio para ver hojas;
 *  - aprieto (casi no cabe nada): sin alto fijo; la pagina se desplaza y la barra queda `sticky` abajo.
 */
const ROOMY_LIST = 240;
const FLOW_BELOW = 140;

/** Alto disponible (px) desde el borde superior de `element` hasta el inferior de la ventana visible, sin la barra de pestañas. */
export function availableHeight(element: HTMLElement): { height: number; tabbar: number } {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  const top = element.getBoundingClientRect().top + window.scrollY;
  const tabbar = document.querySelector<HTMLElement>('[data-chrome="tabbar"]');
  const tabbarHeight = tabbar && getComputedStyle(tabbar).display !== "none" ? Math.ceil(tabbar.getBoundingClientRect().height) : 0;
  return { height: Math.floor(viewport - top - tabbarHeight), tabbar: tabbarHeight };
}

/** Que modo corresponde a un alto disponible `height` con una barra de `barHeight` y una cabecera de `headHeight` (px). */
export function pickMode(height: number, barHeight: number, headHeight: number): { flow: boolean; sticky: boolean } {
  const flow = height - barHeight < FLOW_BELOW;
  return { flow, sticky: !flow && height - barHeight - headHeight >= ROOMY_LIST };
}

type Mode = { height: number | null; sticky: boolean; flow: boolean; headHeight: number; tabbar: number };

export type ScreenShellProps = {
  /** Cabecera (titulo, estado, deshacer...). */
  top?: ReactNode;
  /** Contenido que se desplaza. */
  children: ReactNode;
  /** Barra inferior con la accion primaria. */
  bar?: ReactNode;
  /** El contenedor con desplazamiento (la cuadricula virtualiza y auto-desplaza sobre el). */
  scrollerRef?: RefObject<HTMLDivElement | null>;
  className?: string;
  /** Atributos de datos de la raiz (`data-review`, `data-save-screen`). */
  rootProps?: Record<string, string>;
  barProps?: Record<string, string>;
};

export function ScreenShell({ top, children, bar, scrollerRef, className, rootProps, barProps }: ScreenShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ownScroller = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const scroller = scrollerRef ?? ownScroller;
  const [mode, setMode] = useState<Mode>({ height: null, sticky: true, flow: false, headHeight: 0, tabbar: 0 });

  // La pagina no se desplaza mientras la pantalla esta abierta (se vuelve al inicio al entrar: el paso nuevo se ve entero).
  const locked = !mode.flow;
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  useLayoutEffect(() => {
    if (!locked) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [locked]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const measure = () => {
      const { height, tabbar } = availableHeight(element);
      const barHeight = barRef.current?.offsetHeight ?? 0;
      const headHeight = headRef.current?.offsetHeight ?? 0;
      const { flow, sticky } = pickMode(height, barHeight, headHeight);
      const next: Mode = { height: flow ? null : height, sticky, flow, headHeight, tabbar };
      setMode((current) => (current.height === next.height && current.sticky === next.sticky && current.flow === next.flow && current.headHeight === next.headHeight && current.tabbar === next.tabbar ? current : next));
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const tabbar = document.querySelector('[data-chrome="tabbar"]');
    if (tabbar) observer?.observe(tabbar);
    if (headRef.current) observer?.observe(headRef.current);
    if (barRef.current) observer?.observe(barRef.current);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  const rootStyle: CSSProperties = mode.height === null ? {} : { height: mode.height };
  const scrollStyle: CSSProperties = { touchAction: "pan-y", scrollPaddingTop: mode.sticky ? mode.headHeight : 0, scrollPaddingBottom: 8 };
  return (
    <div ref={rootRef} data-screen-shell="" data-shell-mode={mode.flow ? "flow" : mode.sticky ? "fixed-header" : "scroll-header"} style={rootStyle} className={cn("mx-auto flex w-full flex-col", className)} {...rootProps}>
      <div ref={scroller} data-shell-scroll="" className={cn("px-[16px] md:px-[24px]", mode.flow ? "" : "min-h-0 flex-1 overflow-y-auto overscroll-contain")} style={scrollStyle}>
        {top ? (
          <div ref={headRef} data-shell-top="" className={cn("-mx-[16px] px-[16px] pt-4 pb-2 md:-mx-[24px] md:px-[24px] md:pt-6", mode.sticky ? "sticky top-0 z-20 bg-background" : "")}>
            {top}
          </div>
        ) : null}
        {children}
      </div>
      {bar ? (
        <div
          ref={barRef}
          data-shell-bar=""
          style={mode.flow ? { bottom: mode.tabbar } : undefined}
          className={cn("shrink-0 border-t border-hairline bg-surface px-[16px] py-3 md:px-[24px]", mode.flow ? "sticky z-20" : "")}
          {...barProps}
        >
          {bar}
        </div>
      ) : null}
    </div>
  );
}
