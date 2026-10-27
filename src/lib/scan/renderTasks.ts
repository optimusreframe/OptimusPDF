import { applyFilterTo, backgroundMapsFor } from "@/lib/scan/filters";
import { decodeToRgba, encodeRgba, readDisplaySize, reencodedSizes } from "@/lib/scan/renderIO";
import { abortIfNeeded, cropAndRotate, needsWarp, renderRgba, thumbnailOf, type RenderHooks, type RenderJob } from "@/lib/scan/renderCore";
import { detectTextOrientation, type OrientationReading } from "@/lib/scan/orientation";
import { resolveFilter, type ResolvedFilter } from "@/lib/scan/filters";
import { cropRgba, downscaleRgba, type Rgba } from "@/lib/scan/pixels";
import { computeSignature, type PageSignature } from "@/lib/scan/similarity";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { ScanFilterMode, ScanMode, ScanRotation } from "@/lib/scan/types";

/**
 * Tareas de pixeles del Escaner. Se ejecutan IGUAL en un Web Worker (`renderWorker.ts`) que en el hilo principal (respaldo
 * si el navegador no ofrece worker/OffscreenCanvas): una tarea decodifica el original, lo procesa (`renderCore`) y devuelve
 * resultados pequenos (blobs, lecturas de calidad, firma de la hoja). El original nunca se modifica.
 */

export type PageQualityReading = { blurry: boolean; glare: boolean; dark: boolean; blank: boolean; sparse: boolean; sharpness: number | null };

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
      /**
       * La pagina podria no necesitar procesado (sin recorte ni giro): se mira primero con una copia pequena y, si el filtro
       * resuelto no toca los pixeles (`original`/`color`) y no hay ajuste, el resultado ES el original (`passthrough`).
       */
      passthroughCandidate?: boolean;
      /** Mide el peso de una muestra JPEG del resultado (para estimar el PDF). */
      sampleBytes?: boolean;
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
      /** El resultado es el propio original (sin recodificar). `processed` viene `null`: el motor usa el original. */
      passthrough: boolean;
      jpegSample: JpegSample | null;
    }
  | { kind: "ingest"; blob: Blob }
  | { kind: "orientation"; reading: OrientationReading | null }
  | { kind: "sample"; image: Rgba };

/** Cache de la ultima imagen decodificada (por contexto): evita decodificar dos veces al crear una pagina. */
let cache: { token: string; image: Rgba } | null = null;

export function clearTaskCache(): void {
  cache = null;
}

/** Lado de la copia con la que se decide si una pagina necesita procesado. */
const PEEK_SIDE = 1280;
/** Lado del parche a resolucion nativa con el que se mide el peso del resultado. */
export const PATCH_SIDE = 128;
/** Cuadricula 7 x 7 de parches pequenos sobre el documento: margenes y centro pesan lo que ocupan (un parche central sobrestima). */
const GRID = [0.07, 0.21, 0.36, 0.5, 0.64, 0.79, 0.93];
const PATCH_SPOTS: ReadonlyArray<[number, number]> = GRID.flatMap((fy) => GRID.map((fx): [number, number] => [fx, fy]));
/** Mayor lado al que se decodifica el original para medir (resolucion nativa hasta aqui). */
const NATIVE_SAMPLE_MAX_SIDE = 4096;
const THUMB_QUALITY = 0.8;
const PROCESSED_QUALITY = 0.9;
/** Calidades JPEG de los presets (Alta, Equilibrada, Compacta): se miden en los mismos parches para estimar cada preset con el peso REAL de este contenido. */
const PRESET_QUALITIES = [0.92, 0.87, 0.8] as const;
/** Uno de cada tantos parches mide tambien la recodificacion a las calidades de los presets. */
const RATIO_EVERY = 4;
type JpegSample = { side: number; bytesPerPixel: number; qualityRatio?: Record<string, number> };

/**
 * Mide el peso por pixel del resultado con parches del original a su resolucion NATIVA (cuarenta y nueve, en cuadricula sobre el documento, con
 * el filtro y el ajuste de la pagina), codificados a la calidad del resultado. Reducir la foto para medirla perderia el ruido y
 * subestimaria el peso real (sobre todo con filtros que lo realzan); un solo parche central sobrestima las hojas con texto solo
 * en el centro.
 */
async function measureNativeSample(source: Blob, job: RenderJob, resolved: ResolvedFilter, hooks: RenderHooks): Promise<JpegSample | null> {
  let native: Rgba;
  try {
    native = await decodeToRgba(source, NATIVE_SAMPLE_MAX_SIDE, hooks.signal);
  } catch {
    return null;
  }
  const quad = job.mode !== "photo" ? job.corners : null;
  // Los parches caen DENTRO de la hoja (interpolacion bilineal del cuadrilatero), no en el escritorio de las esquinas del recuadro.
  const at = (fx: number, fy: number): { x: number; y: number } => {
    if (!quad) return { x: fx * native.width, y: fy * native.height };
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const top = lerp(quad.topLeft, quad.topRight, fx);
    const bottom = lerp(quad.bottomLeft, quad.bottomRight, fx);
    const point = lerp(top, bottom, fy);
    return { x: point.x * native.width, y: point.y * native.height };
  };
  const side = Math.max(16, Math.min(PATCH_SIDE, native.width, native.height));
  const maps = backgroundMapsFor(native.width > 1280 || native.height > 1280 ? downscaleRgba(native, 1280) : native, native.width, native.height);
  // Cabeceras y tablas de un JPEG pequeno: se miden con un parche liso y se restan (en parches pequenos pesan casi como el contenido).
  const blank: Rgba = { data: new Uint8ClampedArray(side * side * 4).fill(255), width: side, height: side };
  const qualities = [PROCESSED_QUALITY, ...PRESET_QUALITIES];
  const overhead = new Map<number, number>();
  for (const quality of qualities) overhead.set(quality, (await encodeRgba(blank, "image/jpeg", quality)).size);
  const bytes = new Map<number, number>(qualities.map((quality) => [quality, 0]));
  const ratioBytes = new Map<number, number>();
  let ratioBase = 0;
  let spot = 0;
  let pixels = 0;
  for (const [fx, fy] of PATCH_SPOTS) {
    abortIfNeeded(hooks.signal);
    const centre = at(fx, fy);
    const left = Math.min(native.width - side, Math.max(0, centre.x - side / 2));
    const top = Math.min(native.height - side, Math.max(0, centre.y - side / 2));
    const patch = cropRgba(native, left, top, side, side);
    // El filtro usa el FONDO de toda la hoja (no el del parche): un parche solo de texto no tiene papel de referencia.
    await applyFilterTo(patch, resolved, job.adjust, { background: { maps, x: left, y: top } });
    // El peso del resultado procesado (calidad 0,9) y, para cada preset, lo que pesaria RECODIFICARLO (lo que hace `prepareForPdf`
    // con el JPEG ya procesado: decodificarlo y volver a codificar). Recodificar un JPEG ya comprimido ahorra mas que comprimir
    // pixeles sin tocar, y cuanto mas depende del codificador de cada navegador: por eso se mide, no se supone.
    const first = await encodeRgba(patch, "image/jpeg", PROCESSED_QUALITY);
    bytes.set(PROCESSED_QUALITY, (bytes.get(PROCESSED_QUALITY) ?? 0) + Math.max(0, first.size - (overhead.get(PROCESSED_QUALITY) ?? 0)));
    // La relacion entre calidades es estable de un parche a otro: se mide solo en uno de cada RATIO_EVERY (cuatro recodificaciones por
    // parche pesan en WebKit) y se compara con el peso a 0,9 de ESOS mismos parches.
    if (spot % RATIO_EVERY === 0) {
      const sizes = await reencodedSizes(first, PRESET_QUALITIES, hooks.signal);
      if (sizes) {
        ratioBase += Math.max(0, first.size - (overhead.get(PROCESSED_QUALITY) ?? 0));
        PRESET_QUALITIES.forEach((quality, index) => ratioBytes.set(quality, (ratioBytes.get(quality) ?? 0) + Math.max(0, sizes[index] - (overhead.get(quality) ?? 0))));
      }
    }
    spot += 1;
    pixels += patch.width * patch.height;
  }
  const base = bytes.get(PROCESSED_QUALITY) ?? 0;
  if (pixels > 0 && base > 0) {
    if (ratioBase > 0) {
      const qualityRatio: Record<string, number> = {};
      for (const quality of PRESET_QUALITIES) qualityRatio[String(quality)] = Math.max(0.2, Math.min(2, (ratioBytes.get(quality) ?? 0) / ratioBase));
      return { side, bytesPerPixel: base / pixels, qualityRatio };
    }
    return { side, bytesPerPixel: base / pixels };
  }
  return pixels > 0 ? { side, bytesPerPixel: base / pixels } : null;
}

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
      const header = request.source.size > 0 ? await readDisplaySize(request.source) : null;
      const zeroAdjust = request.job.adjust.brightness === 0 && request.job.adjust.contrast === 0;
      const candidate = request.encodeProcessed && request.passthroughCandidate === true && zeroAdjust && !needsWarp(request.job.corners, request.job.rotation, request.job.mode);
      // Candidata a «sin procesar»: basta una copia pequena para saber que filtro se aplicaria.
      let source = cached ?? (await decodeToRgba(request.source, candidate ? PEEK_SIDE : request.decodeMax, hooks.signal));
      let passthrough = false;
      let resolvedEarly: ResolvedFilter | null = null;
      if (candidate) {
        resolvedEarly = resolveFilter(request.job.filter, request.job.mode, source);
        passthrough = resolvedEarly === "original" || resolvedEarly === "color";
        // Hace falta procesar de verdad (p. ej. `auto` resolvio «mejorado»): se decodifica a resolucion completa.
        if (!passthrough) source = await decodeToRgba(request.source, request.decodeMax, hooks.signal);
      }
      const sourceSize = header ? { width: header.width, height: header.height } : { width: source.width, height: source.height };
      let signature: PageSignature | null = null;
      const job = passthrough ? { ...request.job, maxSide: Math.min(request.job.maxSide, PEEK_SIDE) } : request.job;
      const output = await renderRgba(source, job, hooks, {
        measure: request.measure,
        onCrop: request.signature ? (crop) => (signature = computeSignature(crop)) : undefined,
      });
      abortIfNeeded(hooks.signal);
      const processed = request.encodeProcessed && !passthrough ? await encodeRgba(output.image, "image/jpeg", PROCESSED_QUALITY) : null;
      const thumb = request.thumbSide ? await encodeRgba(thumbnailOf(output.image, request.thumbSide), "image/jpeg", THUMB_QUALITY) : null;
      let jpegSample: JpegSample | null = null;
      // Una pagina que sera su propio original (sin recorte, giro, ajuste ni filtro que toque pixeles) se estima por los bytes del archivo.
      const identityLike = !needsWarp(request.job.corners, request.job.rotation, request.job.mode) && zeroAdjust && (output.resolved === "original" || output.resolved === "color");
      if (request.sampleBytes && !passthrough && !identityLike) {
        jpegSample = await measureNativeSample(request.source, request.job, output.resolved, hooks);
      }
      const quality = output.quality
        ? { blurry: output.quality.blurry, glare: output.quality.glare, dark: output.quality.dark, blank: output.quality.blank, sparse: output.quality.sparse, sharpness: output.quality.sharpness }
        : null;
      return {
        kind: "render",
        processed,
        processedSize: processed ? { width: output.image.width, height: output.image.height } : passthrough ? { width: sourceSize.width, height: sourceSize.height } : null,
        thumb,
        resolved: resolvedEarly ?? output.resolved,
        quality,
        signature,
        pixels: request.pixels ? output.image : null,
        sourceSize,
        passthrough,
        jpegSample,
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
