"use client";

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type RefObject,
} from "react";
import { Check, GripVertical, RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useContainerSize } from "@/app/pdf-pro/pages/pagesHooks";
import {
  computeGrid,
  fitRotated,
  insertionIndexAt,
  insertionMarker,
  itemPosition,
  neighbourIndex,
  scrollTopToReveal,
  visibleRange,
  type GridMetrics,
  type GridOptions,
} from "@/app/pdf-pro/pages/pagesLayout";

/**
 * Cuadricula VIRTUALIZADA de paginas del organizador (Wave 7 · U4): solo se pintan las filas a la
 * vista (con margen), asi que 500 paginas pesan lo mismo que 20.
 *
 *  - Es un `listbox` de seleccion multiple: una sola tarjeta en el orden de tabulacion (`tabindex`
 *    movil), flechas/Inicio/Fin/AvPag/RePag mueven el foco, Mayus+flecha amplia la seleccion,
 *    Espacio la alterna, Ctrl/Cmd+A selecciona todo, Supr elimina, R gira, D duplica,
 *    Ctrl/Cmd+Mayus+flechas MUEVEN las paginas seleccionadas (alternativa a arrastrar).
 *  - Arrastrar y soltar con raton/lapiz desde cualquier punto de la tarjeta y con el dedo desde su
 *    asa (`touch-action: none` solo ahi, para no impedir el desplazamiento). Eventos de puntero,
 *    no HTML5 DnD (que no funciona con el tacto). Auto-desplazamiento cerca de los bordes y
 *    Escape cancela.
 *  - El tacto alterna la seleccion con un toque (sin modificadores) y nunca exige arrastrar.
 */

export type GridItem = {
  id: string;
  /** Posicion visible (1-based). */
  number: number;
  kind: "existing" | "external" | "blank" | "image";
  /** Giro extra que se vera (0/90/180/270). */
  rotation: number;
  /** Ancho / alto de la pagina tal como se ve ANTES del giro extra. */
  aspect: number;
  thumb?: string;
  /** Segunda linea de la tarjeta («original 5», «en blanco»...). */
  detail: string;
  ariaLabel: string;
};

export type GridCommand =
  | { type: "delete" }
  | { type: "rotate"; degrees: 90 | -90 }
  | { type: "duplicate" }
  | { type: "selectAll" }
  | { type: "clear" }
  | { type: "shift"; direction: -1 | 1 };

export type PageGridHandle = {
  /** Lleva el foco del teclado a la tarjeta `id` (la desplaza a la vista si hace falta). */
  focusItem: (id: string) => void;
  /** Foco a la tarjeta enfocada (o la primera). */
  focusGrid: () => void;
};

export type PageGridStrings = {
  dragHandle: string;
  dragStart: (count: number) => string;
  dragCancel: string;
  loading: string;
};

export type PageGridProps = {
  items: readonly GridItem[];
  selection: ReadonlySet<string>;
  anchorId: string | null;
  focusId: string | null;
  label: string;
  strings: PageGridStrings;
  /** Reordenar arrastrando (por defecto, si). */
  draggable?: boolean;
  onSelectionChange: (ids: string[], anchorId: string | null, focusId: string | null) => void;
  onFocusChange: (id: string) => void;
  onCommand?: (command: GridCommand) => void;
  onDrop?: (ids: string[], insertBefore: number) => void;
  onVisibleChange?: (range: { first: number; last: number } | null) => void;
  announce?: (text: string) => void;
  className?: string;
  options?: Partial<GridOptions>;
  ref?: Ref<PageGridHandle>;
};

/** Movimiento minimo (px) antes de que un clic pase a ser un arrastre. */
const DRAG_THRESHOLD = 5;
/** Franja (px) junto a cada borde donde el arrastre desplaza la cuadricula. */
const EDGE_ZONE = 72;
/**
 * (M2 · GE-03) Velocidad maxima del auto-desplazamiento, en px POR SEGUNDO: con 26 px por fotograma iba a 1 560 px/s a 60 Hz y a
 * 3 100 px/s en un iPad de 120 Hz (la lista pasaba de largo). Ahora no depende de la tasa de fotogramas y es proporcional a lo
 * cerca que esta el dedo del borde (0 al entrar en la franja, tope en el borde), con un minimo para que arranque al entrar.
 */
const MAX_SCROLL_SPEED = 720;
const MIN_SCROLL_SPEED = 90;
/** Un fotograma largo (pestaña en segundo plano, CPU saturada) no da un salto: el tiempo se acota. */
const MAX_FRAME_MS = 48;

/** Velocidad (px/s, con signo) del auto-desplazamiento para un puntero a `clientY` de un contenedor `top`..`top + height`. */
export function edgeScrollSpeed(clientY: number, top: number, height: number): number {
  const fromTop = top + EDGE_ZONE - clientY;
  const fromBottom = clientY - (top + height - EDGE_ZONE);
  const depth = fromTop > 0 ? fromTop : fromBottom > 0 ? fromBottom : 0;
  if (depth === 0) return 0;
  const closeness = Math.min(1, depth / EDGE_ZONE);
  const speed = MIN_SCROLL_SPEED + (MAX_SCROLL_SPEED - MIN_SCROLL_SPEED) * closeness;
  return fromTop > 0 ? -speed : speed;
}

type DragState = {
  ids: string[];
  /** Posicion del puntero en coordenadas del contenido. */
  x: number;
  y: number;
  insertBefore: number;
};

const FALLBACK_SIZE = { width: 360, height: 520 };
/** Tope del alto que se virtualiza (si el contenedor no tiene alto propio, no se pinta todo). */
const MAX_VIEWPORT = 1600;

type Latest = {
  metrics: GridMetrics;
  items: readonly GridItem[];
  selection: ReadonlySet<string>;
  onDrop?: (ids: string[], insertBefore: number) => void;
  onSelectionChange: (ids: string[], anchorId: string | null, focusId: string | null) => void;
  announce?: (text: string) => void;
  strings: PageGridStrings;
  indexById: ReadonlyMap<string, number>;
};

type DragDeps = {
  scrollerRef: RefObject<HTMLDivElement | null>;
  latest: RefObject<Latest>;
  setDrag: (state: DragState | null) => void;
  setScrollTop: (value: number) => void;
  suppressClick: RefObject<boolean>;
  lastPointerType: RefObject<string>;
};

/**
 * Sensor de arrastre por eventos de puntero. Los oyentes de ventana van en FASE DE CAPTURA: una hoja
 * (`Sheet`) o cualquier ancestro que llame a `stopPropagation()` al burbujear no puede cortar el arrastre. Se crea UNA vez: los oyentes de ventana son siempre
 * las mismas funciones (se pueden quitar), y lo ultimo (tarjetas, seleccion, medidas) se lee de
 * `latest.current` en el momento de usarlo.
 */
function createDragController(deps: DragDeps) {
  type Session = {
    pointerId: number;
    startX: number;
    startY: number;
    id: string;
    active: boolean;
    clientX: number;
    clientY: number;
    ids: string[];
    insertBefore: number;
    raf: number | null;
    /** Marca de tiempo del fotograma anterior (para medir por tiempo, no por fotograma) y resto de pixeles sin aplicar. */
    lastFrame: number | null;
    carry: number;
  };
  let session: Session | null = null;

  const contentPoint = (clientX: number, clientY: number) => {
    const scroller = deps.scrollerRef.current;
    if (!scroller) return { x: clientX, y: clientY };
    const box = scroller.getBoundingClientRect();
    return { x: clientX - box.left + scroller.scrollLeft, y: clientY - box.top + scroller.scrollTop };
  };

  const update = (clientX: number, clientY: number) => {
    if (!session || !session.active) return;
    session.clientX = clientX;
    session.clientY = clientY;
    const point = contentPoint(clientX, clientY);
    session.insertBefore = insertionIndexAt(deps.latest.current.metrics, point.x, point.y);
    deps.setDrag({ ids: session.ids, x: point.x, y: point.y, insertBefore: session.insertBefore });
  };

  const tick = (now: number) => {
    const scroller = deps.scrollerRef.current;
    if (!session || !session.active || !scroller) return;
    const elapsed = session.lastFrame === null ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, now - session.lastFrame));
    session.lastFrame = now;
    const box = scroller.getBoundingClientRect();
    const height = box.height || scroller.clientHeight;
    const speed = edgeScrollSpeed(session.clientY, box.top, height);
    if (speed !== 0 && elapsed > 0) {
      // Pixeles = velocidad × tiempo; la parte fraccionaria se acumula (el navegador redondea `scrollTop` a pixeles).
      const wanted = (speed * elapsed) / 1000 + session.carry;
      const delta = Math.trunc(wanted);
      session.carry = wanted - delta;
      if (delta !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + delta;
        if (scroller.scrollTop !== before) {
          deps.setScrollTop(scroller.scrollTop);
          update(session.clientX, session.clientY);
        }
      }
    } else if (speed === 0) {
      session.carry = 0;
    }
    session.raf = requestAnimationFrame(tick);
  };

  const onMove = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return;
    if (!session.active) {
      if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_THRESHOLD) return;
      const { items, selection, onSelectionChange } = deps.latest.current;
      // Arrastrar una tarjeta que no estaba seleccionada la selecciona (solo ella).
      let ids: string[];
      if (selection.has(session.id)) {
        ids = items.filter((item) => selection.has(item.id)).map((item) => item.id);
      } else {
        ids = [session.id];
        onSelectionChange(ids, session.id, session.id);
      }
      session.active = true;
      session.ids = ids;
      deps.latest.current.announce?.(deps.latest.current.strings.dragStart(ids.length));
      session.raf = requestAnimationFrame(tick);
    }
    event.preventDefault();
    update(event.clientX, event.clientY);
  };

  const finish = (commit: boolean) => {
    const current = session;
    if (!current) return;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    session = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    deps.setDrag(null);
    if (!current.active) return;
    deps.suppressClick.current = true;
    // El clic que sigue a soltar llega justo despues: pasado ese turno se deja de suprimir.
    window.setTimeout(() => {
      deps.suppressClick.current = false;
    }, 0);
    if (commit) deps.latest.current.onDrop?.(current.ids, current.insertBefore);
    else deps.latest.current.announce?.(deps.latest.current.strings.dragCancel);
  };

  function onUp(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.active) update(event.clientX, event.clientY);
    finish(true);
  }

  function onCancel(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    finish(false);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && session?.active) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  return {
    start(event: ReactPointerEvent<HTMLDivElement>, id: string) {
      if (event.button !== 0 || !event.isPrimary || session) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-no-drag]")) return;
      // Con el dedo solo se arrastra desde el asa: el resto de la tarjeta deja desplazar la cuadricula.
      if (event.pointerType === "touch" && !target.closest("[data-drag-handle]")) return;
      session = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        id,
        active: false,
        clientX: event.clientX,
        clientY: event.clientY,
        ids: [],
        insertBefore: 0,
        raf: null,
        lastFrame: null,
        carry: 0,
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onKey, true);
    },
    cancel() {
      finish(false);
    },
  };
}

export function PageGrid({
  items,
  selection,
  anchorId,
  focusId,
  label,
  strings,
  draggable = true,
  onSelectionChange,
  onFocusChange,
  onCommand,
  onDrop,
  onVisibleChange,
  announce,
  className,
  options,
  ref,
}: PageGridProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const measured = useContainerSize(scrollerRef, FALLBACK_SIZE);
  const size = useMemo(
    () => ({ width: measured.width, height: Math.min(measured.height, MAX_VIEWPORT) }),
    [measured.width, measured.height],
  );
  const [scrollTop, setScrollTop] = useState(0);
  const metrics = useMemo(() => computeGrid(size.width, items.length, options), [size.width, items.length, options]);
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.id, index));
    return map;
  }, [items]);

  const focusIndex = focusId !== null ? (indexById.get(focusId) ?? -1) : -1;
  // La que lleva el `tabindex=0`: la enfocada, o la primera.
  const tabId = focusIndex >= 0 ? focusId : (items[0]?.id ?? null);

  const range = useMemo(
    () => visibleRange(metrics, scrollTop, size.height, 2),
    [metrics, scrollTop, size.height],
  );
  const strict = useMemo(
    () => visibleRange(metrics, scrollTop, size.height, 0),
    [metrics, scrollTop, size.height],
  );

  const onVisibleRef = useRef(onVisibleChange);
  useEffect(() => {
    onVisibleRef.current = onVisibleChange;
  });
  const strictFirst = strict?.first ?? -1;
  const strictLast = strict?.last ?? -1;
  useEffect(() => {
    onVisibleRef.current?.(strictFirst < 0 ? null : { first: strictFirst, last: strictLast });
  }, [strictFirst, strictLast]);

  const rendered = useMemo(() => {
    if (!range) return [];
    const indices: number[] = [];
    for (let index = range.first; index <= range.last; index += 1) indices.push(index);
    if (focusIndex >= 0 && (focusIndex < range.first || focusIndex > range.last)) indices.push(focusIndex);
    return indices;
  }, [range, focusIndex]);

  /* ---------------- refs con lo ultimo (los manejadores de ventana no deben quedarse viejos) ---------------- */
  const latest = useRef<Latest>({ metrics, items, selection, onDrop, onSelectionChange, announce, strings, indexById });
  useEffect(() => {
    latest.current = { metrics, items, selection, onDrop, onSelectionChange, announce, strings, indexById };
  });

  /* ---------------- foco ---------------- */
  const pendingFocus = useRef<string | null>(null);
  const focusDom = useCallback((id: string) => {
    const element = scrollerRef.current?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"]`);
    if (element) {
      element.focus({ preventScroll: true });
      return true;
    }
    return false;
  }, []);

  /**
   * (M2 · GE-03) Llevar el foco a una tarjeta se DIFIERE al siguiente pintado (ver el efecto de abajo): quien lo pide justo
   * despues de reordenar (soltar un arrastre, «Mover antes/despues») lo hace con las tarjetas aun en el orden VIEJO, y la
   * posicion que daba `latest` era la de antes del movimiento: la cuadricula saltaba a la fila de donde SALIA la pagina (la
   * primera, tras arrastrar la pagina 1) y la pagina movida quedaba fuera de vista. Con el pintado nuevo en la mano, el indice
   * es el de ahora y el desplazamiento solo ocurre si la tarjeta no esta ya a la vista.
   */
  const pendingReveal = useRef<string | null>(null);
  const [, requestPaint] = useState(0);
  const focusItem = useCallback((id: string) => {
    pendingFocus.current = id;
    pendingReveal.current = id;
    requestPaint((tick) => tick + 1);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusItem,
      focusGrid: () => {
        const id = tabId;
        if (id) focusItem(id);
      },
    }),
    [focusItem, tabId],
  );

  // La tarjeta pedida se lleva a la vista (con el orden y las medidas de ESTE pintado) y recibe el foco en cuanto aparece.
  // Sin lista de dependencias a proposito: corre tras cada pintado y solo actua si hay un foco pendiente (`setScrollTop` queda protegido).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const revealId = pendingReveal.current;
    if (revealId) {
      pendingReveal.current = null;
      const index = indexById.get(revealId);
      const scroller = scrollerRef.current;
      if (index === undefined) {
        pendingFocus.current = null;
      } else if (scroller) {
        const next = scrollTopToReveal(metrics, index, scroller.scrollTop, scroller.clientHeight || size.height);
        if (next !== scroller.scrollTop) {
          scroller.scrollTop = next;
          setScrollTop(next);
        }
      }
    }
    const id = pendingFocus.current;
    if (id && focusDom(id)) pendingFocus.current = null;
  });

  /* ---------------- seleccion ---------------- */
  const selectRange = useCallback(
    (fromIndex: number, toIndex: number): string[] => {
      const low = Math.min(fromIndex, toIndex);
      const high = Math.max(fromIndex, toIndex);
      return items.slice(low, high + 1).map((item) => item.id);
    },
    [items],
  );

  const lastPointerType = useRef<string>("mouse");
  const suppressClick = useRef(false);

  const handleClick = (event: ReactMouseEvent, id: string, index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const toggle = event.ctrlKey || event.metaKey || lastPointerType.current === "touch";
    if (event.shiftKey) {
      const from = anchorId !== null ? (indexById.get(anchorId) ?? index) : index;
      const ids = selectRange(from, index);
      const merged = toggle && !(lastPointerType.current === "touch") ? [...new Set([...selection, ...ids])] : ids;
      onSelectionChange(merged, anchorId ?? id, id);
      return;
    }
    if (toggle) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange([...next], id, id);
      return;
    }
    onSelectionChange([id], id, id);
  };

  /* ---------------- teclado ---------------- */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-page-id]");
    if (!target) return;
    const id = target.dataset.pageId as string;
    const index = indexById.get(id);
    if (index === undefined) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    const moves: Record<string, "left" | "right" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown"> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
      Home: "home",
      End: "end",
      PageUp: "pageUp",
      PageDown: "pageDown",
    };

    if (key in moves) {
      event.preventDefault();
      if (mod && event.shiftKey && key.startsWith("Arrow")) {
        onCommand?.({ type: "shift", direction: key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1 });
        return;
      }
      const pageRows = Math.max(1, Math.floor(size.height / metrics.rowHeight) - 1);
      const next = neighbourIndex(metrics, index, moves[key], pageRows);
      if (next === null) return;
      const nextId = items[next].id;
      if (event.shiftKey) {
        const from = anchorId !== null ? (indexById.get(anchorId) ?? index) : index;
        onSelectionChange(selectRange(from, next), anchorId ?? id, nextId);
      }
      onFocusChange(nextId);
      focusItem(nextId);
      return;
    }
    if (key === " " || key === "Spacebar") {
      event.preventDefault();
      if (event.shiftKey) {
        const from = anchorId !== null ? (indexById.get(anchorId) ?? index) : index;
        onSelectionChange(selectRange(from, index), anchorId ?? id, id);
        return;
      }
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectionChange([...next], id, id);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      onSelectionChange([id], id, id);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      onCommand?.({ type: "delete" });
      return;
    }
    if (key === "Escape") {
      if (onCommand && selection.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        onCommand?.({ type: "clear" });
      }
      return;
    }
    if (mod && (key === "a" || key === "A")) {
      event.preventDefault();
      onCommand?.({ type: "selectAll" });
      return;
    }
    if (!mod && !event.altKey && (key === "r" || key === "R")) {
      event.preventDefault();
      onCommand?.({ type: "rotate", degrees: event.shiftKey ? -90 : 90 });
      return;
    }
    if (!mod && !event.altKey && (key === "d" || key === "D")) {
      event.preventDefault();
      onCommand?.({ type: "duplicate" });
    }
  };

  /* ---------------- arrastrar ---------------- */
  const [drag, setDrag] = useState<DragState | null>(null);
  const controllerRef = useRef<ReturnType<typeof createDragController> | null>(null);
  useEffect(() => {
    const controller = createDragController({ scrollerRef, latest, setDrag, setScrollTop, suppressClick, lastPointerType });
    controllerRef.current = controller;
    return () => {
      controller.cancel();
      controllerRef.current = null;
    };
  }, []);
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    lastPointerType.current = event.pointerType || "mouse";
    if (!draggable) return;
    controllerRef.current?.start(event, id);
  };

  const marker = drag ? insertionMarker(metrics, drag.insertBefore) : null;
  const draggedSet = useMemo(() => new Set(drag?.ids ?? []), [drag]);

  return (
    <div
      ref={scrollerRef}
      role="listbox"
      aria-multiselectable="true"
      aria-label={label}
      data-pages-grid=""
      onKeyDown={handleKeyDown}
      onScroll={(event) => setScrollTop((event.currentTarget as HTMLDivElement).scrollTop)}
      className={cn("relative min-h-0 overflow-y-auto overflow-x-hidden", className)}
    >
      <div className="relative w-full" style={{ height: metrics.totalHeight }}>
        {rendered.map((index) => {
          const item = items[index];
          if (!item) return null;
          const position = itemPosition(metrics, index);
          return (
            <PageCard
              key={item.id}
              item={item}
              index={index}
              total={items.length}
              x={position.x}
              y={position.y}
              width={metrics.cardWidth}
              thumbHeight={metrics.thumbHeight}
              height={metrics.cardHeight}
              selected={selection.has(item.id)}
              dragging={draggedSet.has(item.id)}
              tabbable={item.id === tabId}
              draggable={draggable}
              loadingLabel={strings.loading}
              handleLabel={strings.dragHandle}
              onClick={handleClick}
              onPointerDown={handlePointerDown}
              onFocus={onFocusChange}
            />
          );
        })}
        {marker ? (
          <div
            aria-hidden="true"
            data-drop-marker=""
            className="pointer-events-none absolute z-20 w-1 -translate-x-1/2 rounded-full bg-signal pointer-coarse:w-1.5 shadow-[0_0_0_2px_rgba(255,255,255,0.35)] forced-colors:bg-[Highlight]"
            style={{ left: marker.x, top: marker.y, height: marker.height }}
          />
        ) : null}
        {drag ? (
          <div
            aria-hidden="true"
            data-drag-ghost=""
            className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal px-3 py-1 text-footnote font-semibold text-[var(--color-on-signal)] shadow-elevation-2 forced-colors:border forced-colors:border-[Highlight] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]"
            style={{ left: drag.x, top: drag.y }}
          >
            {drag.ids.length}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type PageCardProps = {
  item: GridItem;
  index: number;
  total: number;
  x: number;
  y: number;
  width: number;
  height: number;
  thumbHeight: number;
  selected: boolean;
  dragging: boolean;
  tabbable: boolean;
  draggable: boolean;
  loadingLabel: string;
  handleLabel: string;
  onClick: (event: ReactMouseEvent, id: string, index: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void;
  onFocus: (id: string) => void;
};

const PageCard = memo(function PageCard({
  item,
  index,
  total,
  x,
  y,
  width,
  height,
  thumbHeight,
  selected,
  dragging,
  tabbable,
  draggable,
  loadingLabel,
  handleLabel,
  onClick,
  onPointerDown,
  onFocus,
}: PageCardProps) {
  const inner = fitRotated(width - 16, thumbHeight - 16, item.aspect, item.rotation);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={item.ariaLabel}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={tabbable ? 0 : -1}
      data-page-id={item.id}
      data-selected={selected ? "true" : undefined}
      data-kind={item.kind}
      onClick={(event) => onClick(event, item.id, index)}
      onPointerDown={(event) => onPointerDown(event, item.id)}
      onFocus={() => onFocus(item.id)}
      className={cn(
        "group absolute flex cursor-pointer select-none flex-col rounded-ios border bg-white/4 text-foreground outline-none",
        "transition-[border-color,background-color,box-shadow,opacity] duration-[var(--duration-fast)]",
        "hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected ? "border-signal bg-signal/12 ring-2 ring-signal" : "border-hairline",
        dragging && "opacity-45",
        // forced-colors: sin colores propios; la seleccion se ve por borde grueso y el foco por el anillo del sistema.
        "forced-colors:border-[ButtonText] forced-colors:data-[selected=true]:border-[3px] forced-colors:data-[selected=true]:border-[Highlight]",
      )}
      style={{ left: x, top: y, width, height }}
    >
      <div
        data-thumb=""
        className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-t-ios"
        style={{ height: thumbHeight }}
      >
        {item.kind === "blank" ? (
          <div
            data-blank=""
            className="absolute left-1/2 top-1/2 border border-hairline-strong bg-white shadow-elevation-1"
            style={{
              width: inner.width,
              height: inner.height,
              transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
            }}
          />
        ) : item.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumb}
            alt=""
            draggable={false}
            className="absolute left-1/2 top-1/2 max-w-none bg-white object-contain shadow-elevation-1"
            style={{
              width: inner.width,
              height: inner.height,
              transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
            }}
          />
        ) : (
          <div
            role="img"
            aria-label={loadingLabel}
            className="absolute left-1/2 top-1/2 flex items-center justify-center bg-white/10"
            style={{
              width: inner.width,
              height: inner.height,
              transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
            }}
          >
            <span className="size-6 animate-pulse rounded-full bg-white/10" />
          </div>
        )}
        {selected ? (
          <span
            aria-hidden="true"
            data-check=""
            className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-signal text-[var(--color-on-signal)] shadow-elevation-1 forced-colors:border forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
          >
            <Check className="size-4" strokeWidth={3} />
          </span>
        ) : null}
        {item.rotation !== 0 ? (
          <span
            aria-hidden="true"
            className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-caption font-semibold text-white forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]"
          >
            <RotateCw className="size-3" />
            {item.rotation}°
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-1.5 pointer-coarse:pl-11 text-center leading-tight">
        <span className="text-footnote font-semibold tabular-nums">{item.number}</span>
        <span className="line-clamp-1 w-full text-caption text-muted-foreground" title={item.detail}>
          {item.detail}
        </span>
      </div>
      {draggable ? (
          <span
            aria-hidden="true"
            data-drag-handle=""
            title={handleLabel}
            className={cn(
              "absolute bottom-1 left-1 z-10 flex size-7 touch-none items-center justify-center rounded-full bg-black/55 text-white",
              "opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 group-focus-visible:opacity-100",
              "pointer-coarse:bottom-0 pointer-coarse:left-0 pointer-coarse:size-11 pointer-coarse:opacity-100",
              selected && "opacity-100",
              "forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]",
            )}
          >
            <GripVertical className="size-4" />
          </span>
        ) : null}
    </div>
  );
});
