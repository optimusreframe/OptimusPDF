import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant =
  | "neutral"
  | "signal"
  | "live"
  | "soon"
  | "success"
  | "destructive";

/*
 * Chip de estado. Los neutros van sobre material fino (el peso mas ligero:
 * un chip es la superficie mas pequeña de la jerarquia); los semanticos
 * llevan tinte del color con hairline del mismo tono. Tipografia
 * caption-2 (11 px, 500, tracking +0.02em), sentence-case: el texto lo
 * decide quien lo usa. El texto de los semanticos usa las variantes
 * `*-text` (no el color de relleno): sobre su propio tinte `text-destructive`
 * daba 4.31:1 en oscuro y `text-success` 4.58:1 en claro (W1-D).
 */
const VARIANTS: Record<BadgeVariant, string> = {
  neutral: "material-thin text-muted-foreground",
  signal: "border border-signal/40 bg-signal/15 text-foreground",
  live: "border border-success/35 bg-success/12 text-success-text",
  soon: "material-thin text-muted-foreground",
  success: "border border-success/35 bg-success/12 text-success-text",
  destructive: "border border-destructive/35 bg-destructive/12 text-destructive-text",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  /** Punto indicador a la izquierda (estado). */
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
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption-2 leading-none font-medium whitespace-nowrap",
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  );
}
