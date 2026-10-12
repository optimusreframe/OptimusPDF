import type { NormalizedRect } from "@/lib/pdf/core";

/**
 * Matematica del recorte por margenes de PDF Pro (Wave 7 · U5): convierte los margenes numericos (mm)
 * en el rectangulo normalizado (0..1, origen arriba-izquierda) que consume `cropPdf`, y a la inversa
 * (para que el visor pueda mostrar/arrastrar la seleccion; ver `cropOverlay.ts`).
 */

export const POINTS_PER_INCH = 72;
export const MM_PER_INCH = 25.4;

export const pointsToMm = (points: number): number => (points * MM_PER_INCH) / POINTS_PER_INCH;
export const mmToPoints = (mm: number): number => (mm * POINTS_PER_INCH) / MM_PER_INCH;

export type CropMargins = { top: number; right: number; bottom: number; left: number };

export const ZERO_MARGINS: CropMargins = { top: 0, right: 0, bottom: 0, left: 0 };

/** Tamano de la pagina de referencia, en mm. */
export type PageMm = { width: number; height: number };

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Margenes saneados (>= 0). */
export function sanitizeMargins(margins: CropMargins): CropMargins {
  return {
    top: finite(margins.top),
    right: finite(margins.right),
    bottom: finite(margins.bottom),
    left: finite(margins.left),
  };
}

/** Hay algun margen mayor que 0. */
export function hasAnyMargin(margins: CropMargins): boolean {
  const m = sanitizeMargins(margins);
  return m.top > 0 || m.right > 0 || m.bottom > 0 || m.left > 0;
}

/**
 * Rectangulo que SE CONSERVA tras quitar los margenes. Puede salir con ancho o alto <= 0 si los margenes
 * se comen la pagina: quien llama lo comprueba (`cropCanRun`).
 */
export function marginsToRect(margins: CropMargins, page: PageMm): NormalizedRect {
  const m = sanitizeMargins(margins);
  const width = page.width > 0 ? page.width : 1;
  const height = page.height > 0 ? page.height : 1;
  return {
    x: m.left / width,
    y: m.top / height,
    width: 1 - (m.left + m.right) / width,
    height: 1 - (m.top + m.bottom) / height,
  };
}

/** Inversa de `marginsToRect`: de la seleccion arrastrada en el visor a margenes en mm. */
export function rectToMargins(rect: NormalizedRect, page: PageMm): CropMargins {
  return {
    left: rect.x * page.width,
    top: rect.y * page.height,
    right: (1 - rect.x - rect.width) * page.width,
    bottom: (1 - rect.y - rect.height) * page.height,
  };
}

/** Redondea a una decima de mm (lo que muestra la interfaz). */
export function roundMm(value: number): number {
  return Math.round(value * 10) / 10;
}

/** «Igual en todas»: el mismo valor en los cuatro lados. */
export function uniformMargins(value: number): CropMargins {
  return { top: value, right: value, bottom: value, left: value };
}
