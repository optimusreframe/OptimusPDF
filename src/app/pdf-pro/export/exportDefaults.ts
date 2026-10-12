import type { ExportFormatId, ExportOptionsMap } from "@/app/pdf-pro/export/exportTypes";

/**
 * Opciones por defecto de cada exportacion. Son LOS MISMOS valores que los `DEFAULT_PDF_TO_*` de los motores
 * (`src/lib/pdf/pdfTo*.ts`), copiados aqui para no importar los motores (y sus librerias pesadas) en el paquete
 * inicial. `exportDefaults.test.ts` comprueba que no se desvian de los motores.
 */
export const DEFAULT_EXPORT_OPTIONS: { [K in ExportFormatId]: ExportOptionsMap[K] } = {
  images: { format: "jpg", quality: 0.92, scale: 2, scope: "all", range: "" },
  text: { ocrFallback: true, pageSeparators: false },
  word: {},
  excel: { stripRepeated: true },
  csv: { format: "csv", stripRepeated: true },
  markdown: {
    detectHeadings: true,
    detectTables: true,
    stripRepeated: true,
    pageSeparators: false,
    ocrFallback: true,
    ocrLanguage: "spa",
  },
  json: { ocrFallback: true },
  powerpoint: { quality: 0.92, scale: 2 },
};

/** Rango de calidad JPEG (copia de `pdfToImages.ts`, que arrastra jszip: aqui no se importa). */
export const JPG_QUALITY_MIN = 0.5;
export const JPG_QUALITY_MAX = 1;

/** Copia fresca de las opciones por defecto de un formato. */
export function defaultExportOptions<K extends ExportFormatId>(id: K): ExportOptionsMap[K] {
  return { ...DEFAULT_EXPORT_OPTIONS[id] };
}

/** `true` si ese formato rasteriza o reconoce paginas con OCR cuando la opcion esta activa (puede necesitar red). */
export function exportUsesOcr<K extends ExportFormatId>(id: K, options: ExportOptionsMap[K]): boolean {
  switch (id) {
    case "text":
    case "markdown":
    case "json":
      return (options as { ocrFallback: boolean }).ocrFallback;
    case "word":
      // `pdfToWord` usa siempre el OCR de respaldo del motor compartido.
      return true;
    default:
      return false;
  }
}
