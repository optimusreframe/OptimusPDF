/**
 * Marcas de agua en contenido opcional (OCG), deteccion (a) de docs/PLAN-FIRMA-AGIL.md §9.5: grupos cuyo nombre es «Watermark»,
 * «Marca de agua», «Borrador», «Confidencial»… y su render aislado: la pagina con el grupo encendido frente a la misma pagina con
 * el grupo apagado; la diferencia son los pixeles del grupo (fondo transparente).
 */

import type { ExtractedAsset, NormRect } from "./types";
import { EXPORT_SCALE, WATERMARK_NAME_PATTERN, foldText, type PdfDocument, type PdfPage, type RasterImage, type SurfaceFactory } from "./annotationsTypes";
import { yieldToMain } from "@/lib/image/inkExtract";
import type { PageEnv } from "./annotationsPage";
import { diffLayers, estimatePngBytes, fitScale, normalizeViewRect, renderRegion, shortHash, thumbBlob, trimTransparent, type ViewRect } from "./annotationsRaster";

export type OcgGroupInfo = { id: string; name: string; visibleByDefault: boolean };

type OptionalContentConfigLike = Iterable<[string, { name?: string | null }]> & {
  setVisibility(id: string, visible: boolean): void;
  isVisible(group: { type: string; id: string }): boolean;
};

async function loadConfig(doc: PdfDocument): Promise<OptionalContentConfigLike | null> {
  try {
    const config = (await doc.getOptionalContentConfig()) as unknown as OptionalContentConfigLike | null;
    return config ?? null;
  } catch {
    return null;
  }
}

/** Todos los grupos de contenido opcional del documento. */
export async function listOcgGroups(doc: PdfDocument): Promise<OcgGroupInfo[]> {
  const config = await loadConfig(doc);
  if (!config) return [];
  const out: OcgGroupInfo[] = [];
  try {
    for (const [id, group] of config) {
      out.push({ id, name: typeof group?.name === "string" ? group.name : "", visibleByDefault: config.isVisible({ type: "OCG", id }) });
    }
  } catch {
    // Configuracion rara: se devuelve lo leido.
  }
  return out;
}

/** Grupos cuyo nombre parece de marca de agua. */
export async function findWatermarkGroups(doc: PdfDocument): Promise<OcgGroupInfo[]> {
  return (await listOcgGroups(doc)).filter((group) => WATERMARK_NAME_PATTERN.test(foldText(group.name)));
}

/** Pixeles que el grupo `groupId` anade a la region de la pagina (diferencia entre encendido y apagado). */
export async function renderOcgLayer(params: {
  doc: PdfDocument;
  page: PdfPage;
  groupId: string;
  region: ViewRect;
  scale: number;
  createSurface: SurfaceFactory;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RasterImage> {
  const { doc, page, groupId, region, scale, createSurface, signal, timeoutMs } = params;
  const off = await loadConfig(doc);
  const on = await loadConfig(doc);
  if (!off || !on) throw new Error("Sin configuracion de contenido opcional.");
  off.setVisibility(groupId, false);
  on.setVisibility(groupId, true);
  const base = await renderRegion({ page, region, scale, annotationMode: 1, createSurface, optionalContentConfig: off, signal, timeoutMs });
  const over = await renderRegion({ page, region, scale, annotationMode: 1, createSurface, optionalContentConfig: on, signal, timeoutMs });
  await yieldToMain();
  return diffLayers(base, over);
}

/* -------------------------------------------------------------------------------------------------------------- */
/* Elemento del contrato                                                                                           */
/* -------------------------------------------------------------------------------------------------------------- */

/** Se renderiza el grupo a fondo en las primeras paginas que lo usan; en el resto se reutiliza la caja de la primera. */
export const MAX_OCG_RENDERED_PAGES = 3;
/** Escala de analisis de una pagina entera (1,5 px/pt: suficiente para la miniatura y la caja). */
export const OCG_ANALYSIS_SCALE = 1.5;

export async function buildOcgAsset(group: OcgGroupInfo, pages: readonly PageEnv[]): Promise<ExtractedAsset | null> {
  if (pages.length === 0) return null;
  const occurrences: Array<{ pageIndex: number; rect: NormRect }> = [];
  let thumb: Blob | null = null;
  let size: { width: number; height: number; scale: number; thumbPixels: number } | null = null;
  let leadRect: NormRect | null = null;
  const rendered = pages.slice(0, MAX_OCG_RENDERED_PAGES);
  for (const env of rendered) {
    const region = { x: 0, y: 0, width: env.viewWidth, height: env.viewHeight };
    const scale = fitScale(region.width, region.height, OCG_ANALYSIS_SCALE);
    const layer = await renderOcgLayer({ doc: env.doc, page: env.page, groupId: group.id, region, scale, createSurface: env.createSurface, signal: env.signal, timeoutMs: env.timeoutMs });
    const trimmed = trimTransparent(layer, 1, 8);
    if (!trimmed) continue;
    const rect = normalizeViewRect(
      { x: trimmed.rect.x / scale, y: trimmed.rect.y / scale, width: trimmed.rect.width / scale, height: trimmed.rect.height / scale },
      env.viewWidth,
      env.viewHeight,
    );
    occurrences.push({ pageIndex: env.pageIndex, rect });
    if (!thumb) {
      thumb = await thumbBlob(trimmed.image);
      leadRect = rect;
      size = {
        width: Math.round((trimmed.image.width / scale) * EXPORT_SCALE),
        height: Math.round((trimmed.image.height / scale) * EXPORT_SCALE),
        scale,
        thumbPixels: Math.min(256, trimmed.image.width) * Math.min(256, trimmed.image.height),
      };
    }
  }
  if (!thumb || !size || !leadRect) return null;
  for (const env of pages.slice(MAX_OCG_RENDERED_PAGES)) occurrences.push({ pageIndex: env.pageIndex, rect: leadRect });
  const reasons = [`capa opcional «${group.name}»`];
  reasons.push(group.visibleByDefault ? "visible por defecto" : "oculta por defecto");
  reasons.push(pages.length === 1 ? "aparece en 1 página" : `aparece en ${pages.length} páginas`);
  return {
    id: `ocg-${shortHash(`${group.id}|${group.name}`)}`,
    kind: "watermark",
    confidence: 0.9,
    reasons,
    source: "ocg",
    occurrences,
    pixel: { width: size.width, height: size.height, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: estimatePngBytes(thumb.size, size.thumbPixels, size.width * size.height),
    thumb,
    ref: { engine: "ocg", groupId: group.id },
  };
}
