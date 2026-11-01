"use client";

import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Campo de texto del sistema de diseno (16 px con tacto: iOS no hace zoom al enfocarlo). */
export const AUTOFILL_INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

/** Texto largo (pegar datos): mismo aspecto, altura propia. */
export const AUTOFILL_TEXTAREA_CLASS =
  "min-h-28 w-full resize-y rounded-ios-sm border border-white/14 bg-white/5 px-3 py-2 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

export type RadioRowProps = {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  /** Lo que acompana a la opcion (evidencia, campo para corregir…): queda dentro de la misma tarjeta. */
  children?: ReactNode;
  describedBy?: string;
  value?: string;
};

/**
 * Opcion de un grupo (`input type=radio` nativo, etiqueta asociada): toda la fila es el objetivo (>= 44 px de alto), igual que
 * `Checkbox`. El control activo se distingue por el aro Y por el estado (`aria-checked` nativo), nunca solo por color.
 */
export function RadioRow({ name, label, checked, onChange, children, describedBy, value }: RadioRowProps) {
  const id = useId();
  return (
    <div className="w-full">
      <div className="group relative flex min-h-11 cursor-pointer items-center gap-3">
        <span className="relative flex size-[22px] shrink-0 items-center justify-center">
          <input
            id={id}
            type="radio"
            name={name}
            value={value}
            checked={checked}
            aria-describedby={describedBy}
            onChange={onChange}
            className={cn(
              "peer absolute inset-0 size-full cursor-pointer appearance-none rounded-full border border-hairline-strong bg-white/5",
              "transition-[background-color,border-color,border-width] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
              "checked:border-[7px] checked:border-signal checked:bg-[var(--color-on-signal)]",
              "forced-colors:border-[ButtonText] forced-colors:checked:border-[Highlight]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            )}
          />
        </span>
        <label htmlFor={id} className="flex min-h-11 flex-1 cursor-pointer items-center text-subheadline font-medium text-foreground select-none [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-['']">
          {label}
        </label>
      </div>
      {children ? <div className="pl-[34px]">{children}</div> : null}
    </div>
  );
}
