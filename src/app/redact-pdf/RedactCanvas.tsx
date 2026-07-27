"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import { MIN_BOX_SIDE, type RedactBox } from "@/lib/pdf/redact";
import type { RedactStrings } from "@/app/redact-pdf/strings";

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Identificadores estables sin depender de `crypto.randomUUID`. */
let boxCounter = 0;
function nextBoxId(): string {
  boxCounter += 1;
  return `box-${boxCounter}`;
}

type Draft = { x: number; y: number; width: number; height: number };

type PointerOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
};

export type RedactCanvasProps = {
  file: File | null;
  boxes: RedactBox[];
  onBoxesChange: (boxes: RedactBox[]) => void;
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

function normalize(draft: Draft): Draft {
  const x = Math.min(draft.x, draft.x + draft.width);
  const y = Math.min(draft.y, draft.y + draft.height);
  return {
    x,
    y,
    width: Math.min(1 - x, Math.abs(draft.width)),
    height: Math.min(1 - y, Math.abs(draft.height)),
  };
}

/**
 * Vista previa donde se dibujan las zonas a censurar. Cada rectangulo se
 * guarda normalizado 0..1 sobre la pagina renderizada, de modo que el
 * motor puede aplicarlo a cualquier resolucion de rasterizado.
 */
export function RedactCanvas(props: RedactCanvasProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <RedactCanvasInner key={key} {...props} />;
}

function RedactCanvasInner({
  file,
  boxes,
  onBoxesChange,
  pageIndex,
  onPageIndexChange,
  strings,
  onError,
}: RedactCanvasProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<PointerOrigin | null>(null);
  const errorRef = useRef(onError);

  useEffect(() => {
    errorRef.current = onError;
  });

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

  const pageBoxes = boxes.filter((box) => box.pageIndex === pageIndex);

  const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host || !preview) return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = clamp01((event.clientX - bounds.left) / bounds.width);
    const y = clamp01((event.clientY - bounds.top) / bounds.height);
    originRef.current = {
      x,
      y,
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
    };
    setDraft({ x, y, width: 0, height: 0 });
  };

  const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = originRef.current;
    if (!origin) return;
    event.preventDefault();
    const x = clamp01((event.clientX - origin.left) / origin.width);
    const y = clamp01((event.clientY - origin.top) / origin.height);
    setDraft({
      x: origin.x,
      y: origin.y,
      width: x - origin.x,
      height: y - origin.y,
    });
  };

  const endDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = originRef.current;
    originRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const current = draft;
    setDraft(null);
    if (!origin || !current) return;

    const rect = normalize(current);
    if (rect.width < MIN_BOX_SIDE || rect.height < MIN_BOX_SIDE) return;

    onBoxesChange([...boxes, { id: nextBoxId(), pageIndex, ...rect }]);
  };

  if (!file) return null;

  const draftRect = draft ? normalize(draft) : null;
  const total = Math.max(1, pageCount);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="hud-label text-[11px] text-muted-foreground">
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
          <span className="hud-label text-[10px] text-foreground tabular-nums">
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

      <div className="glass rounded-ios flex justify-center p-3">
        <div
          ref={hostRef}
          onPointerDown={startDraw}
          onPointerMove={moveDraw}
          onPointerUp={endDraw}
          onPointerCancel={endDraw}
          className="relative w-full max-w-[640px] cursor-crosshair touch-none select-none"
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

          {preview
            ? pageBoxes.map((box) => (
                <div
                  key={box.id}
                  className="absolute border border-white/25 bg-background"
                  style={{
                    left: percent(box.x),
                    top: percent(box.y),
                    width: percent(box.width),
                    height: percent(box.height),
                  }}
                >
                  <button
                    type="button"
                    aria-label={strings.removeBox}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() =>
                      onBoxesChange(
                        boxes.filter((candidate) => candidate.id !== box.id),
                      )
                    }
                    className={cn(
                      "absolute -top-2.5 -right-2.5 flex size-6 items-center justify-center rounded-full",
                      "border border-white/20 bg-elevated text-muted-foreground",
                      "transition-colors hover:text-destructive",
                    )}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              ))
            : null}

          {draftRect ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute border-2 border-signal bg-background/70"
              style={{
                left: percent(draftRect.x),
                top: percent(draftRect.y),
                width: percent(draftRect.width),
                height: percent(draftRect.height),
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="hud-label text-[10px] text-muted-foreground tabular-nums">
          {strings.boxesOnPage(pageBoxes.length)} · {strings.totalBoxes(boxes.length)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pageBoxes.length === 0}
            onClick={() =>
              onBoxesChange(boxes.filter((box) => box.pageIndex !== pageIndex))
            }
          >
            {strings.clearPage}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={boxes.length === 0}
            onClick={() => onBoxesChange([])}
          >
            {strings.clearAll}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {strings.drawHint}
      </p>

      {thumbs.length > 1 ? (
        <div className="mt-6">
          <h4 className="hud-label mb-2 text-[10px] text-muted-foreground">
            {strings.thumbsTitle}
          </h4>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {thumbs.map((thumb, index) => {
              const count = boxes.filter(
                (box) => box.pageIndex === index,
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
                    <span className="hud-label absolute right-1 bottom-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] text-foreground tabular-nums">
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
