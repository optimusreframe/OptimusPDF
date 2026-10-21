"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type ComponentProps,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import { pickBarSpot } from "@/app/sign-pdf/barNeighbors";
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

/** `fixed`: acoplada al borde inferior de la ventana visual (coordenadas de ventana, no del escenario). */
type Placement = { left: number; top: number; side: BarSide; fixed?: boolean };

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
  /**
   * (W5-U5) Con la barra de zoom y paginas a media pantalla (aun sin fijar arriba), la barra
   * flotante colocada ENCIMA de un bloque cae sobre ella y la nav (z-30) tapaba sus controles.
   * Con esto la barra flotante va POR ENCIMA de la nav (z-40): sigue sobre el bloque (que queda
   * libre para tocarlo otra vez) y todos sus controles reciben el toque. Firmar no lo activa:
   * su comportamiento visible no cambia.
   *
   * Es tambien el interruptor de TODO lo especifico de Editar en la colocacion: medir la ventana
   * visual (teclado virtual, zoom de pellizco), acoplarse abajo y desplazar la pagina. Por defecto
   * (`false`) la barra se calcula exactamente como antes de la Wave 5.
   */
  aboveSticky?: boolean;
  /**
   * (W7-U6) Region con desplazamiento PROPIO en la que vive el lienzo (el modo Editar/Anotar de PDF Pro, que no
   * desplaza la ventana). Con ella, la zona segura es la de esa region (su caja visible) y los desplazamientos de
   * acople van a ella y no a la ventana. Ausente = exactamente el comportamiento de siempre.
   */
  boundsRef?: RefObject<HTMLElement | null>;
  /** (W5-U5) Descripcion accesible (se lee una vez al entrar en la barra), p. ej. los atajos del elemento. */
  description?: string;
  children: ReactNode;
};

/**
 * Borde inferior (px de ventana) de lo que de verdad se ve. Con el teclado virtual
 * abierto la ventana VISUAL es mas baja que `innerHeight`: la barra se coloca por
 * encima del teclado, no detras (W5-U4b). Sin `visualViewport`, `innerHeight`.
 */
/** Calma (ms) del alto de la ventana visual antes de reajustar el desplazamiento de la barra acoplada. */
const VIEWPORT_SETTLE_MS = 120;
/** Ventana (ms) tras seleccionar en la que la barra de Editar ignora punteros (click fantasma del dedo). */
const GHOST_CLICK_MS = 350;
/** Un toque de hace menos de esto es el que acaba de seleccionar el elemento. */
const TOUCH_SELECT_WINDOW_MS = 1000;

export function usableViewportBottom(win: {
  innerHeight: number;
  visualViewport?: { offsetTop: number; height: number } | null;
}): number {
  const visual = win.visualViewport;
  if (!visual || !Number.isFinite(visual.height) || visual.height <= 0) return win.innerHeight;
  return Math.min(win.innerHeight, visual.offsetTop + visual.height);
}

/**
 * Borde inferior que usa la barra para colocarse. Con `viewportAware` (Editar) es
 * el de la ventana visual; sin el, EXACTAMENTE `innerHeight` como siempre (Firmar
 * no cambia con teclado virtual ni zoom de pellizco).
 */
export function barViewportBottom(
  win: { innerHeight: number; visualViewport?: { offsetTop: number; height: number } | null },
  viewportAware: boolean,
): number {
  return viewportAware ? usableViewportBottom(win) : win.innerHeight;
}

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

/**
 * Superficie de la barra. Con `blockPointersOnExit` (Editar), mientras la barra SE VA (su animacion de salida dura
 * ~120 ms, mas con la maquina cargada) deja de recibir punteros en el acto: tapaba el punto donde el usuario ya
 * empezaba a dibujar con la herramienta recien elegida y el dibujo se perdia (W5-U5). Firmar no lo activa.
 */
function BarSurface({
  surfaceRef,
  blockPointersOnExit,
  style,
  ...rest
}: ComponentProps<typeof motion.div> & {
  surfaceRef: RefObject<HTMLDivElement | null>;
  blockPointersOnExit: boolean;
}) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={surfaceRef}
      {...rest}
      style={blockPointersOnExit && !present ? { ...style, pointerEvents: "none" } : style}
    />
  );
}

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
  aboveSticky = false,
  boundsRef,
  description,
  children,
}: FloatingBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const probeRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  const sideCallback = useRef(onSideChange);
  useEffect(() => {
    sideCallback.current = onSideChange;
  });

  const layoutKeyRef = useRef(layoutKey);
  /** Ultima seleccion/geometria para la que ya se desplazo la pagina al acoplar la barra (una sola vez por una). */
  const dockedScrollRef = useRef<string | null>(null);
  /** Idem para el desplazamiento que descubre los tiradores cuando la paleta fija de abajo los taparia. */
  const revealScrollRef = useRef<string | null>(null);
  /** Alto de la ventana visual medido por la ultima pasada y si ya estuvo estable (teclado virtual, N6). */
  const viewportHeightRef = useRef<{ height: number | null; settled: boolean; timer: number }>({
    height: null,
    settled: true,
    timer: 0,
  });
  const computeRef = useRef<() => void>(() => {});
  /**
   * (W5-U5, N6) Con el dedo, los eventos de raton de compatibilidad (mousedown/mouseup/click) llegan DESPUES de
   * `pointerup`: si la barra aparece (acoplada) justo bajo el dedo, caen en su primer control (el selector de fuente) y
   * le roban el foco. Tras una seleccion HECHA CON EL DEDO, esos eventos «fantasma» —los que llegan a la barra sin que
   * antes hubiera un `pointerdown` suyo— se descartan durante ~350 ms. Un toque nuevo, o un clic de raton, si pasan.
   */
  const ghostUntilRef = useRef(0);
  const barPressRef = useRef(false);
  useLayoutEffect(() => {
    layoutKeyRef.current = layoutKey;
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
    let anchorRect = intersect(toPx(element.getBoundingClientRect()), clipRect);
    if (anchorRect && aboveSticky && selKind === "text") {
      // (W5-U5 · D1) Los tiradores externos (44 px bajo el bloque) y el asa de mover cuelgan FUERA de su caja: la barra
      // no puede taparlos, asi que forman parte del ancla (para elegir lado y para el desplazamiento al acoplar).
      for (const part of host.querySelectorAll<HTMLElement>("[data-resize-handle], [data-move-handle]")) {
        const partRect = intersect(toPx(part.getBoundingClientRect()), clipRect);
        if (!partRect) continue;
        const left = Math.min(anchorRect.x, partRect.x);
        const top = Math.min(anchorRect.y, partRect.y);
        const right = Math.max(anchorRect.x + anchorRect.width, partRect.x + partRect.width);
        const bottom = Math.max(anchorRect.y + anchorRect.height, partRect.y + partRect.height);
        anchorRect = { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
    if (!pageRect || !anchorRect) {
      // El elemento esta fuera de la parte visible de la pagina (zoom y desplazamiento).
      setPlacement(null);
      return;
    }

    const viewportWidth = document.documentElement.clientWidth;
    // Solo Editar mide la ventana VISUAL (teclado virtual, zoom de pellizco); Firmar conserva `innerHeight`.
    const viewportHeight = barViewportBottom(window, aboveSticky);
    if (aboveSticky) {
      // El alto cambia mientras el teclado se anima: el desplazamiento de acople espera ~120 ms de calma.
      const tracked = viewportHeightRef.current;
      const rounded = Math.round(viewportHeight);
      if (tracked.height === null) {
        tracked.height = rounded;
      } else if (tracked.height !== rounded) {
        tracked.height = rounded;
        tracked.settled = false;
        window.clearTimeout(tracked.timer);
        tracked.timer = window.setTimeout(() => {
          tracked.settled = true;
          computeRef.current();
        }, VIEWPORT_SETTLE_MS);
      }
    }
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
    // (W7-U6) Region con desplazamiento propio: su caja visible manda sobre la ventana y sobre las barras de la pagina.
    const boundsEl = boundsRef?.current ?? null;
    const boundsRect = boundsEl ? boundsEl.getBoundingClientRect() : null;
    const hasBounds = !!boundsRect && boundsRect.height > 0 && boundsRect.width > 0;
    if (hasBounds) safeTop = boundsRect.top;
    const scrollPageBy = (top: number) => {
      if (hasBounds && boundsEl && typeof boundsEl.scrollBy === "function") boundsEl.scrollBy({ top, behavior: "instant" });
      else window.scrollBy({ top, behavior: "instant" });
    };
    let safeBottom = hasBounds ? Math.min(viewportHeight, boundsRect.bottom) : viewportHeight;
    /** Parte baja de la ventana sin barras fijas (la paleta movil aun cuenta como zona libre). */
    let viewBottom = safeBottom;
    const safeLeft = hasBounds ? boundsRect.left : 0;
    const safeWidth = hasBounds ? boundsRect.width : viewportWidth;
    const mobile = viewportWidth < 768;
    // (W5-U5) Con el teclado virtual abierto las barras fijas de abajo quedan DETRAS de el: ya no restan sitio.
    const keyboardOpen = aboveSticky && viewportHeight < window.innerHeight - 80;
    if (mobile && !hasBounds) {
      const inset = probeRef.current?.offsetHeight ?? 0;
      safeBottom = keyboardOpen ? viewportHeight - 4 : viewportHeight - MOBILE_FIXED_BOTTOM_REM * REM - inset;
      viewBottom = safeBottom;
      const palette = document.querySelector<HTMLElement>("[data-tool-palette]");
      if (palette) {
        const paletteRect = palette.getBoundingClientRect();
        if (paletteRect.top < safeBottom && paletteRect.bottom > safeTop) {
          safeBottom = Math.min(safeBottom, paletteRect.top - 4);
        }
      }
    }
    // El dock de la paleta de Firmar (boton plegado o barra, pegajoso detras de la hoja) tapa el borde de abajo de la parte
    // util: elemento, tiradores y barra quedan por encima de el. En escritorio ancho el dock es `display: contents` (sin caja).
    if (!keyboardOpen) {
      const dock = document.querySelector<HTMLElement>("[data-palette-dock]");
      if (dock) {
        const dockRect = dock.getBoundingClientRect();
        if (dockRect.height > 0 && dockRect.top > safeTop + (safeBottom - safeTop) * 0.3 && dockRect.top < safeBottom && dockRect.bottom > safeTop) {
          safeBottom = Math.min(safeBottom, dockRect.top - 4);
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
        x: safeLeft,
        y: safeTop,
        width: safeWidth,
        height: Math.max(0, safeBottom - safeTop),
      },
      stage: {
        left: Math.max(stageRect.left, 8),
        right: Math.min(stageRect.right, viewportWidth - 8),
      },
      gap: BAR_GAP,
      prefer,
    });
    if (aboveSticky && mobile && selKind === "text" && placed.side !== "overlay") {
      // (D1) La barra cabe, pero los tiradores externos de un bloque cerca de la paleta fija de abajo quedarian TAPADOS
      // por ella: se sube la pagina (una vez por seleccion y alto de ventana) lo justo para dejarlos libres.
      const overflow = anchorRect.y + anchorRect.height + 2 - safeBottom;
      const revealKey = `${selKind}:${selId}:${layoutKeyRef.current}:${Math.round(viewportHeight)}`;
      if (overflow > 0 && revealScrollRef.current !== revealKey && viewportHeightRef.current.settled) {
        revealScrollRef.current = revealKey;
        const delta = Math.max(0, Math.min(overflow, anchorRect.y - 4 - safeTop));
        if (delta > 0) scrollPageBy(delta);
      }
    }
    if (aboveSticky && placed.side === "overlay" && height > 0) {
      // Ningun lado cabe sin tapar el elemento (pantalla estrecha, barra alta, teclado): la barra se ACOPLA al
      // borde inferior util de la ventana visual y la pagina se desplaza (una vez) para que el elemento
      // seleccionado quede visible POR ENCIMA de ella. Nunca se devuelve el caso en que su centro queda tapado.
      const dockTop = Math.max(safeTop, safeBottom - height - 4);
      // (N6) La clave incluye el alto de la ventana visual: si el teclado se abre/cierra DESPUES de acoplar, la barra
      // sube/baja y hay que volver a poner el elemento por encima de ella; solo cuando el alto se estabiliza.
      const scrollKey = `${selKind}:${selId}:${layoutKeyRef.current}:${Math.round(viewportHeight)}`;
      if (dockedScrollRef.current !== scrollKey && viewportHeightRef.current.settled) {
        dockedScrollRef.current = scrollKey;
        const need = anchorRect.y + anchorRect.height + 8 - dockTop;
        // (D1) El ancla ya incluye el asa de mover y los tiradores: solo se deja un margen minimo bajo la nav.
        const room = anchorRect.y - 4 - safeTop;
        const delta = Math.max(0, Math.min(need, room));
        if (delta > 0) scrollPageBy(delta);
      }
      setPlacement((current) =>
        current && current.fixed && current.left === Math.round(placed.x * 2) / 2 && current.top === dockTop
          ? current
          : { left: Math.round(placed.x * 2) / 2, top: dockTop, side: "overlay", fixed: true },
      );
      return;
    }
    let spot: { x: number; y: number; side: BarSide } = placed;
    if (aboveSticky && selKind === "text" && !mobile && placed.side !== "overlay") {
      // (minor b) En una tabla apretada, mejor al otro lado o junto al bloque que tapando el de al lado.
      const neighbors: PxRect[] = [];
      for (const other of host.querySelectorAll<HTMLElement>('[data-element-kind="text"][data-drag-mode="move"]')) {
        if (other === element) continue;
        const near = intersect(toPx(other.getBoundingClientRect()), clipRect);
        if (near) neighbors.push(near);
      }
      if (neighbors.length > 0) {
        spot = pickBarSpot({
          placed: { x: placed.x, y: placed.y, side: placed.side },
          anchor: anchorRect,
          anchorPad: ANCHOR_PAD,
          bar: { width, height },
          safe: { x: safeLeft, y: safeTop, width: safeWidth, height: Math.max(0, safeBottom - safeTop) },
          stage: { left: Math.max(stageRect.left, 8), right: Math.min(stageRect.right, viewportWidth - 8) },
          gap: BAR_GAP,
          neighbors,
        });
      }
    }
    const next: Placement = {
      left: Math.round((spot.x - stageRect.left) * 2) / 2,
      top: Math.round((spot.y - stageRect.top) * 2) / 2,
      side: spot.side,
    };
    setPlacement((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.side === next.side
        ? current
        : next,
    );
  }, [hostRef, stageRef, clipRef, boundsRef, selKind, selId, prefer, aboveSticky]);

  useEffect(() => {
    computeRef.current = compute;
  });
  useEffect(() => {
    const tracked = viewportHeightRef.current;
    return () => window.clearTimeout(tracked.timer);
  }, []);

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

  /** Instante (ms) del ultimo toque con el dedo: solo ese gesto genera el click de compatibilidad. */
  const lastTouchRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!aboveSticky) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") lastTouchRef.current = performance.now();
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [aboveSticky]);
  useEffect(() => {
    if (!aboveSticky || selKind === null) return;
    const touched = performance.now() - lastTouchRef.current < TOUCH_SELECT_WINDOW_MS;
    ghostUntilRef.current = touched ? performance.now() + GHOST_CLICK_MS : 0;
  }, [aboveSticky, selKind, selId]);
  const stopGhost = (event: SyntheticEvent) => {
    if (performance.now() < ghostUntilRef.current && !barPressRef.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

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
          <BarSurface
            key="bar"
            surfaceRef={barRef}
            blockPointersOnExit={aboveSticky}
            role="group"
            aria-label={label}
            aria-describedby={description ? descriptionId : undefined}
            data-floating-bar=""
            data-side={placement?.side}
            data-docked={placement?.fixed ? "" : undefined}
            onKeyDown={onKeyDown}
            {...(aboveSticky
              ? {
                  onPointerDownCapture: () => {
                    barPressRef.current = true;
                  },
                  onMouseDownCapture: stopGhost,
                  onMouseUpCapture: stopGhost,
                  onClickCapture: (event: SyntheticEvent) => {
                    stopGhost(event);
                    barPressRef.current = false;
                  },
                }
              : {})}
            onBlur={(event) => {
              // Solo cuando el foco SALE a otro elemento: si el nodo enfocado se desmonta
              // (el selector de tipo sustituye a las acciones) no hay `relatedTarget`.
              const next = event.relatedTarget;
              if (next instanceof Node && !event.currentTarget.contains(next)) {
                onFocusLeave?.();
              }
            }}
            // (W5-U5) La barra de Editar entra y sale solo con opacidad: el resorte de escala dejaba su caja moviendose
            // (36 px en una barra ancha, cola de ~1 s) y nada que mida la posicion —un dedo, una prueba— la daba por quieta.
            initial={aboveSticky ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
            animate={aboveSticky ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={
              aboveSticky
                ? { opacity: 0, transition: { duration: 0.1 } }
                : { opacity: 0, scale: 0.96, transition: { duration: 0.12 } }
            }
            transition={aboveSticky ? { duration: 0.1 } : withCrossFadeOpacity(springs.snappy)}
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              visibility: placement ? "visible" : "hidden",
              transformOrigin: placement?.side === "bottom" ? "top center" : "bottom center",
            }}
            className={cn(
              "material-thick shadow-elevation-3",
              placement?.fixed ? "fixed" : "absolute",
              aboveSticky ? "z-40" : "z-20",
              "flex w-max max-w-full flex-wrap items-center justify-center gap-1 rounded-ios p-1 pointer-coarse:gap-2",
            )}
          >
            {description ? (
              <span id={descriptionId} className="sr-only">
                {description}
              </span>
            ) : null}
            {children}
          </BarSurface>
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
      className={cn("flex items-center gap-0.5 rounded-ios-sm bg-white/6 p-0.5 pointer-coarse:gap-2 pointer-coarse:p-0", className)}
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
