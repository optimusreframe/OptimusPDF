"use client";

import { useId, useState } from "react";

export type MmFieldProps = {
  label: string;
  /** Valor en mm. */
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
};

/**
 * Campo numerico con decimales (mm). A diferencia de `NumberField` (enteros) deja escribir «12,5»: mientras
 * se teclea conserva el texto tal cual y solo comunica valores validos. 44 px de alto.
 */
export function MmField({ label, value, onChange, min = 0, max = 2000, step = 0.5, unit = "mm" }: MmFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);

  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="ui-label mb-1.5 block text-muted-foreground">
        {label} <span aria-hidden="true">({unit})</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={`${label} (${unit})`}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const next = Number.parseFloat(text.replace(",", "."));
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
          else if (text === "") onChange(0);
        }}
        onBlur={() => setDraft(null)}
        className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground pointer-coarse:text-base tabular-nums transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
      />
    </div>
  );
}
