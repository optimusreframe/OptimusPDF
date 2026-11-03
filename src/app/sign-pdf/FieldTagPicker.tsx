"use client";

import type { PointerEvent as ReactPointerEvent } from "react";
import { Plus, Tag, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useOptionalLanguage } from "@/lib/i18n";
import { chipTagsFor, tagLabel, type TaggableType } from "@/lib/fieldTags";
import { customTagNames, useValueHistoryVersion } from "@/lib/valueHistory";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

/**
 * Chips para ponerle ETIQUETA a un campo de texto con un toque (Dirección, Nombre, Teléfono, Correo, N.º de póliza,
 * N.º de reclamo, Aseguradora, Fecha de pérdida), mas las etiquetas propias de la persona y «Otra…» para crear una.
 * Si el rótulo del campo sugiere una etiqueta, esa va primero y preseleccionada.
 *
 * Es una fila de botones sin estado propio: la usan la barra de sugerencias sobre el teclado (`SuggestionBar`) y la barra
 * flotante del campo seleccionado (`FloatingFieldBar`). Con `keepFocus` los chips no le quitan el foco al campo que se
 * esta escribiendo (el `<input>` cierra la edicion al perderlo).
 */

const CHIP =
  "inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-footnote font-semibold whitespace-nowrap " +
  "transition-[background-color,color,box-shadow,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.97] motion-reduce:active:scale-100 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal pointer-coarse:min-h-11 " +
  "forced-colors:border forced-colors:border-[ButtonText]";
const CHIP_IDLE = "bg-white/10 text-foreground hover:bg-white/16";
const CHIP_ACTIVE =
  "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]";
/** La etiqueta que sugiere el rótulo del campo: contorno discreto, ademas de ir la primera. */
const CHIP_SUGGESTED = "bg-white/10 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal-text)] hover:bg-white/16";

export type FieldTagPickerProps = {
  type: TaggableType;
  /** Etiqueta que lleva el campo ahora. */
  current: string | null;
  /** Etiqueta que sugiere el rótulo detectado del campo (va la primera). */
  suggested: string | null;
  onPick: (tag: string) => void;
  onNone: () => void;
  onOther: () => void;
  /** Los chips no roban el foco del campo que se esta escribiendo. */
  keepFocus?: boolean;
  className?: string;
};

/** Evita que el toque en un chip quite el foco al `<input>` del campo (y con el, cierre la edicion). */
export function keepInputFocus(event: ReactPointerEvent<Element>): void {
  event.preventDefault();
}

export function FieldTagPicker({ type, current, suggested, onPick, onNone, onOther, keepFocus = false, className }: FieldTagPickerProps) {
  const language = useOptionalLanguage();
  const strings = useTagStrings();
  useValueHistoryVersion();
  const custom = customTagNames();
  const customKeys = Object.keys(custom).sort((a, b) => custom[a].localeCompare(custom[b], language));
  const base = chipTagsFor(type);
  const first = suggested && base.includes(suggested) ? suggested : null;
  const ordered = [...(first ? [first] : []), ...base.filter((tag) => tag !== first), ...(type === "text" ? customKeys : [])];
  const focusProps = keepFocus ? { onPointerDown: keepInputFocus, onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() } : {};

  return (
    <div role="group" aria-label={strings.pickerLabel} data-tag-picker="" className={cn("flex items-center gap-2", className)}>
      {ordered.map((tag) => {
        const active = tag === current;
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={active}
            data-tag={tag}
            onClick={() => onPick(tag)}
            className={cn(CHIP, active ? CHIP_ACTIVE : tag === first ? CHIP_SUGGESTED : CHIP_IDLE)}
            {...focusProps}
          >
            {tagLabel(tag, language, custom)}
          </button>
        );
      })}
      <button type="button" onClick={onOther} className={cn(CHIP, CHIP_IDLE)} data-tag-other="" {...focusProps}>
        <Plus aria-hidden="true" className="size-4" />
        {strings.chipOther}
      </button>
      {current ? (
        <button type="button" onClick={onNone} className={cn(CHIP, CHIP_IDLE)} data-tag-none="" {...focusProps}>
          <X aria-hidden="true" className="size-4" />
          {strings.chipNone}
        </button>
      ) : null}
    </div>
  );
}

/** El icono de etiqueta con el tamano de los chips (lo comparten la pastilla de la barra y la de la barra flotante). */
export function TagGlyph({ className }: { className?: string }) {
  return <Tag aria-hidden="true" className={cn("size-4 shrink-0", className)} />;
}
