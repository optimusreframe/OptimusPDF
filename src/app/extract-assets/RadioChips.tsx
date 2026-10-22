"use client";

import { cn } from "@/lib/cn";

export type RadioChipsProps<T extends string> = {
  legend: string;
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
};

/** Eleccion unica en fichas de 44 px (radios nativos: flechas, nombre y estado para el lector de pantalla). */
export function RadioChips<T extends string>({ legend, name, value, options, onChange, disabled }: RadioChipsProps<T>) {
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      <legend className="ui-label mb-2 text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "relative inline-flex h-11 cursor-pointer items-center rounded-full border px-4 text-subheadline font-semibold",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal",
              "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
              value === option.value ? "border-signal bg-signal/15 text-foreground" : "border-hairline-strong text-muted-foreground",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
