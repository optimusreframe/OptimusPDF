"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/cn";
import {
  MIN_BOX_PT,
  resizePxRect,
  type NudgeDirection,
  type PageMetrics,
  type PxRect,
  type ResizeHandle,
} from "@/app/edit-pdf/editCanvasMath";
import {
  SMALL_ELEMENT_PX,
  elementPxRect,
  linePxPoints,
  moveLineEnd,
  normBoxToPx,
  pxRectToNormBox,
  resizeLockedPxRect,
  shiftLinePoints,
} from "@/app/edit-pdf/editElements";
import type {
  EditImageItem,
  EditShapeElement,
  EditShapeItem,
  ImageAsset,
  LinePoints,
} from "@/app/edit-pdf/editSession";
import type { EditInlineStrings, EditStrings } from "@/app/edit-pdf/strings";
import { PINCH_START_EVENT } from "@/app/edit-pdf/useZoomGestures";
import { moveForKey, moveTarget, type LayerMove } from "@/app/edit-pdf/layerNavigation";
import { CHECK_STROKES, MIN_ELEMENT_SIDE } from "@/lib/pdf/editPdf";

/*
 * Capa de imagenes y formas de la hoja (W5-U4b): imagen, rectangulo, elipse,
 * linea, resaltado y marca, dibujados en vivo sobre la pagina. Va como HIJA de
 * `TextBlockLayer` para compartir su contexto de apilado:
 *
 *   z-1 cobertura · z-2 texto editado y RESALTADOS · z-3 regiones de texto
 *   z-4 imagenes y formas · z-5 tiradores · z-6 editor de texto
 *
 * En el PDF las formas se pintan DESPUES del texto editado (`splitForExport`), de
 * ahi que se vean encima del texto. El resaltado va un nivel por debajo de las
 * regiones de texto SOLO para recibir el puntero: asi pinchar un texto resaltado
 * sigue seleccionando el texto (un resaltado casi siempre lo cubre entero) y el
 * resaltado se alcanza por los bordes que sobresalen del texto, por teclado o
 * con su herramienta. Un rectangulo o una elipse SIN relleno solo reciben el
 * puntero por su borde (`pointer-events: stroke`): el texto que enmarcan sigue
 * siendo editable.
 *
 * Cada elemento tiene una region accesible (`role="button"`, enfocable, con
 * `data-element-kind`/`data-element-id`, que es lo que ancla la barra
 * flotante) que NO recibe puntero: el puntero lo reciben la figura SVG o la
 * imagen. Teclado: flechas mueven (Mayus = paso grande), Alt+flechas cambian el
 * tamano (en una linea mueven su segundo extremo), Supr borra, Esc suelta.
 * Con una herramienta de dibujo armada (`passive`) los elementos no reciben
 * puntero: arrastrar sobre uno dibuja un elemento nuevo, como en Firmar. Con el
 * resaltador armado, los resaltados existentes si lo reciben (`interactiveTypes`).
 */

const LINE_ENDS = ["p1", "p2"] as const;
type LineEnd = (typeof LINE_ENDS)[number];

export type ElementHandlers = {
  onSelect: (id: string | null) => void;
  /** Soltar un arrastre de movimiento (px de la hoja). */
  onMove: (id: string, dxPx: number, dyPx: number) => void;
  /** Caja nueva (px de la hoja) de una imagen o figura de caja. */
  onResize: (id: string, rect: PxRect) => void;
  /** Extremos nuevos de una linea. */
  onReshape: (id: string, points: LinePoints) => void;
  onNudge: (id: string, direction: NudgeDirection, big: boolean, resize: boolean) => void;
  onDelete: (id: string) => void;
  /** Hay un arrastre en curso (la barra flotante se oculta). */
  onGesture: (active: boolean) => void;
  /** Tab desde el elemento seleccionado: `true` si el foco ya paso a la barra. */
  onTabIntoBar: (id: string) => boolean;
};

export type ElementItem = EditShapeItem | EditImageItem;

export type ElementLayerProps = {
  metrics: PageMetrics;
  /** Imagenes y formas de la pagina, en orden de creacion (lo ultimo, encima). */
  items: readonly ElementItem[];
  assets: Readonly<Record<string, ImageAsset>>;
  selectedId: string | null;
  /** Herramienta armada: los elementos no reciben puntero (salvo los tipos de `interactiveTypes`). */
  passive: boolean;
  /**
   * Tipos que siguen recibiendo puntero con una herramienta armada. Con el resaltador armado, los
   * resaltados existentes se pueden elegir (por debajo del texto no se alcanzarian con el raton).
   */
  interactiveTypes?: readonly string[];
  coarse: boolean;
  /** Elemento que se esta dibujando ahora mismo (vista previa en vivo). */
  draft: EditShapeElement | null;
  strings: EditInlineStrings;
  typeLabels: EditStrings["typeLabels"];
  handlers: ElementHandlers;
};

type Gesture =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; rect: PxRect }
  | { kind: "end"; end: LineEnd; points: LinePoints };

type GestureStart = {
  kind: "move" | "resize" | "end";
  handle?: ResizeHandle;
  end?: LineEnd;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  cancelled: boolean;
  pointerType: string;
  startRect: PxRect;
  /** Posicion de la hoja en pantalla al empezar: los extremos de una linea se miden contra ella. */
  sheetLeft: number;
  sheetTop: number;
};

/** Nombre accesible de un elemento, sin su posicion. */
export function elementName(
  item: ElementItem,
  typeLabels: EditStrings["typeLabels"],
  strings: EditInlineStrings,
): string {
  if (item.kind === "image") return typeLabels.image;
  const el = item.element;
  if (el.type === "check") return `${typeLabels.check}: ${el.mark === "cross" ? strings.markCross : strings.markCheck}`;
  return typeLabels[el.type];
}

/* ------------------------------------------------------------------ *
 * Figura SVG (visual + zona de puntero)
 * ------------------------------------------------------------------ */

type PointerHandler = (event: ReactPointerEvent<Element>) => void;
type HitProps = {
  /** Evita que el clic mueva el foco a la hoja: lo toma la region del elemento. */
  onMouseDown: (event: ReactMouseEvent<Element>) => void;
  onPointerDown: PointerHandler;
  onPointerMove: PointerHandler;
  onPointerUp: PointerHandler;
  onPointerCancel: PointerHandler;
};

function strokePx(width: number, scale: number): number {
  return width > 0 ? Math.max(0.75, width * scale) : 0;
}

/** Ancho (px) de la zona de puntero alrededor de un trazo. */
function hitStroke(strokeWidth: number, coarse: boolean): number {
  return Math.max(coarse ? 44 : 16, strokeWidth + 8);
}

const SELECTION_STYLE: CSSProperties = {
  stroke: "var(--color-signal)",
  strokeWidth: 2,
  fill: "none",
};

export type ShapeSvgProps = {
  element: EditShapeElement;
  metrics: PageMetrics;
  selected?: boolean;
  /** Con zona de puntero (elementos de la pagina); sin ella, la vista previa del dibujo. */
  hit?: { coarse: boolean; handlers: HitProps } | null;
  touchAction?: string;
  className?: string;
};

export function ShapeSvg({
  element,
  metrics,
  selected = false,
  hit = null,
  touchAction,
  className,
}: ShapeSvgProps) {
  const scale = metrics.scale;
  const hitHandlers = hit?.handlers;
  const cursor: CSSProperties = { cursor: "move" };

  let visual: React.ReactNode = null;
  let hitShape: React.ReactNode = null;
  let outline: React.ReactNode = null;

  if (element.type === "line") {
    const p = linePxPoints(metrics, element);
    const width = strokePx(element.strokeWidth, scale);
    visual = (
      <line
        data-shape-visual="line"
        x1={p.x1}
        y1={p.y1}
        x2={p.x2}
        y2={p.y2}
        stroke={element.strokeColor}
        strokeWidth={Math.max(1, width)}
        strokeLinecap="round"
      />
    );
    if (hit) {
      hitShape = (
        <line
          data-hit="line"
          x1={p.x1}
          y1={p.y1}
          x2={p.x2}
          y2={p.y2}
          stroke="transparent"
          strokeWidth={hitStroke(width, hit.coarse)}
          strokeLinecap="round"
          pointerEvents="stroke"
          style={cursor}
          {...hitHandlers}
        />
      );
    }
    if (selected) {
      outline = (
        <line
          x1={p.x1}
          y1={p.y1}
          x2={p.x2}
          y2={p.y2}
          style={{ ...SELECTION_STYLE, strokeDasharray: "5 4" }}
        />
      );
    }
  } else {
    const rect = normBoxToPx(metrics, element);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (element.type === "rect" || element.type === "ellipse") {
      const width = strokePx(element.strokeWidth, scale);
      const paint = {
        fill: element.fill ? element.fillColor : "none",
        fillOpacity: element.fill ? element.fillOpacity : undefined,
        stroke: width > 0 ? element.strokeColor : "none",
        strokeWidth: width,
      };
      visual =
        element.type === "rect" ? (
          <rect data-shape-visual="rect" x={rect.left} y={rect.top} width={rect.width} height={rect.height} {...paint} />
        ) : (
          <ellipse
            data-shape-visual="ellipse"
            cx={cx}
            cy={cy}
            rx={rect.width / 2}
            ry={rect.height / 2}
            {...paint}
          />
        );
      if (hit) {
        // Sin relleno solo el borde recibe el puntero: lo que hay dentro sigue al alcance.
        const common = {
          "data-hit": element.type,
          fill: "transparent",
          stroke: "transparent",
          strokeWidth: hitStroke(width, hit.coarse),
          pointerEvents: element.fill ? ("all" as const) : ("stroke" as const),
          style: cursor,
          ...hitHandlers,
        };
        hitShape =
          element.type === "rect" ? (
            <rect x={rect.left} y={rect.top} width={rect.width} height={rect.height} {...common} />
          ) : (
            <ellipse cx={cx} cy={cy} rx={rect.width / 2} ry={rect.height / 2} {...common} />
          );
      }
    } else if (element.type === "highlight") {
      visual = (
        <rect
          data-shape-visual="highlight"
          x={rect.left}
          y={rect.top}
          width={rect.width}
          height={rect.height}
          fill={element.color}
          fillOpacity={element.opacity}
        />
      );
      if (hit) {
        const minSide = hit.coarse ? 44 : 20;
        const h = Math.max(rect.height, minSide);
        hitShape = (
          <rect
            data-hit="highlight"
            x={rect.left}
            y={cy - h / 2}
            width={rect.width}
            height={h}
            fill="transparent"
            pointerEvents="all"
            style={cursor}
            {...hitHandlers}
          />
        );
      }
    } else {
      // Marca: los mismos trazos que el motor, dentro de su caja.
      const width = Math.max(1, strokePx(element.strokeWidth, scale));
      visual = (
        <g data-shape-visual="check">
          {CHECK_STROKES[element.mark].map(([x1, y1, x2, y2], index) => (
            <line
              key={index}
              x1={rect.left + x1 * rect.width}
              y1={rect.top + y1 * rect.height}
              x2={rect.left + x2 * rect.width}
              y2={rect.top + y2 * rect.height}
              stroke={element.strokeColor}
              strokeWidth={width}
              strokeLinecap="round"
            />
          ))}
        </g>
      );
      if (hit) {
        const minSide = hit.coarse ? 44 : 28;
        const w = Math.max(rect.width, minSide);
        const h = Math.max(rect.height, minSide);
        hitShape = (
          <rect
            data-hit="check"
            x={cx - w / 2}
            y={cy - h / 2}
            width={w}
            height={h}
            fill="transparent"
            pointerEvents="all"
            style={cursor}
            {...hitHandlers}
          />
        );
      }
    }
    if (selected) {
      outline = (
        <rect
          x={rect.left - 2}
          y={rect.top - 2}
          width={rect.width + 4}
          height={rect.height + 4}
          rx={3}
          style={SELECTION_STYLE}
        />
      );
    }
  }

  return (
    <svg
      aria-hidden="true"
      width={metrics.cssWidth}
      height={metrics.cssHeight}
      className={cn("pointer-events-none absolute top-0 left-0 overflow-visible", className)}
      style={{ touchAction }}
    >
      {visual}
      {outline}
      {hitShape}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Entrada de un elemento
 * ------------------------------------------------------------------ */

type EntryProps = {
  item: ElementItem;
  asset: ImageAsset | undefined;
  index: number;
  total: number;
  metrics: PageMetrics;
  selected: boolean;
  passive: boolean;
  coarse: boolean;
  name: string;
  hintId: string;
  strings: EditInlineStrings;
  handlers: ElementHandlers;
  /** (W5-U5) Unica parada de Tab de la capa (roving tabindex). */
  tabStop: boolean;
  navigate: (id: string, move: LayerMove) => void;
  onFocusEntry: (id: string) => void;
};

function ElementEntryImpl(props: EntryProps) {
  const {
    item,
    asset,
    index,
    total,
    metrics,
    selected,
    passive,
    coarse,
    name,
    hintId,
    strings,
    handlers,
    tabStop,
    navigate,
    onFocusEntry,
  } = props;
  const element = item.element;
  const lineEl = item.kind === "shape" && item.element.type === "line" ? item.element : null;
  const isLine = lineEl !== null;
  const isImage = item.kind === "image";
  const id = item.id;

  const baseRect = useMemo(() => elementPxRect(metrics, element), [metrics, element]);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<GestureStart | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const bounds = useMemo(
    () => ({ width: metrics.cssWidth, height: metrics.cssHeight }),
    [metrics.cssWidth, metrics.cssHeight],
  );
  const minSide = Math.max(MIN_ELEMENT_SIDE * metrics.cssWidth, MIN_ELEMENT_SIDE * metrics.cssHeight, MIN_BOX_PT * metrics.scale * 0.5);
  const lockedRatio = isImage ? baseRect.height / Math.max(1, baseRect.width) : 0;

  const finish = () => {
    gestureRef.current = null;
    setGesture(null);
    handlers.onGesture(false);
  };

  const begin = (
    event: ReactPointerEvent<Element>,
    kind: "move" | "resize" | "end",
    extra: { handle?: ResizeHandle; end?: LineEnd } = {},
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sin captura el gesto sigue mientras el puntero este encima.
    }
    // El teclado (Supr, flechas) actua sobre el elemento tocado: su region toma el foco.
    regionRef.current?.focus({ preventScroll: true });
    const sheet = event.currentTarget.closest("[data-page-index]")?.getBoundingClientRect();
    gestureRef.current = {
      kind,
      ...extra,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      cancelled: false,
      pointerType: event.pointerType,
      startRect: { ...baseRect },
      sheetLeft: sheet?.left ?? 0,
      sheetTop: sheet?.top ?? 0,
    };
  };

  const computeGesture = (g: GestureStart, clientX: number, clientY: number): Gesture | null => {
    const dx = clientX - g.startX;
    const dy = clientY - g.startY;
    if (g.kind === "move") return { kind: "move", dx, dy };
    if (g.kind === "end" && g.end && lineEl) {
      const point = { x: clientX - g.sheetLeft, y: clientY - g.sheetTop };
      return { kind: "end", end: g.end, points: moveLineEnd(metrics, lineEl, g.end, point) };
    }
    if (g.kind === "resize" && g.handle) {
      const rect = isImage
        ? resizeLockedPxRect(g.startRect, g.handle, dx, dy, lockedRatio, minSide, bounds)
        : resizePxRect(g.startRect, g.handle, dx, dy, minSide, bounds);
      return { kind: "resize", rect };
    }
    return null;
  };

  const onPointerMove = (event: ReactPointerEvent<Element>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId || g.cancelled) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (!g.moved) {
      if (Math.hypot(dx, dy) <= 8) return;
      g.moved = true;
      handlers.onGesture(true);
    }
    const next = computeGesture(g, event.clientX, event.clientY);
    if (next) setGesture(next);
  };

  const onPointerUp = (event: ReactPointerEvent<Element>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ya liberado.
    }
    if (g.cancelled) {
      finish();
      return;
    }
    if (g.moved) {
      const result = computeGesture(g, event.clientX, event.clientY);
      finish();
      if (!result) return;
      if (result.kind === "move") {
        if (result.dx !== 0 || result.dy !== 0) handlers.onMove(id, result.dx, result.dy);
      } else if (result.kind === "resize") {
        handlers.onResize(id, result.rect);
      } else {
        handlers.onReshape(id, result.points);
      }
      return;
    }
    finish();
    // Toque corto: con el dedo la seleccion llega ahora (arrastrar era desplazar la pagina).
    if (g.pointerType !== "mouse" && g.kind === "move" && !selected) handlers.onSelect(id);
  };

  const onPointerCancel = (event: ReactPointerEvent<Element>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    finish();
  };

  const dragging = gesture !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (gestureRef.current) gestureRef.current.cancelled = true;
      setGesture(null);
      handlers.onGesture(false);
    };
    // Un pellizco con dos dedos cancela el arrastre del primero.
    const onPinch = () => {
      if (gestureRef.current) gestureRef.current.cancelled = true;
      setGesture(null);
      handlers.onGesture(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(PINCH_START_EVENT, onPinch);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(PINCH_START_EVENT, onPinch);
    };
  }, [dragging, handlers]);

  const onBodyPointerDown = (event: ReactPointerEvent<Element>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Con raton o lapiz, el clic selecciona al instante; con el dedo, al soltar.
    if (event.pointerType !== "touch" && !selected) handlers.onSelect(id);
    begin(event, "move");
  };

  const keepFocus = (event: ReactMouseEvent<Element>) => event.preventDefault();

  const onCornerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    begin(event, "resize", { handle: event.currentTarget.dataset.resizeHandle as ResizeHandle });
  };

  const onEndPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    begin(event, "end", { end: event.currentTarget.dataset.lineEnd as LineEnd });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const arrow: Record<string, NudgeDirection> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      handlers.onDelete(id);
    } else if (arrow[event.key] && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      // Seleccionado (o con Mayus / Alt): las flechas MUEVEN o redimensionan. Si solo
      // tiene el foco, recorren los elementos de la pagina.
      if (selected || event.altKey || event.shiftKey) {
        handlers.onNudge(id, arrow[event.key], event.shiftKey, event.altKey);
      } else {
        navigate(id, moveForKey(event.key)!);
      }
    } else if (
      (event.key === "Home" || event.key === "End" || event.key === "PageUp" || event.key === "PageDown") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      navigate(id, moveForKey(event.key)!);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handlers.onSelect(id);
    } else if (event.key === "Escape") {
      handlers.onSelect(null);
    } else if (event.key === "Tab" && !event.shiftKey && selected) {
      if (handlers.onTabIntoBar(id)) event.preventDefault();
    }
  };

  /* Geometria en vivo (durante un arrastre). */
  let liveElement: EditShapeElement | null = item.kind === "shape" ? item.element : null;
  let liveRect: PxRect = baseRect;
  if (gesture) {
    if (lineEl) {
      const points =
        gesture.kind === "end"
          ? gesture.points
          : gesture.kind === "move"
            ? shiftLinePoints(metrics, lineEl, gesture.dx, gesture.dy)
            : null;
      if (points) {
        liveElement = { ...lineEl, ...points };
        liveRect = elementPxRect(metrics, liveElement);
      }
    } else if (gesture.kind === "resize") {
      liveRect = gesture.rect;
    } else if (gesture.kind === "move") {
      liveRect = {
        ...baseRect,
        left: Math.min(Math.max(0, baseRect.left + gesture.dx), Math.max(0, bounds.width - baseRect.width)),
        top: Math.min(Math.max(0, baseRect.top + gesture.dy), Math.max(0, bounds.height - baseRect.height)),
      };
    }
    if (item.kind === "shape" && !lineEl) {
      liveElement = { ...item.element, ...pxRectToNormBox(metrics, liveRect) } as EditShapeElement;
    }
  }

  const hitActive = !passive;
  const touchAction = selected ? "none" : "pan-y";
  const bodyHandlers: HitProps = {
    onMouseDown: keepFocus,
    onPointerDown: onBodyPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };

  const handleHit = coarse ? 44 : 28;
  const small = Math.min(liveRect.width, liveRect.height) < SMALL_ELEMENT_PX;
  const showHandles = selected && hitActive;

  const corners: Record<ResizeHandle, { left: number; top: number }> = {
    nw: { left: liveRect.left, top: liveRect.top },
    ne: { left: liveRect.left + liveRect.width, top: liveRect.top },
    sw: { left: liveRect.left, top: liveRect.top + liveRect.height },
    se: { left: liveRect.left + liveRect.width, top: liveRect.top + liveRect.height },
  };
  // Un elemento diminuto solo lleva el tirador de la esquina inferior derecha y FUERA de su cuerpo.
  const cornerList: ResizeHandle[] = small ? ["se"] : ["nw", "ne", "sw", "se"];
  const outsideShift = small ? handleHit / 2 : 0;

  const handleStyle = (left: number, top: number): CSSProperties => ({
    left: left - handleHit / 2,
    top: top - handleHit / 2,
    width: handleHit,
    height: handleHit,
  });

  const lineEnds = (() => {
    if (!isLine || !liveElement || liveElement.type !== "line") return null;
    return linePxPoints(metrics, liveElement);
  })();

  const label = strings.elementLabel(name, index + 1, total);
  const highlightLevel = element.type === "highlight";
  const regionRect = liveRect;

  return (
    <>
      {item.kind === "image" ? (
        asset ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={asset.previewUrl}
            alt=""
            draggable={false}
            data-element-image={id}
            {...(hitActive ? bodyHandlers : {})}
            className={cn(
              "absolute z-[4] block max-w-none select-none",
              hitActive ? "pointer-events-auto cursor-move" : "pointer-events-none",
            )}
            style={{
              left: liveRect.left,
              top: liveRect.top,
              width: liveRect.width,
              height: liveRect.height,
              touchAction,
              outline: selected ? "2px solid var(--color-signal)" : undefined,
              outlineOffset: 2,
            }}
          />
        ) : null
      ) : liveElement ? (
        <ShapeSvg
          element={liveElement}
          metrics={metrics}
          selected={selected}
          hit={hitActive ? { coarse, handlers: bodyHandlers } : null}
          touchAction={touchAction}
          className={highlightLevel ? "z-[2]" : "z-[4]"}
        />
      ) : null}

      <div
        ref={regionRef}
        role="button"
        tabIndex={tabStop ? 0 : -1}
        aria-label={label}
        aria-pressed={selected}
        aria-describedby={hintId}
        aria-keyshortcuts="Delete ArrowUp ArrowDown Home End"
        data-element-kind={item.kind}
        data-element-type={element.type}
        data-element-id={id}
        data-drag-mode="move"
        data-selected={selected ? "" : undefined}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocusEntry(id);
        }}
        className={cn(
          "pointer-events-none absolute z-[4] rounded-[3px]",
          "focus-visible:outline-2 focus-visible:outline-offset-4 outline-signal",
        )}
        style={{
          left: regionRect.left,
          top: regionRect.top,
          width: Math.max(regionRect.width, 1),
          height: Math.max(regionRect.height, 1),
        }}
      />

      {showHandles && !isLine
        ? cornerList.map((handle) => (
            <div
              key={handle}
              aria-hidden="true"
              data-resize-handle={handle}
              data-element-handle={id}
              onMouseDown={keepFocus}
              onPointerDown={onCornerPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              className={cn(
                "pointer-events-auto absolute z-[5] flex touch-none items-center justify-center",
                handle === "nw" || handle === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize",
              )}
              style={handleStyle(
                corners[handle].left + (small ? outsideShift : 0),
                corners[handle].top + (small ? outsideShift : 0),
              )}
            >
              <span className="size-2.5 rounded-full border-2 border-signal bg-white" />
            </div>
          ))
        : null}

      {showHandles && lineEnds
        ? LINE_ENDS.map((end) => {
            const x = end === "p1" ? lineEnds.x1 : lineEnds.x2;
            const y = end === "p1" ? lineEnds.y1 : lineEnds.y2;
            return (
              <div
                key={end}
                aria-hidden="true"
                data-line-end={end}
                data-element-handle={id}
                onMouseDown={keepFocus}
                onPointerDown={onEndPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                className="pointer-events-auto absolute z-[5] flex cursor-move touch-none items-center justify-center"
                style={handleStyle(x, y)}
              >
                <span className="size-2.5 rounded-full border-2 border-signal bg-white" />
              </div>
            );
          })
        : null}
    </>
  );
}

const ElementEntry = memo(ElementEntryImpl);

/* ------------------------------------------------------------------ *
 * Capa
 * ------------------------------------------------------------------ */

export function ElementLayer({
  metrics,
  items,
  assets,
  selectedId,
  passive,
  interactiveTypes,
  coarse,
  draft,
  strings,
  typeLabels,
  handlers,
}: ElementLayerProps) {
  const hintId = useId();
  const names = useMemo(
    () => items.map((item) => elementName(item, typeLabels, strings)),
    [items, typeLabels, strings],
  );

  /* Roving tabindex: UNA sola parada de Tab para todos los elementos de la pagina. */
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const stopId =
    (lastFocused !== null && ids.includes(lastFocused) && lastFocused) ||
    (selectedId !== null && ids.includes(selectedId) && selectedId) ||
    ids[0] ||
    null;
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  });
  const navigate = useCallback((from: string, move: LayerMove) => {
    const list = idsRef.current;
    const index = list.indexOf(from);
    if (index < 0) return;
    const target = list[moveTarget(index, list.length, move)];
    if (!target || target === from) return;
    const regions = document.querySelectorAll<HTMLElement>(
      '[data-element-kind="shape"][data-drag-mode="move"], [data-element-kind="image"][data-drag-mode="move"]',
    );
    for (const region of Array.from(regions)) {
      if (region.dataset.elementId === target) {
        region.focus();
        return;
      }
    }
  }, []);
  const onFocusEntry = useCallback((id: string) => setLastFocused(id), []);

  return (
    <>
      {items.map((item, index) => (
        <ElementEntry
          key={item.id}
          item={item}
          asset={item.kind === "image" ? assets[item.element.assetId] : undefined}
          index={index}
          total={items.length}
          metrics={metrics}
          selected={selectedId === item.id}
          passive={passive && !interactiveTypes?.includes(item.element.type)}
          coarse={coarse}
          name={names[index]}
          hintId={hintId}
          strings={strings}
          handlers={handlers}
          tabStop={item.id === stopId}
          navigate={navigate}
          onFocusEntry={onFocusEntry}
        />
      ))}
      {draft ? (
        <div data-element-draft="" aria-hidden="true">
          <ShapeSvg element={draft} metrics={metrics} className="z-[4]" />
        </div>
      ) : null}
      <span id={hintId} className="sr-only">
        {strings.elementHint}
      </span>
    </>
  );
}
