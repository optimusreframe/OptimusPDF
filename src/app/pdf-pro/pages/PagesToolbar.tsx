"use client";

import type { ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Ellipsis,
  FileInput,
  FileOutput,
  FilePlus2,
  ImagePlus,
  Merge,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { PagesStrings } from "@/app/pdf-pro/pages/pagesStrings";

/**
 * Barras de herramientas del organizador de paginas (Wave 7 · U4). Solo presentacion: reciben
 * que esta activo y devuelven la accion pedida.
 *
 * Todos los botones usan `aria-disabled` (no el atributo `disabled`): un boton que se desactiva
 * justo despues de pulsarlo (eliminar la ultima seleccion, aplicar) no puede soltar el foco al
 * <body>. La accion se ignora mientras esta desactivado.
 */

export type ActionButtonProps = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  /** Solo icono (la etiqueta pasa a `aria-label`). */
  iconOnly?: boolean;
  size?: "sm" | "md";
  className?: string;
  pressed?: boolean;
  testId?: string;
  describedBy?: string;
  /** Texto corto que se VE (el nombre accesible sigue siendo `label`, que lo contiene): para filas estrechas. */
  shortLabel?: string;
};

export function ActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  variant = "secondary",
  iconOnly = false,
  size = "sm",
  className,
  testId,
  describedBy,
  shortLabel,
}: ActionButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      aria-label={iconOnly || shortLabel ? label : undefined}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      title={iconOnly ? label : undefined}
      data-action={testId}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cn(
        // `!` (importante): `cn` no fusiona clases y el relleno del tamano del boton ganaria al de solo icono.
        iconOnly && "px-0! gap-0!",
        iconOnly && (size === "md" ? "w-11!" : "w-9! pointer-coarse:h-11! pointer-coarse:w-11!"),
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 forced-colors:aria-disabled:border-[GrayText] forced-colors:aria-disabled:text-[GrayText] forced-colors:aria-disabled:opacity-100",
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {iconOnly ? null : (shortLabel ?? label)}
    </Button>
  );
}

export type PagesToolbarModel = {
  strings: PagesStrings;
  total: number;
  selectionCount: number;
  changeCount: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  /** Hay documentos sumados que aun se estan leyendo (no se puede aplicar). */
  blocked: boolean;
  canRemove: boolean;
};

export type PagesToolbarHandlers = {
  onUndo: () => void;
  onRedo: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onSelectEven: () => void;
  onSelectOdd: () => void;
  onSelectRange: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMoveBefore: () => void;
  onMoveAfter: () => void;
  onInsertBlank: () => void;
  onInsertPdf: () => void;
  onInsertImages: () => void;
  onMerge: () => void;
  onExtract: () => void;
  onSplit: () => void;
  onMore: () => void;
};

/**
 * «Descartar» (solo con cambios) y «Aplicar cambios». En la barra inferior del movil (`compact`) llevan texto corto («Aplicar»,
 * «Descartar») y nombre accesible completo: caben en una fila con el recuento de seleccion.
 */
function PagesApplyButtons({
  model,
  handlers,
  compact,
  className,
}: {
  model: PagesToolbarModel;
  handlers: PagesToolbarHandlers;
  compact: boolean;
  className?: string;
}) {
  const { strings: s, dirty, busy, blocked } = model;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {dirty ? (
        <ActionButton
          label={s.status.discard}
          shortLabel={compact ? s.status.discardShort : undefined}
          disabled={busy}
          onClick={handlers.onDiscard}
          variant="ghost"
          size={compact ? "md" : "sm"}
          testId="discard"
        />
      ) : null}
      <ActionButton
        label={busy ? s.status.applying : s.status.apply}
        shortLabel={compact ? (busy ? s.status.applying : s.status.applyShort) : undefined}
        variant="primary"
        size={compact ? "md" : "sm"}
        disabled={!dirty || busy || blocked}
        onClick={handlers.onApply}
        testId="apply"
      />
    </div>
  );
}

/** Fila de estado: chip de cambios, deshacer/rehacer y Aplicar/Descartar. */
export function PagesStatusBar({
  model,
  handlers,
  compact,
}: {
  model: PagesToolbarModel;
  handlers: PagesToolbarHandlers;
  compact: boolean;
}) {
  const { strings: s, dirty, changeCount, canUndo, canRedo, busy } = model;
  return (
    <div
      role="group"
      aria-label={s.status.changes(changeCount)}
      data-pages-status=""
      className={cn(
        "flex items-center gap-x-2 gap-y-2",
        // Compacta (movil): UNA fila con el estado y deshacer/rehacer; «Aplicar» y «Descartar» viven abajo, al alcance del pulgar.
        compact ? "px-3 py-1.5" : "flex-wrap px-4 py-3",
      )}
    >
      <span
        data-pages-chip=""
        className={cn(
          "inline-flex h-7 items-center rounded-full px-3 text-footnote font-semibold",
          dirty
            ? "bg-signal/15 text-foreground ring-1 ring-signal/40 forced-colors:border forced-colors:border-[Highlight]"
            : "text-muted-foreground",
        )}
      >
        {dirty ? s.status.changes(changeCount) : s.status.noChanges}
      </span>
      <div className="flex items-center gap-1 pointer-coarse:gap-2">
        <ActionButton
          iconOnly
          size="sm"
          label={s.status.undo}
          icon={<Undo2 />}
          disabled={!canUndo || busy}
          onClick={handlers.onUndo}
          testId="undo"
        />
        <ActionButton
          iconOnly
          size="sm"
          label={s.status.redo}
          icon={<Redo2 />}
          disabled={!canRedo || busy}
          onClick={handlers.onRedo}
          testId="redo"
        />
      </div>
      {compact ? null : <PagesApplyButtons model={model} handlers={handlers} compact={false} className="ml-auto max-w-full flex-wrap justify-end" />}
    </div>
  );
}

/** Barra completa (panel ancho): seleccion, paginas, insertar y sacar. */
export function PagesActionBar({ model, handlers }: { model: PagesToolbarModel; handlers: PagesToolbarHandlers }) {
  const { strings: s, selectionCount, total, canRemove, busy } = model;
  // Mientras se aplica, el plan no se toca: lo que se editara quedaria fuera del resultado.
  const none = selectionCount === 0 || busy;
  return (
    <div role="group" aria-label={s.actions.moreTitle} data-pages-toolbar="" className="space-y-2 px-4 pb-3">
      <div role="group" aria-label={s.actions.groupSelection} className="flex flex-wrap items-center gap-1.5">
        <span className="ui-label mr-1 text-muted-foreground">{s.actions.select}</span>
        <ActionButton label={s.actions.selectAll} onClick={handlers.onSelectAll} testId="select-all" />
        <ActionButton label={s.actions.selectOdd} onClick={handlers.onSelectOdd} testId="select-odd" />
        <ActionButton label={s.actions.selectEven} onClick={handlers.onSelectEven} testId="select-even" />
        <ActionButton label={s.actions.selectRange} onClick={handlers.onSelectRange} testId="select-range" />
        <ActionButton label={s.actions.selectNone} onClick={handlers.onSelectNone} disabled={none} testId="select-none" />
        <span data-pages-selection="" className="ml-auto text-footnote text-muted-foreground tabular-nums">
          {selectionCount === 0 ? s.status.none : s.status.selected(selectionCount, total)}
        </span>
      </div>
      <div role="group" aria-label={s.actions.groupPages} className="flex flex-wrap items-center gap-1.5">
        <ActionButton label={s.actions.rotateLeft} icon={<RotateCcw />} onClick={handlers.onRotateLeft} disabled={none} testId="rotate-left" />
        <ActionButton label={s.actions.rotateRight} icon={<RotateCw />} onClick={handlers.onRotateRight} disabled={none} testId="rotate-right" />
        <ActionButton label={s.actions.remove} icon={<Trash2 />} onClick={handlers.onRemove} disabled={none || !canRemove} testId="remove" />
        <ActionButton label={s.actions.duplicate} icon={<Copy />} onClick={handlers.onDuplicate} disabled={none} testId="duplicate" />
        <ActionButton label={s.actions.moveBefore} icon={<ArrowLeft />} onClick={handlers.onMoveBefore} disabled={none} testId="move-before" />
        <ActionButton label={s.actions.moveAfter} icon={<ArrowRight />} onClick={handlers.onMoveAfter} disabled={none} testId="move-after" />
      </div>
      <div role="group" aria-label={s.actions.groupInsert} className="flex flex-wrap items-center gap-1.5">
        <ActionButton label={s.actions.insertBlank} icon={<FilePlus2 />} onClick={handlers.onInsertBlank} testId="insert-blank" />
        <ActionButton label={s.actions.insertFromPdf} icon={<FileInput />} onClick={handlers.onInsertPdf} testId="insert-pdf" />
        <ActionButton label={s.actions.insertImages} icon={<ImagePlus />} onClick={handlers.onInsertImages} testId="insert-images" />
        <ActionButton label={s.actions.mergePdfs} icon={<Merge />} onClick={handlers.onMerge} testId="merge" />
      </div>
      <div role="group" aria-label={s.actions.groupExport} className="flex flex-wrap items-center gap-1.5">
        <ActionButton label={s.actions.extract} icon={<FileOutput />} onClick={handlers.onExtract} disabled={none} testId="extract" />
        <ActionButton label={s.actions.split} icon={<Scissors />} onClick={handlers.onSplit} testId="split" />
      </div>
    </div>
  );
}

/** Barra inferior compacta (telefono / panel estrecho): lo mas usado a un toque y «Más». */
export function PagesCompactBar({ model, handlers }: { model: PagesToolbarModel; handlers: PagesToolbarHandlers }) {
  const { strings: s, selectionCount, total, canRemove, busy } = model;
  const none = selectionCount === 0 || busy;
  return (
    <div
      role="group"
      aria-label={s.actions.moreTitle}
      data-pages-toolbar=""
      data-compact=""
      className="shrink-0 border-t border-hairline bg-background/80 px-2 pt-1.5 pb-2 backdrop-blur"
    >
      {/* Fila 1: el recuento y «Aplicar» (con «Descartar» si hay cambios) al alcance del pulgar (M2 · ER-02, GE-05). */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pb-1.5 pl-1">
        <p data-pages-selection="" className="min-w-0 flex-1 basis-32 text-caption text-muted-foreground tabular-nums">
          {selectionCount === 0 ? s.status.none : s.status.selected(selectionCount, total)}
        </p>
        <PagesApplyButtons model={model} handlers={handlers} compact />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1.5 pointer-coarse:gap-2">
        <ActionButton iconOnly size="sm" label={s.actions.rotateLeft} icon={<RotateCcw />} onClick={handlers.onRotateLeft} disabled={none} testId="rotate-left" />
        <ActionButton iconOnly size="sm" label={s.actions.rotateRight} icon={<RotateCw />} onClick={handlers.onRotateRight} disabled={none} testId="rotate-right" />
        <ActionButton iconOnly size="sm" label={s.actions.remove} icon={<Trash2 />} onClick={handlers.onRemove} disabled={none || !canRemove} testId="remove" />
        <ActionButton iconOnly size="sm" label={s.actions.duplicate} icon={<Copy />} onClick={handlers.onDuplicate} disabled={none} testId="duplicate" />
        <ActionButton iconOnly size="sm" label={s.actions.moveBefore} icon={<ArrowLeft />} onClick={handlers.onMoveBefore} disabled={none} testId="move-before" />
        <ActionButton iconOnly size="sm" label={s.actions.moveAfter} icon={<ArrowRight />} onClick={handlers.onMoveAfter} disabled={none} testId="move-after" />
        <ActionButton
          iconOnly
          size="sm"
          label={s.actions.more}
          icon={<Ellipsis />}
          onClick={handlers.onMore}
          testId="more"
        />
      </div>
    </div>
  );
}
