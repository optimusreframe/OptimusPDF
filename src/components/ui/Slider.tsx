"use client";

import { useId } from "react";
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
  return (
    <div className={cn("w-full", className)}>
      <div className="mb-2 flex items-center justify-between">
        <label
          htmlFor={id}
          className="hud-label text-[10px] text-muted-foreground"
        >
          {label}
        </label>
        <span className="hud-label text-[10px] text-foreground tabular-nums">
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
        className={cn(
          "h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10",
          "[&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-signal",
          "[&::-webkit-slider-thumb]:shadow-[0_0_16px_-2px_var(--color-glow)]",
          "[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-signal",
          "disabled:opacity-40",
        )}
      />
    </div>
  );
}
