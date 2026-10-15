"use client";

import { useId } from "react";
import { Mail } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

export type ESignTeaserProps = {
  className?: string;
};

/**
 * «E-sign · Pedir firma por email» (Fase 0 «Firma agil», U0.7): la opcion de la firma electronica por correo, SOLO VISUAL
 * y deshabilitada, con la insignia «Proximamente» / «Soon». No tiene logica: ni estado, ni red, ni navegacion; tocarla no
 * hace nada.
 *
 * Es un boton con `aria-disabled="true"` (no `disabled`): se puede enfocar y el lector de pantalla lo anuncia como no
 * disponible, junto con «Disponible proximamente». Mide 44 px de alto como minimo. El estado deshabilitado se dibuja con
 * borde discontinuo, cursor «no permitido» y sin efectos de pulsacion; el texto conserva el color de los textos
 * secundarios (no se atenua con opacidad) para que el nombre y la insignia se lean con el contraste de siempre.
 */
export function ESignTeaser({ className }: ESignTeaserProps) {
  const { language } = useI18n();
  const e = SIGN_STRINGS[language].esign;
  const hintId = useId();
  return (
    <div data-esign-teaser="" className={cn("w-full", className)}>
      <button
        type="button"
        aria-disabled="true"
        aria-describedby={hintId}
        className={cn(
          "flex min-h-11 w-full cursor-not-allowed items-center justify-center gap-2 rounded-ios-sm border border-dashed border-hairline-strong px-4 py-2 text-callout font-medium text-muted-foreground select-none",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
          // forced-colors: deshabilitado = GrayText y borde del sistema.
          "forced-colors:border-[GrayText] forced-colors:text-[GrayText]",
        )}
      >
        <Mail aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 text-balance">{e.label}</span>
        {/* El espacio separa el nombre de la insignia al calcular el nombre accesible («E-sign ... email Próximamente»). */}
        {" "}
        <Badge variant="soon" className="shrink-0">
          {e.soon}
        </Badge>
      </button>
      <span id={hintId} className="sr-only">
        {e.unavailable}
      </span>
    </div>
  );
}
