import type { Language } from "@/lib/i18n";
import type { ConvertProblem } from "@/lib/media/image/convert";

/**
 * Textos propios del «Convertidor de imágenes». Copy original ES/EN: el diccionario global solo cubre lo compartido por todas
 * las herramientas (nombre y descripción de la herramienta, mensajes de error del shell).
 */
export type ImageConverterStrings = {
  formatLabel: string;
  /** `{formats}`: los que este navegador no puede crear («WebP, AVIF»). */
  unavailableNote: string;
  qualityLabel: string;
  qualityHint: string;
  losslessHint: string;
  bmpHint: string;
  sizeLabel: string;
  sizeOriginal: string;
  sizeMaxWidth: string;
  sizePercent: string;
  maxWidthLabel: string;
  maxWidthHint: string;
  percentLabel: string;
  percentHint: string;
  backgroundLabel: string;
  /** `{format}`: JPG o BMP. */
  backgroundHint: string;
  privacyNote: string;
  gifNote: string;
  /** Se pinta sobre la lista: el tamaño final no se sabe hasta convertir. */
  progressFile: string;
  filenameSuffix: string;
  zipName: string;
  /** Frase bajo «Listo»: el resultado son imagenes (o un ZIP), no «un documento» como dice el texto general. */
  doneSubtitle: string;
  /** `{format}`, `{before}`, `{after}`. */
  summaryOne: string;
  /** `{n}`, `{format}`, `{before}`, `{after}`. */
  summaryMany: string;
  /** `{ok}` de `{total}`. */
  noticeTitleFailures: string;
  noticeTitleCapped: string;
  noticeTitleBoth: string;
  /** `{name}`, `{reason}`. */
  noticeFailureLine: string;
  /** `{name}`, `{width}`, `{height}`. */
  noticeCappedLine: string;
  problemsTitleOne: string;
  /** `{n}`. */
  problemsTitleMany: string;
  problemsHint: string;
  removeAndContinue: string;
  /** Tras el nombre del archivo: «está vacío (0 bytes).». `{max}` en `tooBig` y `tooManyPixels`. */
  problemLine: Record<ConvertProblem, string>;
  detailsSummary: string;
  detailsCapped: string;
};

export const STRINGS: Record<Language, ImageConverterStrings> = {
  es: {
    formatLabel: "Formato de salida",
    unavailableNote: "{formats}: este navegador no sabe crearlo, por eso no aparece. Prueba en otro navegador si lo necesitas.",
    qualityLabel: "Calidad",
    qualityHint: "Más calidad, más peso. Con 90 % casi no se nota la diferencia con el original.",
    losslessHint: "PNG no pierde calidad al guardarse, así que no hay nada que ajustar (el archivo puede pesar más que un JPG).",
    bmpHint: "BMP no se comprime: el archivo pesa mucho más. Úsalo solo si lo necesitas.",
    sizeLabel: "Tamaño",
    sizeOriginal: "Original",
    sizeMaxWidth: "Ancho máx.",
    sizePercent: "Porcentaje",
    maxWidthLabel: "Ancho máximo (px)",
    maxWidthHint: "Se conserva la proporción. Nunca se amplía: una imagen más estrecha se queda como está.",
    percentLabel: "Escala",
    percentHint: "Se conserva la proporción.",
    backgroundLabel: "Color de fondo",
    backgroundHint: "{format} no guarda transparencia: lo transparente se rellena con este color.",
    privacyNote:
      "Se aplica la orientación de la foto, se borran los metadatos (ubicación, cámara, fecha) y los colores pasan a sRGB. Todo ocurre en tu dispositivo.",
    gifNote: "De un GIF animado se usa solo el primer fotograma.",
    progressFile: "Convirtiendo imagen {n} de {total}…",
    filenameSuffix: "convertida",
    zipName: "imagenes-convertidas",
    doneSubtitle: "Tu archivo está preparado para descargar.",
    summaryOne: "Convertida a {format}: de {before} a {after}.",
    summaryMany: "{n} imágenes convertidas a {format}: de {before} a {after} en total.",
    noticeTitleFailures: "{ok} de {total} imágenes convertidas. No se pudo convertir:",
    noticeTitleCapped: "Algunas imágenes se redujeron más de lo pedido:",
    noticeTitleBoth: "{ok} de {total} imágenes convertidas. Revisa estos avisos:",
    noticeFailureLine: "{name}: {reason}",
    noticeCappedLine: "{name}: se redujo a {width} × {height} px porque este dispositivo no puede dibujar imágenes más grandes.",
    problemsTitleOne: "1 imagen no se puede convertir",
    problemsTitleMany: "{n} imágenes no se pueden convertir",
    problemsHint: "Quítalas para continuar; si no, se omiten al convertir y el resultado las nombra.",
    removeAndContinue: "Quitar y continuar",
    problemLine: {
      empty: "está vacía (0 bytes).",
      notImage: "no es una imagen válida.",
      truncated: "está incompleta: el archivo se cortó.",
      corrupt: "está dañada.",
      heic: "es HEIC y este navegador no puede abrirlo. Prueba en Safari o exporta la foto como JPEG.",
      unreadable: "no se pudo abrir en este navegador.",
      tooBig: "pesa demasiado para abrirla en este dispositivo (máximo {max}).",
      tooManyPixels: "tiene demasiados píxeles para abrirla en este dispositivo (máximo {max} Mpx).",
      encodeFailed: "se abrió, pero este navegador no pudo guardarla en el formato elegido. Prueba con otro formato.",
      batchFull: "no cupo en esta tanda (la memoria del ZIP está llena). Conviértela aparte.",
    },
    detailsSummary: "Ver el tamaño de cada archivo",
    detailsCapped: "reducida al límite del dispositivo",
  },
  en: {
    formatLabel: "Output format",
    unavailableNote: "{formats}: this browser cannot create it, so it is not listed. Try another browser if you need it.",
    qualityLabel: "Quality",
    qualityHint: "More quality, bigger file. At 90 % the difference from the original is hard to see.",
    losslessHint: "PNG does not lose quality when saved, so there is nothing to adjust (the file can be bigger than a JPG).",
    bmpHint: "BMP is not compressed: the file is much bigger. Use it only if you need it.",
    sizeLabel: "Size",
    sizeOriginal: "Original",
    sizeMaxWidth: "Max width",
    sizePercent: "Percentage",
    maxWidthLabel: "Maximum width (px)",
    maxWidthHint: "The proportions are kept. It is never enlarged: a narrower image stays as it is.",
    percentLabel: "Scale",
    percentHint: "The proportions are kept.",
    backgroundLabel: "Background color",
    backgroundHint: "{format} does not keep transparency: transparent areas are filled with this color.",
    privacyNote:
      "The photo's orientation is applied, metadata (location, camera, date) is removed and colors are converted to sRGB. Everything happens on your device.",
    gifNote: "For an animated GIF only the first frame is used.",
    progressFile: "Converting image {n} of {total}…",
    filenameSuffix: "converted",
    zipName: "converted-images",
    doneSubtitle: "Your file is ready to download.",
    summaryOne: "Converted to {format}: from {before} to {after}.",
    summaryMany: "{n} images converted to {format}: from {before} to {after} in total.",
    noticeTitleFailures: "{ok} of {total} images converted. Could not convert:",
    noticeTitleCapped: "Some images were reduced more than you asked:",
    noticeTitleBoth: "{ok} of {total} images converted. Please check these notices:",
    noticeFailureLine: "{name}: {reason}",
    noticeCappedLine: "{name}: reduced to {width} × {height} px because this device cannot draw larger images.",
    problemsTitleOne: "1 image cannot be converted",
    problemsTitleMany: "{n} images cannot be converted",
    problemsHint: "Remove them to continue; otherwise they are skipped when converting and the result names them.",
    removeAndContinue: "Remove and continue",
    problemLine: {
      empty: "is empty (0 bytes).",
      notImage: "is not a valid image.",
      truncated: "is incomplete: the file was cut short.",
      corrupt: "is damaged.",
      heic: "is HEIC and this browser cannot open it. Try Safari or export the photo as JPEG.",
      unreadable: "could not be opened in this browser.",
      tooBig: "is too big to open on this device (maximum {max}).",
      tooManyPixels: "has too many pixels to open on this device (maximum {max} MP).",
      encodeFailed: "was opened, but this browser could not save it in the chosen format. Try another format.",
      batchFull: "did not fit in this batch (the ZIP memory is full). Convert it separately.",
    },
    detailsSummary: "See the size of each file",
    detailsCapped: "reduced to the device limit",
  },
};

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
