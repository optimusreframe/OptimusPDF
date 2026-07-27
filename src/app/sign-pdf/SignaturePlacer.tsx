"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, ChevronRight, Move } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type SignaturePlacerProps = {
  file: File | null;
  /** PNG en data URL, o null si aún no hay firma. */
  signature: string | null;
  /** alto / ancho del PNG de la firma. */
  ratio: number;
  /** `width: 0` significa "aún sin colocar". */
  rect: NormalizedRect;
  onRectChange: (rect: NormalizedRect) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  pageCount: number;
  onPageCount: (count: number) => void;
  onError?: (code: PdfErrorCode) => void;
  strings: SignStrings;
};

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  startX: number;
  startY: number;
  startRect: NormalizedRect;
  hostWidth: number;
  hostHeight: number;
};

const PREVIEW_WIDTH = 900;
const MIN_WIDTH_FRACTION = 0.06;
const DEFAULT_WIDTH_FRACTION = 0.32;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Remonta la vista previa cuando cambia el archivo o la página, como
 * hace `PageThumbnailGrid`, para no limpiar estado desde un efecto.
 */
export function SignaturePlacer(props: SignaturePlacerProps) {
  const { file, pageIndex } = props;
  if (!file) return null;
  return (
    <SignaturePlacerInner
      key={`${file.name}:${file.size}:${file.lastModified}:${pageIndex}`}
      {...props}
      file={file}
    />
  );
}

function SignaturePlacerInner({
  file,
  signature,
  ratio,
  rect,
  onRectChange,
  pageIndex,
  onPageIndexChange,
  pageCount,
  onPageCount,
  onError,
  strings,
}: SignaturePlacerProps & { file: File }) {
  const [preview, setPreview] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const callbacksRef = useRef({ onError, onPageCount, onRectChange });

  useEffect(() => {
    callbacksRef.current = { onError, onPageCount, onRectChange };
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
   * Colocación por defecto: centrada y en el tercio inferior, que es
   * donde se firma casi siempre. Se calcula cuando ya se conoce el
   * tamaño real de la vista previa en pantalla.
   */
  const placeByDefault = () => {
    const host = hostRef.current;
    if (!host || !signature || rect.width > 0 || ratio <= 0) return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const width = DEFAULT_WIDTH_FRACTION;
    const height = Math.min(
      0.9,
      (width * bounds.width * ratio) / bounds.height,
    );
    callbacksRef.current.onRectChange({
      x: 0.5 - width / 2,
      y: clamp(0.74 - height / 2, 0, 1 - height),
      width,
      height,
    });
  };

  useEffect(() => {
    placeByDefault();
    // Se recalcula al cambiar la firma o cuando ya hay vista previa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ratio, preview]);

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
      hostWidth: bounds.width || 1,
      hostHeight: bounds.height || 1,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    const dx = (event.clientX - drag.startX) / drag.hostWidth;
    const dy = (event.clientY - drag.startY) / drag.hostHeight;
    const start = drag.startRect;

    if (drag.mode === "move") {
      onRectChange({
        x: clamp(start.x + dx, 0, Math.max(0, 1 - start.width)),
        y: clamp(start.y + dy, 0, Math.max(0, 1 - start.height)),
        width: start.width,
        height: start.height,
      });
      return;
    }

    const width = clamp(start.width + dx, MIN_WIDTH_FRACTION, 1 - start.x);
    const height = (width * drag.hostWidth * ratio) / drag.hostHeight;
    if (start.y + height > 1) return;
    onRectChange({ x: start.x, y: start.y, width, height });
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
        <h3 className="hud-label text-[11px] text-muted-foreground">
          {strings.placeTitle}
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
              alt={strings.placeTitle}
              draggable={false}
              onLoad={placeByDefault}
              className="block w-full rounded-[10px]"
            />
          ) : (
            <div className="flex aspect-[3/4] w-full items-center justify-center rounded-[10px] bg-white/5">
              <Spinner className="size-5" label={strings.loadingPreview} />
            </div>
          )}

          {preview && signature && rect.width > 0 ? (
            <div
              role="group"
              aria-label={strings.placeTitle}
              data-drag-mode="move"
              {...handlers}
              className="absolute cursor-move rounded-[4px] border border-signal/70 bg-signal/5"
              style={{
                left: percent(rect.x),
                top: percent(rect.y),
                width: percent(rect.width),
                height: percent(rect.height),
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={signature}
                alt={strings.createTitle}
                draggable={false}
                className="pointer-events-none block size-full object-contain"
              />
              <span
                data-drag-mode="resize"
                {...handlers}
                aria-hidden="true"
                className="absolute -right-2.5 -bottom-2.5 flex size-6 cursor-nwse-resize items-center justify-center rounded-full border-2 border-foreground bg-signal"
              >
                <Move className="size-3 text-foreground" />
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {signature ? strings.placeHint : strings.noSignature}
      </p>
    </div>
  );
}
