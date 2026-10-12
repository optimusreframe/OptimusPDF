"use client";

import type { Ref } from "react";
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
}: ProTopBarProps) {
  const strings = getProStrings(language);
  const s = strings.suite;
  return (
    <div
      role="group"
      data-pro-region="top"
      aria-label={s.topBarLabel}
      className="flex min-h-14 shrink-0 items-center gap-2 border-b border-hairline px-3 md:px-4"
    >
      <Layers aria-hidden="true" className="hidden size-5 shrink-0 text-accent-pro sm:block" />
      <div className="min-w-0 flex-1">
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
          <Badge variant={dirty ? "signal" : "neutral"}>{dirty ? s.unsaved : s.saved}</Badge>
        </p>
      </div>
      <BarIconButton label={s.undo} shortcut="Control+Z Meta+Z" disabled={!canUndo} onClick={onUndo}>
        <Undo2 aria-hidden="true" className="size-[18px]" />
      </BarIconButton>
      <BarIconButton label={s.redo} shortcut="Control+Shift+Z Meta+Shift+Z Control+Y" disabled={!canRedo} onClick={onRedo}>
        <Redo2 aria-hidden="true" className="size-[18px]" />
      </BarIconButton>
      <Button size="md" onClick={onDownload} className="shrink-0">
        <Download aria-hidden="true" className="size-4" />
        <span className="max-sm:sr-only">{s.download}</span>
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
