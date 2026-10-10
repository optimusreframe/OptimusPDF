"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, ChevronRight, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { HIT_44_PSEUDO } from "@/components/ui/touchTarget";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { DEFAULT_CROP_RECT } from "@/lib/pdf/crop";
import type { CropStrings } from "@/app/crop-pdf/strings";

export type CropCanvasProps = {
  file: File | null;
  rect: NormalizedRect;
  onRectChange: (rect: NormalizedRect) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  /** Total de páginas del documento; lo publica este componente. */
  pageCount: number;
  onPageCount: (count: number) => void;
  onError?: (code: PdfErrorCode) => void;
  strings: CropStrings;
};

type DragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type DragState = {
  mode: DragMode;
  startX: number;
  startY: number;
  startRect: NormalizedRect;
  width: number;
  height: number;
};

/** Lado mínimo de la selección, en fracción de página. */
const MIN_SIDE = 0.05;
const PREVIEW_WIDTH = 900;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function applyDrag(
  mode: DragMode,
  rect: NormalizedRect,
  dx: number,
  dy: number,
): NormalizedRect {
  if (mode === "move") {
    return {
      x: clamp(rect.x + dx, 0, 1 - rect.width),
      y: clamp(rect.y + dy, 0, 1 - rect.height),
      width: rect.width,
      height: rect.height,
    };
  }

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (mode.includes("w")) left = clamp(left + dx, 0, right - MIN_SIDE);
  if (mode.includes("e")) right = clamp(right + dx, left + MIN_SIDE, 1);
  if (mode.includes("n")) top = clamp(top + dy, 0, bottom - MIN_SIDE);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + MIN_SIDE, 1);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

const EDGES: Array<{ mode: DragMode; className: string }> = [
  { mode: "n", className: "-top-2.5 left-1/2 -translate-x-1/2 cursor-ns-resize" },
  {
    mode: "s",
    className: "-bottom-2.5 left-1/2 -translate-x-1/2 cursor-ns-resize",
  },
  { mode: "w", className: "top-1/2 -left-2.5 -translate-y-1/2 cursor-ew-resize" },
  {
    mode: "e",
    className: "top-1/2 -right-2.5 -translate-y-1/2 cursor-ew-resize",
  },
];

const CORNERS: Array<{ mode: DragMode; className: string }> = [
  { mode: "nw", className: "-top-2.5 -left-2.5 cursor-nwse-resize" },
  { mode: "ne", className: "-top-2.5 -right-2.5 cursor-nesw-resize" },
  { mode: "sw", className: "-bottom-2.5 -left-2.5 cursor-nesw-resize" },
  { mode: "se", className: "-bottom-2.5 -right-2.5 cursor-nwse-resize" },
];

/**
 * Remonta la vista previa cuando cambia el archivo o la página (patrón
 * "reset state with a key"), en vez de limpiar estado desde un efecto.
 */
export function CropCanvas(props: CropCanvasProps) {
  const { file, pageIndex } = props;
  if (!file) return null;
  return (
    <CropCanvasInner
      key={`${file.name}:${file.size}:${file.lastModified}:${pageIndex}`}
      {...props}
      file={file}
    />
  );
}

function CropCanvasInner({
  file,
  rect,
  onRectChange,
  pageIndex,
  onPageIndexChange,
  pageCount,
  onPageCount,
  onError,
  strings,
}: CropCanvasProps & { file: File }) {
  const [preview, setPreview] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const callbacksRef = useRef({ onError, onPageCount });

  useEffect(() => {
    callbacksRef.current = { onError, onPageCount };
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        callbacksRef.current.onPageCount(document.numPages);
        const number = Math.min(Math.max(1, pageIndex + 1), document.numPages);
        const page = await document.getPage(number);
        const url = await renderPageToDataUrl(page, {
          maxWidth: PREVIEW_WIDTH,
        });
        page.cleanup();
        void closePdfDocument(document);
        if (!cancelled) setPreview(url);
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError?.(toPdfError(error).code);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, pageIndex]);

  /**
   * Un único manejador para los nueve tiradores: el modo viaja en un
   * `data-*`, así no se crea una función nueva por tirador en cada render.
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const host = hostRef.current;
    const mode = event.currentTarget.dataset.dragMode as DragMode | undefined;
    if (!host || !mode) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = host.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
      width: bounds.width || 1,
      height: bounds.height || 1,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    onRectChange(
      applyDrag(
        drag.mode,
        drag.startRect,
        (event.clientX - drag.startX) / drag.width,
        (event.clientY - drag.startY) / drag.height,
      ),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };

  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">
          {strings.selectionTitle}
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
            {strings.pageOf(pageIndex + 1, Math.max(1, pageCount))}
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
          className="relative w-full max-w-[640px] touch-none select-none"
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={strings.selectionTitle}
              draggable={false}
              className="block w-full rounded-[10px]"
            />
          ) : (
            <div className="flex aspect-[3/4] w-full items-center justify-center rounded-[10px] bg-white/5">
              <Spinner className="size-5" label={strings.loadingPreview} />
            </div>
          )}

          {preview ? (
            /* Velo: oscurece lo que se descarta sin tapar los tiradores. */
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-[10px]"
            >
              <div
                className="absolute shadow-[0_0_0_9999px_color-mix(in_oklab,var(--color-background)_68%,transparent)]"
                style={{
                  left: percent(rect.x),
                  top: percent(rect.y),
                  width: percent(rect.width),
                  height: percent(rect.height),
                }}
              />
            </div>
          ) : null}

          {preview ? (
            <div
              role="group"
              aria-label={strings.selectionTitle}
              data-drag-mode="move"
              {...handlers}
              className="absolute cursor-move rounded-[6px] border-2 border-signal"
              style={{
                left: percent(rect.x),
                top: percent(rect.y),
                width: percent(rect.width),
                height: percent(rect.height),
              }}
            >
              {EDGES.map((edge) => (
                <span
                  key={edge.mode}
                  data-drag-mode={edge.mode}
                  {...handlers}
                  className={cn(
                    "absolute size-5 rounded-full border border-white/30 bg-signal/70",
                    // Con el dedo la zona de toque es de 44 px sin cambiar el aspecto (no se pinta).
                    HIT_44_PSEUDO,
                    edge.className,
                  )}
                />
              ))}
              {CORNERS.map((corner) => (
                <span
                  key={corner.mode}
                  data-drag-mode={corner.mode}
                  {...handlers}
                  className={cn(
                    "absolute size-5 rounded-full border-2 border-foreground bg-signal",
                    HIT_44_PSEUDO,
                    corner.className,
                  )}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground tabular-nums">
          {strings.sizeLabel} {Math.round(rect.width * 100)} ×{" "}
          {Math.round(rect.height * 100)} %
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onRectChange(DEFAULT_CROP_RECT)}
        >
          <RefreshCcw aria-hidden="true" className="size-3.5" />
          {strings.reset}
        </Button>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {strings.selectionHint}
      </p>
    </div>
  );
}
