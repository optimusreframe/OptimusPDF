import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type GlassCardProps = HTMLAttributes<HTMLDivElement> & {
  /** Realza el borde y eleva la tarjeta al pasar el puntero. */
  interactive?: boolean;
  children?: ReactNode;
};

export function GlassCard({
  interactive = false,
  className,
  children,
  ...props
}: GlassCardProps) {
  return (
    <div
      className={cn(
        "glass rounded-ios",
        interactive &&
          "transition-all duration-200 ease-spring hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/10",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
