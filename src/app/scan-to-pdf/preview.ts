import type { ScanFilter } from "@/lib/pdf/scanToPdf";

/**
 * Equivalente CSS aproximado del filtro que `applyScanFilter` aplica al
 * generar el PDF. Solo se usa para previsualizar: el resultado real lo
 * calcula el motor pixel a pixel.
 */
export function previewFilter(filter: ScanFilter): string | undefined {
  switch (filter) {
    case "bw":
      return "grayscale(1) contrast(1.35) brightness(1.03)";
    case "grayscale":
      return "grayscale(1)";
    case "enhance":
      // El estiramiento de histograma depende de la foto, asi que CSS solo
      // puede insinuarlo con un contraste suave.
      return "contrast(1.18) saturate(1.05)";
    default:
      return undefined;
  }
}
