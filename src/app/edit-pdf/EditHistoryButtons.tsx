"use client";

import { Redo2, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";

/*
 * Deshacer y rehacer del editor como botones de 44 px de la BARRA del modo de PDF Pro en movil (M6 · a): antes solo existian
 * dentro de la bandeja de herramientas, que tapa la hoja. Mismo aspecto que los botones de icono de la cabecera (relleno
 * visible de 32 px dentro de un area tactil de 44), `aria-disabled` (no `disabled`) para no soltar el foco al agotar el historial.
 */

type HistoryButtonProps = {
  id: "undo" | "redo";
  label: string;
  shortcuts: string;
  shortcutLabel: string;
  disabled: boolean;
  onClick: () => void;
};

function HistoryButton({ id, label, shortcuts, shortcutLabel, disabled, onClick }: HistoryButtonProps) {
  const Icon = id === "undo" ? Undo2 : Redo2;
  return (
    <button
      type="button"
      data-history-button={id}
      aria-label={label}
      title={`${label} (${shortcutLabel})`}
      aria-keyshortcuts={shortcuts}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className={cn(
        "group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cn(
          "flex size-8 items-center justify-center rounded-full text-foreground transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] forced-colors:border forced-colors:border-[ButtonText]",
          !disabled && "group-active:scale-90 group-active:duration-[80ms]",
        )}
      >
        <Icon aria-hidden="true" className="size-[18px]" />
      </span>
    </button>
  );
}

export function EditHistoryButtons({
  undoLabel,
  redoLabel,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  undoLabel: string;
  redoLabel: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <>
      <HistoryButton id="undo" label={undoLabel} shortcuts="Control+Z Meta+Z" shortcutLabel="Ctrl+Z" disabled={!canUndo} onClick={onUndo} />
      <HistoryButton
        id="redo"
        label={redoLabel}
        shortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        shortcutLabel="Ctrl+Shift+Z"
        disabled={!canRedo}
        onClick={onRedo}
      />
    </>
  );
}
