"use client";

import { Pin, PinOff, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { RankedSuggestion } from "@/lib/valueHistory";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

export type ValueSuggestionsProps = {
  id: string;
  suggestions: readonly RankedSuggestion[];
  highlightedIndex: number;
  /** Encima (`"top"`) o debajo (`"bottom"`) del campo, segun quepa en la pagina. */
  placement: "top" | "bottom";
  onPick: (value: string) => void;
  onForget: (value: string) => void;
  /** Fijar (o soltar) un valor. Ausente = sin boton de fijar. */
  onPin?: (value: string, pinned: boolean) => void;
  strings: SignStrings;
};

/** Texto con la parte que coincide con lo escrito en negrita. */
function Highlighted({ item }: { item: RankedSuggestion }) {
  if (item.matchAt < 0 || item.matchLength === 0) return <>{item.value}</>;
  const end = item.matchAt + item.matchLength;
  return (
    <>
      {item.value.slice(0, item.matchAt)}
      <strong className="font-bold">{item.value.slice(item.matchAt, end)}</strong>
      {item.value.slice(end)}
    </>
  );
}

/**
 * Desplegable de autocompletado anclado a un `TextFieldBox` en edicion, para RATON y TECLADO FISICO (con el dedo lo sustituye
 * la barra sobre el teclado, `SuggestionBar`). Vive dentro del propio recuadro absoluto del campo (mismo sistema de
 * coordenadas), asi que solo necesita separarse verticalmente con
 * `top`/`bottom` -- el `zIndex` de que quede por encima de los demas
 * campos lo pone el propio `TextFieldBox` mientras esta en edicion.
 *
 * Las coincidencias salen ya ordenadas (primero las que empiezan igual, luego las que lo contienen; las fijadas arriba) y con
 * la parte coincidente resaltada. Cada fila trae «Fijar» y «Olvidar» (con raton: 24 px de objetivo).
 *
 * Fondo opaco blanco/negro (NO `surface-card` ni un material, verificado en un
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
  onPin,
  strings,
}: ValueSuggestionsProps) {
  const tagStrings = useTagStrings();
  if (suggestions.length === 0) return null;

  const keepFocus = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      id={id}
      role="listbox"
      className={cn(
        "rounded-ios-sm absolute inset-x-0 z-10 max-h-48 overflow-y-auto border border-black/10 bg-white py-1 text-black shadow-lg",
        placement === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
      )}
      style={{ touchAction: "pan-y" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {suggestions.map((item, index) => (
        <div
          key={item.value}
          role="option"
          aria-selected={index === highlightedIndex}
          className={cn(
            "flex items-center gap-1 px-2 py-1.5 text-xs",
            index === highlightedIndex ? "bg-signal/15" : undefined,
          )}
        >
          <button
            type="button"
            onPointerDown={keepFocus}
            onClick={() => onPick(item.value)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            {item.pinned ? (
              <>
                <Pin aria-hidden="true" className="size-3 shrink-0 text-black/55" />
                <span className="sr-only">{tagStrings.suggestionPinned}</span>
              </>
            ) : null}
            <span className="truncate">
              <Highlighted item={item} />
            </span>
          </button>
          {onPin ? (
            <button
              type="button"
              aria-label={item.pinned ? tagStrings.unpinNamed(item.value) : tagStrings.pinNamed(item.value)}
              title={item.pinned ? tagStrings.unpin : tagStrings.pin}
              onPointerDown={keepFocus}
              onClick={() => onPin(item.value, !item.pinned)}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-black/55 transition-colors hover:bg-black/8 hover:text-black"
            >
              {item.pinned ? <PinOff aria-hidden="true" className="size-3.5" /> : <Pin aria-hidden="true" className="size-3.5" />}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={strings.forgetSuggestion(item.value)}
            title={tagStrings.forget}
            onPointerDown={keepFocus}
            onClick={() => onForget(item.value)}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-black/55 transition-colors hover:bg-black/8 hover:text-destructive"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
