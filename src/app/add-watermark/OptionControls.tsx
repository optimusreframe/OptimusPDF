"use client";

import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Controles pequenos del panel de opciones. Se duplican en
 * `add-page-numbers` porque este workstream no puede crear archivos en
 * `components/`; unificarlos es tarea de limpieza posterior.
 */

export type Choice<T extends string | number> = {
  value: T;
  label: string;
};

export type ChoiceGroupProps<T extends string | number> = {
  label: string;
  value: T;
  choices: Array<Choice<T>>;
  onChange: (value: T) => void;
  /** Botones en rejilla en vez de lista vertical. */
  columns?: 1 | 2 | 3;
  hint?: string;
};

export function ChoiceGroup<T extends string | number>({
  label,
  value,
  choices,
  onChange,
  columns = 1,
  hint,
}: ChoiceGroupProps<T>) {
  return (
    <div>
      <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "grid gap-1.5",
          columns === 3 && "grid-cols-3",
          columns === 2 && "grid-cols-2",
        )}
      >
        {choices.map((choice) => {
          const active = choice.value === value;
          return (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(choice.value)}
              className={cn(
                "flex min-h-11 items-center justify-between gap-2 rounded-ios-sm border px-3 py-2 text-left text-sm transition-all duration-200 ease-spring",
                active
                  ? "border-signal/60 bg-signal/15 text-foreground"
                  : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground",
              )}
            >
              <span className="min-w-0 truncate">{choice.label}</span>
              {active ? (
                <Check aria-hidden="true" className="size-3.5 shrink-0 text-signal" />
              ) : null}
            </button>
          );
        })}
      </div>
      {hint ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type ToggleRowProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
};

export function ToggleRow({ label, checked, onChange, hint }: ToggleRowProps) {
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between gap-3 rounded-ios-sm border border-white/10 bg-white/5 px-3 py-2.5 transition-colors hover:border-white/25"
      >
        <span className="hud-label text-[10px] text-foreground">{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200",
            checked ? "bg-signal" : "bg-white/15",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-foreground transition-transform duration-200 ease-spring",
              checked && "translate-x-4",
            )}
          />
        </span>
      </button>
      {hint ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type NumberFieldProps = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
};

export function NumberField({
  label,
  value,
  min = 0,
  max = 99999,
  onChange,
}: NumberFieldProps) {
  const id = useId();
  return (
    <div className="min-w-0 flex-1">
      <label
        htmlFor={id}
        className="hud-label mb-1.5 block text-[10px] text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          onChange(Number.isNaN(next) ? min : Math.min(max, Math.max(min, next)));
        }}
        className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground tabular-nums outline-none transition-colors focus:border-signal/60"
      />
    </div>
  );
}

export type TextFieldProps = {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
  hint?: string;
};

export function TextField({
  label,
  value,
  placeholder,
  maxLength = 120,
  onChange,
  hint,
}: TextFieldProps) {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="hud-label mb-1.5 block text-[10px] text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60"
      />
      {hint ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type ColorSwatchesProps = {
  label: string;
  value: string;
  colors: readonly string[];
  onChange: (value: string) => void;
};

/**
 * La tinta del documento es un dato del usuario, no un token de la
 * interfaz: por eso el color se aplica en linea a partir del valor
 * elegido y no desde una variable CSS del tema.
 */
export function ColorSwatches({
  label,
  value,
  colors,
  onChange,
}: ColorSwatchesProps) {
  return (
    <div>
      <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
        {label}
      </span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {colors.map((color) => {
          const active = color.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={color}
              title={color}
              onClick={() => onChange(color)}
              className={cn(
                "size-9 rounded-full border-2 transition-all duration-200 ease-spring",
                active
                  ? "border-signal scale-110"
                  : "border-white/20 hover:border-white/40",
              )}
              style={{ backgroundColor: color }}
            />
          );
        })}
      </div>
    </div>
  );
}

export function OptionSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-white/8 pt-5 first:border-0 first:pt-0">
      {title ? (
        <h3 className="hud-label text-[10px] text-foreground">{title}</h3>
      ) : null}
      {children}
    </section>
  );
}
