"use client";

import type { ReactNode, Ref } from "react";
import { ChevronDown, Download, Layers, Redo2, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { MoreMenu, type MoreMenuItem } from "@/app/pdf-pro/shell/MoreMenu";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import type { Language } from "@/lib/i18n";

export type ProTopBarProps = {
  language: Language;
  name: string;
  pageCount: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDownload: () => void;
  onClose: () => void;
  /** Opciones del menu «Mas» (paleta, exportar, atajos, paneles...). */
  moreItems?: readonly MoreMenuItem[];
  /** Opciones del menu «Guardar y exportar» (descargar, guardar como, con contraseña, exportar). */
  saveItems?: readonly MoreMenuItem[];
  /** Sube cada vez que un atajo pide abrir el menu «Guardar y exportar». */
  saveMenuSignal?: number;
  /** Igual para el menu «Mas» (en pantallas estrechas el atajo de guardar abre este). */
  moreMenuSignal?: number;
  headingRef?: Ref<HTMLHeadingElement>;
  /**
   * Indicador de estado global junto a «Descargar» (Wave 9: la exportacion en curso). Pinta `null` en reposo; mientras
   * pinta algo (`data-export-indicator`), la barra se parte en dos filas para darle su propia linea.
   */
  status?: ReactNode;
  /**
   * Barra COMPACTA (movil con un modo abierto, o movil horizontal): una sola fila de 48 px para que la hoja conserve
   * sitio, con el estado «sin cambios» reducido a un punto (el texto sigue ahi para lectores de pantalla).
   */
  compact?: boolean;
  /**
   * Hueco para la barra del modo cuando no hay alto para una fila propia (movil horizontal): `ProModeHost` pinta
   * ahi «Descartar» y «Aplicar», junto a «Descargar» y «Mas».
   */
  modeSlotRef?: (element: HTMLDivElement | null) => void;
  /**
   * (M5 · N1) Con un modo abierto en un movil el deshacer/rehacer GLOBAL esta apagado (el modo trae el suyo en la paleta): sus
   * dos botones de 44 px se retiran y dejan sitio a «Aplicar» y al titulo en vez de quedar como dos botones muertos.
   */
  hideHistory?: boolean;
};

/** Boton de icono de 44 px (patron del Sidebar): el relleno visible es de 32 px. */
function BarIconButton({
  label,
  shortcut,
  disabled = false,
  onClick,
  children,
  className,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // `aria-disabled` (no `disabled`): un boton que se desactiva con el foco puesto lo dejaria caer a <body>.
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={shortcut}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cn(
        "group flex size-11 shrink-0 items-center justify-center rounded-full",
        "focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal",
        disabled && "opacity-40",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-full text-foreground",
          "transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          !disabled && "group-hover:bg-white/10 group-active:scale-90 group-active:duration-[80ms]",
        )}
      >
        {children}
      </span>
    </button>
  );
}

/** Barra superior del documento: nombre, estado, deshacer/rehacer, descargar y cerrar. */
export function ProTopBar({
  language,
  name,
  pageCount,
  dirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDownload,
  onClose,
  moreItems,
  saveItems,
  saveMenuSignal,
  moreMenuSignal,
  headingRef,
  status,
  compact = false,
  modeSlotRef,
  hideHistory = false,
}: ProTopBarProps) {
  const strings = getProStrings(language);
  const s = strings.suite;
  return (
    <div
      role="group"
      data-pro-region="top"
      aria-label={s.topBarLabel}
      data-compact={compact ? "" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-hairline px-3 max-[360px]:gap-1 md:px-4",
        compact ? "min-h-12" : "min-h-14",
        // Con `viewport-fit=cover` un iPhone horizontal tapa los bordes con la isla y las esquinas: la barra respeta la zona segura.
        "pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))]",
        // Con un indicador a la vista el indicador baja a su propia fila: la barra se parte en dos mientras dura.
        "has-[[data-export-indicator]]:flex-wrap has-[[data-export-indicator]]:py-1",
      )}
    >
      <Layers aria-hidden="true" className={cn("hidden size-5 shrink-0 text-accent-pro", compact ? "min-[900px]:block" : "sm:block")} />
      <div className={cn("flex-1", modeSlotRef ? "min-w-[4.5rem]" : "min-w-0")}>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-headline text-foreground outline-none"
          title={name}
        >
          <span className="sr-only">{s.regionLabel}: </span>
          {name}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
          <span>{s.pageCount(pageCount)}</span>
          {compact ? (
            <>
              {/* Compacta: un punto si hay cambios (la fila no se parte en dos); el texto completo sigue para lectores. */}
              <span
                aria-hidden="true"
                className={dirty ? "size-2 shrink-0 rounded-full bg-signal forced-colors:bg-[Highlight]" : "hidden"}
              />
              <span className="sr-only">{dirty ? s.unsaved : s.saved}</span>
            </>
          ) : (
            <Badge variant={dirty ? "signal" : "neutral"}>{dirty ? s.unsaved : s.saved}</Badge>
          )}
        </p>
      </div>
      {hideHistory ? null : (
        <>
          <BarIconButton label={s.undo} shortcut="Control+Z Meta+Z" disabled={!canUndo} onClick={onUndo}>
            <Undo2 aria-hidden="true" className="size-[18px]" />
          </BarIconButton>
          <BarIconButton label={s.redo} shortcut="Control+Shift+Z Meta+Shift+Z Control+Y" disabled={!canRedo} onClick={onRedo}>
            <Redo2 aria-hidden="true" className="size-[18px]" />
          </BarIconButton>
        </>
      )}
      {status}
      {modeSlotRef ? <div ref={modeSlotRef} data-pro-mode-slot="" className="contents" /> : null}
      <Button size="md" onClick={onDownload} className="shrink-0">
        <Download aria-hidden="true" className="size-4" />
        <span className={compact ? "sr-only" : "max-sm:sr-only"}>{s.download}</span>
      </Button>
      {saveItems ? (
        <MoreMenu
          label={strings.save.menuLabel}
          items={saveItems}
          icon={ChevronDown}
          menuId="save"
          hiddenBelow="sm"
          openSignal={saveMenuSignal}
        />
      ) : null}
      {moreItems ? <MoreMenu label={strings.shell.more} items={moreItems} menuId="more" openSignal={moreMenuSignal} /> : null}
      {/* En movil «Cerrar documento» vive en el menu «Mas» (no caben cinco botones de 44 px junto al nombre). */}
      <BarIconButton label={s.close} onClick={onClose} className="max-sm:hidden">
        <X aria-hidden="true" className="size-[18px]" />
      </BarIconButton>
    </div>
  );
}
