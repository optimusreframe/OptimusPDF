"use client";

import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { colorName } from "@/lib/colorNames";
import { useOptionalLanguage } from "@/lib/i18n";
import { HIT_44 } from "@/components/ui/touchTarget";

/**
 * Controles pequenos del panel de opciones, COMPARTIDOS por add-watermark y
 * add-page-numbers (y reutilizados por edit-pdf). Hasta W6-C vivian
 * duplicados, linea por linea, en las dos carpetas; ahora hay una sola
 * implementacion y `@/app/add-watermark/OptionControls` y
 * `@/app/add-page-numbers/OptionControls` son reexportaciones finas para no
 * romper importaciones ni pruebas existentes.
 *
 * Accesibilidad de sistema (W6-C): con `forced-colors: active` cada control
 * se delimita con borde del sistema y la opcion elegida con Highlight (los
 * rellenos translucidos desaparecen en ese modo); con puntero grueso las
 * muestras de color amplian su zona de toque a 44 px.
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
  // En el panel de opciones (280 px utiles) tres columnas dejan ~60 px de
  // texto: con una etiqueta de mas de 9 caracteres se pasa a dos (W1-D).
  const longest = Math.max(0, ...choices.map((choice) => String(choice.label).length));
  const cols = columns === 3 && longest > 9 ? 2 : columns;
  return (
    <div>
      <span className="ui-label mb-2 block text-muted-foreground">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "grid gap-1.5",
          cols === 3 && "grid-cols-3",
          cols === 2 && "grid-cols-2",
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
              title={String(choice.label)}
              onClick={() => onChange(choice.value)}
              className={cn(
                // Sin truncar: la etiqueta pasa a dos lineas y la marca de
                // seleccion va en la esquina (no le quita ancho al texto).
                "relative flex min-h-11 items-center rounded-ios-sm border py-2 pr-4 pl-2.5 text-left text-sm leading-tight whitespace-normal transition-all duration-200 ease-spring",
                active
                  ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-2 forced-colors:border-[Highlight]"
                  : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground forced-colors:border-[ButtonText]",
              )}
            >
              <span className="min-w-0">{choice.label}</span>
              {active ? (
                <Check
                  aria-hidden="true"
                  className="absolute top-1 right-1 size-3 text-signal forced-colors:text-[Highlight]"
                />
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
        className="flex w-full items-center justify-between gap-3 rounded-ios-sm border border-white/10 bg-white/5 px-3 py-2.5 transition-colors hover:border-white/25 forced-colors:border-[ButtonText]"
      >
        <span className="text-subheadline font-medium text-foreground">{label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 forced-colors:border forced-colors:border-[ButtonText]",
            checked ? "bg-signal forced-colors:bg-[Highlight]" : "bg-white/15",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-foreground transition-transform duration-200 ease-spring",
              checked
                ? "translate-x-4 forced-colors:bg-[HighlightText]"
                : "forced-colors:bg-[ButtonText]",
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
        className="ui-label mb-1.5 block text-muted-foreground"
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
        className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground tabular-nums transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
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
        className="ui-label mb-1.5 block text-muted-foreground"
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
        className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
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
  const language = useOptionalLanguage();
  return (
    <div>
      <span className="ui-label mb-2 block text-muted-foreground">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        // Con puntero grueso el hueco sube a 12 px: la muestra elegida crece
        // (scale-110) y su zona de 44 px escalada no debe pisar a las vecinas.
        className="flex flex-wrap gap-2 pointer-coarse:gap-3"
      >
        {colors.map((color) => {
          const active = color.toLowerCase() === value.toLowerCase();
          // El nombre es el del color («Azul»), no su codigo hexadecimal.
          const name = colorName(color, language);
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={name}
              title={name}
              onClick={() => onChange(color)}
              className={cn(
                "size-9 rounded-full border-2 transition-all duration-200 ease-spring",
                // La tinta es un dato del usuario: en forced-colors se conserva
                // el relleno (forced-color-adjust: none) y el borde pasa a
                // CanvasText; la elegida lleva ademas un aro de Highlight.
                "forced-colors:[forced-color-adjust:none] forced-colors:border-[CanvasText]",
                // Con puntero grueso: 44 px de zona de toque (el pitch de las
                // muestras es 36 + 8 de hueco = 44, no se solapan).
                HIT_44,
                active
                  ? "border-signal scale-110 forced-colors:outline-2 forced-colors:outline-offset-2 forced-colors:outline-[Highlight]"
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
        <h3 className="text-subheadline font-semibold text-foreground">{title}</h3>
      ) : null}
      {children}
    </section>
  );
}
