import type { Language } from "@/lib/i18n";
import type { ImagePresetId } from "@/lib/image/prepareForPdf";

/**
 * Textos de «Calidad de imagen» compartidos por Imagenes a PDF y Escanear a PDF (y su pantalla de resultado). Copy original
 * ES/EN; los marcadores `{...}` se sustituyen con `fillCopy`.
 */
export type ImageQualityStrings = {
  label: string;
  preset: Record<ImagePresetId, { label: string; description: string }>;
  /** «Tamaño estimado del PDF: ≈ {after} frente a ≈ {before} sin optimizar». */
  estimateVersus: string;
  /** Con `Original`: «≈ {size} (lo que pesan tus fotos)». */
  estimateSame: string;
  estimateCalculating: string;
  estimateOriginalsKept: string;
  /** Aviso en la estimacion cuando aun asi pasaria de ~100 MB. */
  estimateTooBig: string;
  /** Mensaje del progreso: «Optimizando foto {n} de {total}». */
  progressOptimizing: string;
  progressAdding: string;
  /** «Tus fotos: {before} → PDF: {after} ({percent} menos)». */
  resultSaved: string;
  /** Sin ahorro: «Tus fotos: {before} → PDF: {after}». */
  resultSame: string;
  resultZip: string;
  noticeTitle: string;
  noticeHuge: string;
  noticeBig: string;
};

export const IMAGE_QUALITY_STRINGS: Record<Language, ImageQualityStrings> = {
  es: {
    label: "Calidad de imagen",
    preset: {
      original: { label: "Original", description: "Sin cambios: el PDF pesa lo que pesan tus fotos." },
      high: { label: "Alta", description: "Casi idéntica a la original, incluso al hacer zoom. Ahorra bastante." },
      balanced: { label: "Equilibrada", description: "Recomendada: se ve igual y pesa mucho menos." },
      compact: { label: "Compacta", description: "Para enviar por correo o mensaje: la mínima sin que se note a simple vista." },
    },
    estimateVersus: "Tamaño estimado del PDF: ≈ {after} frente a ≈ {before} sin optimizar.",
    estimateSame: "Tamaño estimado del PDF: ≈ {size} (lo que pesan tus fotos).",
    estimateCalculating: "Calculando el tamaño estimado…",
    estimateOriginalsKept: "Tus archivos originales no se modifican.",
    estimateTooBig: "Aun así sería muy grande (más de ~100 MB). Prueba «Compacta» o más fotos por página.",
    progressOptimizing: "Optimizando foto {n} de {total}",
    progressAdding: "Añadiendo foto {n} de {total}",
    resultSaved: "Tus fotos: {before} → PDF: {after} ({percent} menos)",
    resultSame: "Tus fotos: {before} → PDF: {after}",
    resultZip: "Tus fotos: {before} → ZIP: {after}",
    noticeTitle: "Antes de compartirlo",
    noticeHuge:
      "Pesa más de 100 MB: WhatsApp y la mayoría de correos no lo aceptarán. Prueba «Compacta», pon más fotos por página o divídelo con Dividir PDF.",
    noticeBig:
      "Pesa más de 25 MB: muchos correos lo rechazan (el límite habitual es ~25 MB). Prueba «Compacta», pon más fotos por página o divídelo con Dividir PDF.",
  },
  en: {
    label: "Image quality",
    preset: {
      original: { label: "Original", description: "Unchanged: the PDF weighs what your photos weigh." },
      high: { label: "High", description: "Almost identical to the original, even when zoomed in. Saves a lot." },
      balanced: { label: "Balanced", description: "Recommended: looks the same and weighs much less." },
      compact: { label: "Compact", description: "For email or messages: the smallest that still looks the same at a glance." },
    },
    estimateVersus: "Estimated PDF size: ≈ {after} versus ≈ {before} unoptimized.",
    estimateSame: "Estimated PDF size: ≈ {size} (what your photos weigh).",
    estimateCalculating: "Estimating the size…",
    estimateOriginalsKept: "Your original files are never modified.",
    estimateTooBig: "Still very large (over ~100 MB). Try “Compact” or more photos per page.",
    progressOptimizing: "Optimizing photo {n} of {total}",
    progressAdding: "Adding photo {n} of {total}",
    resultSaved: "Your photos: {before} → PDF: {after} ({percent} smaller)",
    resultSame: "Your photos: {before} → PDF: {after}",
    resultZip: "Your photos: {before} → ZIP: {after}",
    noticeTitle: "Before you share it",
    noticeHuge:
      "It is over 100 MB: WhatsApp and most email services will not accept it. Try “Compact”, put more photos on each page, or split it with Split PDF.",
    noticeBig:
      "It is over 25 MB: many email services reject it (the usual limit is ~25 MB). Try “Compact”, put more photos on each page, or split it with Split PDF.",
  },
};

export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** Umbrales del aviso de la pantalla de resultado (bytes). */
export const SHARE_LIMIT_MAIL = 25 * 1024 * 1024;
export const SHARE_LIMIT_HUGE = 100 * 1024 * 1024;

/**
 * El «Antes → Despues» y los avisos de tamano de la pantalla de resultado. `sourceBytes` es lo que pesan las fotos
 * originales sumadas; `pdfBytes` el archivo que se descarga. Sin ahorro real no se presume ninguno.
 */
export function describeResult(
  strings: ImageQualityStrings,
  sizes: { sourceBytes: number; pdfBytes: number; zip?: boolean },
  format: (bytes: number) => string,
  percentFormat: (percent: number) => string,
): { summary: string; notices?: { title: string; items: string[] } } {
  const { sourceBytes, pdfBytes } = sizes;
  const saved = sourceBytes > 0 ? 1 - pdfBytes / sourceBytes : 0;
  const percent = Math.round(saved * 100);
  const summary =
    percent >= 1 && !sizes.zip
      ? fillCopy(strings.resultSaved, { before: format(sourceBytes), after: format(pdfBytes), percent: percentFormat(percent) })
      : fillCopy(sizes.zip ? strings.resultZip : strings.resultSame, { before: format(sourceBytes), after: format(pdfBytes) });
  if (pdfBytes > SHARE_LIMIT_HUGE) return { summary, notices: { title: strings.noticeTitle, items: [strings.noticeHuge] } };
  if (pdfBytes > SHARE_LIMIT_MAIL) return { summary, notices: { title: strings.noticeTitle, items: [strings.noticeBig] } };
  return { summary };
}
