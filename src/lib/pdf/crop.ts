import {
  PdfError,
  getPageGeometry,
  loadPdf,
  normalizedRectToUserBox,
  savePdfToBlob,
  toPdfError,
  type NormalizedRect,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de recorte: traduce la seleccion hecha sobre la vista previa a
 * un CropBox proporcional al tamano real de cada pagina.
 *
 * Se toca el CropBox y no el MediaBox: el contenido sigue intacto dentro
 * del archivo y el recorte es reversible, que es el comportamiento
 * estandar de "recortar PDF" y la opcion mas conservadora.
 */

export type CropScope = "all" | "current";

export type CropOptions = {
  /** Seleccion 0..1 sobre la vista renderizada, origen arriba-izquierda. */
  rect: NormalizedRect;
  scope: CropScope;
  /** Pagina mostrada en la vista previa (indice 0). */
  pageIndex: number;
};

export const DEFAULT_CROP_RECT: NormalizedRect = {
  x: 0.06,
  y: 0.06,
  width: 0.88,
  height: 0.88,
};

export const DEFAULT_CROP_OPTIONS: CropOptions = {
  rect: DEFAULT_CROP_RECT,
  scope: "all",
  pageIndex: 0,
};

/** Un recorte por debajo de esto deja una pagina inservible. */
const MIN_SIDE_POINTS = 8;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sanitizeRect(rect: NormalizedRect): NormalizedRect {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  return {
    x,
    y,
    width: Math.min(1 - x, Math.max(0.02, rect.width)),
    height: Math.min(1 - y, Math.max(0.02, rect.height)),
  };
}

export async function cropPdf(
  file: File,
  options: CropOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const document = await loadPdf(file);
    onProgress?.(0.2);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const rect = sanitizeRect(options.rect);
    const targets =
      options.scope === "current"
        ? [Math.min(Math.max(0, options.pageIndex), pages.length - 1)]
        : pages.map((_, index) => index);

    for (let step = 0; step < targets.length; step += 1) {
      const page = pages[targets[step]];
      const geometry = getPageGeometry(page);
      const box = normalizedRectToUserBox(geometry, rect);

      // Nunca fuera de la caja visible original.
      const left = Math.max(geometry.box.x, box.x);
      const bottom = Math.max(geometry.box.y, box.y);
      const right = Math.min(geometry.box.x + geometry.box.width, box.x + box.width);
      const top = Math.min(
        geometry.box.y + geometry.box.height,
        box.y + box.height,
      );

      const width = right - left;
      const height = top - bottom;
      if (width < MIN_SIDE_POINTS || height < MIN_SIDE_POINTS) {
        throw new PdfError("empty");
      }

      page.setCropBox(left, bottom, width, height);
      onProgress?.(0.2 + ((step + 1) / targets.length) * 0.75);
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
