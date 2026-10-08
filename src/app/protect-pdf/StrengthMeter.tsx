"use client";

import { cn } from "@/lib/cn";
import type { PasswordStrength } from "@/lib/pdf/protect";

export type StrengthMeterProps = {
  label: string;
  score: number;
  level: PasswordStrength;
  levelLabel: string;
  hint: string;
};

const SEGMENTS = 4;

const FILL: Record<PasswordStrength, string> = {
  weak: "bg-destructive",
  medium: "bg-accent-edit",
  strong: "bg-success",
};

const TEXT: Record<PasswordStrength, string> = {
  weak: "text-destructive",
  medium: "text-accent-edit",
  strong: "text-success",
};

/**
 * Medidor visual de fortaleza. Mide longitud y variedad de caracteres,
 * nada mas: es una guia, no una garantia, y el copy lo dice.
 */
export function StrengthMeter({
  label,
  score,
  level,
  levelLabel,
  hint,
}: StrengthMeterProps) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="ui-label text-muted-foreground">
          {label}
        </span>
        <span className={cn("text-footnote font-semibold", TEXT[level])}>
          {levelLabel}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={SEGMENTS}
        aria-valuenow={score}
        aria-valuetext={levelLabel}
        className="mt-2 flex gap-1.5"
      >
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors duration-200",
              index < score ? FILL[level] : "bg-white/10",
            )}
          />
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}
