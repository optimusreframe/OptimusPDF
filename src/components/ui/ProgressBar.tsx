import { cn } from "@/lib/cn";

export type ProgressBarProps = {
  /** Progreso en porcentaje 0..100. */
  value: number;
  label?: string;
  className?: string;
};

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
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full bg-signal glow-signal transition-[width] duration-300 ease-spring"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between">
        {label ? (
          <span className="hud-label text-[10px] text-muted-foreground">
            {label}
          </span>
        ) : (
          <span />
        )}
        <span className="hud-label text-[10px] text-muted-foreground tabular-nums">
          {clamped}%
        </span>
      </div>
    </div>
  );
}
