"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, SquareDashed, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";

/**
 * Piezas compartidas por las herramientas de organizacion (WS-A):
 * carga de miniaturas, tarjeta de pagina y campos de formulario del
 * panel de opciones.
 *
 * Vive dentro de `app/organize-pdf/` porque es la herramienta canonica
 * de manipulacion de paginas; si otro workstream necesita estas piezas,
 * el sitio natural es promoverlas a `components/tool/`.
 */

const THUMB_WIDTH = 200;

/**
 * Identidad estable de un archivo. Sirve para saber si el plan guardado
 * en las opciones sigue describiendo el documento que hay cargado.
 */
export function fileKey(file: File | undefined): string {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : "";
}

export type PageThumbnails = {
  /** Numero de paginas del documento (0 mientras se abre). */
  pageCount: number;
  /** Data URL por numero de pagina 1-based. */
  thumbs: Record<number, string>;
  loading: boolean;
  /** Codigo de error del motor: PDF cifrado, dañado, etc. */
  error: PdfErrorCode | null;
};

/**
 * Rasteriza todas las paginas del archivo fuera de pantalla y las va
 * publicando segun se completan. Cancela limpiamente si el componente se
 * desmonta.
 *
 * El estado se reinicia remontando (patron "reset state with a key"):
 * quien use el hook debe montar su tablero con `key={fileKey(file)}`,
 * igual que hace `PageThumbnailGrid`. Asi ningun efecto tiene que
 * limpiar estado de forma sincrona.
 */
export function usePageThumbnails(file: File | undefined): PageThumbnails {
  const [state, setState] = useState<PageThumbnails>(() => ({
    pageCount: 0,
    thumbs: {},
    loading: Boolean(file),
    error: null,
  }));

  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await openPdfDocument(file);
        if (cancelled) return;

        const total = doc.numPages;
        setState((previous) => ({ ...previous, pageCount: total }));

        for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
          if (cancelled) break;
          const page = await doc.getPage(pageNumber);
          // `renderPageToDataUrl` usa intent "print": el rasterizado fuera
          // de pantalla no debe depender de que la pestaña este pintando.
          const url = await renderPageToDataUrl(page, {
            maxWidth: THUMB_WIDTH,
          });
          page.cleanup();
          if (cancelled) break;
          setState((previous) => ({
            ...previous,
            thumbs: { ...previous.thumbs, [pageNumber]: url },
          }));
        }

        if (!cancelled) {
          setState((previous) => ({ ...previous, loading: false }));
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            pageCount: 0,
            thumbs: {},
            loading: false,
            error: toPdfError(error).code,
          });
        }
      } finally {
        if (doc) void closePdfDocument(doc);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  return state;
}

/* ------------------------------------------------------------------ *
 * Tarjeta de pagina
 * ------------------------------------------------------------------ */

export type PageTileTone = "plain" | "selected" | "removed" | "muted";

const TONE_FRAME: Record<PageTileTone, string> = {
  plain: "border-white/10",
  selected: "border-signal/60 bg-signal/10",
  removed: "border-destructive/60 bg-destructive/12",
  muted: "border-white/10 opacity-45",
};

export type PageTileProps = {
  /** Numero mostrado bajo la miniatura. */
  number: number;
  /** Etiqueta accesible del area de la miniatura. */
  label: string;
  url?: string;
  /** Rotacion visual en grados (solo previsualizacion). */
  rotation?: number;
  tone?: PageTileTone;
  /**
   * Marca esta tarjeta como pagina en blanco (sin origen en el
   * documento): muestra un marcador fijo en vez de buscar `url` o caer
   * en el `<Spinner>` de "miniatura aun no lista".
   */
  blank?: boolean;
  /** Texto del marcador cuando `blank` es true. */
  blankLabel?: string;
  /** Estado del boton principal para lectores de pantalla. */
  pressed?: boolean;
  onSelect?: () => void;
  /** Marca en la esquina superior derecha. */
  badge?: "check" | "cross" | ReactNode;
  /** Controles que aparecen sobre la miniatura. */
  actions?: ReactNode;
  /**
   * Gap/padding mas ajustados en la pildora de `actions`, para tarjetas
   * con 5 controles en vez de 4 (ver `TileButton.compact`). Por defecto
   * `false`: cero cambio visual para los demas llamadores de `PageTile`.
   */
  compactActions?: boolean;
  /** Texto adicional junto al numero de pagina. */
  note?: string;
  className?: string;
};

export function PageTile({
  number,
  label,
  url,
  rotation = 0,
  tone = "plain",
  blank = false,
  blankLabel,
  pressed,
  onSelect,
  badge,
  actions,
  compactActions = false,
  note,
  className,
}: PageTileProps) {
  const thumbnail = (
    <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
      {blank ? (
        <span className="flex flex-col items-center gap-1.5 text-muted-foreground">
          <SquareDashed aria-hidden="true" className="size-6" />
          {blankLabel ? (
            <span className="text-caption-2">{blankLabel}</span>
          ) : null}
        </span>
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="max-h-full max-w-full object-contain transition-transform duration-300 ease-spring"
          style={{ transform: `rotate(${rotation}deg)` }}
        />
      ) : (
        <Spinner className="size-4" />
      )}
    </span>
  );

  return (
    <div
      className={cn(
        "glass rounded-ios-sm group/tile relative overflow-hidden border p-2 transition-all duration-200 ease-spring",
        TONE_FRAME[tone],
        className,
      )}
    >
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={pressed}
          aria-label={label}
          className="block w-full cursor-pointer"
        >
          {thumbnail}
        </button>
      ) : (
        thumbnail
      )}

      {badge ? (
        <span className="pointer-events-none absolute top-3 right-3">
          {badge === "check" ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-signal text-[var(--color-on-signal)]">
              <Check aria-hidden="true" className="size-3" />
            </span>
          ) : badge === "cross" ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-destructive text-[var(--color-on-signal)]">
              <X aria-hidden="true" className="size-3" />
            </span>
          ) : (
            badge
          )}
        </span>
      ) : null}

      {actions ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center opacity-100 transition-opacity duration-200 md:opacity-0 md:group-hover/tile:opacity-100 md:group-focus-within/tile:opacity-100">
          <div
            className={cn(
              "glass-bar pointer-events-auto flex items-center rounded-full border border-white/14 py-1",
              compactActions ? "gap-0.5 px-0.5" : "gap-1 px-1",
            )}
          >
            {actions}
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-1">
        <span className="text-caption text-muted-foreground tabular-nums">
          {number}
        </span>
        {note ? (
          <span className="text-caption text-signal-text">{note}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Boton circular pequeño para las acciones sobre la miniatura. */
export function TileButton({
  label,
  disabled,
  tone = "plain",
  compact = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  tone?: "plain" | "destructive";
  /**
   * `size-6` en vez de `size-7`. Necesario para tarjetas con 5 acciones
   * (organize-pdf, tras agregar "insertar blanco"): a `size-7` la pildora
   * mide 166px y se recorta contra el `overflow-hidden` de una tarjeta de
   * 165.5px en el viewport movil de referencia (375px) -- verificado en
   * navegador real, no solo calculado. Otros llamadores de `TileButton`
   * (extract-pages, remove-pages, rotate-pdf, split-pdf, sign-pdf) siguen
   * en `size-7` por defecto: sin este prop, cero cambio visual para ellos.
   */
  compact?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center rounded-full transition-colors",
        compact ? "size-6" : "size-7",
        tone === "destructive"
          ? "text-destructive-text hover:bg-destructive/20"
          : "text-muted-foreground hover:bg-white/14 hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Contenedor del tablero de paginas
 * ------------------------------------------------------------------ */

export function PageBoard({
  title,
  loading,
  errorText,
  toolbar,
  children,
}: {
  title: string;
  loading?: boolean;
  errorText?: string | null;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="ui-label text-muted-foreground">
            {title}
          </h3>
          {loading ? <Spinner className="size-4" /> : null}
        </div>
        {toolbar ? (
          <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
        ) : null}
      </div>

      {errorText ? (
        <p
          role="alert"
          className="rounded-ios-sm border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground"
        >
          {errorText}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {children}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Campos del panel de opciones
 * ------------------------------------------------------------------ */

const FIELD_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground " +
  "placeholder:text-muted-foreground/70 transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

export function NumberField({
  label,
  value,
  min = 1,
  max,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("min-w-0 flex-1", className)}>
      <label
        htmlFor={id}
        className="ui-label mb-2 block text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (Number.isNaN(next)) return;
          onChange(next);
        }}
        className={cn(FIELD_CLASS, "tabular-nums")}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  invalid,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div>
      <label
        htmlFor={id}
        className="ui-label mb-2 block text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD_CLASS, invalid && "border-destructive/60")}
      />
      {hint ? (
        <p
          id={hintId}
          className={cn(
            "mt-2 text-xs",
            invalid ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-signal"
      />
      <label htmlFor={id} className="cursor-pointer">
        <span className="block text-sm text-foreground">{label}</span>
        {description ? (
          <span className="mt-1 block text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </label>
    </div>
  );
}

export function FieldNote({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-xs leading-relaxed",
        tone === "warning" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
