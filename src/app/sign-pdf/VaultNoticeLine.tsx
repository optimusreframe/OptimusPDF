"use client";

import { cn } from "@/lib/cn";
import type { VaultNotice } from "@/app/sign-pdf/vaultMessages";

/**
 * Aviso del baul de firmas (guardada, aplicada, no cabe...). La region
 * `role=status` esta SIEMPRE montada y solo cambia su contenido: un lector de
 * pantalla anuncia el cambio, cosa que no hace con una region que aparece ya
 * llena. Vacia, es `sr-only` y no ocupa sitio.
 */
export function VaultNoticeLine({
  notice,
  className,
}: {
  notice: VaultNotice | null;
  className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        notice
          ? cn(
              "text-footnote",
              notice.tone === "success" && "text-success-text",
              notice.tone === "info" && "text-foreground",
              notice.tone === "error" && "text-destructive-text",
              className,
            )
          : "sr-only",
      )}
    >
      {notice?.text ?? ""}
    </p>
  );
}
