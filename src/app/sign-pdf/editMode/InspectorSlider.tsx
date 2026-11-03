"use client";

import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { IconButton, fillStyle } from "@/app/sign-pdf/editMode/editUi";

/*
 * Deslizador del inspector con VALOR NUMERICO y paso fino: la pista (`slider-ios`) para ajustar a ojo, el numero
 * (editable con el teclado) para ajustar al decimal, y «−» / «+» de 44 px para subir o bajar de paso en paso sin tener que
 * acertar con la pista. Todo comparte el mismo valor: nada que sincronizar a mano.
 */

export type InspectorSliderProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Texto tras el numero («%», «pt»). */
  unit: string;
  disabled?: boolean;
  /** Nombres accesibles de los botones y del numero (ya traducidos). */
  decreaseLabel: string;
  increaseLabel: string;
  valueLabel: string;
  onChange: (value: number) => void;
  className?: string;
};

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function snap(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  return Math.round((min + steps * step) * 100) / 100;
}

export function InspectorSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled = false,
  decreaseLabel,
  increaseLabel,
  valueLabel,
  onChange,
  className,
}: InspectorSliderProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const span = max - min;
  const fraction = span > 0 ? (value - min) / span : 0;

  const commit = (text: string) => {
    setDraft(null);
    const parsed = Number.parseFloat(text.replace(",", "."));
    if (!Number.isFinite(parsed)) return;
    const next = snap(parsed, min, max, step);
    if (next !== value) onChange(next);
  };

  return (
    <div className={cn("w-full", disabled && "opacity-50", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="ui-label min-w-0 truncate text-muted-foreground">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <IconButton
            label={decreaseLabel}
            className="size-11"
            disabled={disabled || value <= min}
            onClick={() => onChange(snap(value - step, min, max, step))}
          >
            <Minus aria-hidden="true" className="size-4" />
          </IconButton>
          <span className="flex items-baseline gap-0.5 text-footnote text-foreground tabular-nums">
            <input
              type="text"
              inputMode="decimal"
              aria-label={valueLabel}
              disabled={disabled}
              value={draft ?? formatValue(value)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={(event) => {
                if (draft !== null) commit(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit(event.currentTarget.value);
                } else if (event.key === "Escape" && draft !== null) {
                  // El primer Escape solo descarta lo escrito: no sale del modo.
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                }
              }}
              /* 16 px de verdad: Safari de iPhone no acerca la pagina al enfocarlo. */
              className="h-9 w-14 rounded-ios-sm bg-white/8 px-1 text-center text-base font-medium text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
            />
            <span aria-hidden="true" className="w-4 text-caption text-muted-foreground">
              {unit}
            </span>
          </span>
          <IconButton
            label={increaseLabel}
            className="size-11"
            disabled={disabled || value >= max}
            onClick={() => onChange(snap(value + step, min, max, step))}
          >
            <Plus aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={`${formatValue(value)} ${unit}`}
        onChange={(event) => onChange(snap(Number(event.target.value), min, max, step))}
        className="slider-ios"
        style={fillStyle(fraction)}
      />
    </div>
  );
}
