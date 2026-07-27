import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant =
  | "neutral"
  | "signal"
  | "live"
  | "soon"
  | "success"
  | "destructive";

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "border-white/10 bg-white/5 text-muted-foreground",
  signal: "border-signal/40 bg-signal/15 text-foreground",
  live: "border-success/35 bg-success/12 text-success",
  soon: "border-white/10 bg-white/5 text-muted-foreground",
  success: "border-success/35 bg-success/12 text-success",
  destructive: "border-destructive/40 bg-destructive/12 text-destructive",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  /** Punto indicador a la izquierda (estado HUD). */
  dot?: boolean;
  children?: ReactNode;
};

export function Badge({
  variant = "neutral",
  dot = false,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "hud-label inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] leading-none",
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  );
}
