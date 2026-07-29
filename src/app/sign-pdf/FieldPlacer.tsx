"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, ChevronRight, Move, PenLine, Type, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type NormalizedRect,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  SIGNATURE_FIELD_TYPES,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import type { SignStrings } from "@/app/sign-pdf/strings";

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Lado minimo de un hueco, en fraccion de pagina. */
const MIN_FIELD_SIDE = 0.02;

/** Movimiento por debajo del cual un puntero cuenta como clic, no arrastre. */
const CLICK_SLOP = 0.004;

/** Ancho inicial y proporcion (alto/ancho en pixeles) de cada tipo de hueco. */
const DEFAULT_FIELD: Record<
  SignatureFieldType,
  { width: number; ratio: number }
> = {
  signature: { width: 0.3, ratio: 1 / 3 },
  initials: { width: 0.11, ratio: 1 },
};

const TYPE_ICONS: Record<SignatureFieldType, typeof Type> = {
  signature: PenLine,
  initials: Type,
};

/** Identificadores estables sin depender de `crypto.randomUUID`. */
let fieldCounter = 0;
function nextFieldId(): string {
  fieldCounter += 1;
  return `fld-${fieldCounter}`;
}

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  id: string;
  startX: number;
  startY: number;
  snapshot: SignatureField;
};

type Draft = { x: number; y: number; toX: number; toY: number };

export type FieldPlacerProps = {
  file: File | null;
  signers: Signer[];
  activeSignerId: string | null;
  fields: SignatureField[];
  onFieldsChange: (fields: SignatureField[]) => void;
  activeType: SignatureFieldType;
  onActiveTypeChange: (type: SignatureFieldType) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  strings: SignStrings;
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
 * Lienzo de reserva de huecos: la pagina renderizada con una capa de
 * campos encima, uno por firmante y tipo. Comparte el contrato de
 * interaccion de `EditCanvas` (`data-drag-mode` + `data-element-id` sobre
 * el nodo que se arrastra) y guarda todo en fracciones 0..1 con origen
 * arriba-izquierda, que es lo que espera el motor.
 */
export function FieldPlacer(props: FieldPlacerProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <FieldPlacerInner key={key} {...props} />;
}

function FieldPlacerInner({
  file,
  signers,
  activeSignerId,
  fields,
  onFieldsChange,
  activeType,
  onActiveTypeChange,
  pageIndex,
  onPageIndexChange,
  selectedId,
  onSelectedIdChange,
  strings,
  onError,
}: FieldPlacerProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
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

  const signerById = (id: string): Signer | null =>
    signers.find((signer) => signer.id === id) ?? null;

  const activeSigner = activeSignerId ? signerById(activeSignerId) : null;
  const pageFields = fields.filter((field) => field.pageIndex === pageIndex);

  const typeLabel = (type: SignatureFieldType): string =>
    type === "signature" ? strings.fieldSignature : strings.fieldInitials;

  /* ---------------------------------------------------------------- *
   * Mutaciones
   * ---------------------------------------------------------------- */

  const addField = useCallback(
    (rect: NormalizedRect) => {
      if (!activeSignerId) return;
      const field: SignatureField = {
        id: nextFieldId(),
        signerId: activeSignerId,
        pageIndex,
        type: activeType,
        rect,
      };
      onFieldsChange([...fields, field]);
      onSelectedIdChange(field.id);
    },
    [
      activeSignerId,
      activeType,
      fields,
      onFieldsChange,
      onSelectedIdChange,
      pageIndex,
    ],
  );

  const patchField = useCallback(
    (id: string, rect: NormalizedRect) => {
      onFieldsChange(
        fields.map((field) => (field.id === id ? { ...field, rect } : field)),
      );
    },
    [fields, onFieldsChange],
  );

  const removeField = useCallback(
    (id: string) => {
      onFieldsChange(fields.filter((field) => field.id !== id));
      if (selectedId === id) onSelectedIdChange(null);
    },
    [fields, onFieldsChange, onSelectedIdChange, selectedId],
  );

  /* Tecla Supr/Retroceso sobre el hueco seleccionado. */
  const removeRef = useRef(removeField);
  useEffect(() => {
    removeRef.current = removeField;
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

  /** Tamano por defecto del tipo activo, en fracciones de la pagina. */
  const defaultSize = (): { width: number; height: number } => {
    const preset = DEFAULT_FIELD[activeType];
    const aspect =
      hostSize.width > 0 && hostSize.height > 0
        ? hostSize.width / hostSize.height
        : 0.75;
    return {
      width: preset.width,
      height: Math.min(0.9, preset.width * preset.ratio * aspect),
    };
  };

  const addCentered = (x: number, y: number) => {
    const size = defaultSize();
    addField({
      x: clamp(x - size.width / 2, 0, Math.max(0, 1 - size.width)),
      y: clamp(y - size.height / 2, 0, Math.max(0, 1 - size.height)),
      width: size.width,
      height: size.height,
    });
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
    if (!preview || !activeSignerId) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draftOriginRef.current = point;
    setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
  };

  const startDrag = (event: ReactPointerEvent<Element>) => {
    const host = hostRef.current;
    const target = event.currentTarget as HTMLElement;
    const mode = target.dataset.dragMode as DragMode | undefined;
    const id = target.dataset.elementId;
    const snapshot = fields.find((field) => field.id === id);
    if (!host || !mode || !id || !snapshot) return;
    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      id,
      startX: event.clientX,
      startY: event.clientY,
      snapshot,
    };
    onSelectedIdChange(id);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    const drag = dragRef.current;
    if (drag && host) {
      event.preventDefault();
      const bounds = host.getBoundingClientRect();
      const dx = (event.clientX - drag.startX) / (bounds.width || 1);
      const dy = (event.clientY - drag.startY) / (bounds.height || 1);
      const start = drag.snapshot.rect;

      if (drag.mode === "move") {
        patchField(drag.id, {
          x: clamp(start.x + dx, 0, Math.max(0, 1 - start.width)),
          y: clamp(start.y + dy, 0, Math.max(0, 1 - start.height)),
          width: start.width,
          height: start.height,
        });
        return;
      }

      patchField(drag.id, {
        x: start.x,
        y: start.y,
        width: clamp(start.width + dx, MIN_FIELD_SIDE, 1 - start.x),
        height: clamp(start.height + dy, MIN_FIELD_SIDE, 1 - start.y),
      });
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

    const width = Math.abs(current.toX - current.x);
    const height = Math.abs(current.toY - current.y);
    if (width < CLICK_SLOP && height < CLICK_SLOP) {
      addCentered(current.x, current.y);
      return;
    }
    if (width < MIN_FIELD_SIDE || height < MIN_FIELD_SIDE) {
      onSelectedIdChange(null);
      return;
    }
    addField({
      x: Math.min(current.x, current.toX),
      y: Math.min(current.y, current.toY),
      width,
      height,
    });
  };

  if (!file) return null;

  const total = Math.max(1, pageCount);

  return (
    <div>
      <div className="mb-3">
        <h3 className="hud-label text-[11px] text-muted-foreground">
          {strings.fieldsTitle}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {strings.fieldsHint}
        </p>
      </div>

      {/* Tipo del proximo hueco */}
      <div className="mb-3">
        <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
          {strings.fieldTypeLabel}
        </span>
        <div
          role="radiogroup"
          aria-label={strings.fieldTypeLabel}
          className="flex flex-wrap gap-1.5"
        >
          {SIGNATURE_FIELD_TYPES.map((type) => {
            const Icon = TYPE_ICONS[type];
            const active = type === activeType;
            return (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onActiveTypeChange(type)}
                className={cn(
                  "hud-label flex min-h-11 items-center gap-2 rounded-ios-sm border px-3 text-[10px] transition-all duration-200 ease-spring",
                  active
                    ? "border-signal/60 bg-signal/15 text-foreground"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {typeLabel(type)}
              </button>
            );
          })}

          <Button
            variant="secondary"
            size="sm"
            disabled={!activeSignerId}
            onClick={() => addCentered(0.5, 0.75)}
          >
            {strings.addFieldHere}
          </Button>
        </div>
      </div>

      {/* Cabecera con navegacion de paginas */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="hud-label text-[10px] text-muted-foreground">
          {activeSigner
            ? strings.fieldOwnerLabel(activeSigner.name, typeLabel(activeType))
            : strings.needSigner}
        </p>
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
              alt={strings.fieldsTitle}
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

          {pageFields.map((field) => (
            <FieldBox
              key={field.id}
              field={field}
              signer={signerById(field.signerId)}
              selected={field.id === selectedId}
              label={strings.fieldOwnerLabel(
                signerById(field.signerId)?.name ?? "",
                typeLabel(field.type),
              )}
              strings={strings}
              onPointerDownHandler={startDrag}
              onRemove={() => removeField(field.id)}
            />
          ))}

          {draft ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute rounded-[4px] border-2 border-dashed"
              style={{
                left: percent(Math.min(draft.x, draft.toX)),
                top: percent(Math.min(draft.y, draft.toY)),
                width: percent(Math.abs(draft.toX - draft.x)),
                height: percent(Math.abs(draft.toY - draft.y)),
                borderColor: activeSigner?.color ?? "#ffffff",
              }}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="hud-label text-[10px] text-muted-foreground tabular-nums">
          {strings.fieldsOnPage(pageFields.length)} ·{" "}
          {strings.totalFields(fields.length)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pageFields.length === 0}
            onClick={() => {
              onFieldsChange(
                fields.filter((field) => field.pageIndex !== pageIndex),
              );
              onSelectedIdChange(null);
            }}
          >
            {strings.clearPageFields}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={fields.length === 0}
            onClick={() => {
              onFieldsChange([]);
              onSelectedIdChange(null);
            }}
          >
            {strings.clearAllFields}
          </Button>
        </div>
      </div>

      {fields.length === 0 ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {strings.noFields}
        </p>
      ) : null}

      {thumbs.length > 1 ? (
        <div className="mt-6">
          <h4 className="hud-label mb-2 text-[10px] text-muted-foreground">
            {strings.thumbsTitle}
          </h4>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {thumbs.map((thumb, index) => {
              const count = fields.filter(
                (field) => field.pageIndex === index,
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

type FieldBoxProps = {
  field: SignatureField;
  signer: Signer | null;
  selected: boolean;
  label: string;
  strings: SignStrings;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onRemove: () => void;
};

function FieldBox({
  field,
  signer,
  selected,
  label,
  strings,
  onPointerDownHandler,
  onRemove,
}: FieldBoxProps) {
  const color = signer?.color ?? "#8b95a5";

  return (
    <div
      role="group"
      aria-label={label}
      data-drag-mode="move"
      data-element-id={field.id}
      onPointerDown={onPointerDownHandler}
      className="absolute cursor-move rounded-[4px]"
      style={{
        left: percent(field.rect.x),
        top: percent(field.rect.y),
        width: percent(field.rect.width),
        height: percent(field.rect.height),
        boxSizing: "border-box",
        /* Color del firmante: dato del documento, no un token del tema. */
        border: `2px ${selected ? "solid" : "dashed"} ${color}`,
        backgroundColor: `${color}22`,
        outline: selected ? "1px solid var(--color-signal)" : undefined,
        outlineOffset: "2px",
      }}
    >
      <span
        className="pointer-events-none absolute -top-0.5 left-0 max-w-full -translate-y-full truncate rounded-t-[4px] px-1.5 py-0.5 text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
      >
        {label}
      </span>

      {selected ? (
        <>
          <button
            type="button"
            aria-label={strings.removeField}
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
            aria-label={strings.resizeField}
            data-drag-mode="resize"
            data-element-id={field.id}
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
