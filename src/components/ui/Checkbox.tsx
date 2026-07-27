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

/** Casilla de verificacion con estetica HUD (input real, accesible). */
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
      <div className="flex items-start gap-3">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <input
            id={inputId}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-describedby={hintId}
            onChange={(event) => onChange(event.target.checked)}
            className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[7px] border border-white/14 bg-white/5 transition-colors checked:border-signal checked:bg-signal disabled:cursor-not-allowed disabled:opacity-40"
          />
          <Check
            aria-hidden="true"
            className="pointer-events-none size-3.5 text-foreground opacity-0 transition-opacity peer-checked:opacity-100"
          />
        </span>
        <label
          htmlFor={inputId}
          className={cn(
            "text-sm leading-snug font-medium text-foreground",
            disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
          )}
        >
          {label}
        </label>
      </div>
      {hint ? (
        <p
          id={hintId}
          className="mt-2 pl-8 text-xs leading-relaxed text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
