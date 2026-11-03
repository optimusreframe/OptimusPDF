"use client";

import { useId, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Piezas pequenas del modo «Editar campos»: todas con zona de toque de 44 px (el modo es tactil primero), foco visible,
 * respuesta en el pointerdown (`active:` escala) y sin movimiento con «reducir movimiento».
 */

const PRESS =
  "transition-[background-color,color,scale,box-shadow,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)] " +
  "active:scale-[0.95] motion-reduce:active:scale-100 " +
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal " +
  "forced-colors:border forced-colors:border-[ButtonText]";

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  label: string;
  pressed?: boolean;
  /** Atenuado y sin accion, pero enfocable (no se pierde el foco al agotarse, p. ej. «Deshacer»). */
  inactive?: boolean;
  children: ReactNode;
};

/** Boton de solo icono de 44x44. El nombre accesible y el `title` son la misma etiqueta. */
export function IconButton({ label, pressed, inactive, className, onClick, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-disabled={inactive ? true : undefined}
      onClick={inactive ? undefined : onClick}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-ios-sm text-foreground",
        pressed ? "bg-signal/25 shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]" : "hover:bg-white/10",
        inactive && "opacity-40",
        PRESS,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

type PillButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "plain" | "primary" | "destructive";
  active?: boolean;
  children: ReactNode;
};

/** Boton con texto (y, si quiere, icono) de al menos 44 px de alto. */
export function PillButton({ tone = "plain", active, className, children, ...rest }: PillButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-ios-sm px-3.5 text-footnote font-semibold",
        tone === "primary" &&
          "bg-signal text-[var(--color-on-signal)] shadow-elevation-1 hover:bg-glow forced-colors:border-2 forced-colors:border-[Highlight]",
        tone === "destructive" && "bg-destructive/12 text-destructive-text hover:bg-destructive/18",
        tone === "plain" &&
          (active
            ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
            : "bg-white/8 text-foreground hover:bg-white/14"),
        "disabled:opacity-40 aria-disabled:opacity-40",
        PRESS,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Interruptor con texto: `role="switch"`, 44 px de alto, el estado se dice con palabras (no solo con el color). */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  const hintId = useId();
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="min-w-0">
        <p className="text-footnote font-medium text-foreground">{label}</p>
        {hint ? (
          <p id={hintId} className="text-caption text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        onClick={() => onChange(!checked)}
        className={cn("inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-ios-sm", PRESS)}
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative inline-block h-[1.625rem] w-11 rounded-full transition-colors duration-200 motion-reduce:transition-none",
            checked ? "bg-signal" : "bg-muted-foreground/40",
            "forced-colors:border forced-colors:bg-transparent forced-colors:border-[ButtonText]",
          )}
        >
          <span
            className={cn(
              "absolute top-[0.1875rem] left-[0.1875rem] size-5 rounded-full bg-background shadow-elevation-1 transition-transform duration-200 motion-reduce:transition-none",
              checked ? "translate-x-[1.125rem] forced-colors:bg-[Highlight]" : "forced-colors:bg-[ButtonText]",
            )}
          />
        </span>
      </button>
    </div>
  );
}

export type Choice<T extends string> = { value: T; label: string; icon?: ReactNode; color?: string };

/** Grupo de opciones excluyentes (`radiogroup`): tipo, firmante... Cada opcion mide 44 px de alto y dice su estado con el aro y `aria-checked`. */
export function ChoiceRow<T extends string>({
  label,
  value,
  choices,
  onChange,
  className,
}: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(choice.value)}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-ios-sm px-3 text-footnote font-semibold",
              checked
                ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                : "bg-white/8 text-foreground hover:bg-white/14",
              PRESS,
            )}
          >
            {choice.color ? (
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                /* Color del firmante: dato del documento, no un token del tema. */
                style={{ backgroundColor: choice.color }}
              />
            ) : null}
            {choice.icon}
            <span className="max-w-32 truncate">{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Encabezado de seccion del panel. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h4 className={cn("ui-label mb-2 text-muted-foreground", className)}>{children}</h4>;
}

/** Variable CSS tipada para el relleno de la pista del deslizador. */
export function fillStyle(fraction: number): CSSProperties {
  const percent = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  return { "--slider-fill": percent } as CSSProperties;
}

/**
 * Lleva `element` a la vista dentro de su contenedor con desplazamiento (`[data-edit-scroll]`) sin tocar a los demas
 * ancestros: `scrollIntoView` tambien desplaza contenedores con `overflow: hidden` (la pantalla completa del modo se
 * correria) y esto no.
 */
export function scrollWithin(element: HTMLElement | null, mode: "nearest" | "center" = "nearest"): void {
  const scroller = element?.closest<HTMLElement>("[data-edit-scroll]");
  if (!element || !scroller) return;
  const a = element.getBoundingClientRect();
  const b = scroller.getBoundingClientRect();
  const pick = (start: number, end: number, from: number, to: number, current: number, extent: number): number => {
    if (mode === "center") return current + (start + end) / 2 - (from + to) / 2;
    if (start < from) return current - (from - start);
    if (end > to) return Math.min(current + (end - to), extent);
    return current;
  };
  scroller.scrollTop = pick(a.top, a.bottom, b.top, b.bottom, scroller.scrollTop, scroller.scrollHeight);
  scroller.scrollLeft = pick(a.left, a.right, b.left, b.right, scroller.scrollLeft, scroller.scrollWidth);
}
