"use client";

import { useId, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import { IMAGE_PRESET_IDS, type ImagePresetId } from "@/lib/image/prepareForPdf";
import { IMAGE_QUALITY_STRINGS, fillCopy, formatSizeRange, previewWarnings } from "@/lib/image/qualityStrings";
import { isIosWebKit } from "@/lib/image/platform";
import type { PdfSizeEstimate } from "@/lib/image/estimatePdfSize";

export type ImageQualityPickerProps = {
  value: ImagePresetId;
  onChange: (preset: ImagePresetId) => void;
  /** Estimacion del peso del PDF con la calidad elegida; `null` mientras se calcula. */
  estimate: PdfSizeEstimate | null;
  /** Peso central estimado con «Alta» (solo si alguna foto pasa de 12 Mpx y la calidad elegida no es «Alta»). */
  highDetailBytes?: number | null;
  /** ADITIVO: texto que sustituye a la estimacion (p. ej. «Ya esta optimizado…» cuando la calidad elegida pesa como Original). */
  estimateNote?: string | null;
  className?: string;
};

const subscribeNothing = (): (() => void) => () => {};

/**
 * Selector «Calidad de imagen» (segmentado tactil de 44 px): Original / Alta / Equilibrada / Compacta, con la descripcion
 * corta del preset elegido y la ESTIMACION del peso final marcada con «≈» (se calcula antes de generar con una muestra real
 * de 1-2 fotos; con la incertidumbre alta se da un rango «≈ 35-45 MB»). Antes de generar avisa si el PDF pasaria de ~20 MB
 * (correo) o ~100 MB (WhatsApp) y, con «Original» y muchas fotos en iPhone/iPad, del riesgo de memoria. Estimacion y avisos
 * viven en UNA region viva (`role="status"`): el lector de pantalla los anuncia al cambiar de calidad. Lo comparten Imagenes a
 * PDF y Escanear a PDF.
 */
export function ImageQualityPicker({ value, onChange, estimate, highDetailBytes = null, estimateNote = null, className }: ImageQualityPickerProps) {
  const { language } = useI18n();
  const copy = IMAGE_QUALITY_STRINGS[language];
  const locale = localeTag(language);
  const descriptionId = useId();
  const size = (bytes: number): string => formatFileSize(bytes, locale);
  // La plataforma solo se conoce en el navegador: en el servidor y al hidratar es «no iOS», sin desajuste.
  const ios = useSyncExternalStore(subscribeNothing, isIosWebKit, () => false);

  let estimateText = copy.estimateCalculating;
  if (estimate) {
    if (value === "original") estimateText = fillCopy(copy.estimateSame, { size: size(estimate.optimizedBytes) });
    else if (estimate.uncertain && estimate.lowBytes !== undefined && estimate.highBytes !== undefined)
      estimateText = fillCopy(copy.estimateRange, {
        range: formatSizeRange(estimate.lowBytes, estimate.highBytes, size),
        before: size(estimate.unoptimizedBytes),
      });
    else estimateText = fillCopy(copy.estimateVersus, { after: size(estimate.optimizedBytes), before: size(estimate.unoptimizedBytes) });
  }
  if (estimate && estimateNote) estimateText = estimateNote;
  const warnings = estimate ? previewWarnings(estimate, value, ios) : [];
  const warningText = { mail: copy.warnMail, huge: copy.warnHuge, memory: copy.warnMemory };

  return (
    <div className={className} data-image-quality="">
      <SegmentedControl<ImagePresetId>
        wrap
        label={copy.label}
        value={value}
        onChange={onChange}
        options={IMAGE_PRESET_IDS.map((id) => ({ value: id, label: copy.preset[id].label }))}
      />
      <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-muted-foreground" data-image-quality-description="">
        {copy.preset[value].description}
      </p>
      <div role="status" aria-live="polite" aria-atomic="false" data-image-quality-live="">
        <p className="mt-1.5 text-sm leading-relaxed text-foreground tabular-nums" data-image-quality-estimate="">
          {estimateText}
        </p>
        {estimate && highDetailBytes !== null && value !== "high" && value !== "original" ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground" data-image-quality-high-detail="">
            {fillCopy(copy.estimateHighDetail, { size: size(highDetailBytes) })}
          </p>
        ) : null}
        {warnings.map((warning) => (
          <p key={warning} className="mt-1.5 flex items-start gap-2 text-sm leading-relaxed text-foreground" data-image-quality-warning={warning}>
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{warningText[warning]}</span>
          </p>
        ))}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {copy.estimateOriginalsKept}
        {value !== "original" ? ` ${copy.colorNote}` : ""}
      </p>
    </div>
  );
}
