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
 * Rejilla 3x3 de anclaje. Se duplica en `add-watermark` a proposito:
 * el alcance de este workstream no permite crear componentes compartidos
 * en `components/tool/`. Extraerlo es tarea de limpieza posterior.
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
      <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "grid grid-cols-3 gap-1.5 rounded-ios-sm border border-white/10 bg-white/5 p-1.5 transition-opacity",
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
                  ? "border-signal/60 bg-signal/20"
                  : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/8",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full transition-colors",
                  active ? "bg-signal" : "bg-white/25",
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
