"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, ChevronLeft, ChevronRight, Move, PenLine, Type, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
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
  normalizeFieldLabel,
  signerDisplayName,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import {
  fieldTypeOf,
  type DetectedField,
  type DetectedFieldType,
} from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { ValueSuggestions } from "@/app/sign-pdf/ValueSuggestions";
import {
  forgetValue,
  recordValue,
  suggestValues,
  useValueHistoryVersion,
} from "@/lib/valueHistory";

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Lado minimo de un hueco, en fraccion de pagina. */
const MIN_FIELD_SIDE = 0.02;

/** Movimiento por debajo del cual un puntero cuenta como clic, no arrastre. */
const CLICK_SLOP = 0.004;

/**
 * Movimiento (en pixeles fisicos, no fraccion de pagina) por debajo del
 * cual tocar un campo de texto YA EXISTENTE cuenta como un toque (abre
 * el editor) y no como el inicio de un arrastre. A diferencia de
 * `CLICK_SLOP` (fraccion del ancho de pagina, pensado para decidir si un
 * gesto sobre lienzo vacio crea un campo centrado o uno del tamaño
 * arrastrado), el temblor real de un dedo es una cantidad de pixeles
 * fisicos constante, sin importar el zoom de la vista previa -- 8px
 * coincide con el "touch slop" de referencia de Android (8dp) y esta
 * cerca del de iOS (~10pt).
 */
const TAP_MOVE_THRESHOLD_PX = 8;

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

/**
 * Identificadores estables sin depender de `crypto.randomUUID`. Exportado
 * (no solo de uso interno) porque aplicar una plantilla de disposicion
 * (`signTemplates.ts`) tiene que acuñar ids nuevos con el mismo contador
 * que "anadir campo a mano" -- nunca reutilizar los ids guardados en la
 * plantilla, que pueden colisionar con los del documento actual.
 */
let fieldCounter = 0;
export function nextFieldId(): string {
  fieldCounter += 1;
  return `fld-${fieldCounter}`;
}

/**
 * Adelanta el contador por encima de los ids ya en uso. Necesario al
 * restaurar un borrador o una configuracion importada: el contador
 * arranca en 0 en cada carga de pagina, asi que sin esto un campo nuevo
 * anadido despues de restaurar podria regenerar un id ya usado por el
 * borrador (`fld-1` de nuevo) y pisar silenciosamente el campo original.
 */
export function reserveFieldIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^fld-(\d+)$/.exec(id);
    if (match) fieldCounter = Math.max(fieldCounter, Number(match[1]));
  }
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
  onActiveSignerIdChange: (id: string) => void;
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
  /** Borrar un hueco muestra "Deshacer" en vez de borrarlo sin red de seguridad. Mismo flag que el de campos de texto. */
  undoDeleteEnabled?: boolean;
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
  onActiveSignerIdChange,
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
  undoDeleteEnabled = false,
}: FieldPlacerProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);

  /**
   * "Deshacer" al borrar un hueco: mismo patron que `TextFieldPlacer`
   * (unico pendiente, 6s, se reemplaza si se borra otro antes). A
   * diferencia de un campo de texto, un hueco no tiene un "valor" propio
   * que restaurar -- pero SI importa restaurar el id y el rect EXACTOS
   * (nunca regenerarlos): `captureStamp` (`SigningCeremony.tsx`) los usa
   * para validar la captura del firmante, asi que borrar y deshacer un
   * hueco tiene que revalidarla en silencio, no dejarla marcada como
   * "hay que volver a firmar".
   */
  const [pendingUndo, setPendingUndo] = useState<{
    field: SignatureField;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (!pendingUndo) return;
    const timer = window.setTimeout(() => setPendingUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pendingUndo]);

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

  /** Nombre a mostrar de un firmante por id, con el mismo fallback numerado que `SignerManager`. */
  const signerDisplayNameById = (id: string): string => {
    const index = signers.findIndex((signer) => signer.id === id);
    if (index === -1) return "";
    return signerDisplayName(signers[index].name, index, strings.defaultSignerName);
  };

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
      const index = fields.findIndex((field) => field.id === id);
      if (undoDeleteEnabled && index !== -1) {
        setPendingUndo({ field: fields[index], index });
      }
      onFieldsChange(fields.filter((field) => field.id !== id));
      if (selectedId === id) onSelectedIdChange(null);
    },
    [fields, undoDeleteEnabled, onFieldsChange, onSelectedIdChange, selectedId],
  );

  /** Repone el hueco borrado en su posicion original, id y rect intactos. */
  const restorePendingUndo = useCallback(() => {
    if (!pendingUndo) return;
    const next = [...fields];
    next.splice(Math.min(pendingUndo.index, next.length), 0, pendingUndo.field);
    onFieldsChange(next);
    onSelectedIdChange(pendingUndo.field.id);
    setPendingUndo(null);
  }, [pendingUndo, fields, onFieldsChange, onSelectedIdChange]);

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

      {/* Dueño del proximo hueco: se cambia aqui mismo, sin volver al paso 1. */}
      {signers.length > 0 ? (
        <div className="mb-3">
          <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
            {strings.activeSignerLabel}
          </span>
          <div
            role="radiogroup"
            aria-label={strings.activeSignerLabel}
            className="flex flex-wrap gap-1.5"
          >
            {signers.map((signer, index) => {
              const active = signer.id === activeSignerId;
              return (
                <button
                  key={signer.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onActiveSignerIdChange(signer.id)}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-ios-sm border px-3 text-xs transition-all duration-200 ease-spring",
                    active
                      ? "border-signal/60 bg-signal/15 text-foreground"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 rounded-full"
                    /* Color del firmante: dato del documento, no un token del tema. */
                    style={{ backgroundColor: signer.color }}
                  />
                  <span className="max-w-32 truncate">
                    {signerDisplayName(signer.name, index, strings.defaultSignerName)}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {strings.activeSignerHint}
          </p>
        </div>
      ) : null}

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
            ? strings.fieldOwnerLabel(
                signerDisplayNameById(activeSigner.id),
                typeLabel(activeType),
              )
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

      {/*
       * Controles destructivos arriba, lejos de las miniaturas: en movil
       * se hace scroll dentro de la vista previa para moverse entre
       * paginas, y un boton que borra todo justo antes de las miniaturas
       * quedaba en esa misma ruta de scroll -- facil de tocar sin querer.
       */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
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
            onClick={() => setConfirmClearAllOpen(true)}
          >
            {strings.clearAllFields}
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
                signerDisplayNameById(field.signerId),
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

      {fields.length === 0 ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {strings.noFields}
        </p>
      ) : null}

      {pendingUndo ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
        >
          <span className="text-xs text-muted-foreground">
            {strings.fieldDeletedNotice}
          </span>
          <Button variant="ghost" size="sm" onClick={restorePendingUndo}>
            {strings.undoRemoveField}
          </Button>
        </div>
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

      <ConfirmSheet
        open={confirmClearAllOpen}
        onClose={() => setConfirmClearAllOpen(false)}
        onConfirm={() => {
          onFieldsChange([]);
          onSelectedIdChange(null);
        }}
        title={strings.confirmClearAllFieldsTitle}
        body={strings.confirmClearAllFieldsBody}
        confirmLabel={strings.clearAllFields}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
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

/* ------------------------------------------------------------------ *
 * Campos de texto: mismo gesto de colocacion que `FieldPlacer`, sobre
 * una lista de `DetectedField` (detectados o anadidos a mano) en vez de
 * huecos de firma por firmante. No comparte estado con `FieldPlacer`
 * (no hay firmante ni tipo de campo), pero replica su interaccion
 * (arrastrar para crear, mover, redimensionar, Supr para borrar) para
 * que el gesto se sienta identico.
 * ------------------------------------------------------------------ */

/** Lado y alto por defecto de un campo de texto nuevo, en fraccion de pagina. */
const DEFAULT_TEXT_FIELD = { width: 0.28, height: 0.045 };

/** Identificadores estables para los campos anadidos a mano. Exportado por el mismo motivo que `nextFieldId`. */
let textFieldCounter = 0;
export function nextTextFieldId(): string {
  textFieldCounter += 1;
  return `txt-${textFieldCounter}`;
}

/** Mismo motivo que `reserveFieldIds`, para los campos de texto (`txt-N`). */
export function reserveTextFieldIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^txt-(\d+)$/.exec(id);
    if (match) textFieldCounter = Math.max(textFieldCounter, Number(match[1]));
  }
}

type TextDragState = {
  mode: DragMode;
  id: string;
  startX: number;
  startY: number;
  snapshot: DetectedField;
  /** Puntero que inicio el gesto: un segundo dedo no debe poder finalizarlo ni moverlo. */
  pointerId: number;
  /** Se vuelve `true` en cuanto el movimiento supera `TAP_MOVE_THRESHOLD_PX`; hasta entonces, sigue siendo un toque en potencia. */
  moved: boolean;
};

export type TextFieldPlacerProps = {
  file: File | null;
  fields: DetectedField[];
  onFieldsChange: (fields: DetectedField[]) => void;
  /** Valor actual de cada campo, indexado por `id`. */
  values: Record<string, string>;
  onValueChange: (id: string, value: string) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  /** Campo con el input en linea abierto -- distinto de `selectedId` (borde/tiradores). */
  editingId: string | null;
  onEditingIdChange: (id: string | null) => void;
  strings: SignStrings;
  onError?: (code: PdfErrorCode) => void;
  /** Tab/Enter salta al siguiente campo vacio en vez de cerrar el editor. */
  keyboardNavEnabled?: boolean;
  /** Borrar un campo muestra "Deshacer" en vez de borrarlo sin red de seguridad. */
  undoDeleteEnabled?: boolean;
  /** Permite elegir el tipo del campo seleccionado (casilla, fecha, inicial), no solo texto libre. */
  richFieldTypesEnabled?: boolean;
  /** Pellizco con dos dedos para acercar el lienzo, en formularios densos. */
  pinchZoomEnabled?: boolean;
};

export function TextFieldPlacer(props: TextFieldPlacerProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <TextFieldPlacerInner key={key} {...props} />;
}

function TextFieldPlacerInner({
  file,
  fields,
  onFieldsChange,
  values,
  onValueChange,
  pageIndex,
  onPageIndexChange,
  selectedId,
  onSelectedIdChange,
  editingId,
  onEditingIdChange,
  strings,
  onError,
  keyboardNavEnabled = false,
  undoDeleteEnabled = false,
  richFieldTypesEnabled = false,
  pinchZoomEnabled = false,
}: TextFieldPlacerProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);

  /**
   * Zoom con pellizco (dos dedos): `zoom` y `pan` viven aqui, no en el
   * padre, igual que "Deshacer" -- solo importan mientras este lienzo
   * concreto este montado. `activePointersRef` registra TODOS los
   * punteros activos (no solo el que arrastra un campo) para poder medir
   * la distancia entre dos dedos; `pinchRef` solo existe mientras el
   * pellizco esta en marcha.
   */
  const MAX_ZOOM = 3;
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  );
  const pinchRef = useRef<{
    pointerIds: [number, number];
    startDistance: number;
    startZoom: number;
    startPan: { x: number; y: number };
    startMid: { x: number; y: number };
  } | null>(null);

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  // Re-renderiza este subarbol cuando el historial cambia, incluida otra
  // pestaña (borrar datos ahi debe apagar las sugerencias aqui tambien).
  useValueHistoryVersion();

  /**
   * Un unico "Deshacer" pendiente a la vez (no una cola): borrar otro
   * campo mientras el anterior sigue deshacible lo reemplaza sin mas
   * -- el anterior queda borrado en firme. Vive aqui, no en el padre,
   * porque solo importa mientras este subarbol este montado.
   */
  const [pendingUndo, setPendingUndo] = useState<{
    field: DetectedField;
    index: number;
    value: string;
  } | null>(null);

  useEffect(() => {
    if (!pendingUndo) return;
    const timer = window.setTimeout(() => setPendingUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pendingUndo]);

  /**
   * Casillas "tocadas" en esta pasada por el paso "text": una casilla sin
   * marcar cuenta como pendiente para la navegacion por teclado (Tab/Enter)
   * solo mientras nadie la haya visitado o alternado todavia. Vive en un
   * ref, no en `SignToolOptions`, porque nadie mas la consume (a
   * diferencia de `selectedTextFieldId`/`editingTextFieldId`, que el
   * padre si escribe) y porque nunca debe entrar en el ciclo de
   * autoguardado ni en `SignConfigManifest` -- es estado de esta sesion
   * de edicion, no del documento. Se reinicia al desmontar/remontar este
   * lienzo (salir del paso "text" y volver), que es el comportamiento
   * correcto: una pasada nueva por el formulario vuelve a ofrecer cada
   * casilla una vez.
   */
  const touchedCheckboxesRef = useRef<Set<string>>(new Set());

  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<TextDragState | null>(null);
  const draftOriginRef = useRef<{ x: number; y: number } | null>(null);
  const errorRef = useRef(onError);

  useEffect(() => {
    errorRef.current = onError;
  });

  /* Vista grande de la pagina activa (igual que `FieldPlacer`). */
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
        setPageCount(document.numPages);
        const number = Math.min(
          Math.max(1, pageIndex + 1),
          Math.max(1, document.numPages),
        );
        const page = await document.getPage(number);
        const url = await renderPageToDataUrl(page, { maxWidth: PREVIEW_WIDTH });
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

  const pageFields = fields.filter((field) => field.pageIndex === pageIndex);
  const fallbackLabel = (id: string): string => {
    const globalIndex = fields.findIndex((field) => field.id === id);
    return strings.textFieldFallbackLabel(globalIndex + 1);
  };

  /* ---------------------------------------------------------------- *
   * Mutaciones
   * ---------------------------------------------------------------- */

  const addField = useCallback(
    (rect: NormalizedRect) => {
      const field: DetectedField = {
        id: nextTextFieldId(),
        pageIndex,
        rect,
        source: "manual",
        confidence: "high",
      };
      onFieldsChange([...fields, field]);
      onSelectedIdChange(field.id);
      onEditingIdChange(field.id);
    },
    [fields, onFieldsChange, onSelectedIdChange, onEditingIdChange, pageIndex],
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
      const index = fields.findIndex((field) => field.id === id);
      if (undoDeleteEnabled && index !== -1) {
        setPendingUndo({ field: fields[index], index, value: values[id] ?? "" });
      }
      onFieldsChange(fields.filter((field) => field.id !== id));
      if (selectedId === id) onSelectedIdChange(null);
      if (editingId === id) onEditingIdChange(null);
    },
    [
      fields,
      values,
      undoDeleteEnabled,
      onFieldsChange,
      onSelectedIdChange,
      selectedId,
      editingId,
      onEditingIdChange,
    ],
  );

  /** Repone el campo borrado (y su valor) en su posicion original. */
  const restorePendingUndo = useCallback(() => {
    if (!pendingUndo) return;
    const next = [...fields];
    next.splice(Math.min(pendingUndo.index, next.length), 0, pendingUndo.field);
    onFieldsChange(next);
    if (pendingUndo.value) onValueChange(pendingUndo.field.id, pendingUndo.value);
    onSelectedIdChange(pendingUndo.field.id);
    setPendingUndo(null);
  }, [pendingUndo, fields, onFieldsChange, onValueChange, onSelectedIdChange]);

  const removeRef = useRef(removeField);
  useEffect(() => {
    removeRef.current = removeField;
  });
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape sale del editor sin perder la seleccion (tiradores/quitar
        // siguen visibles); si ya no se estaba editando, no hace nada mas.
        onEditingIdChange(null);
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      removeRef.current(selectedId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, onEditingIdChange]);

  /**
   * Tab/Enter en un campo: salta al siguiente campo pendiente en orden de
   * documento (todas las paginas, pagina por pagina), cambiando de pagina
   * si hace falta. Si no queda ninguno pendiente, simplemente cierra el
   * editor (mismo resultado que hoy sin navegacion por teclado).
   *
   * "Pendiente" no es lo mismo que "sin rellenar" (`isFieldFilled` en
   * detectFields.ts, que alimenta el aviso de campos pendientes): una
   * casilla sin marcar es una respuesta valida y por eso siempre cuenta
   * como "rellena" ahi. Para la navegacion, en cambio, una casilla sin
   * marcar SI es pendiente -- pero solo la primera vez que el cursor la
   * visita en esta pasada; visitarla no la marca, la deja lista para que
   * el usuario decida con la barra espaciadora.
   */
  const isPendingForNav = useCallback(
    (f: DetectedField) => {
      const value = values[f.id] ?? "";
      if (fieldTypeOf(f) === "checkbox") {
        return value.length === 0 && !touchedCheckboxesRef.current.has(f.id);
      }
      return value.trim().length === 0;
    },
    [values],
  );

  const advanceToNextEmptyField = useCallback(
    (currentId: string) => {
      const ordered = [...fields].sort((a, b) => a.pageIndex - b.pageIndex);
      const currentIndex = ordered.findIndex((f) => f.id === currentId);
      if (currentIndex === -1 || ordered.length === 0) {
        onEditingIdChange(null);
        return;
      }
      const total = ordered.length;
      for (let step = 1; step <= total; step++) {
        const candidate = ordered[(currentIndex + step) % total];
        if (candidate.id !== currentId && isPendingForNav(candidate)) {
          if (fieldTypeOf(candidate) === "checkbox") {
            touchedCheckboxesRef.current.add(candidate.id);
          }
          onSelectedIdChange(candidate.id);
          onPageIndexChange(candidate.pageIndex);
          onEditingIdChange(candidate.id);
          return;
        }
      }
      onEditingIdChange(null);
    },
    [fields, isPendingForNav, onSelectedIdChange, onPageIndexChange, onEditingIdChange],
  );

  const addCentered = (x: number, y: number) => {
    addField({
      x: clamp(x - DEFAULT_TEXT_FIELD.width / 2, 0, Math.max(0, 1 - DEFAULT_TEXT_FIELD.width)),
      y: clamp(y - DEFAULT_TEXT_FIELD.height / 2, 0, Math.max(0, 1 - DEFAULT_TEXT_FIELD.height)),
      width: DEFAULT_TEXT_FIELD.width,
      height: DEFAULT_TEXT_FIELD.height,
    });
  };

  /* ---------------------------------------------------------------- *
   * Puntero: mismo gesto que `FieldPlacer` (crear arrastrando, mover,
   * redimensionar por el tirador).
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
    if (pinchZoomEnabled) {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      // Un segundo dedo mientras no hay ningun campo en arrastre es un
      // pellizco, nunca un segundo intento de dibujar un campo.
      if (activePointersRef.current.size === 2 && !dragRef.current) {
        const [[idA, a], [idB, b]] = [...activePointersRef.current.entries()];
        event.preventDefault();
        // Si el primer dedo habia empezado a dibujar un campo nuevo, ese
        // borrador queda cancelado: dos dedos ya no son "dibujar".
        draftOriginRef.current = null;
        setDraft(null);
        pinchRef.current = {
          pointerIds: [idA, idB],
          startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          startZoom: zoom,
          startPan: pan,
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
      // Un tercer dedo, o cualquier dedo mientras el pellizco ya esta en
      // marcha: se ignora, no reinicia nada.
      if (activePointersRef.current.size > 2 || pinchRef.current) return;
    }

    if (!preview) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Tocar el lienzo vacio (para crear un campo nuevo) siempre cierra el
    // editor de cualquier campo existente que estuviera abierto.
    onEditingIdChange(null);
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
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    // El tirador de redimensionar no tiene ambiguedad de "¿fue un toque?"
    // (es un control pequeño y deliberado): sigue previniendo el
    // comportamiento por defecto de inmediato, como antes. El cuerpo del
    // campo (mode === "move") NO lo hace aqui todavia -- si se previniera
    // ya en el pointerdown, un toque real (que abre el teclado en el
    // input recien enfocado) se veria bloqueado en iOS; se previene recien
    // en el primer pointermove que supera el umbral de temblor, una vez
    // que ya sabemos que es un arrastre de verdad, no un toque.
    if (mode === "resize") event.preventDefault();
    dragRef.current = {
      mode,
      id,
      startX: event.clientX,
      startY: event.clientY,
      snapshot,
      pointerId: event.pointerId,
      moved: false,
    };
    onSelectedIdChange(id);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinchZoomEnabled) {
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }
      const pinch = pinchRef.current;
      if (pinch) {
        const a = activePointersRef.current.get(pinch.pointerIds[0]);
        const b = activePointersRef.current.get(pinch.pointerIds[1]);
        if (a && b) {
          event.preventDefault();
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          const nextZoom = clamp(
            pinch.startZoom * (distance / pinch.startDistance),
            1,
            MAX_ZOOM,
          );
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          // Cota generosa, no un contenido pixel-perfecto: solo evita
          // que el pellizco arrastre el lienzo a valores disparatados.
          const PAN_LIMIT_PX = 400;
          setZoom(nextZoom);
          setPan({
            x: clamp(
              pinch.startPan.x + (midX - pinch.startMid.x),
              -PAN_LIMIT_PX,
              PAN_LIMIT_PX,
            ),
            y: clamp(
              pinch.startPan.y + (midY - pinch.startMid.y),
              -PAN_LIMIT_PX,
              PAN_LIMIT_PX,
            ),
          });
        }
        return;
      }
    }

    const host = hostRef.current;
    const drag = dragRef.current;
    if (drag && host) {
      if (event.pointerId !== drag.pointerId) return;

      if (drag.mode === "move" && !drag.moved) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance <= TAP_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
      }
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

  /**
   * Deja de rastrear un dedo para el pellizco. Si era uno de los dos que
   * lo sostenian, el pellizco termina; si ademas el zoom quedo muy cerca
   * de 1x, encaja del todo (sin esto un pellizco que vuelve casi a 1
   * dejaria un zoom/pan residual imperceptible pero ya no reiniciable
   * sin pasar primero por debajo de 1x).
   */
  const endPinchPointer = (pointerId: number) => {
    if (!pinchZoomEnabled) return;
    activePointersRef.current.delete(pointerId);
    const pinch = pinchRef.current;
    if (pinch && pinch.pointerIds.includes(pointerId)) {
      pinchRef.current = null;
      setZoom((current) => {
        if (current > 1.02) return current;
        setPan({ x: 0, y: 0 });
        return 1;
      });
    }
  };

  /** Puntero perdido a medio gesto (interrupcion del sistema): se aborta sin decidir toque ni arrastre. */
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    dragRef.current = null;
    draftOriginRef.current = null;
    setDraft(null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      // Un toque limpio (sin superar el umbral de temblor) sobre el
      // cuerpo de un campo existente abre el editor -- es la unica forma
      // de rellenar que le pedimos al usuario, tiene que sentirse
      // inmediata. El tirador de redimensionar nunca abre el editor.
      if (drag.mode === "move" && !drag.moved) {
        const tapped = fields.find((field) => field.id === drag.id);
        // Una casilla no tiene modo "editar": el mismo toque limpio que
        // abriria el editor en cualquier otro tipo la marca/desmarca
        // directamente.
        if (tapped && fieldTypeOf(tapped) === "checkbox") {
          touchedCheckboxesRef.current.add(tapped.id);
          onValueChange(tapped.id, (values[tapped.id] ?? "") ? "" : "true");
        } else {
          onEditingIdChange(drag.id);
        }
      }
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
  const selectedField = selectedId
    ? fields.find((field) => field.id === selectedId)
    : null;

  return (
    <div>
      <div className="mb-3">
        <h3 className="hud-label text-[11px] text-muted-foreground">
          {strings.textFieldsTitle}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {strings.textFieldsHint}
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => addCentered(0.5, 0.75)}>
            {strings.addTextFieldHere}
          </Button>
          {pinchZoomEnabled && zoom !== 1 ? (
            <Button variant="ghost" size="sm" onClick={resetZoom}>
              {strings.resetZoomButton}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={strings.previousPage}
            disabled={pageIndex === 0}
            onClick={() => {
              onEditingIdChange(null);
              onPageIndexChange(Math.max(0, pageIndex - 1));
            }}
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
            onClick={() => {
              onEditingIdChange(null);
              onPageIndexChange(Math.min(pageCount - 1, pageIndex + 1));
            }}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>

      {/*
       * Controles destructivos arriba: en movil se hace scroll dentro de
       * la vista previa para moverse por el documento, asi que ningun
       * boton que borre todo queda en esa ruta de scroll.
       */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="hud-label text-[10px] text-muted-foreground tabular-nums">
          {strings.textFieldsOnPage(pageFields.length)} ·{" "}
          {strings.totalTextFields(fields.length)}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={pageFields.length === 0}
            onClick={() => {
              onFieldsChange(fields.filter((field) => field.pageIndex !== pageIndex));
              onSelectedIdChange(null);
              onEditingIdChange(null);
            }}
          >
            {strings.clearPageTextFields}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={fields.length === 0}
            onClick={() => setConfirmClearAllOpen(true)}
          >
            {strings.clearAllTextFields}
          </Button>
        </div>
      </div>

      <div className="glass rounded-ios flex justify-center overflow-hidden p-3">
        <div
          ref={hostRef}
          onPointerDown={startCreate}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className="relative w-full max-w-[640px] cursor-crosshair touch-none select-none"
          style={
            zoom !== 1 || pan.x !== 0 || pan.y !== 0
              ? {
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center center",
                }
              : undefined
          }
        >
          {preview ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={preview}
              alt={strings.textFieldsTitle}
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
            <TextFieldBox
              key={field.id}
              field={field}
              label={field.label ?? fallbackLabel(field.id)}
              value={values[field.id] ?? ""}
              onValueChange={(value) => onValueChange(field.id, value)}
              historyKey={
                field.label &&
                (fieldTypeOf(field) === "text" ||
                  fieldTypeOf(field) === "initials")
                  ? normalizeFieldLabel(field.label)
                  : null
              }
              selected={field.id === selectedId}
              editing={field.id === editingId}
              strings={strings}
              onPointerDownHandler={startDrag}
              onSelect={() => onSelectedIdChange(field.id)}
              onRemove={() => removeField(field.id)}
              onEditEnd={() => onEditingIdChange(null)}
              onAdvance={
                keyboardNavEnabled
                  ? () => advanceToNextEmptyField(field.id)
                  : undefined
              }
              onToggle={
                fieldTypeOf(field) === "checkbox"
                  ? () => {
                      touchedCheckboxesRef.current.add(field.id);
                      onValueChange(
                        field.id,
                        (values[field.id] ?? "") ? "" : "true",
                      );
                    }
                  : undefined
              }
            />
          ))}

          {draft ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-signal"
              style={{
                left: percent(Math.min(draft.x, draft.toX)),
                top: percent(Math.min(draft.y, draft.toY)),
                width: percent(Math.abs(draft.toX - draft.x)),
                height: percent(Math.abs(draft.toY - draft.y)),
              }}
            />
          ) : null}
        </div>
      </div>

      {richFieldTypesEnabled && selectedField ? (
        <div className="mt-3">
          <SegmentedControl<DetectedFieldType>
            size="sm"
            label={strings.textFieldTypeLabel}
            value={fieldTypeOf(selectedField)}
            onChange={(type) => {
              onFieldsChange(
                fields.map((field) =>
                  field.id === selectedField.id ? { ...field, type } : field,
                ),
              );
              // El valor anterior podria no tener sentido en el tipo
              // nuevo (ej. un texto escrito, empotrado como "X" si se
              // cambia a casilla): se limpia al cambiar de tipo.
              onValueChange(selectedField.id, "");
            }}
            options={[
              { value: "text", label: strings.fieldTypeText },
              { value: "checkbox", label: strings.fieldTypeCheckbox },
              { value: "date", label: strings.fieldTypeDate },
              { value: "initials", label: strings.fieldTypeInitials },
            ]}
          />
        </div>
      ) : null}

      {selectedField?.confidence === "low" ? (
        <p className="mt-3 text-xs leading-relaxed text-amber-400">
          {strings.lowConfidenceHint}
        </p>
      ) : null}

      {fields.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {strings.noTextFields}
        </p>
      ) : null}

      {pendingUndo ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
        >
          <span className="text-xs text-muted-foreground">
            {strings.textFieldDeletedNotice}
          </span>
          <Button variant="ghost" size="sm" onClick={restorePendingUndo}>
            {strings.undoRemoveTextField}
          </Button>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmClearAllOpen}
        onClose={() => setConfirmClearAllOpen(false)}
        onConfirm={() => {
          onFieldsChange([]);
          onSelectedIdChange(null);
          onEditingIdChange(null);
        }}
        title={strings.confirmClearAllTextFieldsTitle}
        body={strings.confirmClearAllTextFieldsBody}
        confirmLabel={strings.clearAllTextFields}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </div>
  );
}

type TextFieldBoxProps = {
  field: DetectedField;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Clave del historial de valores (etiqueta normalizada), o `null` sin etiqueta estable. */
  historyKey: string | null;
  selected: boolean;
  /** Input en linea abierto (distinto de `selected`: un campo puede estar seleccionado -- tiradores visibles -- sin estar en edicion). */
  editing: boolean;
  strings: SignStrings;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onSelect: () => void;
  onRemove: () => void;
  /** El input perdio el foco (toco otro campo/boton/fuera): cierra el editor sin perder la seleccion. */
  onEditEnd: () => void;
  /** Tab/Enter: saltar al siguiente campo pendiente. `undefined` si la navegacion por teclado esta apagada. */
  onAdvance?: () => void;
  /** Alterna una casilla (marca/desmarca) y la registra como "tocada". Solo definido para `type === "checkbox"`. */
  onToggle?: () => void;
};

/**
 * Un campo de texto sobre la vista previa: contorno solido (AcroForm o
 * vectorial) o discontinuo (deteccion raster experimental, confianza
 * baja). Un toque limpio (sin arrastre) abre el input en linea justo
 * encima del propio campo -- la unica forma de rellenar que se le pide
 * al usuario, como tocar un hueco en Adobe Acrobat.
 */
function TextFieldBox({
  field,
  label,
  value,
  onValueChange,
  historyKey,
  selected,
  editing,
  strings,
  onPointerDownHandler,
  onSelect,
  onRemove,
  onEditEnd,
  onAdvance,
  onToggle,
}: TextFieldBoxProps) {
  const type = fieldTypeOf(field);
  const dashed = field.confidence === "low";
  const color = dashed ? "#f59e0b" : "#0d4bff";

  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const checkboxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (type === "checkbox" && editing) {
      checkboxRef.current?.focus();
    }
  }, [type, editing]);

  const suggestions =
    editing && historyKey && !suggestionsDismissed
      ? suggestValues(historyKey, value, 5)
      : [];

  const commitAndClose = () => {
    if (historyKey) recordValue(historyKey, value);
    onEditEnd();
  };

  return (
    <div
      role="group"
      aria-label={label}
      data-drag-mode="move"
      data-element-id={field.id}
      onPointerDown={(event) => {
        onSelect();
        onPointerDownHandler(event);
      }}
      className="absolute cursor-move rounded-[4px]"
      style={{
        left: percent(field.rect.x),
        top: percent(field.rect.y),
        width: percent(field.rect.width),
        height: percent(field.rect.height),
        boxSizing: "border-box",
        border: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        backgroundColor: value ? `${color}22` : "transparent",
        outline: selected ? "1px solid var(--color-signal)" : undefined,
        outlineOffset: "2px",
        // Por encima de los campos siguientes (hermanos absolutos sin
        // z-index propio, se apilan por orden del DOM): sin esto, el
        // dropdown de sugerencias de un campo puede quedar tapado por un
        // campo posterior en la misma pagina.
        zIndex: editing ? 30 : undefined,
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
            aria-label={strings.removeTextField}
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
            aria-label={strings.resizeTextField}
            data-drag-mode="resize"
            data-element-id={field.id}
            onPointerDown={onPointerDownHandler}
            className="absolute -right-2.5 -bottom-2.5 flex size-6 cursor-nwse-resize items-center justify-center rounded-full border-2 border-foreground bg-signal"
          >
            <Move aria-hidden="true" className="size-3 text-foreground" />
          </span>
        </>
      ) : null}

      {/*
        Una casilla no tiene modo "editar": el toque limpio que la
        marca/desmarca vive en `onPointerUp` del lienzo. Este nodo es solo
        el objetivo de foco para Tab/Enter (navegacion por teclado) y
        Espacio (alternar) -- no intercepta punteros (`pointer-events-none`,
        sin onClick/onPointerDown) para no interferir con el arrastre ni
        con el toggle por toque, que siguen viviendo en el lienzo.
      */}
      {type === "checkbox" ? (
        <span
          ref={checkboxRef}
          role="checkbox"
          aria-checked={Boolean(value)}
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              onToggle?.();
              return;
            }
            if (
              onAdvance &&
              (event.key === "Enter" ||
                (event.key === "Tab" && !event.shiftKey))
            ) {
              event.preventDefault();
              onAdvance();
            }
          }}
          className="pointer-events-none absolute inset-0 flex items-center justify-center outline-none"
        >
          {value ? <Check aria-hidden="true" className="size-4 text-white" /> : null}
        </span>
      ) : /* Toca para editar: el input vive encima del propio campo, como un hueco de Adobe Acrobat. */
      editing ? (
        <>
          <input
            type={type === "date" ? "date" : "text"}
            aria-label={label}
            value={value}
            placeholder={
              type === "initials"
                ? strings.initialsFieldPlaceholder
                : strings.textFieldPlaceholder
            }
            maxLength={type === "initials" ? 4 : undefined}
            autoFocus
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const next =
                type === "initials"
                  ? event.target.value.toUpperCase()
                  : event.target.value;
              onValueChange(next);
              setHighlightedIndex(-1);
              setSuggestionsDismissed(false);
            }}
            onBlur={commitAndClose}
            onKeyDown={(event) => {
              if (suggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlightedIndex((index) =>
                    Math.min(index + 1, suggestions.length - 1),
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlightedIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Enter" && highlightedIndex >= 0) {
                  event.preventDefault();
                  onValueChange(suggestions[highlightedIndex]);
                  setSuggestionsDismissed(true);
                  return;
                }
                if (event.key === "Escape") {
                  setSuggestionsDismissed(true);
                  return;
                }
              }

              // Navegacion por teclado (si esta activa en Ajustes): Tab o
              // Enter confirma el valor y salta al siguiente campo vacio,
              // sin soltar el lienzo.
              if (
                onAdvance &&
                (event.key === "Enter" ||
                  (event.key === "Tab" && !event.shiftKey))
              ) {
                event.preventDefault();
                if (historyKey) recordValue(historyKey, value);
                setSuggestionsDismissed(true);
                onAdvance();
              }
            }}
            className="absolute inset-0 h-full w-full rounded-[3px] border-0 bg-white/95 px-1.5 text-xs text-black outline-none ring-2 ring-signal"
          />
          {/* Fecha/inicial no tienen historial de sugerencias (`historyKey` llega null desde el padre): la lista siempre esta vacia y este componente no pinta nada. */}
          <ValueSuggestions
            id={`${field.id}-suggestions`}
            suggestions={suggestions}
            highlightedIndex={highlightedIndex}
            placement={field.rect.y > 0.5 ? "top" : "bottom"}
            onPick={(picked) => {
              onValueChange(picked);
              setSuggestionsDismissed(true);
            }}
            onForget={(forgotten) => {
              if (historyKey) forgetValue(historyKey, forgotten);
            }}
            strings={strings}
          />
        </>
      ) : value ? (
        <span className="pointer-events-none absolute inset-0 flex items-center truncate px-1.5 text-xs text-white">
          {value}
        </span>
      ) : null}
    </div>
  );
}
