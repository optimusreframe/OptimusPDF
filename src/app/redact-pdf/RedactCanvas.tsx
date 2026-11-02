"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Droplet,
  Grid3x3,
  Redo2,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { Spinner } from "@/components/ui/Spinner";
import { HIT_44_PSEUDO } from "@/components/ui/touchTarget";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  DEFAULT_PAINT_COLOR,
  DEFAULT_STROKE_WIDTH,
  ERASER_RADIUS,
  MAX_STROKE_WIDTH,
  MIN_BOX_SIDE,
  MIN_STROKE_WIDTH,
  MIN_STROKE_POINTS,
  elementHitTest,
  strokeBounds,
  type RedactElement,
  type RedactMode,
  type RedactPoint,
  type RedactRectElement,
  type RedactStrokeElement,
} from "@/lib/pdf/redact";
import { useHistoryState } from "@/app/redact-pdf/useHistoryState";
import type { RedactStrings } from "@/app/redact-pdf/strings";

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Identificadores estables sin depender de `crypto.randomUUID`. */
let elementCounter = 0;
function nextElementId(): string {
  elementCounter += 1;
  return `el-${elementCounter}`;
}

type Draft = { x: number; y: number; width: number; height: number };

type DragOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
};

type RedactTool = "rect" | "brush" | "eraser";

export type RedactCanvasProps = {
  file: File | null;
  elements: RedactElement[];
  onElementsChange: (elements: RedactElement[]) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  strings: RedactStrings;
  onError?: (code: PdfErrorCode) => void;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function normalizeRect(draft: Draft): Draft {
  const x = Math.min(draft.x, draft.x + draft.width);
  const y = Math.min(draft.y, draft.y + draft.height);
  return {
    x,
    y,
    width: Math.min(1 - x, Math.abs(draft.width)),
    height: Math.min(1 - y, Math.abs(draft.height)),
  };
}

function pointFromClient(clientX: number, clientY: number, origin: DragOrigin): RedactPoint {
  return {
    x: clamp01((clientX - origin.left) / origin.width),
    y: clamp01((clientY - origin.top) / origin.height),
  };
}

/**
 * Puntos reales del evento en fraccion de pagina (0..1). Igual que en el
 * compositor de firma (`SignatureComposer.tsx`), un trazo rapido en el
 * movil llega con varios puntos por evento de React: sin recuperrarlos
 * con `getCoalescedEvents` el navegador solo entrega el ultimo punto y el
 * trazo se convierte en una sucesion de rectas largas en vez de una curva
 * suave. Implementacion propia y no compartida con `SignatureComposer`
 * (que trabaja en espacio de pixeles de un canvas de dibujo real, no en
 * fraccion de pagina sobre una imagen): ver nota de arquitectura en el
 * reporte de este workstream para la recomendacion de extraer un modulo
 * comun en un futuro pase, sin arriesgar el archivo de otro workstream en
 * paralelo.
 */
function pointsFromEvent(
  event: ReactPointerEvent<HTMLDivElement>,
  origin: DragOrigin,
): RedactPoint[] {
  const native = event.nativeEvent;
  const batch =
    typeof native.getCoalescedEvents === "function"
      ? native.getCoalescedEvents()
      : [];
  const items = batch.length > 0 ? batch : [native];
  return items.map((item) => pointFromClient(item.clientX, item.clientY, origin));
}

function isRect(element: RedactElement): element is RedactRectElement {
  return element.kind === "rect";
}

function isStroke(element: RedactElement): element is RedactStrokeElement {
  return element.kind === "stroke";
}

/** Color indicativo del efecto en la vista previa (no es el resultado final). */
function indicatorColor(mode: RedactMode, color: string | undefined): string {
  switch (mode) {
    case "paint":
      return color ?? DEFAULT_PAINT_COLOR;
    case "blur":
      return "#38bdf8";
    case "pixelate":
      return "#f59e0b";
    case "black":
    default:
      return "#000000";
  }
}

function ModeIcon({ mode }: { mode: RedactMode }) {
  if (mode === "blur") return <Droplet aria-hidden="true" className="size-3" />;
  if (mode === "pixelate") return <Grid3x3 aria-hidden="true" className="size-3" />;
  return <Square aria-hidden="true" className="size-3" />;
}

/**
 * Vista previa donde se dibujan las zonas a censurar. Cada elemento
 * (rectangulo o trazo a mano alzada) se guarda normalizado 0..1 sobre la
 * pagina renderizada, de modo que el motor puede aplicarlo a cualquier
 * resolucion de rasterizado.
 */
export function RedactCanvas(props: RedactCanvasProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <RedactCanvasInner key={key} {...props} />;
}

function RedactCanvasInner({
  file,
  elements,
  onElementsChange,
  pageIndex,
  onPageIndexChange,
  strings,
  onError,
}: RedactCanvasProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const [tool, setTool] = useState<RedactTool>("rect");
  const [mode, setMode] = useState<RedactMode>("black");
  const [paintColor, setPaintColor] = useState(DEFAULT_PAINT_COLOR);
  const [brushWidth, setBrushWidth] = useState(DEFAULT_STROKE_WIDTH);
  const [erasingIds, setErasingIds] = useState<Set<string>>(new Set());

  const [draftRect, setDraftRect] = useState<Draft | null>(null);
  const [draftStroke, setDraftStroke] = useState<RedactPoint[] | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const dragOriginRef = useRef<DragOrigin | null>(null);
  const eraseHitsRef = useRef<Set<string>>(new Set());
  const errorRef = useRef(onError);

  const history = useHistoryState<RedactElement[]>(elements);
  const currentElements = history.current;
  const onElementsChangeRef = useRef(onElementsChange);
  const mountedRef = useRef(false);

  useEffect(() => {
    errorRef.current = onError;
    onElementsChangeRef.current = onElementsChange;
  });

  // Propaga el snapshot activo del historial hacia el padre, salvo en el
  // primer render (donde ya coincide con el valor inicial recibido).
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    onElementsChangeRef.current(currentElements);
  }, [currentElements]);

  /* Miniaturas de navegacion: una pasada secuencial por el documento. */
  useEffect(() => {
    // El componente se remonta al cambiar de archivo (ver `key`), asi que
    // sin archivo el estado ya es el inicial: no hay nada que limpiar.
    if (!file) return;
    let cancelled = false;

    void (async () => {
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        setPageCount(document.numPages);

        const collected: string[] = [];
        for (let index = 1; index <= document.numPages; index += 1) {
          if (cancelled) break;
          const page = await document.getPage(index);
          const url = await renderPageToDataUrl(page, {
            maxWidth: THUMB_WIDTH,
          });
          page.cleanup();
          collected.push(url);
          if (!cancelled) setThumbs([...collected]);
        }
        void closePdfDocument(document);
      } catch (error) {
        if (!cancelled) errorRef.current?.(toPdfError(error).code);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  /* Vista grande de la pagina activa. */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        const number = Math.min(
          Math.max(1, pageIndex + 1),
          Math.max(1, document.numPages),
        );
        const page = await document.getPage(number);
        const url = await renderPageToDataUrl(page, {
          maxWidth: PREVIEW_WIDTH,
        });
        page.cleanup();
        void closePdfDocument(document);
        if (!cancelled) setPreview(url);
      } catch (error) {
        if (!cancelled) errorRef.current?.(toPdfError(error).code);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, pageIndex]);

  const pageElements = currentElements.filter((el) => el.pageIndex === pageIndex);

  function getDragOrigin(): DragOrigin | null {
    const host = hostRef.current;
    if (!host || !preview) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
    };
  }

  /* --- Herramienta rectangulo (arrastrar) --- */

  const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = getDragOrigin();
    if (!origin) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromClient(event.clientX, event.clientY, origin);
    dragOriginRef.current = { ...origin, x: point.x, y: point.y };
    setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    event.preventDefault();
    const point = pointFromClient(event.clientX, event.clientY, origin);
    setDraftRect({
      x: origin.x,
      y: origin.y,
      width: point.x - origin.x,
      height: point.y - origin.y,
    });
  };

  const endDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const current = draftRect;
    setDraftRect(null);
    if (!origin || !current) return;

    const rect = normalizeRect(current);
    if (rect.width < MIN_BOX_SIDE || rect.height < MIN_BOX_SIDE) return;

    const element: RedactRectElement = {
      id: nextElementId(),
      kind: "rect",
      pageIndex,
      ...rect,
      mode,
      color: mode === "paint" ? paintColor : undefined,
    };
    history.pushState([...currentElements, element]);
  };

  /* --- Herramienta pincel (trazo a mano alzada) --- */

  const startBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = getDragOrigin();
    if (!origin) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOriginRef.current = origin;
    const point = pointFromClient(event.clientX, event.clientY, origin);
    setDraftStroke([point]);
  };

  const moveBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    event.preventDefault();
    const points = pointsFromEvent(event, origin);
    setDraftStroke((prev) => (prev ? [...prev, ...points] : points));
  };

  const endBrush = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    let points = draftStroke;
    if (origin && points) {
      points = [...points, ...pointsFromEvent(event, origin)];
    }
    setDraftStroke(null);
    if (!points || points.length < MIN_STROKE_POINTS) return;

    const element: RedactStrokeElement = {
      id: nextElementId(),
      kind: "stroke",
      pageIndex,
      points,
      strokeWidth: brushWidth,
      mode,
      color: mode === "paint" ? paintColor : undefined,
    };
    history.pushState([...currentElements, element]);
  };

  /* --- Herramienta borrador --- */

  const collectEraseHits = (point: RedactPoint) => {
    let changed = false;
    for (const element of pageElements) {
      if (eraseHitsRef.current.has(element.id)) continue;
      if (elementHitTest(element, point, ERASER_RADIUS)) {
        eraseHitsRef.current.add(element.id);
        changed = true;
      }
    }
    if (changed) setErasingIds(new Set(eraseHitsRef.current));
  };

  const startErase = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = getDragOrigin();
    if (!origin) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOriginRef.current = origin;
    eraseHitsRef.current = new Set();
    collectEraseHits(pointFromClient(event.clientX, event.clientY, origin));
  };

  const moveErase = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    event.preventDefault();
    for (const point of pointsFromEvent(event, origin)) {
      collectEraseHits(point);
    }
  };

  const endErase = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragOriginRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const hits = eraseHitsRef.current;
    eraseHitsRef.current = new Set();
    setErasingIds(new Set());
    if (hits.size === 0) return;
    history.pushState(currentElements.filter((element) => !hits.has(element.id)));
  };

  /* --- Enrutado por herramienta activa --- */

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "rect") startDraw(event);
    else if (tool === "brush") startBrush(event);
    else startErase(event);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "rect") moveDraw(event);
    else if (tool === "brush") moveBrush(event);
    else moveErase(event);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "rect") endDraw(event);
    else if (tool === "brush") endBrush(event);
    else endErase(event);
  };

  const removeElement = (id: string) => {
    history.pushState(currentElements.filter((element) => element.id !== id));
  };

  if (!file) return null;

  const draftRectNormalized = draftRect ? normalizeRect(draftRect) : null;
  const total = Math.max(1, pageCount);
  const drawHint =
    tool === "rect"
      ? strings.drawHintRect
      : tool === "brush"
        ? strings.drawHintBrush
        : strings.drawHintEraser;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">
          {strings.canvasTitle}
        </h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={strings.previousPage}
            disabled={pageIndex === 0}
            onClick={() => onPageIndexChange(Math.max(0, pageIndex - 1))}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
          <span className="text-footnote font-medium text-foreground tabular-nums">
            {strings.pageOf(pageIndex + 1, total)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={strings.nextPage}
            disabled={pageCount === 0 || pageIndex >= pageCount - 1}
            onClick={() =>
              onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1))
            }
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <SegmentedControl<RedactTool>
          label={strings.toolLabel}
          value={tool}
          onChange={setTool}
          size="sm"
          className="max-w-[280px]"
          options={[
            { value: "rect", label: strings.toolRect },
            { value: "brush", label: strings.toolBrush },
            { value: "eraser", label: strings.toolEraser },
          ]}
        />

        {tool !== "eraser" ? (
          <SegmentedControl<RedactMode>
            label={strings.effectLabel}
            value={mode}
            onChange={setMode}
            size="sm"
            className="max-w-[420px]"
            options={[
              { value: "black", label: strings.effectBlack },
              { value: "blur", label: strings.effectBlur },
              { value: "pixelate", label: strings.effectPixelate },
              { value: "paint", label: strings.effectPaint },
            ]}
          />
        ) : null}

        {tool !== "eraser" && mode === "paint" ? (
          <label className="flex flex-col gap-2">
            <span className="ui-label text-muted-foreground">
              {strings.paintColorLabel}
            </span>
            <input
              type="color"
              aria-label={strings.paintColorLabel}
              value={paintColor}
              onChange={(event) => setPaintColor(event.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-white/10 bg-transparent p-0.5 pointer-coarse:h-11"
            />
          </label>
        ) : null}

        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={strings.undo}
            disabled={!history.canUndo}
            onClick={history.undo}
          >
            <Undo2 aria-hidden="true" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={strings.redo}
            disabled={!history.canRedo}
            onClick={history.redo}
          >
            <Redo2 aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {tool === "brush" ? (
        <div className="mb-3 max-w-[280px]">
          <Slider
            label={strings.brushSizeLabel}
            value={Math.round(brushWidth * 1000)}
            min={Math.round(MIN_STROKE_WIDTH * 1000)}
            max={Math.round(MAX_STROKE_WIDTH * 1000)}
            step={1}
            onChange={(value) => setBrushWidth(value / 1000)}
          />
        </div>
      ) : null}

      <div className="surface-card rounded-ios flex justify-center p-3">
        <div
          ref={hostRef}
          data-testid="redact-canvas-host"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={cn(
            "relative w-full max-w-[640px] touch-none select-none [-webkit-touch-callout:none]",
            tool === "eraser" ? "cursor-cell" : "cursor-crosshair",
          )}
        >
          {preview ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={preview}
              alt={strings.canvasTitle}
              draggable={false}
              className="block w-full rounded-[10px]"
            />
          ) : (
            <div className="flex aspect-[3/4] w-full items-center justify-center rounded-[10px] bg-white/5">
              {loading ? (
                <Spinner className="size-5" label={strings.loadingPreview} />
              ) : null}
            </div>
          )}

          {preview ? (
            <svg
              aria-hidden="true"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 size-full"
            >
              {pageElements.filter(isStroke).map((stroke) => (
                <polyline
                  key={stroke.id}
                  points={stroke.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={indicatorColor(stroke.mode, stroke.color)}
                  strokeWidth={stroke.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={erasingIds.has(stroke.id) ? 0.3 : 0.8}
                />
              ))}
              {draftStroke && draftStroke.length > 1 ? (
                <polyline
                  points={draftStroke.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={indicatorColor(mode, paintColor)}
                  strokeWidth={brushWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.8}
                />
              ) : null}
            </svg>
          ) : null}

          {preview
            ? pageElements.filter(isRect).map((rect) => (
                <div
                  key={rect.id}
                  className={cn(
                    "absolute border",
                    erasingIds.has(rect.id)
                      ? "border-destructive/60 bg-destructive/15"
                      : "border-white/25 bg-background/80",
                  )}
                  style={{
                    left: percent(rect.x),
                    top: percent(rect.y),
                    width: percent(rect.width),
                    height: percent(rect.height),
                    ...(rect.mode === "paint"
                      ? { backgroundColor: `${rect.color ?? DEFAULT_PAINT_COLOR}55` }
                      : {}),
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-1 left-1 flex size-4 items-center justify-center rounded-full bg-background/85 text-foreground"
                  >
                    <ModeIcon mode={rect.mode} />
                  </span>
                  <button
                    type="button"
                    aria-label={strings.removeBox}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => removeElement(rect.id)}
                    className={cn(
                      "absolute -top-2.5 -right-2.5 flex size-6 items-center justify-center rounded-full",
                      "border border-white/20 bg-elevated text-muted-foreground",
                      "transition-colors hover:text-destructive",
                      // Con el dedo la zona de toque es de 44 px sin cambiar el dibujo (pseudo-elemento transparente centrado).
                      HIT_44_PSEUDO,
                    )}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              ))
            : null}

          {preview
            ? pageElements.filter(isStroke).map((stroke) => {
                const bounds = strokeBounds(stroke);
                return (
                  <button
                    key={`${stroke.id}-remove`}
                    type="button"
                    aria-label={strings.removeBox}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => removeElement(stroke.id)}
                    className={cn(
                      "absolute flex size-6 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full",
                      "border border-white/20 bg-elevated text-muted-foreground",
                      "transition-colors hover:text-destructive",
                      HIT_44_PSEUDO,
                    )}
                    style={{
                      left: percent(bounds.x + bounds.width),
                      top: percent(bounds.y),
                    }}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                );
              })
            : null}

          {draftRectNormalized ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute border-2 border-signal bg-background/70"
              style={{
                left: percent(draftRectNormalized.x),
                top: percent(draftRectNormalized.y),
                width: percent(draftRectNormalized.width),
                height: percent(draftRectNormalized.height),
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground tabular-nums">
          {strings.boxesOnPage(pageElements.length)} ·{" "}
          {strings.totalBoxes(currentElements.length)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            // Puntero grueso: 44 px REALES de alto (con raton se queda en 36 px).
            className="pointer-coarse:h-11"
            disabled={pageElements.length === 0}
            onClick={() =>
              history.pushState(
                currentElements.filter((element) => element.pageIndex !== pageIndex),
              )
            }
          >
            {strings.clearPage}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={currentElements.length === 0}
            onClick={() => history.pushState([])}
          >
            {strings.clearAll}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{drawHint}</p>

      {thumbs.length > 1 ? (
        <div className="mt-6">
          <h4 className="ui-label mb-2 text-muted-foreground">
            {strings.thumbsTitle}
          </h4>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {thumbs.map((thumb, index) => {
              const count = currentElements.filter(
                (element) => element.pageIndex === index,
              ).length;
              const active = index === pageIndex;
              return (
                <li key={index} className="shrink-0">
                  <button
                    type="button"
                    aria-label={strings.goToPage(index + 1)}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onPageIndexChange(index)}
                    className={cn(
                      "relative block overflow-hidden rounded-ios-sm border p-0.5 transition-colors",
                      active
                        ? "border-signal"
                        : "border-white/10 hover:border-white/25",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumb}
                      alt=""
                      draggable={false}
                      className="block w-16 rounded-[8px]"
                    />
                    <span className="absolute right-1 bottom-1 rounded-full bg-background/85 px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground tabular-nums">
                      {count > 0 ? `${index + 1} · ${count}` : index + 1}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
