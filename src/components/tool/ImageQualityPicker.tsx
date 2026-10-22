"use client";

import { useId } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import { IMAGE_PRESET_IDS, type ImagePresetId } from "@/lib/image/prepareForPdf";
import { IMAGE_QUALITY_STRINGS, SHARE_LIMIT_HUGE, fillCopy } from "@/lib/image/qualityStrings";
import type { PdfSizeEstimate } from "@/lib/image/estimatePdfSize";

export type ImageQualityPickerProps = {
  value: ImagePresetId;
  onChange: (preset: ImagePresetId) => void;
  /** Estimacion del peso del PDF con la calidad elegida; `null` mientras se calcula. */
  estimate: PdfSizeEstimate | null;
  className?: string;
};

/**
 * Selector «Calidad de imagen» (segmentado tactil de 44 px): Original / Alta / Equilibrada / Compacta, con la descripcion
 * corta del preset elegido y la ESTIMACION del peso final marcada con «≈» (se calcula antes de generar, solo con las
 * cabeceras de las fotos). Lo comparten Imagenes a PDF y Escanear a PDF.
 */
export function ImageQualityPicker({ value, onChange, estimate, className }: ImageQualityPickerProps) {
  const { language } = useI18n();
  const copy = IMAGE_QUALITY_STRINGS[language];
  const locale = localeTag(language);
  const descriptionId = useId();
  const size = (bytes: number): string => formatFileSize(bytes, locale);

  let estimateText = copy.estimateCalculating;
  if (estimate) {
    estimateText =
      value === "original"
        ? fillCopy(copy.estimateSame, { size: size(estimate.optimizedBytes) })
        : fillCopy(copy.estimateVersus, { after: size(estimate.optimizedBytes), before: size(estimate.unoptimizedBytes) });
  }
  const tooBig = estimate !== null && estimate.optimizedBytes > SHARE_LIMIT_HUGE && value !== "original";

  return (
    <div className={className} data-image-quality="">
      <SegmentedControl<ImagePresetId>
        label={copy.label}
        value={value}
        onChange={onChange}
        options={IMAGE_PRESET_IDS.map((id) => ({ value: id, label: copy.preset[id].label }))}
      />
      <p id={descriptionId} className="mt-2 text-xs leading-relaxed text-muted-foreground" data-image-quality-description="">
        {copy.preset[value].description}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground tabular-nums" data-image-quality-estimate="">
        {estimateText}
      </p>
      {tooBig ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.estimateTooBig}</p> : null}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.estimateOriginalsKept}</p>
    </div>
  );
}
