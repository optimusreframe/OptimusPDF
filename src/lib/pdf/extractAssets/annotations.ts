/**
 * Motor de anotaciones, sellos, firmas `/Sig`, marcas de agua y capas opcionales de «Extraer elementos» (U7.2,
 * docs/PLAN-FIRMA-AGIL.md §9.5). Punto de entrada: `findAnnotationAssets(doc, ctx)` devuelve un `PartialExtraction` para el
 * orquestador, y `renderAnnotationAsset(...)` regenera bajo demanda el PNG/SVG/TXT de un elemento (los pixeles completos NO
 * viajan en el resultado; solo miniaturas de <= 256 px).
 *
 * Que detecta:
 *  1. Anotaciones Ink (trazos de lapiz): SVG con color y grosor reales y PNG transparente. Fiabilidad alta.
 *  2. Campos `/Sig`: caja renderizada sola y limpiada con `inkExtract`; `/V` => aviso `digital-signature` (sin verificar). Vacios o
 *     con apariencia de texto: confianza baja con su razon.
 *  3. Sellos: anotaciones `Stamp` (con y sin anotaciones => pixeles del sello; confianza alta) y Form XObjects de color saturado
 *     rojo/azul y forma circular/rectangular (confianza media).
 *  4. Marcas de agua: (a) grupos de contenido opcional con nombre tipo Watermark/Borrador/Confidencial; (b) anotaciones
 *     `/Watermark`; (c) texto girado o grande y translucido repetido en >= 50 % de las paginas (se entrega el TEXTO).
 *     (d) imagen grande translucida repetida: NO se entrega aqui (la imagen la da el motor de imagenes); se devuelven las candidatas
 *     en `translucentImages` para que el clasificador las enlace por `objectId`.
 *
 * Cancelable (`AbortSignal`), `page.cleanup()` por pagina, topes de paginas y elementos del contrato, errores por pagina controlados,
 * y cero red.
 */

import { PdfError, getPdfJs, openPdfDocument, closePdfDocument } from "@/lib/pdf/core";
import { EXTRACT_LIMITS, type ExtractWarning, type ExtractedAsset } from "./types";
import {
  ANNOTATION_MODE,
  ANNOT_FLAG_HIDDEN,
  ANNOT_FLAG_NOVIEW,
  AnnotationRenderError,
  type AnnotationContext,
  type AnnotationExtraction,
  type PdfDocument,
  type PdfJsAnnotation,
  type PdfOps,
  type TranslucentImageCandidate,
} from "./annotationsTypes";
import { STEP_TIMEOUT_MS, defaultSurfaceFactory, normalizeViewRect, withTimeout, type ViewRect } from "./annotationsRaster";
import { EMPTY_INDEX, indexPdfLibAnnotations, objectNumberOfAnnotationId, type PdfLibAnnotationIndex } from "./annotationsPdfLib";
import { annotationViewRect, makePageEnv, renderAnnotationLayer, type AnnotationLayer, type PageEnv } from "./annotationsPage";
import { buildInkAsset, inkShapeOf } from "./annotationsInk";
import { buildSigAsset, isSigWidget } from "./annotationsSig";
import { buildStampAsset, buildWatermarkAnnotationAsset } from "./annotationsStamp";
import { buildFormStampAsset, groupFormStamps, stampLikeness, type FormStampOccurrence } from "./annotationsFormStamp";
import { findWatermarkGroups, buildOcgAsset, type OcgGroupInfo } from "./watermarkOcg";
import { aggregateTextWatermarks, buildTextWatermarkAsset, type TextPageFindings } from "./watermarkText";
import { scanPageOperators, type ImagePaint } from "./watermarkOps";

export { renderAnnotationAsset, ownsAnnotationAsset } from "./annotationsRender";

/** Maximo de grupos de sellos de Form XObject que se materializan (cada uno cuesta un render). */
const MAX_FORM_STAMP_GROUPS = 40;
/** Maximo de anotaciones de una pagina que se procesan. */
const MAX_ANNOTATIONS_PER_PAGE = 300;
/** Una imagen cuenta como «grande» si cubre al menos esta fraccion de la pagina. */
const BIG_IMAGE_AREA = 0.2;

export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof PdfError && error.code === "cancelled") return true;
  if (error instanceof AnnotationRenderError && error.code === "cancelled") return true;
  return error instanceof Error && (error.name === "AbortError" || (error.name === "InkError" && (error as { code?: string }).code === "aborted"));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120);
}

function isVisible(annotation: PdfJsAnnotation): boolean {
  const flags = annotation.annotationFlags ?? 0;
  return (flags & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NOVIEW)) === 0;
}

/** Paginas a procesar (0-based) segun el rango y el tope; avisa si hubo que recortar. */
export function planPages(pageCount: number, options: AnnotationContext["options"]): { pages: number[]; truncated: boolean } {
  const maxPages = Math.max(1, Math.min(options?.maxPages ?? EXTRACT_LIMITS.maxPages, EXTRACT_LIMITS.maxPages));
  const from = Math.max(0, Math.floor(options?.pageRange?.from ?? 0));
  const to = Math.min(pageCount - 1, Math.floor(options?.pageRange?.to ?? pageCount - 1));
  const pages: number[] = [];
  for (let i = from; i <= to && pages.length < maxPages; i += 1) pages.push(i);
  return { pages, truncated: to - from + 1 > pages.length };
}

type ImageEntry = { env: PageEnv; image: ImagePaint };

export async function findAnnotationAssets(doc: PdfDocument, ctx: AnnotationContext = {}): Promise<AnnotationExtraction> {
  const options = ctx.options ?? {};
  const signal = options.signal;
  const createSurface = ctx.createSurface ?? defaultSurfaceFactory();
  const ops: PdfOps = ctx.ops ?? ((await getPdfJs()).OPS as unknown as PdfOps);
  const stepTimeout = ctx.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const guard = <T,>(promise: Promise<T>, label: string): Promise<T> => withTimeout(promise, stepTimeout, signal, label);
  const maxAssets = Math.max(0, (options.maxAssets ?? EXTRACT_LIMITS.maxAssets) - (ctx.assetsAlreadyFound ?? 0));
  const { pages: pageIndices, truncated: pagesTruncated } = planPages(doc.numPages, options);

  const assets: ExtractedAsset[] = [];
  const warnings: ExtractWarning[] = [];
  let capped = false;
  const add = (asset: ExtractedAsset | null | undefined): void => {
    if (!asset) return;
    if (assets.length >= maxAssets) {
      capped = true;
      return;
    }
    assets.push(asset);
  };
  if (pagesTruncated) warnings.push({ code: "too-many-pages", detail: `se analizaron ${pageIndices.length} paginas` });

  // pdf-lib solo se abre cuando hace falta (campos /Sig, anotaciones /Watermark, sellos con nombre): una vez, para todas las paginas.
  let libPromise: Promise<PdfLibAnnotationIndex> | null = null;
  const lib = (): Promise<PdfLibAnnotationIndex> => (libPromise ??= indexPdfLibAnnotations(ctx.bytes, pageIndices).catch(() => EMPTY_INDEX));

  const watermarkGroups: OcgGroupInfo[] = await guard(findWatermarkGroups(doc), "capas").catch(() => []);
  if (signal?.aborted) throw new PdfError("cancelled");
  const groupPages = new Map<string, PageEnv[]>();
  const textPages: TextPageFindings[] = [];
  const formStamps: FormStampOccurrence[] = [];
  const bigImages: ImageEntry[] = [];

  for (let position = 0; position < pageIndices.length; position += 1) {
    if (signal?.aborted) throw new PdfError("cancelled");
    const pageIndex = pageIndices[position];
    let page;
    try {
      page = await guard(doc.getPage(pageIndex + 1), "pagina");
    } catch (error) {
      if (isCancellation(error, signal)) throw new PdfError("cancelled");
      warnings.push({ code: "decode-failed", pageIndex, detail: `pagina: ${message(error)}` });
      continue;
    }
    const env = makePageEnv(doc, page, pageIndex, createSurface, signal, stepTimeout);
    try {
      /* ---------------- Anotaciones ---------------- */
      let annotations: PdfJsAnnotation[] = [];
      try {
        annotations = ((await guard(page.getAnnotations(), "anotaciones")) as unknown as PdfJsAnnotation[]).slice(0, MAX_ANNOTATIONS_PER_PAGE);
      } catch (error) {
        if (isCancellation(error, signal)) throw new PdfError("cancelled");
        warnings.push({ code: "decode-failed", pageIndex, detail: `anotaciones: ${message(error)}` });
      }

      const boxItems: Array<{ annotation: PdfJsAnnotation; index: number; rect: ViewRect }> = [];
      const ocRefs = new Set<string>();
      for (let index = 0; index < annotations.length; index += 1) {
        const annotation = annotations[index];
        try {
          if (!annotation || !isVisible(annotation)) continue;
          const oc = annotation.oc as { id?: string } | string | null | undefined;
          if (typeof oc === "string") ocRefs.add(oc);
          else if (oc && typeof oc === "object" && typeof oc.id === "string") ocRefs.add(oc.id);
          if (annotation.subtype === "Ink") {
            const shape = inkShapeOf(annotation, env.toView);
            if (shape) {
              add(await buildInkAsset({ shape, pageIndex, annotationIndex: index, annotationId: annotation.id, viewWidth: env.viewWidth, viewHeight: env.viewHeight, createSurface }));
            }
          } else if (annotation.subtype === "Stamp" || annotation.subtype === "Watermark" || isSigWidget(annotation)) {
            const rect = annotationViewRect(env, annotation);
            // Un /Sig sin caja visible tambien se informa (firma invisible o campo vacio): va sin rect.
            if (rect || isSigWidget(annotation)) boxItems.push({ annotation, index, rect: rect ?? { x: 0, y: 0, width: 0, height: 0 } });
          }
        } catch (error) {
          if (isCancellation(error, signal)) throw new PdfError("cancelled");
          warnings.push({ code: "decode-failed", pageIndex, detail: `anotacion ${index}: ${message(error)}` });
        }
      }

      if (boxItems.length > 0) {
        const index = await lib();
        const visibleRects = boxItems.filter((item) => item.rect.width > 0).map((item) => item.rect);
        let layer: AnnotationLayer | undefined;
        if (visibleRects.length > 0) {
          try {
            layer = await renderAnnotationLayer(env, visibleRects);
          } catch (error) {
            if (isCancellation(error, signal)) throw new PdfError("cancelled");
            warnings.push({ code: "decode-failed", pageIndex, detail: `render de anotaciones: ${message(error)}` });
          }
        }
        for (const item of boxItems) {
          try {
            const objectNumber = objectNumberOfAnnotationId(item.annotation.id);
            const libInfo = objectNumber === null ? undefined : index.find(pageIndex, objectNumber);
            if (item.annotation.subtype === "Stamp") {
              if (layer) add(await buildStampAsset({ env, annotation: item.annotation, annotationIndex: item.index, lib: libInfo, layer }));
            } else if (item.annotation.subtype === "Watermark") {
              if (layer) add(await buildWatermarkAnnotationAsset({ env, annotation: item.annotation, annotationIndex: item.index, lib: libInfo, layer }));
            } else {
              const output = await buildSigAsset({ env, annotation: item.annotation, annotationIndex: item.index, lib: libInfo, layer });
              add(output.asset);
              if (output.warning) warnings.push(output.warning);
            }
          } catch (error) {
            if (isCancellation(error, signal)) throw new PdfError("cancelled");
            warnings.push({ code: "decode-failed", pageIndex, detail: `anotacion ${item.index}: ${message(error)}` });
          }
        }
      }

      /* ---------------- Lista de operadores: texto, sellos de Form XObject, imagenes, capas ---------------- */
      try {
        const list = await guard(ctx.getOperatorList ? ctx.getOperatorList(page, pageIndex) : page.getOperatorList({ annotationMode: ANNOTATION_MODE.DISABLE } as never), "operadores");
        const graphics = scanPageOperators(list.fnArray as unknown as ArrayLike<number>, list.argsArray as unknown as ArrayLike<unknown>, ops, env);
        textPages.push({ pageIndex, viewWidth: env.viewWidth, viewHeight: env.viewHeight, runs: graphics.textRuns });
        for (const form of graphics.forms) {
          const likeness = stampLikeness(form, env.viewWidth, env.viewHeight);
          if (likeness) formStamps.push({ env, form, likeness });
        }
        for (const image of graphics.images) {
          const area = (image.bbox.width * image.bbox.height) / (env.viewWidth * env.viewHeight);
          if (image.objectId && image.alpha < 0.85 && area >= BIG_IMAGE_AREA) bigImages.push({ env, image });
        }
        for (const group of watermarkGroups) {
          if (graphics.ocgRefs.has(group.id) || ocRefs.has(group.id)) {
            const list2 = groupPages.get(group.id) ?? [];
            list2.push(env);
            groupPages.set(group.id, list2);
          }
        }
      } catch (error) {
        if (isCancellation(error, signal)) throw new PdfError("cancelled");
        warnings.push({ code: "decode-failed", pageIndex, detail: `operadores: ${message(error)}` });
      }
    } finally {
      try {
        page.cleanup();
      } catch {
        // La pagina ya no existe (documento destruido): nada que liberar.
      }
    }
    options.onProgress?.({ pageIndex, pageCount: doc.numPages, assetsSoFar: (ctx.assetsAlreadyFound ?? 0) + assets.length });
  }

  /* ---------------- Resultados que dependen de varias paginas ---------------- */
  const analyzedPages = pageIndices.length;
  const ocgIds = new Set<string>(watermarkGroups.map((group) => group.id));

  for (const group of watermarkGroups) {
    if (signal?.aborted) throw new PdfError("cancelled");
    const envs = groupPages.get(group.id);
    if (!envs || envs.length === 0) continue;
    try {
      add(await buildOcgAsset(group, envs));
    } catch (error) {
      if (isCancellation(error, signal)) throw new PdfError("cancelled");
      warnings.push({ code: "decode-failed", pageIndex: envs[0].pageIndex, detail: `capa «${group.name}»: ${message(error)}` });
    }
  }

  for (const candidate of aggregateTextWatermarks(textPages, analyzedPages, ocgIds)) {
    if (signal?.aborted) throw new PdfError("cancelled");
    try {
      add(await buildTextWatermarkAsset(candidate, createSurface));
    } catch (error) {
      if (isCancellation(error, signal)) throw new PdfError("cancelled");
      warnings.push({ code: "decode-failed", detail: `marca de texto: ${message(error)}` });
    }
  }

  const groups = groupFormStamps(formStamps).slice(0, MAX_FORM_STAMP_GROUPS);
  for (const group of groups) {
    if (signal?.aborted) throw new PdfError("cancelled");
    try {
      add(await buildFormStampAsset(group));
    } catch (error) {
      if (isCancellation(error, signal)) throw new PdfError("cancelled");
      warnings.push({ code: "decode-failed", pageIndex: group[0].env.pageIndex, detail: `sello: ${message(error)}` });
    }
  }

  if (capped) warnings.push({ code: "too-many-assets" });
  if (signal?.aborted) throw new PdfError("cancelled");

  // (d) imagen grande translucida repetida: solo candidatas por `objectId` (la imagen la entrega el motor de imagenes).
  const translucent: TranslucentImageCandidate[] = [];
  if (analyzedPages >= 2) {
    // pdf.js nombra distinto la misma imagen en la primera pagina (`img_p0_…`) y en las siguientes (`g_…`): se agrupa por posicion y tamano.
    const byPlace = new Map<string, ImageEntry[]>();
    for (const entry of bigImages) {
      const rect = normalizeViewRect(entry.image.bbox, entry.env.viewWidth, entry.env.viewHeight);
      const key = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 25)).join("|");
      const list = byPlace.get(key) ?? [];
      list.push(entry);
      byPlace.set(key, list);
    }
    for (const entries of byPlace.values()) {
      const pagesWith = new Set(entries.map((entry) => entry.env.pageIndex));
      if (pagesWith.size < 2 || pagesWith.size / analyzedPages < 0.5) continue;
      for (const entry of entries) {
        translucent.push({
          pageIndex: entry.env.pageIndex,
          objectId: entry.image.objectId as string,
          alpha: entry.image.alpha,
          rect: normalizeViewRect(entry.image.bbox, entry.env.viewWidth, entry.env.viewHeight),
        });
      }
    }
  }

  return { assets, warnings, ...(translucent.length > 0 ? { translucentImages: translucent } : {}) };
}

/** Abre el PDF, busca y lo cierra. Atajo para quien no tiene ya el documento de pdf.js abierto. */
export async function findAnnotationAssetsInFile(file: Blob | Uint8Array, ctx: AnnotationContext = {}): Promise<AnnotationExtraction> {
  const doc = await openPdfDocument(file);
  try {
    const bytes = ctx.bytes ?? (file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer()));
    return await findAnnotationAssets(doc, { ...ctx, bytes });
  } finally {
    await closePdfDocument(doc);
  }
}
