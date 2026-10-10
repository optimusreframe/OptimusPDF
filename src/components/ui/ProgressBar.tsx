"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";

export type ProgressBarProps = {
  /** Progreso en porcentaje 0..100. */
  value: number;
  label?: string;
  className?: string;
};

/*
 * Barra de progreso: el relleno es una pieza de ancho completo que se
 * desplaza en X (compositor, extremos redondeados intactos) con un spring
 * sin rebote -- un progreso que sobrepasa su valor miente. Bajo reduced
 * motion MotionConfig lo hace instantaneo sin cambiar el estado final.
 */
export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return (
    <div className={cn("w-full", className)}>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10 forced-colors:border forced-colors:border-[CanvasText]"
      >
        <motion.div
          initial={false}
          animate={{ x: `${clamped - 100}%` }}
          transition={springs.default}
          className="h-full w-full rounded-full bg-signal will-change-transform forced-colors:bg-[Highlight]"
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        {label ? (
          <span className="ui-label text-caption text-muted-foreground">
            {label}
          </span>
        ) : (
          <span />
        )}
        <span className="text-caption text-foreground tabular-nums">
          {clamped}%
        </span>
      </div>
    </div>
  );
}
