"use client";

import type { ReactNode } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export type OptionsPanelProps = {
  /** Solo relevante en movil: controla el bottom sheet. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Escritorio: panel lateral derecho pegajoso sobre superficie solida (un
 * panel no pasa por encima de nada: sin blur). Movil: bottom sheet con el
 * tacto de iOS (`Sheet`, W1-B) con la accion primaria al pie.
 */
export function OptionsPanel({
  open,
  onOpenChange,
  title,
  footer,
  children,
  className,
}: OptionsPanelProps) {
  const t = useT();
  const isMobile = useIsMobile();
  const heading = title ?? t.tool.optionsTitle;

  if (isMobile) {
    return (
      <Sheet
        open={open}
        onClose={() => onOpenChange(false)}
        title={heading}
        closeLabel={t.common.close}
      >
        <div className="space-y-5 pt-2">{children}</div>
        {footer ? <div className="mt-6">{footer}</div> : null}
      </Sheet>
    );
  }

  return (
    <aside
      aria-label={heading}
      className={cn(
        "surface-card sticky top-20 hidden h-fit w-full shrink-0 rounded-ios p-5 md:block md:w-[320px] lg:top-6",
        className,
      )}
    >
      <h2 className="mb-4 text-headline text-foreground">{heading}</h2>
      <div className="space-y-5">{children}</div>
      {footer ? <div className="mt-6">{footer}</div> : null}
    </aside>
  );
}
