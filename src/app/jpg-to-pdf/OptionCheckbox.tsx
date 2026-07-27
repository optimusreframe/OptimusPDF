"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export type OptionCheckboxProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Texto de apoyo bajo la etiqueta. */
  hint?: string;
  className?: string;
};

/** Casilla de verificacion con estetica HUD (input real, accesible). */
export function OptionCheckbox({
  label,
  checked,
  onChange,
  hint,
  className,
}: OptionCheckboxProps) {
  const id = useId();

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-start gap-3">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[7px] border border-white/14 bg-white/5 transition-colors checked:border-signal checked:bg-signal"
          />
          <Check
            aria-hidden="true"
            className="pointer-events-none size-3.5 text-foreground opacity-0 transition-opacity peer-checked:opacity-100"
          />
        </span>
        <label
          htmlFor={id}
          className="cursor-pointer text-sm leading-snug font-medium text-foreground"
        >
          {label}
        </label>
      </div>
      {hint ? (
        <p className="mt-2 pl-8 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
