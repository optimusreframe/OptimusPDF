"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-ios font-mono font-semibold uppercase tracking-[0.05em] " +
  "transition-all duration-200 ease-spring select-none " +
  "disabled:pointer-events-none disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-signal text-foreground glow-signal hover:bg-glow active:scale-[0.98]",
  secondary:
    "border border-white/14 bg-white/5 text-foreground hover:border-white/25 hover:bg-white/10 active:scale-[0.98]",
  ghost:
    "text-muted-foreground hover:bg-white/6 hover:text-foreground active:scale-[0.98]",
  destructive:
    "border border-destructive/40 bg-destructive/12 text-destructive hover:bg-destructive/20 active:scale-[0.98]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-[10px]",
  md: "h-11 px-5 text-[11px]",
  lg: "h-14 px-7 text-xs",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", fullWidth, className, type, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={buttonClasses(
          variant,
          size,
          cn(fullWidth && "w-full", className),
        )}
        {...props}
      />
    );
  },
);
