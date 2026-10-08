"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { CompressionLevel } from "@/lib/pdf/compress";

export type LevelOption = {
  value: CompressionLevel;
  name: string;
  hint: string;
};

export type LevelCardsProps = {
  label: string;
  value: CompressionLevel;
  options: LevelOption[];
  onChange: (value: CompressionLevel) => void;
};

/**
 * Tres tarjetas en vertical con semantica de grupo de radios: es la
 * forma en la que el usuario espera elegir el nivel de compresion y deja
 * sitio para explicar cada opcion sin abreviar.
 */
export function LevelCards({
  label,
  value,
  options,
  onChange,
}: LevelCardsProps) {
  return (
    <div role="radiogroup" aria-label={label}>
      <span className="ui-label mb-2 block text-muted-foreground">
        {label}
      </span>
      <div className="space-y-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-ios flex w-full items-start gap-3 border p-3.5 text-left",
                "transition-all duration-200 ease-spring",
                active
                  ? "border-signal/60 bg-signal/12"
                  : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  active
                    ? "border-signal bg-signal"
                    : "border-white/25 bg-transparent",
                )}
              >
                {active ? <Check className="size-3 text-foreground" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  {option.name}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
