"use client";

import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

export type SliderProps = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Texto que acompana al valor (por ejemplo "%"). */
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  className?: string;
};

/*
 * Input range nativo (role slider, teclado y lector de pantalla gratis)
 * vestido como UISlider: pista de 4 px rellena hasta el valor, thumb
 * blanco de 28 px con elevacion y feedback en pointerdown (ver
 * `slider-ios` en globals.css). El relleno se pasa como variable CSS.
 */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  suffix,
  disabled = false,
  onChange,
  className,
}: SliderProps) {
  const id = useId();
  const span = max - min;
  const fraction = span > 0 ? (value - min) / span : 0;
  const fill = `${Math.min(100, Math.max(0, fraction * 100))}%`;

  return (
    <div className={cn("w-full", className)}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="ui-label text-muted-foreground">
          {label}
        </label>
        <span className="text-caption text-foreground tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="slider-ios"
        style={{ "--slider-fill": fill } as CSSProperties}
      />
    </div>
  );
}
