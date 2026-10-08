"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

/*
 * Boton al estilo Apple:
 * - Jerarquia por relleno, no por mayusculas: primario solido (signal),
 *   secundario material fino, terciario (ghost) solo texto, destructivo
 *   tintado. Tipografia del sistema, sentence-case, peso 600.
 * - Responde en pointerdown: `:active` escala a 0.97 en 80 ms; al soltar
 *   vuelve con `--ease-spring` en --duration-fast. Nada espera al click.
 * - Foco visible por anillo (`:focus-visible` global, reforzado aqui) y
 *   disabled al 50 % sin bloquear la lectura del texto.
 * `buttonClasses` sigue siendo una cadena para los enlaces que la usan.
 */
const BASE =
  "inline-flex items-center justify-center gap-2 select-none whitespace-nowrap font-semibold tracking-normal " +
  // `scale` va en la lista: Tailwind v4 compila `active:scale-*` a la
  // propiedad individual `scale`, no a `transform`.
  "transition-[scale,background-color,color,border-color,box-shadow,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)] " +
  "active:scale-[0.97] active:duration-[80ms] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal " +
  "disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-signal text-[var(--color-on-signal)] shadow-elevation-1 hover:bg-glow",
  secondary:
    "material-thin text-foreground hover:bg-white/10 active:bg-white/14",
  ghost: "text-foreground hover:bg-white/8 active:bg-white/12",
  destructive:
    "border border-destructive/30 bg-destructive/12 text-destructive-text hover:bg-destructive/18 active:bg-destructive/22",
};

const SIZES: Record<ButtonSize, string> = {
  // sm mide 36 px; con puntero grueso un pseudo-elemento amplia el area de
  // toque a 44 px sin cambiar el aspecto ni el flujo.
  sm:
    "h-9 rounded-ios-sm px-3.5 text-footnote font-semibold " +
    "pointer-coarse:relative pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1 pointer-coarse:before:content-['']",
  md: "h-11 rounded-ios-sm px-5 text-callout font-semibold",
  lg: "h-14 rounded-ios px-7 text-headline",
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
