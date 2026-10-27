"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Ellipsis, GripVertical, Loader, RotateCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ScanPage } from "@/lib/scan/types";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import { qualityKinds, type QualityChipKind } from "@/app/scan-to-pdf/scanState";
import { createGridDrag, type DragLatest, type DragState, type GridDrag } from "@/app/scan-to-pdf/gridDrag";
import { computeLayout, insertionMarker, tilePosition, totalHeight, visibleRange, ACTIONS_H, type GridLayout } from "@/app/scan-to-pdf/gridLayout";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

/** Desde este numero de paginas solo se pintan las filas a la vista (menos, todo: es mas simple y no hay nada que ahorrar). */
export const VIRTUALIZE_FROM = 30;

export type PageGridProps = {
  s: ScanToPdfStrings;
  pages: readonly ScanPage[];
  pendingIds: readonly string[];
  selection: ReadonlySet<string>;
  selecting: boolean;
  /** Modo «Mover aquí»: ids que se estan moviendo (`null` = no). */
  movingIds: readonly string[] | null;
  onOpen: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onRotate: (id: string) => void;
  onRemove: (id: string) => void;
  onMore: (id: string) => void;
  onChip: (id: string, kind: QualityChipKind) => void;
  onDrop: (ids: string[], insertBefore: number) => void;
  onShift: (id: string, delta: number) => void;
  onMoveHere: (insertBefore: number) => void;
  announce: (text: string) => void;
  /** Alto (px) de las barras fijas arriba y abajo, para que el auto-desplazamiento empiece antes de tocarlas. */
  insets?: () => { top: number; bottom: number };
};


function flagLabels(page: ScanPage, s: ScanToPdfStrings): string[] {
  return qualityKinds(page.flags).map((kind) => s.quality[kind].label.toLowerCase());
}

type TileProps = {
  s: ScanToPdfStrings;
  page: ScanPage;
  index: number;
  total: number;
  layout: GridLayout;
  x: number;
  y: number;
  pending: boolean;
  selected: boolean;
  selecting: boolean;
  moving: boolean;
  dragging: boolean;
  movePick: boolean;
  cb: Callbacks;
};

type Callbacks = {
  open: (id: string) => void;
  toggle: (id: string) => void;
  rotate: (id: string) => void;
  remove: (id: string) => void;
  more: (id: string) => void;
  chip: (id: string, kind: QualityChipKind) => void;
  handleDown: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  bodyDown: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  handleKey: (event: ReactKeyboardEvent<HTMLElement>, id: string) => void;
  moveHere: (index: number) => void;
};

const PageTile = memo(function PageTile({ s, page, index, total, layout, x, y, pending, selected, selecting, moving, dragging, movePick, cb }: TileProps) {
  const thumbUrl = useBlobUrl(page.thumb ?? page.original);
  const kinds = qualityKinds(page.flags);
  const number = index + 1;
  const processing = pending || !page.thumb;
  const label = s.tileLabel(number, total, flagLabels(page, s));
  // Con la miniatura del original aun sin recalcular, el giro se insinua con CSS para no dejarla de lado.
  const previewRotation = page.thumb ? 0 : page.rotation;

  return (
    <div
      role="listitem"
      data-page-id={page.id}
      data-page-index={index}
      data-pending={pending || undefined}
      aria-posinset={number}
      aria-setsize={total}
      className={cn("absolute", dragging && "opacity-40")}
      style={{ left: x, top: y, width: layout.tileW, height: layout.tileH }}
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-ios border bg-surface",
          selected ? "border-signal ring-2 ring-signal" : "border-hairline",
        )}
        style={{ height: layout.thumbH }}
      >
        <button
          type="button"
          data-page-main=""
          aria-label={label}
          aria-pressed={selecting ? selected : undefined}
          onClick={() => (selecting ? cb.toggle(page.id) : cb.open(page.id))}
          onPointerDown={(event) => cb.bodyDown(event, page.id)}
          className="absolute inset-0 flex items-center justify-center bg-black/5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
          style={{ touchAction: "pan-y" }}
        >
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbUrl}
              alt=""
              draggable={false}
              decoding="async"
              className="max-h-full max-w-full object-contain select-none"
              style={previewRotation ? { transform: `rotate(${previewRotation}deg)` } : undefined}
            />
          ) : null}
        </button>

        <span aria-hidden="true" className="pointer-events-none absolute top-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-caption font-semibold text-white tabular-nums">
          {number}
        </span>

        {selecting ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-2 right-2 flex size-6 items-center justify-center rounded-full border-2",
              selected ? "border-signal bg-signal text-[var(--color-on-signal)]" : "border-white bg-black/40",
            )}
          >
            {selected ? <Check className="size-4" strokeWidth={3} /> : null}
          </span>
        ) : (
          <button
            type="button"
            data-drag-handle=""
            aria-label={s.dragHandle(number)}
            title={s.dragHandleHint}
            onPointerDown={(event) => cb.handleDown(event, page.id)}
            onKeyDown={(event) => cb.handleKey(event, page.id)}
            className="absolute top-0 right-0 flex size-11 items-center justify-center text-white outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
            style={{ touchAction: "none" }}
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-black/65">
              <GripVertical aria-hidden="true" className="size-4" />
            </span>
          </button>
        )}

        {processing ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/45" data-tile-processing="">
            <Loader aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">{s.processing}</span>
          </span>
        ) : null}

        {!movePick && kinds.length > 0 && !pending ? (
          <div className="absolute inset-x-1.5 bottom-1.5 flex flex-col items-start gap-1">
            {kinds.slice(0, 2).map((kind) => {
              const q = s.quality[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  data-quality-chip={kind}
                  title={q.tip}
                  aria-label={s.chipAction(number, q.label, q.action)}
                  onClick={() => cb.chip(page.id, kind)}
                  className="on-media inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-white/30 bg-black/75 px-2.5 py-1 text-left text-caption leading-tight font-semibold text-white outline-none pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
                >
                  <span className="min-w-0">{q.label}</span>
                  <span aria-hidden="true" className="shrink-0 text-warning-text underline">
                    {q.action}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {movePick ? (
          <button
            type="button"
            data-move-here=""
            onClick={() => cb.moveHere(index)}
            className="absolute inset-x-1.5 bottom-1.5 flex h-11 items-center justify-center rounded-full bg-signal px-3 text-footnote font-semibold text-[var(--color-on-signal)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            {s.moveHere}
          </button>
        ) : null}
      </div>

      <div className="flex items-center justify-between" style={{ height: ACTIONS_H, paddingTop: 4 }}>
        <TileButton label={s.rotate(number)} action="rotate" disabled={moving} onClick={() => cb.rotate(page.id)}>
          <RotateCw aria-hidden="true" className="size-5" />
        </TileButton>
        <TileButton label={s.remove(number)} action="remove" disabled={moving} onClick={() => cb.remove(page.id)}>
          <Trash2 aria-hidden="true" className="size-5" />
        </TileButton>
        <TileButton label={s.more(number)} action="more" disabled={moving} onClick={() => cb.more(page.id)}>
          <Ellipsis aria-hidden="true" className="size-5" />
        </TileButton>
      </div>
    </div>
  );
});

function TileButton({ label, action, disabled, onClick, children }: { label: string; action: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-tile-action={action}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-white/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function Ghost({ page, pointer, count }: { page: ScanPage; pointer: { x: number; y: number }; count: number }) {
  const url = useBlobUrl(page.thumb ?? page.original);
  return (
    <div aria-hidden="true" data-drag-ghost="" className="pointer-events-none fixed z-[60] w-20 rounded-lg border-2 border-signal bg-surface shadow-elevation-3" style={{ left: pointer.x - 40, top: pointer.y - 56 }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="aspect-[3/4] w-full rounded-md object-contain" />
      ) : null}
      {count > 1 ? <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-signal text-caption font-bold text-[var(--color-on-signal)]">{count}</span> : null}
    </div>
  );
}

/**
 * Cuadricula de miniaturas del escaner. Se desplaza con la propia pagina (un dedo, sin zona de desplazamiento anidada) y, con
 * muchas paginas, solo pinta las filas a la vista. Reordenar:
 *   - raton / lapiz: arrastrando desde cualquier punto de la tarjeta;
 *   - dedo: desde el ASA (`touch-action: none` solo ahi) o con una pulsacion larga sobre la miniatura;
 *   - teclado: flechas sobre el asa (Inicio / Fin al principio / al final);
 *   - «Mover aquí»: elegir la pagina, «Mover a otro sitio» y tocar el destino.
 * El auto-desplazamiento cerca de los bordes es por TIEMPO (`createEdgeAutoScroller`): igual a 60 que a 120 Hz.
 */
export function PageGrid({ s, pages, pendingIds, selection, selecting, movingIds, onOpen, onToggleSelect, onRotate, onRemove, onMore, onChip, onDrop, onShift, onMoveHere, announce, insets }: PageGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scroll, setScroll] = useState({ top: 0, height: 800 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const layout = useMemo(() => computeLayout(width || 320), [width]);
  const count = pages.length;
  const virtual = count >= VIRTUALIZE_FROM;

  /* ---------------- medidas y ventana visible ---------------- */
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (!virtual) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const element = containerRef.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      setScroll((previous) => {
        const next = { top: Math.max(0, -box.top), height: window.innerHeight };
        return Math.abs(previous.top - next.top) < 40 && previous.height === next.height ? previous : next;
      });
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtual, count, layout.cols]);

  const range = useMemo(
    () => (virtual ? visibleRange(layout, count, scroll.top, scroll.height, 2) : count > 0 ? { first: 0, last: count - 1 } : null),
    [virtual, layout, count, scroll.top, scroll.height],
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onFocusIn = (event: FocusEvent) => {
      const id = (event.target as HTMLElement | null)?.closest("[data-page-id]")?.getAttribute("data-page-id") ?? null;
      setFocusedId(id);
    };
    element.addEventListener("focusin", onFocusIn);
    return () => element.removeEventListener("focusin", onFocusIn);
  }, []);

  const indices = useMemo(() => {
    if (!range) return [];
    const out: number[] = [];
    for (let index = range.first; index <= range.last; index += 1) out.push(index);
    // La tarjeta con el foco o la que se arrastra nunca se desmonta aunque salga de la ventana.
    const keep = new Set<string>([...(focusedId ? [focusedId] : []), ...(drag ? drag.ids : [])]);
    if (keep.size > 0) {
      pages.forEach((page, index) => {
        if (keep.has(page.id) && !out.includes(index)) out.push(index);
      });
    }
    return out;
  }, [range, focusedId, drag, pages]);

  /* ---------------- arrastre ---------------- */
  const suppressClickRef = useRef(false);
  const dragRef = useRef<GridDrag | null>(null);
  const pageIds = useMemo(() => pages.map((page) => page.id), [pages]);
  const latest = useRef<DragLatest>({ layout, pageIds, selection, onDrop, announce, dragStart: s.dragStart, dragCancel: s.dragCancel, insets });
  useEffect(() => {
    latest.current = { layout, pageIds, selection, onDrop, announce, dragStart: s.dragStart, dragCancel: s.dragCancel, insets };
  });
  useEffect(() => {
    const controller = createGridDrag({ latest, container: containerRef, setDrag, suppressClick: suppressClickRef });
    dragRef.current = controller;
    return () => {
      controller.dispose();
      dragRef.current = null;
    };
  }, []);

  const cb = useMemo<Callbacks>(
    () => ({
      open: (id) => {
        if (!suppressClickRef.current) onOpen(id);
      },
      toggle: (id) => {
        if (!suppressClickRef.current) onToggleSelect(id);
      },
      rotate: onRotate,
      remove: onRemove,
      more: onMore,
      chip: onChip,
      moveHere: onMoveHere,
      handleDown: (event, id) => {
        if (event.button !== 0 || !event.isPrimary) return;
        // El asa empieza a arrastrar en cuanto se mueve (con el dedo, `touch-action: none` ahi); con raton, tras 5 px.
        dragRef.current?.start(event, id, false);
      },
      bodyDown: (event, id) => {
        if (event.button !== 0 || !event.isPrimary || selecting || movingIds) return;
        if (event.pointerType === "touch") dragRef.current?.longPress(event, id, () => event.currentTarget.setAttribute("data-long-pressed", ""));
        else dragRef.current?.start(event, id, false);
      },
      handleKey: (event, id) => {
        const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "Home" ? -Infinity : event.key === "End" ? Infinity : 0;
        if (delta === 0) return;
        event.preventDefault();
        onShift(id, delta);
      },
    }),
    [onOpen, onToggleSelect, onRotate, onRemove, onMore, onChip, onMoveHere, onShift, selecting, movingIds],
  );

  const moveSet = useMemo(() => new Set(movingIds ?? []), [movingIds]);
  const dragSet = useMemo(() => new Set(drag?.ids ?? []), [drag]);
  const marker = drag ? insertionMarker(layout, count, drag.insertBefore) : null;
  const ghostPage = drag ? pages.find((page) => page.id === drag.ids[0]) : null;
  const pendingSet = useMemo(() => new Set(pendingIds), [pendingIds]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        role="list"
        aria-label={s.gridLabel}
        data-page-grid=""
        data-virtual={virtual || undefined}
        className="relative w-full"
        style={{ height: totalHeight(layout, count) }}
      >
        {indices.map((index) => {
          const page = pages[index];
          if (!page) return null;
          const position = tilePosition(layout, index);
          return (
            <PageTile
              key={page.id}
              s={s}
              page={page}
              index={index}
              total={count}
              layout={layout}
              x={position.x}
              y={position.y}
              pending={pendingSet.has(page.id)}
              selected={selection.has(page.id)}
              selecting={selecting}
              moving={moveSet.has(page.id)}
              dragging={dragSet.has(page.id)}
              movePick={movingIds !== null && !moveSet.has(page.id)}
              cb={cb}
            />
          );
        })}
        {marker ? <span aria-hidden="true" data-drop-marker="" className="pointer-events-none absolute w-1 rounded-full bg-signal" style={{ left: marker.x - 2, top: marker.y, height: marker.height }} /> : null}
      </div>
      {drag && ghostPage ? <Ghost page={ghostPage} pointer={drag.pointer} count={drag.ids.length} /> : null}
    </div>
  );
}
