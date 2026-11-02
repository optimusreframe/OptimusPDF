"use client";

import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/pdf/core";
import { reductionPercent, type CompressionMode } from "@/lib/pdf/compress";
import type { CompressStrings } from "@/app/compress-pdf/strings";

export type CompressSummaryProps = {
  strings: CompressStrings;
  locale: string;
  filename: string;
  originalSize: number;
  compressedSize: number;
  /** Modo usado en ESTA ejecucion concreta, para elegir el mensaje correcto. */
  mode: CompressionMode;
  /** `true` cuando no hubo ganancia real y se devolvio el original sin tocar. */
  alreadyOptimized: boolean;
  className?: string;
};

/**
 * Resumen de una compresion (antes / despues / ahorro), COMPARTIDO por la herramienta suelta y por
 * PDF Pro: los numeros son los medidos sobre el archivo realmente producido, nunca una estimacion.
 */
export function CompressSummary({
  strings: s,
  locale,
  filename,
  originalSize,
  compressedSize,
  mode,
  alreadyOptimized,
  className,
}: CompressSummaryProps) {
  const reduction = reductionPercent(originalSize, compressedSize);
  return (
    <section className={cn("surface-card rounded-ios p-5", className)}>
      <h2 className="ui-label text-muted-foreground">{s.summaryTitle}</h2>
      <p className="mt-1 text-sm font-medium [overflow-wrap:anywhere] text-foreground">{filename}</p>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-ios border border-white/10 bg-white/5 p-4">
          <dt className="text-footnote text-muted-foreground">{s.beforeLabel}</dt>
          <dd className="mt-1 text-lg font-bold text-foreground tabular-nums">
            {formatFileSize(originalSize, locale)}
          </dd>
        </div>
        <div className="rounded-ios border border-white/10 bg-white/5 p-4">
          <dt className="text-footnote text-muted-foreground">{s.afterLabel}</dt>
          <dd className="mt-1 text-lg font-bold text-foreground tabular-nums">
            {formatFileSize(compressedSize, locale)}
          </dd>
        </div>
        <div className="rounded-ios border border-white/10 bg-white/5 p-4">
          <dt className="text-footnote text-muted-foreground">{s.reductionLabel}</dt>
          <dd
            className={
              reduction > 0
                ? "mt-1 text-lg font-bold text-success tabular-nums"
                : reduction < 0
                  ? "mt-1 text-lg font-bold text-destructive tabular-nums"
                  : "mt-1 text-lg font-bold text-foreground tabular-nums"
            }
          >
            {reduction > 0 ? `−${reduction}%` : reduction < 0 ? `+${Math.abs(reduction)}%` : "0%"}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {!alreadyOptimized ? s.gainHint : mode === "flatten" ? s.flattenNoGainHint : s.noGainHint}
      </p>
    </section>
  );
}
