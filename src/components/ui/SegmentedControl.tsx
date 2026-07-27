"use client";

import { cn } from "@/lib/cn";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  className?: string;
  size?: "sm" | "md";
};

/** Control segmentado estilo iOS con indicador deslizante. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = "md",
}: SegmentedControlProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const count = Math.max(1, options.length);

  return (
    <div className={cn("w-full", className)}>
      {label ? (
        <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div
        role="tablist"
        aria-label={label}
        className={cn(
          "relative isolate flex w-full rounded-full border border-white/10 bg-white/5 p-1",
          size === "sm" ? "h-9" : "h-11",
        )}
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-1 left-1 -z-10 rounded-full bg-white/12 shadow-[inset_0_1px_0_0_var(--color-hairline-strong)] transition-transform duration-300 ease-spring"
          style={{
            width: `calc((100% - 0.5rem) / ${count})`,
            transform: `translateX(calc(${index} * 100%))`,
          }}
        />
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "hud-label flex-1 rounded-full px-2 text-[10px] transition-colors duration-200",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
