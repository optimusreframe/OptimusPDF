import {
  PdfError,
  getPageGeometry,
  loadPdf,
  normalizedRectToUserBox,
  pdfBytesToBlob,
  savePdfToBytes,
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

/**
 * `range` (PDF Pro): de `fromPage` a `toPage` (1-based, inclusive; 0 en `toPage` = hasta el final).
 * La herramienta suelta solo ofrece `all` y `current`.
 */
export type CropScope = "all" | "current" | "range";

export type CropOptions = {
  /** Seleccion 0..1 sobre la vista renderizada, origen arriba-izquierda. */
  rect: NormalizedRect;
  scope: CropScope;
  /** Pagina mostrada en la vista previa (indice 0). */
  pageIndex: number;
  /** Solo con `scope: "range"`. */
  fromPage?: number;
  toPage?: number;
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

/** Indices (0-based) de las paginas a recortar. */
export function cropTargets(options: CropOptions, pageCount: number): number[] {
  if (options.scope === "current") {
    return [Math.min(Math.max(0, options.pageIndex), pageCount - 1)];
  }
  if (options.scope === "range") {
    const from = Math.min(Math.max(1, Math.floor(options.fromPage ?? 1) || 1), pageCount);
    const rawTo = Math.floor(options.toPage ?? 0) || pageCount;
    const to = Math.min(Math.max(from, rawTo), pageCount);
    return Array.from({ length: to - from + 1 }, (_, step) => from - 1 + step);
  }
  return Array.from({ length: pageCount }, (_, index) => index);
}

export async function cropPdf(
  file: File,
  options: CropOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return pdfBytesToBlob(await cropPdfToBytes(file, options, onProgress));
}

/**
 * Igual que `cropPdf`, pero devuelve los BYTES del PDF resultante (`Uint8Array`) sin pasar por un `Blob`: para quien sigue
 * trabajando con bytes (PDF Pro). Mismos bytes que el `Blob` de `cropPdf`.
 */
export async function cropPdfToBytes(
  file: File,
  options: CropOptions,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    const document = await loadPdf(file);
    onProgress?.(0.2);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const rect = sanitizeRect(options.rect);
    const targets = cropTargets(options, pages.length);

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

    const bytes = await savePdfToBytes(document);
    onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  }
}
