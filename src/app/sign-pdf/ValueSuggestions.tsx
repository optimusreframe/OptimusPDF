"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type ValueSuggestionsProps = {
  id: string;
  suggestions: readonly string[];
  highlightedIndex: number;
  /** Encima (`"top"`) o debajo (`"bottom"`) del campo, segun quepa en la pagina. */
  placement: "top" | "bottom";
  onPick: (value: string) => void;
  onForget: (value: string) => void;
  strings: SignStrings;
};

/**
 * Dropdown de autocompletado anclado a un `TextFieldBox` en edicion. Vive
 * dentro del propio recuadro absoluto del campo (mismo sistema de
 * coordenadas), asi que solo necesita separarse verticalmente con
 * `top`/`bottom` -- el `zIndex` de que quede por encima de los demas
 * campos lo pone el propio `TextFieldBox` mientras esta en edicion.
 *
 * Fondo opaco blanco/negro (NO el token `glass`, verificado en un
 * navegador real): este dropdown se pinta sobre la propia pagina del PDF,
 * cuyo color de fondo puede ser cualquiera (tipicamente blanco), no sobre
 * el chasis oscuro de la app -- un velo translucido pensado para ese
 * chasis queda casi ilegible aqui. Mismo criterio que ya usa el `<input>`
 * hermano (`bg-white/95 text-black` en `TextFieldBox`).
 *
 * Cada opcion confirma en `onPointerDown` con `preventDefault` (no en
 * `onClick`): el input de `TextFieldBox` cierra la edicion en `onBlur`, y
 * sin esto el propio toque que elige una sugerencia le quita el foco al
 * input primero, desmonta este dropdown, y el `onClick` nunca llega a
 * disparar. `stopPropagation` evita ademas que el toque se interprete
 * como el inicio de un arrastre del campo (`TextFieldBox` arranca el
 * arrastre en `onPointerDown` del recuadro).
 */
export function ValueSuggestions({
  id,
  suggestions,
  highlightedIndex,
  placement,
  onPick,
  onForget,
  strings,
}: ValueSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div
      id={id}
      role="listbox"
      className={cn(
        "rounded-ios-sm absolute inset-x-0 z-10 max-h-40 overflow-y-auto border border-black/10 bg-white py-1 text-black shadow-lg",
        placement === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
      )}
      style={{ touchAction: "pan-y" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {suggestions.map((value, index) => (
        <div
          key={value}
          role="option"
          aria-selected={index === highlightedIndex}
          className={cn(
            "flex items-center gap-1 px-2 py-1.5 text-xs",
            index === highlightedIndex ? "bg-signal/15" : undefined,
          )}
        >
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={() => onPick(value)}
            className="min-w-0 flex-1 truncate text-left"
          >
            {value}
          </button>
          <button
            type="button"
            aria-label={strings.forgetSuggestion(value)}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={() => onForget(value)}
            className="shrink-0 rounded-full p-1 text-black/40 transition-colors hover:text-destructive"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
