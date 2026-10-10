"use client";

import { cn } from "@/lib/cn";
import { GRID_ANCHORS, type GridAnchor } from "@/lib/pdf/watermark";

export type PositionGridProps = {
  label: string;
  value: GridAnchor;
  onChange: (value: GridAnchor) => void;
  /** Etiqueta accesible de cada ancla, en el idioma activo. */
  anchorLabels: Record<string, string>;
  disabled?: boolean;
  hint?: string;
};

/**
 * Rejilla 3x3 de anclaje, compartida por add-watermark y add-page-numbers
 * (W6-C: antes habia una copia identica en cada carpeta). Con
 * `forced-colors: active` la rejilla se delimita con borde del sistema, la
 * celda elegida lleva un borde grueso en Highlight y los puntos se pintan en
 * texto (los rellenos translucidos no se ven en ese modo).
 */
export function PositionGrid({
  label,
  value,
  onChange,
  anchorLabels,
  disabled = false,
  hint,
}: PositionGridProps) {
  return (
    <div>
      <span className="ui-label mb-2 block text-muted-foreground">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "grid grid-cols-3 gap-1.5 rounded-ios-sm border border-white/10 bg-white/5 p-1.5 transition-opacity forced-colors:border-[ButtonText]",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        {GRID_ANCHORS.map((anchor) => {
          const active = anchor === value;
          return (
            <button
              key={anchor}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={anchorLabels[anchor] ?? anchor}
              title={anchorLabels[anchor] ?? anchor}
              disabled={disabled}
              onClick={() => onChange(anchor)}
              className={cn(
                "flex aspect-[4/3] items-center justify-center rounded-[10px] border transition-all duration-200 ease-spring",
                active
                  ? "border-signal/60 bg-signal/20 forced-colors:border-2 forced-colors:border-[Highlight]"
                  : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/8 forced-colors:border-[ButtonText]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full transition-colors",
                  active
                    ? "bg-signal forced-colors:bg-[Highlight]"
                    : "bg-white/25 forced-colors:bg-[ButtonText]",
                )}
              />
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
