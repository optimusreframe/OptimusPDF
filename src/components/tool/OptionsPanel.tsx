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
        {/* Pie FIJO de la hoja: «Procesar» siempre a la vista; las opciones largas se desplazan por encima. */}
        {footer ? (
          <div className="material-thick sticky bottom-0 z-10 -mx-5 mt-6 border-t border-hairline px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
            {footer}
          </div>
        ) : null}
      </Sheet>
    );
  }

  /*
   * Escritorio: el panel se queda pegado bajo la cabecera con una altura maxima igual a la
   * ventana visible menos 9 rem: ~8,5 rem es lo que lo separa del borde superior de la pagina
   * (cabecera de la herramienta) en su posicion natural, asi que SIN desplazar la pagina su
   * pie ya cae dentro de la ventana, y una vez fijado (sticky) sobra margen. Lo que no cabe se desplaza DENTRO del panel
   * (`overflow-y-auto`) y el pie, con «Procesar», queda siempre a la vista: nunca hay que bajar
   * la pagina para encontrar el boton (Wave 6 · N7).
   */
  return (
    <aside
      aria-label={heading}
      className={cn(
        "surface-card sticky top-20 hidden h-fit max-h-[calc(100dvh-9rem)] w-full shrink-0 flex-col rounded-ios md:flex md:w-[320px] lg:top-6",
        className,
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
        <h2 className="mb-4 text-headline text-foreground">{heading}</h2>
        <div className="space-y-5">{children}</div>
      </div>
      {footer ? (
        <div className="shrink-0 border-t border-hairline p-5 pt-4">{footer}</div>
      ) : null}
    </aside>
  );
}
