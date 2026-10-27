import { decodeToRgba, encodeRgba, readDisplaySize } from "@/lib/scan/renderIO";
import { abortIfNeeded, cropAndRotate, renderRgba, thumbnailOf, type RenderHooks, type RenderJob } from "@/lib/scan/renderCore";
import { detectTextOrientation, type OrientationReading } from "@/lib/scan/orientation";
import type { ResolvedFilter } from "@/lib/scan/filters";
import { downscaleRgba, type Rgba } from "@/lib/scan/pixels";
import { computeSignature, type PageSignature } from "@/lib/scan/similarity";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { ScanFilterMode, ScanMode, ScanRotation } from "@/lib/scan/types";

/**
 * Tareas de pixeles del Escaner. Se ejecutan IGUAL en un Web Worker (`renderWorker.ts`) que en el hilo principal (respaldo
 * si el navegador no ofrece worker/OffscreenCanvas): una tarea decodifica el original, lo procesa (`renderCore`) y devuelve
 * resultados pequenos (blobs, lecturas de calidad, firma de la hoja). El original nunca se modifica.
 */

export type PageQualityReading = { blurry: boolean; glare: boolean; dark: boolean; blank: boolean; sharpness: number | null };

export type TaskRequest =
  /** Decodifica reducido (para detectar el documento en el hilo principal). Deja la imagen en cache bajo `token`. */
  | { kind: "decode"; source: Blob; maxSide: number; token: string }
  /** Procesa la pagina: recorte+giro+filtro, miniatura, JPEG final, calidad y firma. */
  | {
      kind: "render";
      source: Blob;
      job: RenderJob;
      /** Lado largo al que se decodifica el original. */
      decodeMax: number;
      /** Reusa la imagen decodificada por `decode` con este token (si sigue en cache). */
      token?: string;
      thumbSide: number | null;
      encodeProcessed: boolean;
      measure: boolean;
      signature: boolean;
      /** Devuelve ademas los pixeles del resultado (para el OCR). */
      pixels?: boolean;
    }
  /** Corrige la orientacion EXIF de un JPEG y lo recodifica (solo cuando el original trae EXIF distinto de 1). */
  | { kind: "ingest"; source: Blob; quality: number }
  /** Orientacion del texto de la pagina (heuristica por proyeccion) sin giro previo. */
  | { kind: "orientation"; source: Blob; corners: QuadCorners | null; mode: ScanMode }
  /** Recorte sin filtrar, para el OCR o la firma, a un lado largo dado. */
  | { kind: "sample"; source: Blob; corners: QuadCorners | null; rotation: ScanRotation; mode: ScanMode; maxSide: number; topFraction?: number };

export type TaskResult =
  | { kind: "decode"; image: Rgba }
  | {
      kind: "render";
      processed: Blob | null;
      processedSize: { width: number; height: number } | null;
      thumb: Blob | null;
      resolved: ResolvedFilter;
      quality: PageQualityReading | null;
      signature: PageSignature | null;
      pixels: Rgba | null;
      sourceSize: { width: number; height: number };
    }
  | { kind: "ingest"; blob: Blob }
  | { kind: "orientation"; reading: OrientationReading | null }
  | { kind: "sample"; image: Rgba };

/** Cache de la ultima imagen decodificada (por contexto): evita decodificar dos veces al crear una pagina. */
let cache: { token: string; image: Rgba } | null = null;

export function clearTaskCache(): void {
  cache = null;
}

const THUMB_QUALITY = 0.8;
const PROCESSED_QUALITY = 0.9;

export async function runTask(request: TaskRequest, hooks: RenderHooks = {}): Promise<TaskResult> {
  abortIfNeeded(hooks.signal);
  switch (request.kind) {
    case "decode": {
      const image = await decodeToRgba(request.source, request.maxSide, hooks.signal);
      cache = { token: request.token, image };
      // El llamador recibe una copia: la cache conserva la suya (el buffer enviado se transfiere).
      return { kind: "decode", image: { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height } };
    }
    case "render": {
      const cached = request.token && cache && cache.token === request.token ? cache.image : null;
      // La cache es de un solo uso: se libera en cuanto se consume (o se descarta si era de otra pagina).
      cache = null;
      const source = cached ?? (await decodeToRgba(request.source, request.decodeMax, hooks.signal));
      const header = request.source.size > 0 ? await readDisplaySize(request.source) : null;
      const sourceSize = header ? { width: header.width, height: header.height } : { width: source.width, height: source.height };
      let signature: PageSignature | null = null;
      const output = await renderRgba(source, request.job, hooks, {
        measure: request.measure,
        onCrop: request.signature ? (crop) => (signature = computeSignature(crop)) : undefined,
      });
      abortIfNeeded(hooks.signal);
      const processed = request.encodeProcessed ? await encodeRgba(output.image, "image/jpeg", PROCESSED_QUALITY) : null;
      const thumb = request.thumbSide ? await encodeRgba(thumbnailOf(output.image, request.thumbSide), "image/jpeg", THUMB_QUALITY) : null;
      const quality = output.quality
        ? { blurry: output.quality.blurry, glare: output.quality.glare, dark: output.quality.dark, blank: output.quality.blank, sharpness: output.quality.sharpness }
        : null;
      return {
        kind: "render",
        processed,
        processedSize: processed ? { width: output.image.width, height: output.image.height } : null,
        thumb,
        resolved: output.resolved,
        quality,
        signature,
        pixels: request.pixels ? output.image : null,
        sourceSize,
      };
    }
    case "ingest": {
      const image = await decodeToRgba(request.source, 16_000, hooks.signal);
      return { kind: "ingest", blob: await encodeRgba(image, "image/jpeg", request.quality) };
    }
    case "orientation": {
      const source = await decodeToRgba(request.source, 900, hooks.signal);
      const crop = await cropAndRotate(source, { corners: request.corners, rotation: 0, mode: request.mode, maxSide: 700 }, hooks);
      return { kind: "orientation", reading: detectTextOrientation(crop) };
    }
    case "sample": {
      const source = await decodeToRgba(request.source, Math.max(request.maxSide * 1.6, 1200), hooks.signal);
      let crop = await cropAndRotate(source, { corners: request.corners, rotation: request.rotation, mode: request.mode, maxSide: request.maxSide }, hooks);
      if (request.topFraction && request.topFraction < 1) {
        const rows = Math.max(1, Math.round(crop.height * request.topFraction));
        crop = { data: crop.data.slice(0, rows * crop.width * 4), width: crop.width, height: rows };
      }
      return { kind: "sample", image: crop };
    }
  }
}

/** Atajo: reduce una imagen ya decodificada (para el detector en el hilo principal). */
export function reduced(image: Rgba, side: number): Rgba {
  return downscaleRgba(image, side);
}

export type { ScanFilterMode };
