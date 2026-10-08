import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type GlassCardProps = HTMLAttributes<HTMLDivElement> & {
  /** Se eleva al pasar el puntero y se hunde levemente al presionar. */
  interactive?: boolean;
  children?: ReactNode;
};

/*
 * Tarjeta sobre material regular (peso medio: paneles y tarjetas). La
 * version interactiva sube 2 px con sombra de elevacion 2 al pasar el
 * puntero -- conservando el borde de luz del material -- y responde al
 * presionar (pointerdown) hundiendose a 0.99, con --ease-spring.
 */
export function GlassCard({
  interactive = false,
  className,
  children,
  ...props
}: GlassCardProps) {
  return (
    <div
      className={cn(
        "material-regular rounded-ios",
        interactive &&
          "transition-[translate,scale,box-shadow,background-color] duration-[var(--duration-base)] ease-[var(--ease-spring)] " +
            "hover:-translate-y-0.5 hover:shadow-[var(--shadow-elevation-2),inset_0_1px_0_0_var(--material-highlight)] " +
            "active:translate-y-0 active:scale-[0.99] active:duration-[80ms]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
