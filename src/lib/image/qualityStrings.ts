import type { Language } from "@/lib/i18n";
import type { ImageProblem } from "@/lib/image/imageIntegrity";
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
  /** Con la incertidumbre alta: «Tamaño estimado del PDF: ≈ {range} frente a ≈ {before} sin optimizar.». */
  estimateRange: string;
  /** «Alta» conserva mas detalle al ampliar (≈ {size}). Solo con fotos de mas de 12 Mpx. */
  estimateHighDetail: string;
  /** Aviso PREVIO (antes de generar): pesaria mas de ~20 MB. */
  warnMail: string;
  /** Aviso PREVIO: pesaria mas de ~100 MB. */
  warnHuge: string;
  /** Aviso PREVIO: «Original» con muchas fotos en iPhone/iPad puede agotar la memoria. */
  warnMemory: string;
  /** Nota de color bajo la estimacion. */
  colorNote: string;
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
  /** Fotos omitidas, en el resultado: «Se omitieron {n} fotos y no están en el PDF: {list}.» */
  skippedOne: string;
  skippedMany: string;
  skippedMore: string;
  /** Motivo corto de cada problema, para la lista: «{name} ({reason})». */
  problemShort: Record<ImageProblem, string>;
  /** Frase completa por problema, para el aviso previo: «{name} {sentence}». */
  problemLine: Record<ImageProblem, string>;
  problemsTitleOne: string;
  problemsTitleMany: string;
  problemsHint: string;
  removeAndContinue: string;
};

export const IMAGE_QUALITY_STRINGS: Record<Language, ImageQualityStrings> = {
  es: {
    label: "Calidad de imagen",
    preset: {
      original: { label: "Original", description: "Sin cambios: el PDF pesa lo que pesan tus fotos." },
      high: { label: "Alta", description: "Para expediente o peritaje: conserva el detalle al ampliar. Ahorra bastante." },
      balanced: { label: "Equilibrada", description: "Recomendada para enviar: se ve igual y pesa mucho menos." },
      compact: { label: "Compacta", description: "Solo para correo o mensajes; no sirve como evidencia." },
    },
    estimateVersus: "Tamaño estimado del PDF: ≈ {after} frente a ≈ {before} sin optimizar.",
    estimateSame: "Tamaño estimado del PDF: ≈ {size} (lo que pesan tus fotos).",
    estimateCalculating: "Calculando el tamaño estimado…",
    estimateOriginalsKept: "Tus archivos originales no se modifican.",
    estimateRange: "Tamaño estimado del PDF: ≈ {range} frente a ≈ {before} sin optimizar.",
    estimateHighDetail: "«Alta» conserva más detalle al ampliar (≈ {size}).",
    warnMail: "Pesará más de ~20 MB: muchos correos rechazan adjuntos de ese tamaño. Prueba «Compacta» o pon más fotos por página.",
    warnHuge: "Pesará más de ~100 MB: WhatsApp y la mayoría de correos no lo aceptarán. Prueba «Compacta», más fotos por página o divídelo con Dividir PDF.",
    warnMemory:
      "Con «Original» y tantas fotos pesadas, este iPhone o iPad puede quedarse sin memoria y cerrar la página. Prueba «Alta» o «Equilibrada».",
    colorNote: "Al optimizar se usa color sRGB, el de los PDF: en fotos Display P3 los colores muy intensos pueden verse algo más apagados.",
    progressOptimizing: "Optimizando foto {n} de {total}",
    progressAdding: "Añadiendo foto {n} de {total}",
    resultSaved: "Tus fotos: {before} → PDF: {after} ({percent} menos)",
    resultSame: "Tus fotos: {before} → PDF: {after}",
    resultZip: "Tus fotos: {before} → ZIP: {after}",
    noticeTitle: "Revisa antes de compartirlo",
    noticeHuge:
      "Pesa más de 100 MB: WhatsApp y la mayoría de correos no lo aceptarán. Prueba «Compacta», pon más fotos por página o divídelo con Dividir PDF.",
    noticeBig:
      "Pesa más de 20 MB: muchos correos lo rechazan (con el 33 % que añade el adjunto, el límite de 25 MB queda en ~18 MB). Prueba «Compacta», pon más fotos por página o divídelo con Dividir PDF.",
    skippedOne: "Se omitió 1 foto y no está en el PDF: {list}.",
    skippedMany: "Se omitieron {n} fotos y no están en el PDF: {list}.",
    skippedMore: "y {n} más",
    problemShort: {
      empty: "vacía",
      notImage: "no es una imagen",
      truncated: "incompleta",
      corrupt: "dañada",
      heic: "HEIC que este navegador no puede abrir",
      unreadable: "no se pudo leer",
    },
    problemLine: {
      empty: "está vacía (0 bytes).",
      notImage: "no es una imagen válida.",
      truncated: "está incompleta: el archivo se cortó y la foto saldría rota.",
      corrupt: "está dañada.",
      heic: "es HEIC y este navegador no puede abrirlo. Cambia a «Más compatible» en Ajustes › Cámara o exporta como JPEG.",
      unreadable: "no se pudo leer.",
    },
    problemsTitleOne: "1 foto no se puede usar",
    problemsTitleMany: "{n} fotos no se pueden usar",
    problemsHint: "No entrarán en el PDF. Quítalas para continuar; si no, se omiten al procesar y se avisa en el resultado.",
    removeAndContinue: "Quitar y continuar",
  },
  en: {
    label: "Image quality",
    preset: {
      original: { label: "Original", description: "Unchanged: the PDF weighs what your photos weigh." },
      high: { label: "High", description: "For case files and inspections: keeps the detail when you zoom in. Saves a lot." },
      balanced: { label: "Balanced", description: "Recommended for sending: looks the same and weighs much less." },
      compact: { label: "Compact", description: "Only for email or messages; not suitable as evidence." },
    },
    estimateVersus: "Estimated PDF size: ≈ {after} versus ≈ {before} unoptimized.",
    estimateSame: "Estimated PDF size: ≈ {size} (what your photos weigh).",
    estimateCalculating: "Estimating the size…",
    estimateOriginalsKept: "Your original files are never modified.",
    estimateRange: "Estimated PDF size: ≈ {range} versus ≈ {before} unoptimized.",
    estimateHighDetail: "“High” keeps more detail when you zoom in (≈ {size}).",
    warnMail: "It will weigh over ~20 MB: many email services reject attachments that large. Try “Compact” or put more photos on each page.",
    warnHuge: "It will weigh over ~100 MB: WhatsApp and most email services will not accept it. Try “Compact”, more photos per page, or split it with Split PDF.",
    warnMemory:
      "With “Original” and this many heavy photos, this iPhone or iPad can run out of memory and close the page. Try “High” or “Balanced”.",
    colorNote: "Optimizing uses sRGB color, the one PDFs use: in Display P3 photos very intense colors can look slightly duller.",
    progressOptimizing: "Optimizing photo {n} of {total}",
    progressAdding: "Adding photo {n} of {total}",
    resultSaved: "Your photos: {before} → PDF: {after} ({percent} smaller)",
    resultSame: "Your photos: {before} → PDF: {after}",
    resultZip: "Your photos: {before} → ZIP: {after}",
    noticeTitle: "Check before you share it",
    noticeHuge:
      "It is over 100 MB: WhatsApp and most email services will not accept it. Try “Compact”, put more photos on each page, or split it with Split PDF.",
    noticeBig:
      "It is over 20 MB: many email services reject it (with the 33 % an attachment adds, the 25 MB limit is ~18 MB). Try “Compact”, put more photos on each page, or split it with Split PDF.",
    skippedOne: "1 photo was skipped and is not in the PDF: {list}.",
    skippedMany: "{n} photos were skipped and are not in the PDF: {list}.",
    skippedMore: "and {n} more",
    problemShort: {
      empty: "empty",
      notImage: "not an image",
      truncated: "incomplete",
      corrupt: "damaged",
      heic: "HEIC that this browser cannot open",
      unreadable: "could not be read",
    },
    problemLine: {
      empty: "is empty (0 bytes).",
      notImage: "is not a valid image.",
      truncated: "is incomplete: the file was cut short and the photo would come out broken.",
      corrupt: "is damaged.",
      heic: "is HEIC and this browser cannot open it. Switch to “Most Compatible” in Settings › Camera or export it as JPEG.",
      unreadable: "could not be read.",
    },
    problemsTitleOne: "1 photo cannot be used",
    problemsTitleMany: "{n} photos cannot be used",
    problemsHint: "They will not go into the PDF. Remove them to continue; otherwise they are skipped when processing and the result tells you.",
    removeAndContinue: "Remove and continue",
  },
};

export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/**
 * Umbrales de los avisos de peso (bytes; la interfaz muestra MB de 1024 KB). 20 MB y no 25: un adjunto de correo se codifica en
 * base64 (+33 %), asi que el limite habitual de 25 MB deja pasar ficheros de ~18 MB.
 */
export const SHARE_LIMIT_MAIL = 20 * 1024 * 1024;
export const SHARE_LIMIT_HUGE = 100 * 1024 * 1024;
/** «Original» con mas fotos que esto en iOS/WebKit arriesga quedarse sin memoria (pico medido de ~1,2 GB con 348 MB de fotos). */
export const MEMORY_RISK_BYTES = 120 * 1024 * 1024;

export type SizeWarning = "mail" | "huge" | "memory";

/**
 * Avisos de peso que se dan ANTES de generar (misma escala que los del resultado). `iosWebkit`: el navegador es WebKit de
 * iPhone/iPad (donde la memoria de la pagina es la mas ajustada).
 */
export function previewWarnings(
  estimate: { optimizedBytes: number; sourceBytes: number },
  preset: ImagePresetId,
  iosWebkit: boolean,
): SizeWarning[] {
  const warnings: SizeWarning[] = [];
  if (estimate.optimizedBytes > SHARE_LIMIT_HUGE) warnings.push("huge");
  else if (estimate.optimizedBytes > SHARE_LIMIT_MAIL) warnings.push("mail");
  if (preset === "original" && iosWebkit && estimate.sourceBytes > MEMORY_RISK_BYTES) warnings.push("memory");
  return warnings;
}

/** «a-b MB» con la unidad una sola vez cuando es la misma («35-45 MB»), o «a MB-b GB» si cambia. */
export function formatSizeRange(low: number, high: number, format: (bytes: number) => string): string {
  const a = format(low);
  const b = format(high);
  const unitA = a.slice(a.lastIndexOf(" ") + 1);
  const unitB = b.slice(b.lastIndexOf(" ") + 1);
  if (a === b) return a;
  return unitA === unitB ? `${a.slice(0, a.lastIndexOf(" "))}-${b}` : `${a}-${b}`;
}

/** Nombre y motivo de cada foto omitida, como se lee en el resultado: «foto-12.jpg (no se pudo leer)». */
export function describeSkipped(
  strings: ImageQualityStrings,
  skipped: ReadonlyArray<{ name: string; problem: ImageProblem }>,
  limit = 5,
): string | null {
  if (skipped.length === 0) return null;
  const shown = skipped.slice(0, limit).map((item) => `${item.name || "?"} (${strings.problemShort[item.problem]})`);
  let list = shown.join(", ");
  if (skipped.length > limit) list += ` ${fillCopy(strings.skippedMore, { n: skipped.length - limit })}`;
  return fillCopy(skipped.length === 1 ? strings.skippedOne : strings.skippedMany, { n: skipped.length, list });
}

/**
 * El «Antes → Despues» y los avisos de la pantalla de resultado: fotos omitidas (por nombre) y peso. `sourceBytes` es lo que
 * pesan las fotos originales que entraron; `pdfBytes` el archivo que se descarga. Sin ahorro real no se presume ninguno.
 */
export function describeResult(
  strings: ImageQualityStrings,
  sizes: { sourceBytes: number; pdfBytes: number; zip?: boolean; skipped?: ReadonlyArray<{ name: string; problem: ImageProblem }> },
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
  const items: string[] = [];
  const skipped = describeSkipped(strings, sizes.skipped ?? []);
  if (skipped) items.push(skipped);
  if (pdfBytes > SHARE_LIMIT_HUGE) items.push(strings.noticeHuge);
  else if (pdfBytes > SHARE_LIMIT_MAIL) items.push(strings.noticeBig);
  return items.length > 0 ? { summary, notices: { title: strings.noticeTitle, items } } : { summary };
}
