"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import {
  placeFloatingBar,
  type BarSide,
  type PxRect,
} from "@/app/sign-pdf/canvasGeometry";

/*
 * Barra flotante contextual (W2-B), anclada al elemento seleccionado.
 *
 * - Vive en el ESCENARIO (`stageRef`: contenedor `relative` sin `overflow`),
 *   no dentro de la pagina: el zoom escala la pagina y su tarjeta recorta;
 *   la barra no se escala ni se recorta. Se posiciona en coordenadas del
 *   escenario, asi que el scroll de la pagina la mueve nativamente (sin
 *   desfase); solo el volteo depende del scroll y se recalcula en rAF.
 * - La colocacion (arriba/abajo, volteo, desplazamiento lateral) es
 *   `placeFloatingBar`, pura y probada. Aqui solo se mide.
 * - Nunca roba el foco: aparece sin enfocarse. El orden de foco lo resuelve
 *   el lienzo (Tab desde el elemento entra en la barra y Tab desde la
 *   ultima accion sigue con el siguiente elemento).
 * - Entra/sale con spring interrumpible; con movimiento reducido,
 *   `MotionConfig` deja solo el fundido.
 */

/** Lo que sobresale del elemento: etiqueta arriba (~18 px) y tirador abajo a la derecha (~14 px). */
const ANCHOR_PAD = { top: 20, bottom: 14, right: 12 };
const BAR_GAP = 8;
const REM = 16;
/** Pestana inferior movil: barra de pestanas (4.5 rem) + barra de accion de ToolShell (4.25 rem). */
const MOBILE_FIXED_BOTTOM_REM = 8.75;

type Placement = { left: number; top: number; side: BarSide };

export type FloatingBarProps = {
  /** Escenario `relative` que contiene la tarjeta de la pagina. */
  stageRef: RefObject<HTMLElement | null>;
  /** Tarjeta con `overflow:hidden` que recorta la pagina al hacer zoom. */
  clipRef: RefObject<HTMLElement | null>;
  /** Anfitrion de la pagina (contiene los elementos). */
  hostRef: RefObject<HTMLElement | null>;
  /** Elemento seleccionado, o `null` (la barra sale). */
  selection: { kind: string; id: string } | null;
  /** Cambia cada vez que la geometria del ancla puede haber cambiado (rect, zoom, pagina, tamano). */
  layoutKey: string;
  /** Lado preferido cuando caben los dos. */
  prefer?: "top" | "bottom";
  label: string;
  /** Lado resuelto (o `null` si no hay barra): lo usa el desplegable de sugerencias para ir al lado opuesto. */
  onSideChange?: (side: BarSide | null) => void;
  /** Escape dentro de la barra: devuelve el foco al elemento. */
  onEscape: () => void;
  /** Shift+Tab desde la primera accion. */
  onTabBackward: () => void;
  /** Tab desde la ultima accion; devolver `true` si ya movio el foco. */
  onTabForward: () => boolean;
  /** El foco paso a un elemento FUERA de la barra (Tab, Mayus+Tab...): quien abrio algo dentro lo cierra. */
  onFocusLeave?: () => void;
  children: ReactNode;
};

function intersect(a: PxRect, b: PxRect): PxRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

const toPx = (rect: DOMRect): PxRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

export function FloatingFieldBar({
  stageRef,
  clipRef,
  hostRef,
  selection,
  layoutKey,
  prefer = "top",
  label,
  onSideChange,
  onEscape,
  onTabBackward,
  onTabForward,
  onFocusLeave,
  children,
}: FloatingBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  const sideCallback = useRef(onSideChange);
  useEffect(() => {
    sideCallback.current = onSideChange;
  });

  // Primitivas: la seleccion que llega del padre es un objeto nuevo en cada render.
  const selKind = selection?.kind ?? null;
  const selId = selection?.id ?? null;

  const compute = useCallback(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const clip = clipRef.current;
    const bar = barRef.current;
    if (!host || !stage || !clip || selKind === null || selId === null) {
      setAnchored(false);
      return;
    }
    const element = host.querySelector<HTMLElement>(
      `[data-element-kind="${selKind}"][data-element-id="${CSS.escape(selId)}"][data-drag-mode="move"]`,
    );
    if (!element) {
      setAnchored(false);
      return;
    }
    setAnchored(true);
    if (!bar) return;

    const clipRect = toPx(clip.getBoundingClientRect());
    const pageRect = intersect(toPx(host.getBoundingClientRect()), clipRect);
    const anchorRect = intersect(toPx(element.getBoundingClientRect()), clipRect);
    if (!pageRect || !anchorRect) {
      // El elemento esta fuera de la parte visible de la pagina (zoom y desplazamiento).
      setPlacement(null);
      return;
    }

    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const header = document.querySelector("header");
    let safeTop = 0;
    if (header) {
      const headerRect = header.getBoundingClientRect();
      if (headerRect.height > 0) safeTop = Math.max(0, headerRect.bottom);
    }
    // La barra de zoom y paginas del lienzo es pegajosa: cuando esta pegada tapa su franja.
    const sticky = document.querySelector<HTMLElement>("[data-canvas-sticky]");
    if (sticky) {
      const stickyRect = sticky.getBoundingClientRect();
      const stickyTop = Number.parseFloat(getComputedStyle(sticky).top);
      if (
        stickyRect.height > 0 &&
        Number.isFinite(stickyTop) &&
        stickyRect.top <= stickyTop + 1
      ) {
        safeTop = Math.max(safeTop, stickyRect.bottom);
      }
    }
    let safeBottom = viewportHeight;
    /** Parte baja de la ventana sin barras fijas (la paleta movil aun cuenta como zona libre). */
    let viewBottom = viewportHeight;
    const mobile = viewportWidth < 768;
    if (mobile) {
      const inset = probeRef.current?.offsetHeight ?? 0;
      safeBottom = viewportHeight - MOBILE_FIXED_BOTTOM_REM * REM - inset;
      viewBottom = safeBottom;
      const palette = document.querySelector<HTMLElement>("[data-tool-palette]");
      if (palette) {
        const paletteRect = palette.getBoundingClientRect();
        if (paletteRect.top < safeBottom && paletteRect.bottom > safeTop) {
          safeBottom = Math.min(safeBottom, paletteRect.top - 4);
        }
      }
    }
    // Elemento fuera de la parte util de la ventana (se hizo scroll): la barra se
    // oculta en vez de quedarse anclada al borde, solapando la paleta o las barras fijas.
    if (anchorRect.y + anchorRect.height <= safeTop || anchorRect.y >= viewBottom) {
      setPlacement(null);
      return;
    }
    const stageRect = stage.getBoundingClientRect();

    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const placed = placeFloatingBar({
      anchor: anchorRect,
      anchorPad: ANCHOR_PAD,
      bar: { width, height },
      page: pageRect,
      safe: {
        x: 0,
        y: safeTop,
        width: viewportWidth,
        height: Math.max(0, safeBottom - safeTop),
      },
      stage: {
        left: Math.max(stageRect.left, 8),
        right: Math.min(stageRect.right, viewportWidth - 8),
      },
      gap: BAR_GAP,
      prefer,
    });
    const next: Placement = {
      left: Math.round((placed.x - stageRect.left) * 2) / 2,
      top: Math.round((placed.y - stageRect.top) * 2) / 2,
      side: placed.side,
    };
    setPlacement((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.side === next.side
        ? current
        : next,
    );
  }, [hostRef, stageRef, clipRef, selKind, selId, prefer]);

  // Antes de pintar: asi la barra nunca se ve un frame en un sitio provisional.
  useLayoutEffect(compute, [compute, layoutKey, barSize.width, barSize.height, anchored]);

  /* Tamano de la barra (cambia con el tipo de elemento y al envolver). */
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setBarSize((current) =>
        current.width === bar.offsetWidth && current.height === bar.offsetHeight
          ? current
          : { width: bar.offsetWidth, height: bar.offsetHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [anchored]);

  /* El scroll de la pagina solo cambia el volteo; se recalcula una vez por frame. */
  useEffect(() => {
    if (selKind === null) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [selKind, compute]);

  const visible = selKind !== null && anchored;
  const side = visible && placement ? placement.side : null;
  useEffect(() => {
    sideCallback.current?.(side);
  }, [side]);
  useEffect(() => () => sideCallback.current?.(null), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled])",
      ),
    );
    if (focusable.length === 0) return;
    const active = document.activeElement;
    if (event.shiftKey && active === focusable[0]) {
      event.preventDefault();
      onTabBackward();
    } else if (!event.shiftKey && active === focusable[focusable.length - 1]) {
      if (onTabForward()) event.preventDefault();
    }
  };

  return (
    <>
      {/* Sonda de la zona segura inferior (`env()` no se lee desde JS). */}
      <div
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-[env(safe-area-inset-bottom,0px)] w-0"
      />
      <AnimatePresence>
        {visible ? (
          <motion.div
            key="bar"
            ref={barRef}
            role="group"
            aria-label={label}
            data-floating-bar=""
            data-side={placement?.side}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              // Solo cuando el foco SALE a otro elemento: si el nodo enfocado se desmonta
              // (el selector de tipo sustituye a las acciones) no hay `relatedTarget`.
              const next = event.relatedTarget;
              if (next instanceof Node && !event.currentTarget.contains(next)) {
                onFocusLeave?.();
              }
            }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={withCrossFadeOpacity(springs.snappy)}
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? "visible" : "hidden",
              transformOrigin: placement?.side === "bottom" ? "top center" : "bottom center",
            }}
            className={cn(
              "material-thick shadow-elevation-3 absolute z-20 flex w-max max-w-full flex-wrap items-center justify-center gap-1 rounded-ios p-1",
            )}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Piezas
 * ------------------------------------------------------------------ */

export const BAR_BUTTON_CLASS =
  "flex size-9 shrink-0 items-center justify-center rounded-ios-sm pointer-coarse:size-11 " +
  "transition-[background-color,color,scale,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-spring)] " +
  "active:scale-[0.92] active:duration-[80ms] " +
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal " +
  "disabled:pointer-events-none disabled:opacity-40";

export function BarGroup({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex items-center gap-0.5 rounded-ios-sm bg-white/6 p-0.5 pointer-coarse:p-0", className)}
    >
      {children}
    </div>
  );
}

export function BarButton({
  label,
  onClick,
  pressed,
  destructive,
  disabled,
  children,
  ariaDisabled,
  ariaExpanded,
  dataAction,
}: {
  label: string;
  onClick: () => void;
  /** Boton de alternancia (grupo de tipos): `aria-pressed`. */
  pressed?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Sigue enfocable pero sin efecto (evita perder el foco al agotarse). */
  ariaDisabled?: boolean;
  /** Boton que abre un selector dentro de la barra. */
  ariaExpanded?: boolean;
  dataAction?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-disabled={ariaDisabled || undefined}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaExpanded === undefined ? undefined : "true"}
      disabled={disabled}
      data-bar-action={dataAction}
      onClick={onClick}
      className={cn(
        BAR_BUTTON_CLASS,
        pressed
          ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
          : destructive
            ? "text-destructive-text hover:bg-destructive/12"
            : "text-muted-foreground hover:bg-white/10 hover:text-foreground",
        ariaDisabled && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}
