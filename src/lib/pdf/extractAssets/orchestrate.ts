/**
 * Orquestador REAL de «Extraer elementos» (U7.3, docs/PLAN-FIRMA-AGIL.md §9.5): abre el PDF con pdf.js (en worker), pasa por el motor
 * de imagenes (U7.1) y el de anotaciones/sellos/marcas de agua (U7.2), recoge el texto y los trazos de cada pagina, fusiona y
 * deduplica, clasifica (`classify.ts`) y ordena: firmas e iniciales primero (por confianza), luego sellos, logos, marcas de agua e
 * imagenes. `renderAsset` regenera los pixeles bajo demanda enrutando por `ref.engine`.
 *
 * Contrato de pruebas de integracion (U7.4): `pageCount` = paginas TOTALES; `onProgress.pageIndex` 0-based; `pageRange` 0-based
 * inclusivo; cancelar rechaza con `PdfError("cancelled")` sin resultados parciales; los errores salen como `PdfError`;
 * `formats[0]` es el formato por defecto; PNG con alfa. Topes: 300 paginas, 500 elementos, imagenes de 50 MP (avisos y `truncated`).
 *
 * Dependencias inyectables (`ExtractEnv`): en el navegador son pdf.js con su worker y canvas; las pruebas en Node usan el build
 * «legacy» y `@napi-rs/canvas`. Todo es local: ninguna peticion de red.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_SAFE_FILE_SIZE, PdfError, closePdfDocument, getPdfJs, openPdfDocument, toPdfError } from "@/lib/pdf/core";
import { findAnnotationAssets, isCancellation, ownsAnnotationAsset, renderAnnotationAsset } from "./annotations";
import { defaultSurfaceFactory } from "./annotationsRaster";
import type { PdfOps, SurfaceFactory, TranslucentImageCandidate } from "./annotationsTypes";
import { classifyAssets, dedupeAssets, sortAssets } from "./classify";
import type { RasterRGBA } from "./classifyTypes";
import { cropRegion } from "./region";
import { findImageAssets, renderImageAsset } from "./images";
import { collectPageFacts } from "./orchestratePages";
import { buildVectorAsset, renderVectorAsset } from "./vectorsRender";
import {
  EXTRACT_LIMITS,
  type AssetFormat,
  type ExtractAssetsApi,
  type ExtractOptions,
  type ExtractResult,
  type ExtractWarning,
  type ExtractedAsset,
} from "./types";

export type ExtractEnv = {
  openDocument(bytes: Uint8Array): Promise<PDFDocumentProxy>;
  closeDocument(doc: PDFDocumentProxy): Promise<void>;
  ops(): Promise<PdfOps>;
  createSurface(): SurfaceFactory;
  /** Decodificador de miniaturas PNG (por defecto el propio del clasificador). */
  decodeThumb?: (thumb: Blob) => Promise<RasterRGBA | null>;
  /** Recorte manual (por defecto el real de `region.ts`). */
  cropRegion?: ExtractAssetsApi["cropRegion"];
};

/** Entorno del navegador (y de la aplicacion): pdf.js con su worker y los canvas del documento. */
export const browserEnv: ExtractEnv = {
  openDocument: (bytes) => openPdfDocument(bytes),
  closeDocument: (doc) => closePdfDocument(doc),
  ops: async () => (await getPdfJs()).OPS as unknown as PdfOps,
  createSurface: () => defaultSurfaceFactory(),
};

/** Error de `renderAsset` con un codigo estable (elemento sin formatos descargables, tipo sin motor...). */
export class ExtractRenderError extends Error {
  readonly code: "no-formats" | "unsupported-format" | "unsupported-asset";
  constructor(code: ExtractRenderError["code"], message?: string) {
    super(message ?? code);
    this.name = "ExtractRenderError";
    this.code = code;
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function cancelled(): PdfError {
  return new PdfError("cancelled");
}

async function bytesOf(file: File | Uint8Array): Promise<Uint8Array> {
  return file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
}

/** `/Encrypt` en la cabecera o el final del archivo (el diccionario de cifrado va en el trailer): PDF cifrado que abrio sin contrasena. */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  const scan = (from: number, to: number): boolean => {
    for (let i = from; i <= to - needle.length; i += 1) {
      if (bytes[i] !== needle[0]) continue;
      let ok = true;
      for (let k = 1; k < needle.length; k += 1) {
        if (bytes[i + k] !== needle[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  const head = Math.min(bytes.length, 32 * 1024);
  const tailStart = Math.max(0, bytes.length - 64 * 1024);
  return scan(0, head) || scan(tailStart, bytes.length);
}

/** Avisos sin repetir (mismo codigo, pagina y detalle); `too-many-*` solo una vez. */
export function mergeWarnings(lists: ReadonlyArray<ReadonlyArray<ExtractWarning>>): ExtractWarning[] {
  const seen = new Set<string>();
  const out: ExtractWarning[] = [];
  for (const list of lists) {
    for (const warning of list) {
      const key = warning.code === "too-many-pages" || warning.code === "too-many-assets" ? warning.code : `${warning.code}|${warning.pageIndex ?? ""}|${warning.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(warning);
    }
  }
  return out;
}

function uniqueIds(assets: ExtractedAsset[]): ExtractedAsset[] {
  const used = new Set<string>();
  return assets.map((asset) => {
    let id = asset.id;
    for (let n = 2; used.has(id); n += 1) id = `${asset.id}-${n}`;
    used.add(id);
    return id === asset.id ? asset : { ...asset, id };
  });
}

/** Cuanto de `inner` esta dentro de `outer` (0..1), ambas normalizadas. */
function containment(inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y1 = Math.min(inner.y + inner.height, outer.y + outer.height);
  const area = inner.width * inner.height;
  return area > 0 ? (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area : 0;
}

type Stage = 0 | 1 | 2;

/** Extraccion completa de un PDF con el entorno dado. */
export async function extractWith(env: ExtractEnv, file: File | Uint8Array, options: ExtractOptions = {}): Promise<ExtractResult> {
  const signal = options.signal;
  if (signal?.aborted) throw cancelled();
  const maxPages = clamp(Math.floor(options.maxPages ?? EXTRACT_LIMITS.maxPages), 1, EXTRACT_LIMITS.maxPages);
  const maxAssets = clamp(Math.floor(options.maxAssets ?? EXTRACT_LIMITS.maxAssets), 1, EXTRACT_LIMITS.maxAssets);

  const bytes = await bytesOf(file);
  if (signal?.aborted) throw cancelled();
  if (bytes.byteLength === 0) throw new PdfError("empty");
  if (bytes.byteLength > MAX_SAFE_FILE_SIZE) throw new PdfError("tooLarge");

  let doc: PDFDocumentProxy;
  try {
    doc = await env.openDocument(bytes);
  } catch (error) {
    throw toPdfError(error);
  }
  try {
    if (signal?.aborted) throw cancelled();
    const pageCount = doc.numPages;
    if (pageCount < 1) throw new PdfError("empty");

    const from = clamp(Math.floor(options.pageRange?.from ?? 0), 0, pageCount - 1);
    let to = clamp(Math.floor(options.pageRange?.to ?? pageCount - 1), from, pageCount - 1);
    const preWarnings: ExtractWarning[] = [];
    if (to - from + 1 > maxPages) {
      to = from + maxPages - 1;
      preWarnings.push({ code: "too-many-pages", detail: `${maxPages}` });
    }
    const pageIndices: number[] = [];
    for (let index = from; index <= to; index += 1) pageIndices.push(index);
    const analyzed = pageIndices.length;
    if (looksEncrypted(bytes)) preWarnings.push({ code: "encrypted" });

    // Progreso: tres pasadas (imagenes, anotaciones, texto y trazos) mapeadas a las paginas analizadas, siempre en aumento.
    let lastReported = -1;
    let found = 0;
    const report = (stage: Stage, pagesDone: number, assetsSoFar: number): void => {
      found = Math.max(found, assetsSoFar);
      const fraction = Math.min(1, (stage * analyzed + Math.min(analyzed, pagesDone)) / (3 * analyzed));
      const pageIndex = from + Math.min(analyzed - 1, Math.floor(fraction * analyzed));
      if (pageIndex < lastReported) return;
      lastReported = pageIndex;
      options.onProgress?.({ pageIndex, pageCount, assetsSoFar: found });
    };

    const ops = await env.ops();
    const engineOptions: ExtractOptions = { pageRange: { from, to }, maxPages, maxAssets, signal };

    let images: Awaited<ReturnType<typeof findImageAssets>>;
    try {
      images = await findImageAssets(doc, {
        ops: ops as never,
        bytes,
        includeAnnotations: false,
        options: { ...engineOptions, onProgress: (progress) => report(0, progress.pageIndex - from + 1, progress.assetsSoFar) },
      });
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled();
      throw toPdfError(error);
    }
    if (signal?.aborted) throw cancelled();

    const createSurface = env.createSurface();
    let annotations: Awaited<ReturnType<typeof findAnnotationAssets>>;
    try {
      annotations = await findAnnotationAssets(doc, {
        ops,
        bytes,
        createSurface,
        assetsAlreadyFound: images.assets.length,
        options: { ...engineOptions, onProgress: (progress) => report(1, progress.pageIndex - from + 1, progress.assetsSoFar) },
      });
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled();
      // Un fallo inesperado de este motor no tira las imagenes ya halladas: se avisa y se sigue.
      annotations = { assets: [], warnings: [{ code: "decode-failed", detail: `anotaciones: ${error instanceof Error ? error.message.slice(0, 100) : "error"}` }] };
    }
    if (signal?.aborted) throw cancelled();

    const facts = await collectPageFacts(doc, pageIndices, {
      ops,
      signal,
      onPage: (pageIndex) => report(2, pageIndex - from + 1, found),
    });
    if (signal?.aborted) throw cancelled();

    const scannedPages = [...new Set([...images.scannedPages, ...(annotations.scannedPages ?? [])])].sort((a, b) => a - b);
    const classified = await classifyAssets({
      assets: [...images.assets, ...annotations.assets],
      translucentImages: (annotations.translucentImages ?? []) as TranslucentImageCandidate[],
      pages: facts.facts,
      vectors: facts.vectors,
      scannedPages,
      analyzedPages: analyzed,
      decodeThumb: env.decodeThumb,
      signal,
    });

    // Firmas vectoriales (beta): no se ofrecen si caen dentro de un sello u otro elemento ya hallado en el mismo sitio.
    const vectorAssets: ExtractedAsset[] = [];
    for (const accepted of classified.vectorSignatures) {
      if (signal?.aborted) throw cancelled();
      const rect = accepted.candidate.rect;
      const covered = classified.assets.some(
        (asset) =>
          asset.kind !== "watermark" &&
          asset.occurrences.some((occurrence) => occurrence.pageIndex === accepted.candidate.pageIndex && containment(rect, occurrence.rect) >= 0.7 && occurrence.rect.width * occurrence.rect.height < 0.5),
      );
      if (covered) continue;
      try {
        const built = await buildVectorAsset(accepted, createSurface);
        if (built) vectorAssets.push(built);
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled();
      }
    }

    let assets = sortAssets(dedupeAssets([...classified.assets, ...vectorAssets]));
    const warnings = mergeWarnings([preWarnings, images.warnings, annotations.warnings ?? []]);
    if (assets.length > maxAssets) {
      assets = assets.slice(0, maxAssets);
      if (!warnings.some((warning) => warning.code === "too-many-assets")) warnings.push({ code: "too-many-assets" });
    }
    assets = uniqueIds(assets);

    const failedPages = new Set(warnings.filter((warning) => warning.code === "decode-failed" && warning.pageIndex !== undefined).map((warning) => warning.pageIndex));
    if (assets.length === 0 && failedPages.size >= analyzed && facts.failures >= analyzed) throw new PdfError("corrupt");

    found = assets.length;
    lastReported = -1;
    options.onProgress?.({ pageIndex: to, pageCount, assetsSoFar: assets.length });
    const truncated = warnings.some((warning) => warning.code === "too-many-pages" || warning.code === "too-many-assets");
    return { pageCount, assets, scannedPages, warnings, truncated };
  } finally {
    await env.closeDocument(doc);
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Regenerar un elemento                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** Cuanto se mantiene abierto el documento de la ultima descarga (varias descargas seguidas, p. ej. un ZIP, no lo reabren cada vez). */
export const DOCUMENT_IDLE_MS = 15_000;

type Lease = { source: File | Uint8Array; env: ExtractEnv; doc: Promise<PDFDocumentProxy>; users: number; timer: ReturnType<typeof setTimeout> | null; closing: boolean };

let lease: Lease | null = null;

async function release(entry: Lease): Promise<void> {
  if (entry.closing) return;
  entry.closing = true;
  if (entry.timer) clearTimeout(entry.timer);
  if (lease === entry) lease = null;
  try {
    await entry.env.closeDocument(await entry.doc);
  } catch {
    // no se pudo abrir o ya estaba cerrado
  }
}

/** Libera ya el documento que se mantiene abierto para las descargas (para las pruebas y al salir de la herramienta). */
export async function releaseRenderDocument(): Promise<void> {
  if (lease) await release(lease);
}

async function withDocument<T>(env: ExtractEnv, file: File | Uint8Array, run: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  if (lease && (lease.source !== file || lease.env !== env || lease.closing)) {
    const old = lease;
    lease = null;
    if (old.users === 0) void release(old);
    else old.timer = setTimeout(() => void release(old), 0);
  }
  if (!lease) {
    const entry: Lease = {
      source: file,
      env,
      doc: bytesOf(file).then((bytes) => env.openDocument(bytes)),
      users: 0,
      timer: null,
      closing: false,
    };
    entry.doc.catch(() => {
      if (lease === entry) lease = null;
    });
    lease = entry;
  }
  const entry = lease;
  entry.users += 1;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  try {
    const doc = await entry.doc.catch((error: unknown) => {
      throw toPdfError(error);
    });
    return await run(doc);
  } finally {
    entry.users -= 1;
    if (entry.users === 0 && !entry.closing) {
      entry.timer = setTimeout(() => void release(entry), DOCUMENT_IDLE_MS);
      (entry.timer as { unref?: () => void }).unref?.();
    }
  }
}

/** Bytes del elemento en el formato pedido (el primero de `asset.formats` por defecto). */
export async function renderWith(env: ExtractEnv, file: File | Uint8Array, asset: ExtractedAsset, format?: AssetFormat): Promise<Blob> {
  if (asset.formats.length === 0) throw new ExtractRenderError("no-formats", "Este elemento no tiene nada que descargar.");
  const wanted: AssetFormat = format ?? asset.formats[0];
  if (!asset.formats.includes(wanted)) throw new ExtractRenderError("unsupported-format", `El elemento no ofrece ${wanted}.`);
  const ref = asset.ref;

  if (ref.engine === "region") {
    if (wanted !== "png") throw new ExtractRenderError("unsupported-format");
    const crop = env.cropRegion ?? cropRegion;
    return (await crop(file, ref.pageIndex, ref.rect)).png;
  }

  const ops = await env.ops();
  const createSurface = env.createSurface();
  return withDocument(env, file, async (doc) => {
    try {
      if (ref.engine === "image") return await renderImageAsset(doc, asset, wanted, { ops: ops as never });
      if (ownsAnnotationAsset(asset)) return await renderAnnotationAsset(doc, asset, wanted, { ops, createSurface });
      if (ref.engine === "vector") return await renderVectorAsset(doc, asset, wanted, { ops, createSurface });
    } catch (error) {
      if (isCancellation(error)) throw cancelled();
      throw error;
    }
    throw new ExtractRenderError("unsupported-asset", `Sin motor para ${ref.engine}`);
  });
}

/** Implementacion real de `ExtractAssetsApi.extractAssets` / `renderAsset` (la de la aplicacion). */
export const extractAssets: ExtractAssetsApi["extractAssets"] = (file, options) => extractWith(browserEnv, file, options);
export const renderAsset: ExtractAssetsApi["renderAsset"] = (file, asset, format) => renderWith(browserEnv, file, asset, format);
