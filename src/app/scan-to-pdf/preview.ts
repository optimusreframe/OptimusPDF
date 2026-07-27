import type { ScanFilter } from "@/lib/pdf/scanToPdf";

/**
 * Equivalente CSS aproximado del filtro que `applyScanFilter` aplica al
 * generar el PDF. Solo se usa para previsualizar: el resultado real lo
 * calcula el motor pixel a pixel.
 */
export function previewFilter(filter: ScanFilter): string | undefined {
  return filter === "bw"
    ? "grayscale(1) contrast(1.35) brightness(1.03)"
    : undefined;
}
