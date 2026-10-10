"use client";

import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, GalleryHorizontal, Layers, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { EditInlineStrings, EditStrings } from "@/app/edit-pdf/strings";

/*
 * Barra pegajosa de zoom y paginas del editor inline (W5-U4a/b): zoom (botones),
 * paginador con «ir a la pagina N» y el interruptor de la tira de miniaturas.
 * Va siempre a la vista (`data-canvas-sticky`: la barra flotante de los
 * elementos la respeta), con objetivos de 44 px reales con puntero grueso.
 */

export const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3] as const;
const COARSE_TALL = "pointer-coarse:h-11 pointer-coarse:before:hidden";

/**
 * Boton de la barra de zoom y paginas. Agotado, usa `aria-disabled` y NO
 * `disabled`: pulsar «Pagina siguiente» en la penultima pagina dejaria un boton
 * deshabilitado con el foco, que cae a <body>.
 */
export function NavButton({
  disabled,
  onClick,
  ...rest
}: {
  disabled: boolean;
  onClick: () => void;
  "aria-label": string;
  "aria-keyshortcuts"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
  title?: string;
  "data-flatten-toggle"?: string;
  "data-flattened"?: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-disabled={disabled || undefined}
      className={cn(COARSE_TALL, disabled && "opacity-50")}
      onClick={() => {
        if (!disabled) onClick();
      }}
      {...rest}
    />
  );
}

export type EditNavBarProps = {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  pageIndex: number;
  pageCount: number;
  onGoTo: (index: number) => void;
  stripOpen: boolean;
  onToggleStrip: () => void;
  stripId: string;
  strings: EditStrings;
  s: EditInlineStrings;
  /** Pista de la herramienta armada: cuelga de la barra (no empuja la pagina al aparecer). */
  hint?: ReactNode;
  /**
   * (W5-U5) «Aplanar pagina» de la pagina visible: boton de la barra en pantallas
   * anchas (con texto). En movil la barra sigue siendo de UNA fila (no cabe otro
   * boton de 44 px) y la accion vive en una fila propia bajo ella (`EditWorkspace`).
   * `active` = la pagina ya esta marcada y el boton la desmarca.
   */
  flatten?: { label: string; active: boolean; onClick: () => void };
};

export function EditNavBar({
  zoom,
  onZoomIn,
  onZoomOut,
  pageIndex,
  pageCount,
  onGoTo,
  stripOpen,
  onToggleStrip,
  stripId,
  strings,
  s,
  hint,
  flatten,
}: EditNavBarProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const total = Math.max(1, pageCount);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number.parseInt(draft.trim(), 10);
    setDraft(null);
    if (Number.isFinite(parsed)) onGoTo(Math.min(total, Math.max(1, parsed)) - 1);
  };

  return (
    <div
      data-canvas-sticky=""
      className="material-thick shadow-elevation-2 rounded-ios sticky top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] z-30 flex flex-wrap items-center justify-between gap-y-1 p-1 md:top-[calc(4rem+env(safe-area-inset-top,0px)+0.5rem)] lg:top-3"
    >
      <div role="group" aria-label={s.zoomGroupLabel} className="flex items-center gap-0.5 pointer-coarse:gap-0">
        <NavButton
          aria-label={s.zoomOut}
          aria-keyshortcuts="-"
          title={s.zoomOut}
          disabled={zoom <= 1.01}
          onClick={onZoomOut}
        >
          <ZoomOut aria-hidden="true" className="size-4" />
        </NavButton>
        <span className="min-w-10 text-center text-footnote font-medium text-foreground tabular-nums">
          {s.zoomValue(Math.round(zoom * 100))}
        </span>
        <NavButton
          aria-label={s.zoomIn}
          aria-keyshortcuts="+"
          title={s.zoomIn}
          disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.01}
          onClick={onZoomIn}
        >
          <ZoomIn aria-hidden="true" className="size-4" />
        </NavButton>
      </div>
      <div className="flex items-center gap-0.5 pointer-coarse:gap-0">
        <NavButton
          aria-label={strings.previousPage}
          aria-keyshortcuts="["
          disabled={pageIndex === 0}
          onClick={() => onGoTo(pageIndex - 1)}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </NavButton>
        {/* El texto completo para lectores de pantalla; a la vista, «n / total» con el numero editable. */}
        <span className="sr-only">{strings.pageOf(pageIndex + 1, total)}</span>
        <span className="flex items-center gap-0.5 pointer-coarse:gap-0 text-footnote font-medium text-foreground tabular-nums">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            aria-label={s.goToPageLabel}
            data-go-to-page=""
            value={draft ?? String(pageIndex + 1)}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                setDraft(null);
              }
            }}
            className={cn(
              "h-9 rounded-ios-sm bg-white/6 text-center text-foreground tabular-nums pointer-coarse:h-11 pointer-coarse:min-w-11",
              total >= 1000 ? "w-14" : total >= 100 ? "w-10" : "w-9",
              "focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
            )}
          />
          <span aria-hidden="true" className="text-muted-foreground">
            {s.pageTotal(total)}
          </span>
        </span>
        <NavButton
          aria-label={strings.nextPage}
          aria-keyshortcuts="]"
          disabled={pageCount === 0 || pageIndex >= pageCount - 1}
          onClick={() => onGoTo(pageIndex + 1)}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </NavButton>
        {flatten ? (
          <span className="max-md:hidden">
            <NavButton
              aria-label={flatten.label}
              title={flatten.label}
              data-flatten-toggle=""
              data-flattened={flatten.active ? "" : undefined}
              disabled={false}
              onClick={flatten.onClick}
            >
              <Layers aria-hidden="true" className={cn("size-4", flatten.active && "text-signal-text")} />
              <span aria-hidden="true" className="text-footnote">
                {flatten.label}
              </span>
            </NavButton>
          </span>
        ) : null}
        {pageCount > 1 ? (
          <NavButton
            aria-label={s.thumbsLabel}
            aria-expanded={stripOpen}
            aria-controls={stripId}
            title={stripOpen ? s.thumbsHide : s.thumbsShow}
            disabled={false}
            onClick={onToggleStrip}
          >
            <GalleryHorizontal aria-hidden="true" className={cn("size-4", stripOpen && "text-signal-text")} />
          </NavButton>
        ) : null}
      </div>
      {hint}
    </div>
  );
}
