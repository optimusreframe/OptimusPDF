import { applyFilterTo, resolveFilter, type ResolvedFilter } from "@/lib/scan/filters";
import { inverseHomography, isDegenerateQuad, isFullFrameQuad, quadOutputSize, warpRowsInto, DEFAULT_QUAD, type QuadCorners } from "@/lib/scan/perspective";
import { downscaleRgba, fitSide, type Rgba } from "@/lib/scan/pixels";
import { measurePage, type PageQuality } from "@/lib/scan/quality";
import type { ScanFilterMode, ScanMode, ScanPageAdjust, ScanRotation } from "@/lib/scan/types";

/**
 * Nucleo de PROCESADO de una pagina (puro, sobre pixeles; sin canvas): recorte con perspectiva + giro (en un solo remuestreo,
 * sin una pasada extra de rotacion) + filtro + brillo/contraste. SIEMPRE parte de los pixeles del original que recibe y no
 * los modifica. Trabaja por bandas y cede el hilo entre ellas (`yield`), asi una foto de 12 Mpx no pasa de ~100 ms seguidos
 * en el hilo principal. Lo ejecutan igual el Web Worker y el respaldo del hilo principal.
 */

export type RenderJob = {
  corners: QuadCorners | null;
  rotation: ScanRotation;
  filter: ScanFilterMode;
  adjust: ScanPageAdjust;
  mode: ScanMode;
  /** Lado largo maximo de la salida. */
  maxSide: number;
};

export type RenderHooks = {
  /** Cede el hilo (se llama entre bandas). */
  yield?: () => Promise<void> | void;
  signal?: AbortSignal;
};

export type RenderOutput = {
  image: Rgba;
  resolved: ResolvedFilter;
  /** Lectura de calidad del recorte SIN filtrar (solo si se pidio). */
  quality: PageQuality | null;
};

/** Proporcion ISO/IEC 7810 ID-1 (tarjeta de identificacion). */
export const ID_CARD_RATIO = 85.6 / 53.98;

export function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Gira las esquinas `quarters` cuartos de vuelta horarios: la nueva esquina superior izquierda es la inferior izquierda anterior. */
export function rotateQuad(quad: QuadCorners, quarters: number): QuadCorners {
  let current = quad;
  const turns = ((Math.round(quarters) % 4) + 4) % 4;
  for (let i = 0; i < turns; i += 1) {
    current = { topLeft: current.bottomLeft, topRight: current.topLeft, bottomRight: current.topRight, bottomLeft: current.bottomRight };
  }
  return current;
}

/** ¿Hay que remuestrear (recorte, perspectiva o giro) o basta con copiar? */
export function needsWarp(corners: QuadCorners | null, rotation: ScanRotation, mode: ScanMode): boolean {
  if (mode === "photo") return rotation !== 0;
  if (rotation !== 0) return true;
  return !!corners && !isDegenerateQuad(corners) && !isFullFrameQuad(corners);
}

/** Tamano de salida: lados del cuadrilatero, acotado a `maxSide` (nunca amplia) y con la proporcion de tarjeta en `id-card`. */
export function planOutputSize(quad: QuadCorners, source: { width: number; height: number }, mode: ScanMode, maxSide: number): { width: number; height: number } {
  let { width, height } = quadOutputSize(quad, source.width, source.height);
  if (mode === "id-card") {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (Math.abs(long / short - ID_CARD_RATIO) / ID_CARD_RATIO < 0.18) {
      const fixedShort = Math.round(long / ID_CARD_RATIO);
      if (width >= height) height = fixedShort;
      else width = fixedShort;
    }
  }
  const fitted = fitSide(width, height, maxSide);
  return { width: fitted.width, height: fitted.height };
}

/** Endereza por bandas con cesion del hilo. */
export async function warpBands(source: Rgba, quad: QuadCorners, size: { width: number; height: number }, hooks: RenderHooks): Promise<Rgba | null> {
  const { width, height } = size;
  const homography = inverseHomography(quad, source.width, source.height, width, height);
  if (!homography) return null;
  const data = new Uint8ClampedArray(width * height * 4);
  const rows = Math.max(8, Math.floor(450_000 / width));
  for (let y = 0; y < height; y += rows) {
    abortIfNeeded(hooks.signal);
    warpRowsInto(source, homography, width, y, Math.min(height, y + rows), data);
    if (hooks.yield && y + rows < height) await hooks.yield();
  }
  return { data, width, height };
}

/** Recorte + giro (sin filtro). Devuelve una copia: el origen no se toca. */
export async function cropAndRotate(source: Rgba, job: Pick<RenderJob, "corners" | "rotation" | "mode" | "maxSide">, hooks: RenderHooks = {}): Promise<Rgba> {
  abortIfNeeded(hooks.signal);
  if (!needsWarp(job.corners, job.rotation, job.mode)) {
    // Sin remuestreo: copia (reducida si hace falta) para poder filtrar sin tocar el origen.
    const fitted = fitSide(source.width, source.height, job.maxSide);
    if (fitted.scale < 1) return downscaleRgba(source, job.maxSide);
    return { data: new Uint8ClampedArray(source.data), width: source.width, height: source.height };
  }
  const base = job.mode !== "photo" && job.corners && !isDegenerateQuad(job.corners) ? job.corners : DEFAULT_QUAD;
  const quad = rotateQuad(base, job.rotation / 90);
  const size = planOutputSize(quad, source, job.mode, job.maxSide);
  const warped = await warpBands(source, quad, size, hooks);
  if (warped) return warped;
  return { data: new Uint8ClampedArray(source.data), width: source.width, height: source.height };
}

/** Procesado completo de una pagina a partir de los pixeles del original. */
export async function renderRgba(
  source: Rgba,
  job: RenderJob,
  hooks: RenderHooks = {},
  options: { measure?: boolean; onCrop?: (crop: Rgba) => void } = {},
): Promise<RenderOutput> {
  const image = await cropAndRotate(source, job, hooks);
  const quality = options.measure ? measurePage(image) : null;
  options.onCrop?.(image);
  abortIfNeeded(hooks.signal);
  const resolved = resolveFilter(job.filter, job.mode, image);
  await applyFilterTo(image, resolved, job.adjust, { onBand: hooks.yield });
  abortIfNeeded(hooks.signal);
  return { image, resolved, quality };
}

/** Miniatura: lado largo `side` (por promedio de bloques). */
export function thumbnailOf(image: Rgba, side = 360): Rgba {
  return downscaleRgba(image, side);
}
