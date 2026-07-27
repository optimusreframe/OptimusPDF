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
 * Desktop: barra lateral derecha pegajosa.
 * Movil: bottom sheet iOS con grabber.
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
        <div className="space-y-5">{children}</div>
        {footer ? <div className="mt-6">{footer}</div> : null}
      </Sheet>
    );
  }

  return (
    <aside
      className={cn(
        "glass rounded-ios sticky top-24 hidden h-fit w-full shrink-0 p-5 md:block md:w-[320px]",
        className,
      )}
    >
      <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
        {heading}
      </h2>
      <div className="space-y-5">{children}</div>
      {footer ? <div className="mt-6">{footer}</div> : null}
    </aside>
  );
}
