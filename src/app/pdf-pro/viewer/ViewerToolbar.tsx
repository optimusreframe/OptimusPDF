"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, Maximize2, Minus, PanelLeft, PanelRight, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProViewer } from "@/app/pdf-pro/viewer/ProViewerContext";
import { zoomPercent } from "@/app/pdf-pro/viewer/viewerLayout";
import { VIEWER_MAX_ZOOM, VIEWER_MIN_ZOOM } from "@/app/pdf-pro/viewer/viewerTypes";

/** Boton de icono de 44 px (relleno visible de 32 px), como los de la barra del documento. */
export function ToolbarIconButton({
  label,
  onClick,
  disabled = false,
  pressed,
  expanded,
  controls,
  haspopup,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  haspopup?: "dialog";
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // `aria-disabled` (no `disabled`): un boton que se desactiva con el foco puesto lo dejaria caer a <body>.
      aria-disabled={disabled || undefined}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={haspopup}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cn(
        "group flex size-11 shrink-0 items-center justify-center rounded-full",
        "focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
        disabled && "opacity-40",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-full text-foreground",
          "transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          pressed && "bg-white/10",
          !disabled && "group-hover:bg-white/10 group-active:scale-90 group-active:duration-[80ms]",
          "forced-colors:border forced-colors:border-[ButtonText]",
          pressed && "forced-colors:border-2 forced-colors:border-[Highlight]",
        )}
      >
        {children}
      </span>
    </button>
  );
}

export type ViewerToolbarProps = {
  /** Miniaturas: en escritorio colapsa el panel; en movil abre la hoja. */
  thumbsOpen: boolean;
  thumbsControls?: string;
  onToggleThumbs: () => void;
  /** En movil el boton abre una hoja (`aria-haspopup`). */
  thumbsAsSheet: boolean;
  /** Panel contextual (solo escritorio). */
  contextOpen?: boolean;
  contextControls?: string;
  onToggleContext?: () => void;
};

/**
 * Barra del visor (Wave 7 · U3): miniaturas, «Pagina X de N» con salto por numero, zoom (− % + y ajustar al
 * ancho) y la seleccion de paginas. Todo con objetivos de 44 px y sin depender del raton.
 */
export function ViewerToolbar({
  thumbsOpen,
  thumbsControls,
  onToggleThumbs,
  thumbsAsSheet,
  contextOpen,
  contextControls,
  onToggleContext,
}: ViewerToolbarProps) {
  const { language } = useI18n();
  const s = getProStrings(language).viewer;
  const { api, state } = useProViewer();
  const { currentPage, pageCount, zoom, fitWidth, selectedPages } = state;
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const percent = zoomPercent(zoom);

  // El borrador solo vive mientras el campo tiene el foco (se descarta al salir, confirmar o pulsar Esc): que el
  // visor siga desplazandose (inercia de la rueda) no debe borrar lo que el usuario esta escribiendo.

  const commit = () => {
    const raw = (draft ?? "").trim();
    setDraft(null);
    if (raw === "") return;
    const number = Number.parseInt(raw, 10);
    if (!Number.isFinite(number)) return;
    api.scrollToPage(Math.min(pageCount, Math.max(1, number)) - 1, { behavior: "auto" });
  };

  const disabled = pageCount === 0;
  return (
    <div
      role="toolbar"
      aria-label={s.toolbarLabel}
      data-pro-viewer-toolbar=""
      className="flex shrink-0 flex-wrap items-center gap-x-1 border-b border-hairline px-2"
    >
      <ToolbarIconButton
        label={thumbsOpen && !thumbsAsSheet ? s.hideThumbs : thumbsAsSheet ? s.openThumbs : s.showThumbs}
        onClick={onToggleThumbs}
        expanded={thumbsAsSheet ? undefined : thumbsOpen}
        haspopup={thumbsAsSheet ? "dialog" : undefined}
        controls={thumbsAsSheet ? undefined : thumbsControls}
        disabled={disabled}
      >
        <PanelLeft aria-hidden="true" className="size-[18px]" />
      </ToolbarIconButton>

      <div className="flex items-center gap-1.5 px-1">
        <label htmlFor="pro-page-input" className="sr-only">
          {s.pageInputLabel}
        </label>
        <input
          id="pro-page-input"
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="go"
          aria-disabled={disabled || undefined}
          readOnly={disabled}
          value={draft ?? (pageCount === 0 ? "" : String(currentPage + 1))}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 7))}
          onFocus={(event) => event.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && draft !== null) {
              event.preventDefault();
              event.stopPropagation();
              setDraft(null);
            }
          }}
          className="h-11 w-14 rounded-ios-sm border border-hairline bg-white/5 px-2 text-center text-subheadline tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        <span className="text-subheadline whitespace-nowrap text-muted-foreground tabular-nums">
          {s.pageTotal(pageCount)}
        </span>
      </div>

      <div role="group" aria-label={s.zoomGroup} className="flex items-center">
        <ToolbarIconButton
          label={s.zoomOut}
          onClick={() => api.zoomOut()}
          disabled={disabled || zoom <= VIEWER_MIN_ZOOM + 0.001}
        >
          <Minus aria-hidden="true" className="size-[18px]" />
        </ToolbarIconButton>
        <span
          data-pro-zoom-value=""
          className="hidden min-w-12 text-center text-subheadline tabular-nums text-muted-foreground sm:inline-block"
          title={s.zoomLevel(percent)}
        >
          {percent} %
        </span>
        <ToolbarIconButton
          label={s.zoomIn}
          onClick={() => api.zoomIn()}
          disabled={disabled || zoom >= VIEWER_MAX_ZOOM - 0.001}
        >
          <Plus aria-hidden="true" className="size-[18px]" />
        </ToolbarIconButton>
        <ToolbarIconButton label={s.fitWidth} onClick={() => api.fitWidth()} pressed={fitWidth} disabled={disabled}>
          <Maximize2 aria-hidden="true" className="size-[18px]" />
        </ToolbarIconButton>
      </div>

      {selectedPages.size > 0 ? (
        <div className="flex items-center gap-0.5 pl-1">
          {/* Chip compacto (en un visor estrecho el texto largo hacia saltar la barra a dos filas); el texto completo es para lectores. */}
          <span
            aria-hidden="true"
            title={s.selectedCount(selectedPages.size)}
            className="inline-flex items-center gap-1 rounded-full bg-signal/15 px-2.5 py-1 text-footnote font-semibold text-foreground tabular-nums forced-colors:border forced-colors:border-[Highlight]"
          >
            <Check className="size-3" />
            {selectedPages.size}
          </span>
          <span className="sr-only" data-pro-selection-count="">
            {s.selectedCount(selectedPages.size)}
          </span>
          <ToolbarIconButton label={s.clearSelection} onClick={() => api.clearSelection()}>
            <X aria-hidden="true" className="size-4" />
          </ToolbarIconButton>
        </div>
      ) : null}

      {onToggleContext ? (
        <ToolbarIconButton
          label={contextOpen ? s.hidePanel : s.showPanel}
          onClick={onToggleContext}
          expanded={contextOpen}
          controls={contextControls}
          className="ml-auto max-md:hidden"
        >
          <PanelRight aria-hidden="true" className="size-[18px]" />
        </ToolbarIconButton>
      ) : null}
    </div>
  );
}
