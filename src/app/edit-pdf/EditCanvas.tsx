"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Highlighter,
  ImagePlus,
  Minus,
  Move,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
  type PdfFontFamily,
} from "@/lib/pdf/core";
import {
  EDIT_ELEMENT_TYPES,
  LINE_HEIGHT_FACTOR,
  MIN_ELEMENT_SIDE,
  MIN_LINE_LENGTH,
  type EditElement,
  type EditElementType,
  type EditStyle,
  type ImageElement,
  type LineElement,
  type TextElement,
} from "@/lib/pdf/editPdf";
import type { EditStrings } from "@/app/edit-pdf/strings";

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Ancho inicial de un cuadro de texto y de una imagen, en fraccion de pagina. */
const DEFAULT_TEXT_WIDTH = 0.4;
const DEFAULT_IMAGE_WIDTH = 0.3;

/** Ancho de pagina supuesto mientras pdf.js aun no ha respondido (A4). */
const FALLBACK_PAGE_WIDTH = 595.28;

/** Movimiento por debajo del cual un puntero cuenta como clic, no arrastre. */
const CLICK_SLOP = 0.004;

/** Identificadores estables sin depender de `crypto.randomUUID`. */
let elementCounter = 0;
function nextElementId(): string {
  elementCounter += 1;
  return `el-${elementCounter}`;
}

const TYPE_ICONS: Record<
  EditElementType,
  typeof Type
> = {
  text: Type,
  image: ImagePlus,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  highlight: Highlighter,
};

/**
 * Familias CSS equivalentes a las tipografias estandar del PDF, para que
 * la vista previa se parezca a lo que acabara dentro del archivo.
 */
const CSS_FONT: Record<PdfFontFamily, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

/** Todo lo que no es una linea se dibuja como una caja absoluta. */
type BoxElement = Exclude<EditElement, LineElement>;

type PendingImage = {
  bytes: Uint8Array;
  previewUrl: string;
  /** alto / ancho de la imagen original. */
  ratio: number;
};

type Draft = {
  type: EditElementType;
  x: number;
  y: number;
  toX: number;
  toY: number;
};

type DragMode = "move" | "resize" | "p1" | "p2";

type DragState = {
  mode: DragMode;
  id: string;
  startX: number;
  startY: number;
  snapshot: EditElement;
  hostWidth: number;
  hostHeight: number;
};

export type EditCanvasProps = {
  file: File | null;
  elements: EditElement[];
  onElementsChange: (elements: EditElement[]) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  activeType: EditElementType;
  onActiveTypeChange: (type: EditElementType) => void;
  style: EditStyle;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  strings: EditStrings;
  onError?: (code: PdfErrorCode) => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/**
 * La tinta del documento se elige en hexadecimal y se aplica en linea:
 * no es un token del tema, es un dato del usuario.
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(value)) return `rgba(0,0,0,${alpha})`;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function measureRatio(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () =>
      resolve(image.naturalWidth > 0 ? image.naturalHeight / image.naturalWidth : 1);
    image.onerror = () => resolve(1);
    image.src = dataUrl;
  });
}

/**
 * Lienzo de edicion: la pagina renderizada con una capa de elementos
 * encima. Todo se guarda en fracciones 0..1 de la pagina, como ya hace
 * `RedactCanvas`, para que el motor pueda situarlo a cualquier escala.
 */
export function EditCanvas(props: EditCanvasProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <EditCanvasInner key={key} {...props} />;
}

function EditCanvasInner({
  file,
  elements,
  onElementsChange,
  pageIndex,
  onPageIndexChange,
  activeType,
  onActiveTypeChange,
  style,
  selectedId,
  onSelectedIdChange,
  strings,
  onError,
}: EditCanvasProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pageWidthPt, setPageWidthPt] = useState(FALLBACK_PAGE_WIDTH);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [imageRejected, setImageRejected] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftOriginRef = useRef<{ x: number; y: number } | null>(null);
  const errorRef = useRef(onError);

  useEffect(() => {
    errorRef.current = onError;
  });

  /* Miniaturas de navegacion: una pasada secuencial por el documento. */
  useEffect(() => {
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
          const url = await renderPageToDataUrl(page, { maxWidth: THUMB_WIDTH });
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
        // Viewport a escala 1: puntos PDF con `/Rotate` ya aplicado, que
        // es exactamente la referencia que usa el motor.
        const viewport = page.getViewport({ scale: 1 });
        const url = await renderPageToDataUrl(page, { maxWidth: PREVIEW_WIDTH });
        page.cleanup();
        void closePdfDocument(document);
        if (!cancelled) {
          setPageWidthPt(Math.max(1, viewport.width));
          setPreview(url);
        }
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

  /* Tamano real del lienzo en pixeles: convierte puntos PDF a pantalla. */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const bounds = host.getBoundingClientRect();
      setHostSize({ width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [preview]);

  /** Pixeles de pantalla por punto PDF. */
  const scale = hostSize.width > 0 ? hostSize.width / pageWidthPt : 1;

  const pageElements = elements.filter(
    (element) => element.pageIndex === pageIndex,
  );
  const selected =
    elements.find((element) => element.id === selectedId) ?? null;

  /* ---------------------------------------------------------------- *
   * Mutaciones
   * ---------------------------------------------------------------- */

  /**
   * Un cuadro de texto vacio no llega al PDF, asi que se descarta en
   * cuanto deja de estar seleccionado: si no, quedaria un marco fantasma
   * imposible de entender.
   */
  const pruneEmptyText = useCallback(
    (list: EditElement[], keepId: string | null): EditElement[] =>
      list.filter(
        (element) =>
          element.type !== "text" ||
          element.id === keepId ||
          element.text.trim().length > 0,
      ),
    [],
  );

  const select = useCallback(
    (id: string | null) => {
      onElementsChange(pruneEmptyText(elements, id));
      onSelectedIdChange(id);
    },
    [elements, onElementsChange, onSelectedIdChange, pruneEmptyText],
  );

  const addElement = useCallback(
    (element: EditElement) => {
      onElementsChange([...pruneEmptyText(elements, null), element]);
      onSelectedIdChange(element.id);
    },
    [elements, onElementsChange, onSelectedIdChange, pruneEmptyText],
  );

  const patchElement = useCallback(
    (id: string, next: EditElement) => {
      onElementsChange(
        elements.map((element) => (element.id === id ? next : element)),
      );
    },
    [elements, onElementsChange],
  );

  const removeElement = useCallback(
    (id: string) => {
      onElementsChange(elements.filter((element) => element.id !== id));
      if (selectedId === id) onSelectedIdChange(null);
    },
    [elements, onElementsChange, onSelectedIdChange, selectedId],
  );

  /* Tecla Supr/Retroceso sobre el elemento seleccionado. */
  const removeRef = useRef(removeElement);
  useEffect(() => {
    removeRef.current = removeElement;
  });
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      removeRef.current(selectedId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  /* ---------------------------------------------------------------- *
   * Creacion de elementos
   * ---------------------------------------------------------------- */

  const createText = (x: number, y: number): void => {
    const width = Math.min(DEFAULT_TEXT_WIDTH, Math.max(MIN_ELEMENT_SIDE, 1 - x));
    const element: TextElement = {
      id: nextElementId(),
      pageIndex,
      type: "text",
      x,
      y,
      width,
      text: "",
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      bold: style.bold,
      italic: style.italic,
      color: style.textColor,
    };
    addElement(element);
  };

  const createImage = (x: number, y: number): void => {
    if (!pendingImage) {
      imageInputRef.current?.click();
      return;
    }
    const width = Math.min(DEFAULT_IMAGE_WIDTH, 1);
    const aspect =
      hostSize.width > 0 && hostSize.height > 0
        ? hostSize.width / hostSize.height
        : 0.75;
    const height = Math.min(0.95, width * pendingImage.ratio * aspect);
    const element: ImageElement = {
      id: nextElementId(),
      pageIndex,
      type: "image",
      x: clamp(x - width / 2, 0, 1 - width),
      y: clamp(y - height / 2, 0, Math.max(0, 1 - height)),
      width,
      height,
      bytes: pendingImage.bytes,
      previewUrl: pendingImage.previewUrl,
      ratio: pendingImage.ratio,
    };
    addElement(element);
  };

  const createFromDraft = (current: Draft): void => {
    const x = Math.min(current.x, current.toX);
    const y = Math.min(current.y, current.toY);
    const width = Math.abs(current.toX - current.x);
    const height = Math.abs(current.toY - current.y);
    const id = nextElementId();

    if (current.type === "line") {
      if (Math.hypot(current.toX - current.x, current.toY - current.y) < MIN_LINE_LENGTH) {
        return;
      }
      const element: LineElement = {
        id,
        pageIndex,
        type: "line",
        x1: current.x,
        y1: current.y,
        x2: current.toX,
        y2: current.toY,
        strokeColor: style.strokeColor,
        strokeWidth: style.strokeWidth,
      };
      addElement(element);
      return;
    }

    if (width < MIN_ELEMENT_SIDE || height < MIN_ELEMENT_SIDE) return;

    if (current.type === "highlight") {
      addElement({
        id,
        pageIndex,
        type: "highlight",
        x,
        y,
        width,
        height,
        color: style.highlightColor,
        opacity: style.highlightOpacity,
      });
      return;
    }

    if (current.type === "rect" || current.type === "ellipse") {
      addElement({
        id,
        pageIndex,
        type: current.type,
        x,
        y,
        width,
        height,
        strokeColor: style.strokeColor,
        strokeWidth: style.strokeWidth,
        fill: style.fill,
        fillColor: style.fillColor,
        fillOpacity: style.fillOpacity,
      });
    }
  };

  /* ---------------------------------------------------------------- *
   * Puntero
   * ---------------------------------------------------------------- */

  const toNormalized = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const host = hostRef.current;
    if (!host) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: clamp01((clientX - bounds.left) / bounds.width),
      y: clamp01((clientY - bounds.top) / bounds.height),
    };
  };

  const startCreate = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!preview) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draftOriginRef.current = point;
    setDraft({ type: activeType, x: point.x, y: point.y, toX: point.x, toY: point.y });
  };

  const startDrag = (event: ReactPointerEvent<Element>) => {
    const host = hostRef.current;
    // `currentTarget` puede ser un nodo SVG (las lineas), asi que se
    // accede al dataset por la interfaz comun de HTMLOrSVGElement.
    const target = event.currentTarget as HTMLElement | SVGElement;
    const mode = target.dataset.dragMode as DragMode | undefined;
    const id = target.dataset.elementId;
    const snapshot = elements.find((element) => element.id === id);
    if (!host || !mode || !id || !snapshot) return;
    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    const bounds = host.getBoundingClientRect();
    dragRef.current = {
      mode,
      id,
      startX: event.clientX,
      startY: event.clientY,
      snapshot,
      hostWidth: bounds.width || 1,
      hostHeight: bounds.height || 1,
    };
    select(id);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) {
      event.preventDefault();
      const dx = (event.clientX - drag.startX) / drag.hostWidth;
      const dy = (event.clientY - drag.startY) / drag.hostHeight;
      const next = applyDrag(drag, dx, dy, event, drag.hostWidth, drag.hostHeight);
      if (next) patchElement(drag.id, next);
      return;
    }
    if (!draftOriginRef.current) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    setDraft((current) =>
      current ? { ...current, toX: point.x, toY: point.y } : current,
    );
  };

  const applyDrag = (
    drag: DragState,
    dx: number,
    dy: number,
    event: ReactPointerEvent<HTMLDivElement>,
    hostWidth: number,
    hostHeight: number,
  ): EditElement | null => {
    const snapshot = drag.snapshot;

    if (snapshot.type === "line") {
      if (drag.mode === "move") {
        const shiftX = clamp(
          dx,
          -Math.min(snapshot.x1, snapshot.x2),
          1 - Math.max(snapshot.x1, snapshot.x2),
        );
        const shiftY = clamp(
          dy,
          -Math.min(snapshot.y1, snapshot.y2),
          1 - Math.max(snapshot.y1, snapshot.y2),
        );
        return {
          ...snapshot,
          x1: snapshot.x1 + shiftX,
          y1: snapshot.y1 + shiftY,
          x2: snapshot.x2 + shiftX,
          y2: snapshot.y2 + shiftY,
        };
      }
      const point = toNormalized(event.clientX, event.clientY);
      if (!point) return null;
      return drag.mode === "p1"
        ? { ...snapshot, x1: point.x, y1: point.y }
        : { ...snapshot, x2: point.x, y2: point.y };
    }

    if (snapshot.type === "text") {
      if (drag.mode === "move") {
        return {
          ...snapshot,
          x: clamp(snapshot.x + dx, 0, Math.max(0, 1 - snapshot.width)),
          y: clamp01(snapshot.y + dy),
        };
      }
      return {
        ...snapshot,
        width: clamp(snapshot.width + dx, MIN_ELEMENT_SIDE, 1 - snapshot.x),
      };
    }

    if (drag.mode === "move") {
      return {
        ...snapshot,
        x: clamp(snapshot.x + dx, 0, Math.max(0, 1 - snapshot.width)),
        y: clamp(snapshot.y + dy, 0, Math.max(0, 1 - snapshot.height)),
      };
    }

    const width = clamp(snapshot.width + dx, MIN_ELEMENT_SIDE, 1 - snapshot.x);
    if (snapshot.type === "image") {
      const aspect = hostWidth > 0 && hostHeight > 0 ? hostWidth / hostHeight : 0.75;
      const height = width * snapshot.ratio * aspect;
      if (snapshot.y + height > 1) return null;
      return { ...snapshot, width, height };
    }
    return {
      ...snapshot,
      width,
      height: clamp(snapshot.height + dy, MIN_ELEMENT_SIDE, 1 - snapshot.y),
    };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      return;
    }
    const origin = draftOriginRef.current;
    draftOriginRef.current = null;
    const current = draft;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!origin || !current) return;

    const isClick =
      Math.abs(current.toX - current.x) < CLICK_SLOP &&
      Math.abs(current.toY - current.y) < CLICK_SLOP;

    if (current.type === "text") {
      if (isClick) createText(current.x, current.y);
      return;
    }
    if (current.type === "image") {
      if (isClick) createImage(current.x, current.y);
      return;
    }
    if (isClick) {
      select(null);
      return;
    }
    createFromDraft(current);
  };

  /* ---------------------------------------------------------------- *
   * Imagen pendiente
   * ---------------------------------------------------------------- */

  const onImageInput = async (input: File | null) => {
    if (!input) return;
    setImageRejected(false);
    const bytes = new Uint8Array(await input.arrayBuffer());
    const isPng =
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) {
      setImageRejected(true);
      return;
    }
    const previewUrl = await blobToDataUrl(input);
    const ratio = await measureRatio(previewUrl);
    setPendingImage({ bytes, previewUrl, ratio });
    onActiveTypeChange("image");
  };

  if (!file) return null;

  const total = Math.max(1, pageCount);
  const lines = pageElements.filter(
    (element): element is LineElement => element.type === "line",
  );

  return (
    <div>
      {/* Barra de herramientas */}
      <div className="mb-3">
        <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
          {strings.toolbarLabel}
        </span>
        <div
          role="radiogroup"
          aria-label={strings.toolbarLabel}
          className="flex flex-wrap gap-1.5"
        >
          {EDIT_ELEMENT_TYPES.map((type) => {
            const Icon = TYPE_ICONS[type];
            const active = type === activeType;
            return (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  onActiveTypeChange(type);
                  if (type === "image" && !pendingImage) {
                    imageInputRef.current?.click();
                  }
                }}
                className={cn(
                  "hud-label flex min-h-11 items-center gap-2 rounded-ios-sm border px-3 text-[10px] transition-all duration-200 ease-spring",
                  active
                    ? "border-signal/60 bg-signal/15 text-foreground"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {strings.typeLabels[type]}
              </button>
            );
          })}
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,.png,.jpg,.jpeg"
          className="sr-only"
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            event.target.value = "";
            void onImageInput(picked);
          }}
        />
      </div>

      {activeType === "image" ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => imageInputRef.current?.click()}
          >
            <ImagePlus aria-hidden="true" className="size-4" />
            {pendingImage ? strings.imageReplace : strings.imagePick}
          </Button>
          {pendingImage ? (
            <p className="text-xs text-muted-foreground">
              {strings.imagePending}
            </p>
          ) : null}
          {imageRejected ? (
            <p role="alert" className="text-xs text-destructive">
              {strings.imageRejected}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Cabecera con navegacion de paginas */}
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
          onPointerDown={startCreate}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
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
            ? pageElements
                .filter(
                  (element): element is BoxElement => element.type !== "line",
                )
                .map((element) => (
                  <ElementBox
                    key={element.id}
                    element={element}
                    selected={element.id === selectedId}
                    scale={scale}
                    strings={strings}
                    onPointerDownHandler={startDrag}
                    onRemove={() => removeElement(element.id)}
                  />
                ))
            : null}

          {preview && lines.length > 0 ? (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 size-full overflow-visible"
            >
              {lines.map((line) => {
                const width = Math.max(1, line.strokeWidth * scale);
                return (
                  <g key={line.id}>
                    <line
                      x1={percent(line.x1)}
                      y1={percent(line.y1)}
                      x2={percent(line.x2)}
                      y2={percent(line.y2)}
                      stroke={line.strokeColor}
                      strokeWidth={width}
                      strokeLinecap="round"
                    />
                    <line
                      data-drag-mode="move"
                      data-element-id={line.id}
                      onPointerDown={startDrag}
                      x1={percent(line.x1)}
                      y1={percent(line.y1)}
                      x2={percent(line.x2)}
                      y2={percent(line.y2)}
                      stroke="transparent"
                      strokeWidth={Math.max(16, width + 8)}
                      strokeLinecap="round"
                      style={{ pointerEvents: "stroke", cursor: "move" }}
                    />
                    {line.id === selectedId ? (
                      <line
                        x1={percent(line.x1)}
                        y1={percent(line.y1)}
                        x2={percent(line.x2)}
                        y2={percent(line.y2)}
                        stroke="var(--color-signal)"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                      />
                    ) : null}
                  </g>
                );
              })}
            </svg>
          ) : null}

          {preview && selected && selected.type === "line" ? (
            <LineHandles
              line={selected}
              strings={strings}
              onPointerDownHandler={startDrag}
              onRemove={() => removeElement(selected.id)}
            />
          ) : null}

          {draft ? <DraftLayer draft={draft} style={style} scale={scale} /> : null}
        </div>
      </div>

      {/* Editor del cuadro de texto seleccionado */}
      {selected && selected.type === "text" ? (
        <div className="glass rounded-ios mt-3 p-4">
          <label
            htmlFor="edit-pdf-text"
            className="hud-label mb-2 block text-[10px] text-muted-foreground"
          >
            {strings.textEditorTitle}
          </label>
          <textarea
            id="edit-pdf-text"
            rows={3}
            autoFocus
            value={selected.text}
            placeholder={strings.textPlaceholder}
            onChange={(event) =>
              patchElement(selected.id, {
                ...selected,
                text: event.target.value,
              })
            }
            className="w-full resize-y rounded-ios-sm border border-white/14 bg-white/5 p-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60"
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {strings.textEditorHint}
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="hud-label text-[10px] text-muted-foreground tabular-nums">
          {strings.elementsOnPage(pageElements.length)} ·{" "}
          {strings.totalElements(elements.length)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={elements.length === 0}
            onClick={() => {
              onElementsChange(elements.slice(0, -1));
              onSelectedIdChange(null);
            }}
          >
            <Undo2 aria-hidden="true" className="size-4" />
            {strings.undo}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pageElements.length === 0}
            onClick={() => {
              onElementsChange(
                elements.filter((element) => element.pageIndex !== pageIndex),
              );
              onSelectedIdChange(null);
            }}
          >
            {strings.clearPage}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={elements.length === 0}
            onClick={() => {
              onElementsChange([]);
              onSelectedIdChange(null);
            }}
          >
            {strings.clearAll}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {strings.typeHints[activeType]}
      </p>

      {thumbs.length > 1 ? (
        <div className="mt-6">
          <h4 className="hud-label mb-2 text-[10px] text-muted-foreground">
            {strings.thumbsTitle}
          </h4>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {thumbs.map((thumb, index) => {
              const count = elements.filter(
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

/* ------------------------------------------------------------------ *
 * Piezas del overlay
 * ------------------------------------------------------------------ */

type ElementBoxProps = {
  element: BoxElement;
  selected: boolean;
  scale: number;
  strings: EditStrings;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onRemove: () => void;
};

function ElementBox({
  element,
  selected,
  scale,
  strings,
  onPointerDownHandler,
  onRemove,
}: ElementBoxProps) {
  const base: CSSProperties = {
    left: percent(element.x),
    top: percent(element.y),
    width: percent(element.width),
  };

  let inner: CSSProperties = {};
  if (element.type === "text") {
    const size = element.fontSize * scale;
    inner = {
      minHeight: `${size * LINE_HEIGHT_FACTOR}px`,
      fontFamily: CSS_FONT[element.fontFamily],
      fontSize: `${size}px`,
      lineHeight: LINE_HEIGHT_FACTOR,
      fontWeight: element.bold ? 700 : 400,
      fontStyle: element.italic ? "italic" : "normal",
      color: element.color,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      outline: selected
        ? "1px solid var(--color-signal)"
        : "1px dashed rgba(255,255,255,0.35)",
    };
  } else {
    base.height = percent(element.height);
    if (element.type === "highlight") {
      inner = {
        backgroundColor: hexToRgba(element.color, element.opacity),
        outline: selected ? "1px solid var(--color-signal)" : undefined,
      };
    } else if (element.type === "image") {
      inner = {
        outline: selected
          ? "1px solid var(--color-signal)"
          : "1px dashed rgba(255,255,255,0.35)",
      };
    } else {
      inner = {
        boxSizing: "border-box",
        border:
          element.strokeWidth > 0
            ? `${Math.max(1, element.strokeWidth * scale)}px solid ${element.strokeColor}`
            : undefined,
        backgroundColor: element.fill
          ? hexToRgba(element.fillColor, element.fillOpacity)
          : undefined,
        borderRadius: element.type === "ellipse" ? "50%" : undefined,
        outline: selected ? "1px solid var(--color-signal)" : undefined,
        outlineOffset: "2px",
      };
    }
  }

  return (
    <div
      role="group"
      aria-label={
        element.type === "text" ? strings.textBoxLabel : strings.moveElement
      }
      data-drag-mode="move"
      data-element-id={element.id}
      onPointerDown={onPointerDownHandler}
      className="absolute cursor-move"
      style={{ ...base, ...inner }}
    >
      {element.type === "text" ? (
        element.text.length > 0 ? (
          element.text
        ) : (
          <span style={{ opacity: 0.45 }}>{strings.textPlaceholder}</span>
        )
      ) : null}

      {element.type === "image" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={element.previewUrl}
          alt=""
          draggable={false}
          className="pointer-events-none block size-full object-fill"
        />
      ) : null}

      {selected ? (
        <>
          <button
            type="button"
            aria-label={strings.removeElement}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onRemove}
            className={cn(
              "absolute -top-2.5 -right-2.5 flex size-6 items-center justify-center rounded-full",
              "border border-white/20 bg-elevated text-muted-foreground",
              "transition-colors hover:text-destructive",
            )}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
          <span
            role="button"
            tabIndex={-1}
            aria-label={strings.resizeElement}
            data-drag-mode="resize"
            data-element-id={element.id}
            onPointerDown={onPointerDownHandler}
            className="absolute -right-2.5 -bottom-2.5 flex size-6 cursor-nwse-resize items-center justify-center rounded-full border-2 border-foreground bg-signal"
          >
            <Move aria-hidden="true" className="size-3 text-foreground" />
          </span>
        </>
      ) : null}
    </div>
  );
}

type LineHandlesProps = {
  line: LineElement;
  strings: EditStrings;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onRemove: () => void;
};

function LineHandles({
  line,
  strings,
  onPointerDownHandler,
  onRemove,
}: LineHandlesProps) {
  const handle = (
    mode: "p1" | "p2",
    x: number,
    y: number,
    label: string,
  ) => (
    <span
      role="button"
      tabIndex={-1}
      aria-label={label}
      data-drag-mode={mode}
      data-element-id={line.id}
      onPointerDown={onPointerDownHandler}
      className="absolute size-5 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-foreground bg-signal"
      style={{ left: percent(x), top: percent(y) }}
    />
  );

  return (
    <>
      {handle("p1", line.x1, line.y1, strings.lineStart)}
      {handle("p2", line.x2, line.y2, strings.lineEnd)}
      <button
        type="button"
        aria-label={strings.removeElement}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onRemove}
        className={cn(
          "absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
          "border border-white/20 bg-elevated text-muted-foreground",
          "transition-colors hover:text-destructive",
        )}
        style={{
          left: percent((line.x1 + line.x2) / 2),
          top: percent((line.y1 + line.y2) / 2),
        }}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </>
  );
}

function DraftLayer({
  draft,
  style,
  scale,
}: {
  draft: Draft;
  style: EditStyle;
  scale: number;
}) {
  if (draft.type === "text" || draft.type === "image") return null;

  if (draft.type === "line") {
    return (
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
      >
        <line
          x1={percent(draft.x)}
          y1={percent(draft.y)}
          x2={percent(draft.toX)}
          y2={percent(draft.toY)}
          stroke={style.strokeColor}
          strokeWidth={Math.max(1, style.strokeWidth * scale)}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const x = Math.min(draft.x, draft.toX);
  const y = Math.min(draft.y, draft.toY);
  const width = Math.abs(draft.toX - draft.x);
  const height = Math.abs(draft.toY - draft.y);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{
        left: percent(x),
        top: percent(y),
        width: percent(width),
        height: percent(height),
        boxSizing: "border-box",
        borderRadius: draft.type === "ellipse" ? "50%" : undefined,
        border:
          draft.type === "highlight"
            ? undefined
            : `${Math.max(1, style.strokeWidth * scale)}px solid ${style.strokeColor}`,
        backgroundColor:
          draft.type === "highlight"
            ? hexToRgba(style.highlightColor, style.highlightOpacity)
            : style.fill
              ? hexToRgba(style.fillColor, style.fillOpacity)
              : undefined,
      }}
    />
  );
}
