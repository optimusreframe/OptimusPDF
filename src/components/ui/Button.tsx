"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { HIT_44 } from "@/components/ui/touchTarget";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

/*
 * Boton al estilo Apple:
 * - Jerarquia por relleno, no por mayusculas: primario solido (signal),
 *   secundario material fino, terciario (ghost) solo texto, destructivo
 *   tintado. Tipografia del sistema, sentence-case, peso 600.
 * - Responde en pointerdown: `:active` escala a 0.97 en 80 ms; al soltar
 *   vuelve con `--ease-spring` en --duration-fast. Nada espera al click.
 * - Foco visible por anillo (`:focus-visible` global, reforzado aqui). Deshabilitado
 *   (VI-06): el primario pasa a una pastilla GRIS (`foreground/10` + texto
 *   `muted-foreground`, >= 4.5:1 en claro y oscuro), asi no se lee "lavado" ni
 *   parece activo; el resto baja al 60 % de opacidad (antes 50 %: ~3.4:1).
 * `buttonClasses` sigue siendo una cadena para los enlaces que la usan.
 */
const BASE =
  "inline-flex items-center justify-center gap-2 select-none whitespace-nowrap font-semibold tracking-normal " +
  // `scale` va en la lista: Tailwind v4 compila `active:scale-*` a la
  // propiedad individual `scale`, no a `transform`.
  "transition-[scale,background-color,color,border-color,box-shadow,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)] " +
  "active:scale-[0.97] active:duration-[80ms] " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal " +
  "disabled:pointer-events-none " +
  // forced-colors (W6-C): el relleno desaparece, asi que el limite lo da el
  // borde (ButtonText) y el deshabilitado pasa a GrayText sin el 50 % de
  // opacidad (que lo dejaria aun mas tenue).
  "forced-colors:border forced-colors:border-[ButtonText] " +
  "forced-colors:disabled:border-[GrayText] forced-colors:disabled:text-[GrayText] forced-colors:disabled:opacity-100";

const VARIANTS: Record<ButtonVariant, string> = {
  // El primario se distingue del resto por un borde de 2 px en Highlight.
  primary:
    "bg-signal text-[var(--color-on-signal)] shadow-elevation-1 hover:bg-glow " +
    "disabled:bg-foreground/10 disabled:text-muted-foreground disabled:shadow-none " +
    "forced-colors:border-2 forced-colors:border-[Highlight]",
  secondary:
    "material-thin text-foreground hover:bg-white/10 active:bg-white/14 disabled:opacity-60",
  ghost: "text-foreground hover:bg-white/8 active:bg-white/12 disabled:opacity-60",
  destructive:
    "border border-destructive/30 bg-destructive/12 text-destructive-text hover:bg-destructive/18 active:bg-destructive/22 disabled:opacity-60",
};

const SIZES: Record<ButtonSize, string> = {
  // sm mide 36 px con raton. Con puntero grueso mide 44 de verdad (VI-05: antes
  // eran 36 visibles + un pseudo-elemento de 44 px y los barridos de objetivos
  // veian 36); el pseudo-elemento sigue ahi para los botones estrechos (ancho).
  sm: `h-9 pointer-coarse:h-11 rounded-ios-sm px-3.5 text-footnote font-semibold ${HIT_44}`,
  md: "h-11 rounded-ios-sm px-5 text-callout font-semibold",
  lg: "h-14 rounded-ios px-7 text-headline",
};

/*
 * `wrap`: para rotulos largos (traducciones, tipografias del sistema mas anchas que SF Pro: DejaVu en Linux, Roboto en
 * Android). El boton base no parte el texto (`whitespace-nowrap`) y tiene alto fijo: un rotulo de ~35 caracteres a
 * 320-375 px ocupaba mas que su contenedor y la pagina ganaba scroll horizontal. Con `wrap` parte en lineas, nunca es mas
 * ancho que su contenedor y conserva el alto minimo de su tamano (44 px en `md`), asi que no cambia nada cuando cabe en
 * una linea. Los `!` ganan a `h-*`/`whitespace-nowrap` del tamano base, que comparten especificidad.
 */
const WRAP_BASE = "h-auto! max-w-full py-2 text-center whitespace-normal!";
const WRAP_MIN_HEIGHT: Record<ButtonSize, string> = {
  sm: "min-h-9 pointer-coarse:min-h-11",
  md: "min-h-11",
  lg: "min-h-14",
};

export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
  wrap = false,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], wrap && [WRAP_BASE, WRAP_MIN_HEIGHT[size]], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Rotulo largo: parte el texto en varias lineas en lugar de desbordar (ver `WRAP_BASE`). */
  wrap?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", fullWidth, wrap, className, type, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        // `data-variant` deja a `globals.css` dar la pastilla gris al primario `aria-disabled` aunque el consumidor
        // le ponga su propia opacidad (los botones «Aplicar» de PDF Pro no usan `disabled`, para no perder el foco).
        data-variant={variant}
        className={buttonClasses(
          variant,
          size,
          cn(fullWidth && "w-full", className),
          wrap,
        )}
        {...props}
      />
    );
  },
);
