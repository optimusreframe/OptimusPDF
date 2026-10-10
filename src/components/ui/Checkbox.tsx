"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export type CheckboxProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Texto de apoyo bajo la etiqueta. */
  hint?: string;
  /** Identificador propio. Si no se pasa, se genera uno estable. */
  id?: string;
  disabled?: boolean;
  className?: string;
};

/*
 * Casilla con input real (role checkbox nativo, etiqueta asociada por
 * `htmlFor`). Toda la fila es el objetivo (min 44 px de alto, tambien el
 * hueco entre la caja y el texto: el ::after de la etiqueta cubre la fila); la caja
 * responde en pointerdown hundiendose a 0.9 y al marcar el check entra
 * por escala+opacidad con --ease-spring (bajo reduced motion solo funde).
 */
export function Checkbox({
  label,
  checked,
  onChange,
  hint,
  id,
  disabled,
  className,
}: CheckboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn(
          "group relative flex min-h-11 items-center gap-3",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <span className="relative flex size-[22px] shrink-0 items-center justify-center">
          <input
            id={inputId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={hintId}
            onChange={(event) => onChange(event.target.checked)}
            className={cn(
              "peer absolute inset-0 size-full appearance-none rounded-[7px] border border-hairline-strong bg-white/5",
              "transition-[background-color,border-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
              "checked:border-signal checked:bg-signal",
              // forced-colors: caja con borde del sistema; marcada = Highlight.
              "forced-colors:border-[ButtonText] forced-colors:checked:border-[Highlight] forced-colors:checked:bg-[Highlight] forced-colors:disabled:border-[GrayText]",
              "active:scale-90 active:duration-[80ms] group-active:scale-90",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          />
          <Check
            aria-hidden="true"
            strokeWidth={3}
            className={cn(
              "pointer-events-none size-3.5 scale-50 text-[var(--color-on-signal)] opacity-0",
              "transition-[scale,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
              "peer-checked:scale-100 peer-checked:opacity-100",
              "forced-colors:text-[HighlightText]",
            )}
          />
        </span>
        <label
          htmlFor={inputId}
          className={cn(
            // El ::after cubre TODA la fila (caja de 22 px + hueco + texto): tocar
            // en cualquier punto alterna la casilla, no solo en la caja o el texto.
            "flex min-h-11 flex-1 items-center text-subheadline font-medium text-foreground select-none after:absolute after:inset-0 after:content-['']",
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          )}
        >
          {label}
        </label>
      </div>
      {hint ? (
        <p
          id={hintId}
          className="-mt-1 pl-[34px] text-footnote text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
