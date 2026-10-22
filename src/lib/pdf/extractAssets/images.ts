/**
 * Motor de IMAGENES INCRUSTADAS de «Extraer elementos» (U7.1, docs/PLAN-FIRMA-AGIL.md §9.5).
 *
 * `findImageAssets(doc, ctx)` recorre el documento pagina a pagina y devuelve TODAS las imagenes que lleva el contenido
 * (XObject, en linea, mascaras de 1 bit, dentro de Form XObjects anidados y en grupos fusionados por pdf.js) como
 * `PartialExtraction` del contrato (`types.ts`): ocurrencias (paginas y cajas 0..1), tamano en pixeles, formatos,
 * miniatura de 256 px y motivos FACTUALES. Es un motor de ESTRUCTURA: no clasifica (todo es `kind: "image"`; firmas,
 * logos y sellos los decide el clasificador).
 *
 * Como funciona:
 *  - `getOperatorList()` de cada pagina (solo contenido, sin anotaciones: de esas se ocupa U7.2) y `walkImagePaints`
 *    (`imagesOps.ts`) con la matriz `cm`/`q`/`Q`. Los pixeles los decodifica pdf.js en su worker (`page.objs` /
 *    `commonObjs`); la SMask / Mask llegan ya compuestas en el alfa.
 *  - Deduplicacion: por referencia de objeto (`imgData.ref`) y, si hay copias del mismo dibujo en objetos distintos, por
 *    la huella de los pixeles REDUCIDOS (miniatura de 256 px + medidas). Cada elemento lista todas sus apariciones.
 *  - Memoria acotada: los pixeles completos NO se guardan. Se leen por bandas (miniatura, alfa y huella en una pasada,
 *    cediendo el hilo cada ~24 ms) y `renderImageAsset` los regenera bajo demanda al descargar.
 *  - Topes: 50 MP por imagen (mas grande: solo el JPEG original o aviso `image-too-large`), 500 elementos, 300 paginas.
 *  - Un fallo de decodificacion (`decode-failed`) no rompe el resto. Se puede cancelar (`AbortSignal` -> `AbortError`).
 *
 * Limites conocidos: no se ven las imagenes de patrones de mosaico, de glifos Type3 ni de las apariencias de
 * anotaciones; el orden de `occurrences` es el de pintura.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { MIN_CHARS_FOR_TEXT_PAGE, countLegibleChars } from "@/lib/pdf/pageTextKind";
import { closePdfDocument, getPdfJs, openPdfDocument } from "@/lib/pdf/core";
import {
  EXTRACT_LIMITS,
  type AssetFormat,
  type AssetOccurrence,
  type AssetSource,
  type ExtractOptions,
  type ExtractWarning,
  type ExtractedAsset,
  type NormRect,
  type PartialExtraction,
} from "./types";
import { buildJpegIndex, readJpegHeader, type JpegIndex } from "./imagesJpeg";
import { imageRect, unionCoverage, walkImagePaints, type ImageOpNumbers, type ImagePaintEvent } from "./imagesOps";
import {
  Slicer,
  abortError,
  analyzeSource,
  cropSource,
  encodeSourceAsJpeg,
  encodeSourceAsPng,
  estimatePngBytes,
  isAbortError,
  pixelSourceFor,
  pngBlob,
  type PixelSource,
} from "./imagesPixels";
import { encodePngBytes } from "@/lib/image/inkPng";

export { isAbortError } from "./imagesPixels";

/** `AnnotationMode` de pdf.js: `DISABLE` = solo el contenido de la pagina (las anotaciones son de otro motor); `ENABLE` = con ellas. */
const ANNOTATION_MODE_DISABLE = 0;
const ANNOTATION_MODE_ENABLE = 1;
/** Pinturas de imagen que se recorren como mucho por pagina. */
const MAX_PAINTS_PER_PAGE = 5000;
/** Apariciones que se guardan como mucho por elemento (una imagen pintada 10 000 veces no debe agotar la memoria). */
export const MAX_OCCURRENCES_PER_ASSET = 500;
/** Cobertura de pagina a partir de la cual una pagina sin texto cuenta como ESCANEADA. */
export const SCANNED_COVERAGE = 0.9;
/** Plazo para que pdf.js entregue un objeto de imagen ya pedido en la lista de operadores (el primero que se agota). */
const OBJECT_TIMEOUT_MS = 20_000;
/** Tras un objeto que no llego, los siguientes esperan menos (un documento roto no debe tardar minutos). */
const OBJECT_TIMEOUT_AFTER_MISS_MS = 3_000;

/** `PartialExtraction` con `scannedPages` y `warnings` siempre presentes (sigue siendo un `PartialExtraction`). */
export type ImageExtraction = Required<PartialExtraction>;

export type ImageEngineContext = {
  /** Tabla `OPS` de pdf.js. Por defecto, la de `getPdfJs()` (el motor de la aplicacion). */
  ops?: ImageOpNumbers;
  /** Bytes del PDF, para ofrecer el JPEG original. Por defecto `doc.getData()`. */
  bytes?: Uint8Array;
  options?: ExtractOptions;
  /** Indice de JPEG originales ya construido (lo reutiliza el orquestador); `null` = no ofrecer `jpg-original`. */
  jpegIndex?: JpegIndex | null;
  /**
   * Incluir las imagenes de la apariencia de las anotaciones (sellos con imagen, firmas pegadas como anotacion...). Por
   * defecto NO: las anotaciones las trata `annotations.ts` (U7.2) y una imagen dentro de un sello saldria dos veces.
   */
  includeAnnotations?: boolean;
  /** Solo para pruebas: limite de megapixeles. */
  maxMegapixels?: number;
  /** Plazo (ms) para que pdf.js entregue un objeto de imagen; por defecto 20 s (y 3 s tras el primero que no llega). */
  objectTimeoutMs?: number;
};

/**
 * Contenido de `ExtractedAsset.ref.objectId` de este motor: `<tipo>:<opIndex>:<entrada>:<referencia o ->` y, si la lista de
 * operadores se pidio CON anotaciones, `:a` al final (la misma lista hay que pedir para regenerarlo).
 */
type ParsedRef = { kind: ImagePaintEvent["kind"]; opIndex: number; entry: number; ref: string | null; withAnnotations: boolean };

function makeObjectId(event: ImagePaintEvent, ref: string | null, withAnnotations: boolean): string {
  return `${event.kind}:${event.opIndex}:${event.entry}:${ref ?? "-"}${withAnnotations ? ":a" : ""}`;
}

function parseObjectId(objectId: string): ParsedRef | null {
  const match = /^(xobject|inline|mask):(\d+):(\d+):([^:]+)(:a)?$/.exec(objectId);
  if (!match) return null;
  return { kind: match[1] as ParsedRef["kind"], opIndex: Number(match[2]), entry: Number(match[3]), ref: match[4] === "-" ? null : match[4], withAnnotations: match[5] === ":a" };
}

type PageObjectStore = {
  has(id: string): boolean;
  get(id: string, callback?: (data: unknown) => void): unknown;
};

/** El objeto de imagen de pdf.js: ya resuelto o, si aun no llego, esperando (con plazo y cancelacion). `null` = fallo. */
async function resolveObject(page: PDFPageProxy, objId: string, signal?: AbortSignal, timeoutMs: number = OBJECT_TIMEOUT_MS): Promise<unknown | null> {
  const stores = [page.objs as unknown as PageObjectStore, page.commonObjs as unknown as PageObjectStore];
  for (const store of stores) {
    try {
      if (store.has(objId)) return store.get(objId) ?? null;
    } catch {
      // se espera abajo
    }
  }
  return new Promise<unknown | null>((resolve, reject) => {
    let settled = false;
    const finish = (value: unknown | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => finish(null, abortError());
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const store of stores) {
      try {
        store.get(objId, (data) => finish(data ?? null));
      } catch {
        // ese almacen no tiene el objeto
      }
    }
  });
}

type AssetState = {
  id: string;
  source: AssetSource;
  occurrences: AssetOccurrence[];
  pages: Set<number>;
  occurrenceCount: number;
  pixel: { width: number; height: number; hasAlpha: boolean } | null;
  formats: AssetFormat[];
  bytesEstimate: number;
  thumb: Blob | null;
  objectId: string;
  pageIndex: number;
  inForm: boolean;
  inAnnotation: boolean;
  jpegOriginal: boolean;
  tooLarge: boolean;
  reducedFrom: { width: number; height: number } | null;
};

/**
 * Formatos que se pueden pedir. PNG (con alfa) siempre y es el de por defecto. Sin transparencia: el JPEG ORIGINAL del PDF si
 * lo hay (sin recomprimir) y, si no, `jpg` (recomprimido; el alfa no cabe en un JPEG, asi que una imagen transparente no lo ofrece).
 */
export function formatsFor(hasAlpha: boolean, jpegOriginal: boolean): AssetFormat[] {
  if (hasAlpha) return ["png"];
  return jpegOriginal ? ["png", "jpg-original"] : ["png", "jpg"];
}

function normRef(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") {
    const ref = value as { num?: unknown; gen?: unknown };
    if (typeof ref.num === "number") return ref.gen ? `${ref.num}R${ref.gen}` : `${ref.num}R`;
  }
  return null;
}

function sourceOf(kind: ImagePaintEvent["kind"]): AssetSource {
  return kind === "xobject" ? "xobject" : kind === "inline" ? "inline" : "mask";
}

function reasonsOf(state: AssetState): string[] {
  const reasons: string[] = [];
  if (state.pixel?.hasAlpha) reasons.push("transparente");
  if (state.pages.size >= 2) reasons.push(`repetida en ${state.pages.size} páginas`);
  else if (state.occurrenceCount >= 2) reasons.push(`aparece ${state.occurrenceCount} veces en la página`);
  if (state.jpegOriginal) reasons.push("JPEG original disponible");
  if (state.source === "inline") reasons.push("imagen en línea");
  if (state.source === "mask") reasons.push("máscara de 1 bit");
  if (state.inForm) reasons.push("dentro de un objeto de formulario");
  if (state.inAnnotation) reasons.push("dentro de una anotación");
  if (state.tooLarge) reasons.push("demasiado grande para convertirla: solo el original");
  if (state.reducedFrom && state.pixel) {
    reasons.push(`reducida por el visor de ${state.reducedFrom.width} × ${state.reducedFrom.height} a ${state.pixel.width} × ${state.pixel.height} px`);
  }
  return reasons;
}

function toAsset(state: AssetState): ExtractedAsset {
  return {
    id: state.id,
    kind: "image",
    confidence: 1,
    reasons: reasonsOf(state),
    source: state.source,
    occurrences: state.occurrences,
    pixel: state.pixel,
    formats: state.formats,
    bytesEstimate: state.bytesEstimate,
    thumb: state.thumb,
    ref: { engine: "image", objectId: state.objectId, pageIndex: state.pageIndex },
  };
}

async function defaultOps(): Promise<ImageOpNumbers> {
  const { OPS } = await getPdfJs();
  return OPS as unknown as ImageOpNumbers;
}

async function pageOperatorList(page: PDFPageProxy, withAnnotations: boolean): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }> {
  const list = await page.getOperatorList({ annotationMode: withAnnotations ? ANNOTATION_MODE_ENABLE : ANNOTATION_MODE_DISABLE } as never);
  return list as unknown as { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };
}

/**
 * Todas las imagenes incrustadas de un documento de pdf.js ya abierto. Rechaza con `AbortError` si se cancela.
 * El llamador es dueno del documento (no se cierra aqui).
 */
export async function findImageAssets(doc: PDFDocumentProxy, ctx: ImageEngineContext = {}): Promise<ImageExtraction> {
  const options = ctx.options ?? {};
  const signal = options.signal;
  const slicer = new Slicer(signal);
  const ops = ctx.ops ?? (await defaultOps());
  const maxAssets = options.maxAssets ?? EXTRACT_LIMITS.maxAssets;
  const maxPages = options.maxPages ?? EXTRACT_LIMITS.maxPages;
  const maxPixels = (ctx.maxMegapixels ?? EXTRACT_LIMITS.maxImageMegapixels) * 1_000_000;
  const warnings: ExtractWarning[] = [];
  const scannedPages: number[] = [];

  const pageCount = doc.numPages;
  const first = Math.max(0, Math.min(pageCount - 1, options.pageRange?.from ?? 0));
  let last = Math.max(first, Math.min(pageCount - 1, options.pageRange?.to ?? pageCount - 1));
  if (last - first + 1 > maxPages) {
    last = first + maxPages - 1;
    warnings.push({ code: "too-many-pages", detail: `${maxPages}` });
  }

  let jpegIndexPromise: Promise<JpegIndex> | null = null;
  const getJpegIndex = (): Promise<JpegIndex> => {
    if (ctx.jpegIndex !== undefined) return Promise.resolve(ctx.jpegIndex ?? new Map());
    jpegIndexPromise ??= (async () => {
      try {
        const bytes = ctx.bytes ?? (await doc.getData());
        return await buildJpegIndex(bytes);
      } catch {
        return new Map() as JpegIndex;
      }
    })();
    return jpegIndexPromise;
  };

  const states: AssetState[] = [];
  const byObjId = new Map<string, AssetState | null>();
  const byRef = new Map<string, AssetState>();
  const byHash = new Map<string, AssetState>();
  let capped = false;
  let missedObjects = 0;
  const objectTimeout = ctx.objectTimeoutMs ?? OBJECT_TIMEOUT_MS;
  const waitFor = (): number => (missedObjects > 0 ? Math.min(objectTimeout, OBJECT_TIMEOUT_AFTER_MISS_MS) : objectTimeout);

  const withAnnotations = ctx.includeAnnotations === true;
  const addOccurrence = (state: AssetState, occurrence: AssetOccurrence, event: ImagePaintEvent): void => {
    state.occurrenceCount += 1;
    state.pages.add(occurrence.pageIndex);
    if (event.inForm) state.inForm = true;
    if (event.inAnnotation) state.inAnnotation = true;
    if (state.occurrences.length < MAX_OCCURRENCES_PER_ASSET) state.occurrences.push(occurrence);
  };

  for (let pageIndex = first; pageIndex <= last && !capped; pageIndex += 1) {
    slicer.throwIfAborted();
    let page: PDFPageProxy | null = null;
    const atlases = new Map<unknown, PixelSource | null>();
    const pageRects: NormRect[] = [];
    try {
      page = await doc.getPage(pageIndex + 1);
      const list = await pageOperatorList(page, withAnnotations);
      const { events } = walkImagePaints(list.fnArray, list.argsArray, ops, MAX_PAINTS_PER_PAGE);
      const view = page.getViewport({ scale: 1 });

      for (const event of events) {
        await slicer.tick();
        const rect = imageRect(event.matrix, view);
        pageRects.push(rect);
        const occurrence: AssetOccurrence = { pageIndex, rect };
        const objKey = event.objId ?? `inline:${pageIndex}:${event.opIndex}:${event.entry}`;

        const known = byObjId.get(objKey);
        if (known !== undefined) {
          if (known) addOccurrence(known, occurrence, event);
          continue;
        }
        if (states.length >= maxAssets) {
          if (!capped) {
            capped = true;
            warnings.push({ code: "too-many-assets", pageIndex });
          }
          break;
        }

        let source: PixelSource | null = null;
        try {
          const imgData = event.objId !== null ? await resolveObject(page, event.objId, signal, waitFor()) : event.inline;
          if (!imgData) {
            missedObjects += 1;
            byObjId.set(objKey, null);
            warnings.push({ code: "decode-failed", pageIndex, detail: event.objId ?? "inline" });
            continue;
          }
          const decoded = imgData as { width?: number; height?: number; ref?: unknown };
          const ref = event.kind === "xobject" ? normRef(decoded.ref) : null;

          if (ref) {
            const sameRef = byRef.get(ref);
            if (sameRef) {
              byObjId.set(objKey, sameRef);
              addOccurrence(sameRef, occurrence, event);
              continue;
            }
          }

          const decodedW = event.atlas ? event.atlas.w : Number(decoded.width);
          const decodedH = event.atlas ? event.atlas.h : Number(decoded.height);
          const declared = event.width && event.height ? { width: event.width, height: event.height } : null;
          const biggest = Math.max(decodedW * decodedH, declared ? declared.width * declared.height : 0);

          if (biggest > maxPixels) {
            const state = await buildTooLarge(event, ref, pageIndex, occurrence, decodedW, decodedH, getJpegIndex, withAnnotations);
            warnings.push({ code: "image-too-large", pageIndex, detail: `${declared?.width ?? decodedW}x${declared?.height ?? decodedH}` });
            if (state) {
              states.push(state);
              byObjId.set(objKey, state);
              if (ref) byRef.set(ref, state);
            } else {
              byObjId.set(objKey, null);
            }
            continue;
          }

          if (event.atlas) {
            let parent = atlases.get(event.inline);
            if (parent === undefined) {
              parent = pixelSourceFor(event.inline, { kind: "image" });
              atlases.set(event.inline, parent);
            }
            source = parent ? cropSource(parent, event.atlas) : null;
          } else {
            source = pixelSourceFor(imgData, { kind: event.kind === "mask" ? "mask" : "image", fill: event.fill });
          }
          if (!source) {
            byObjId.set(objKey, null);
            warnings.push({ code: "decode-failed", pageIndex, detail: event.objId ?? "inline" });
            continue;
          }

          const analysis = await analyzeSource(source, EXTRACT_LIMITS.thumbPx, slicer);
          const hashKey = `${analysis.hash}`;
          const duplicate = byHash.get(hashKey);
          if (duplicate) {
            byObjId.set(objKey, duplicate);
            if (ref) byRef.set(ref, duplicate);
            addOccurrence(duplicate, occurrence, event);
            continue;
          }

          const thumb = pngBlob(await encodePngBytes(analysis.thumb));
          let jpegOriginal = false;
          if (ref) {
            const index = await getJpegIndex();
            const jpeg = index.get(ref);
            jpegOriginal = !!jpeg && jpeg.width === analysis.width && jpeg.height === analysis.height;
          }
          const prefix = event.kind === "mask" ? "msk" : event.kind === "inline" ? "inl" : "img";
          const state: AssetState = {
            id: `${prefix}-${analysis.hash}`,
            source: sourceOf(event.kind),
            occurrences: [],
            pages: new Set(),
            occurrenceCount: 0,
            pixel: { width: analysis.width, height: analysis.height, hasAlpha: analysis.hasAlpha },
            formats: formatsFor(analysis.hasAlpha, jpegOriginal),
            bytesEstimate: estimatePngBytes(analysis.width, analysis.height, analysis.hasAlpha, analysis.complexity),
            thumb,
            objectId: makeObjectId(event, ref, withAnnotations),
            pageIndex,
            inForm: false,
            inAnnotation: false,
            jpegOriginal,
            tooLarge: false,
            reducedFrom:
              declared && event.kind === "xobject" && (declared.width > analysis.width || declared.height > analysis.height)
                ? { width: declared.width, height: declared.height }
                : null,
          };
          addOccurrence(state, occurrence, event);
          states.push(state);
          byObjId.set(objKey, state);
          byHash.set(hashKey, state);
          if (ref) byRef.set(ref, state);
        } catch (error) {
          if (isAbortError(error)) throw error;
          byObjId.set(objKey, null);
          warnings.push({ code: "decode-failed", pageIndex, detail: error instanceof Error ? error.message : String(error) });
        } finally {
          if (source && !event.atlas) source.close();
        }
      }

      // Pagina escaneada: las imagenes cubren casi toda la pagina y casi no hay texto.
      if (pageRects.length > 0 && unionCoverage(pageRects) >= SCANNED_COVERAGE) {
        let chars = 0;
        try {
          const content = await page.getTextContent();
          for (const item of content.items) if ("str" in item) chars += countLegibleChars(item.str).legible;
        } catch {
          chars = 0;
        }
        if (chars < MIN_CHARS_FOR_TEXT_PAGE) {
          scannedPages.push(pageIndex);
          warnings.push({ code: "scanned-page", pageIndex });
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      warnings.push({ code: "decode-failed", pageIndex, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      for (const parent of atlases.values()) parent?.close();
      try {
        page?.cleanup();
      } catch {
        // la pagina ya estaba liberada
      }
    }
    options.onProgress?.({ pageIndex, pageCount, assetsSoFar: states.length });
    await slicer.tick();
  }

  return { assets: states.map(toAsset), scannedPages, warnings };
}

/** Imagen de mas de 50 MP: solo se ofrece el JPEG original (si lo hay); si no, se omite (el llamador avisa). */
async function buildTooLarge(
  event: ImagePaintEvent,
  ref: string | null,
  pageIndex: number,
  occurrence: AssetOccurrence,
  decodedW: number,
  decodedH: number,
  getJpegIndex: () => Promise<JpegIndex>,
  withAnnotations: boolean,
): Promise<AssetState | null> {
  if (!ref) return null;
  const jpeg = (await getJpegIndex()).get(ref);
  if (!jpeg) return null;
  const state: AssetState = {
    id: `big-${ref}`,
    source: sourceOf(event.kind),
    occurrences: [],
    pages: new Set(),
    occurrenceCount: 0,
    pixel: { width: jpeg.width || decodedW, height: jpeg.height || decodedH, hasAlpha: false },
    formats: ["jpg-original"],
    bytesEstimate: jpeg.bytes.byteLength,
    thumb: null,
    objectId: makeObjectId(event, ref, withAnnotations),
    pageIndex,
    inForm: false,
    inAnnotation: event.inAnnotation,
    jpegOriginal: true,
    tooLarge: true,
    reducedFrom: null,
  };
  state.occurrenceCount = 1;
  state.pages.add(pageIndex);
  state.inForm = event.inForm;
  state.occurrences.push(occurrence);
  return state;
}

/* ------------------------------------------------------------------ *
 * Regenerar un elemento bajo demanda
 * ------------------------------------------------------------------ */

export type RenderImageOptions = {
  signal?: AbortSignal;
  ops?: ImageOpNumbers;
  /** Bytes del PDF (para `jpg-original`); por defecto los de `source` o `doc.getData()`. */
  bytes?: Uint8Array;
  /** Calidad del JPEG recomprimido (`jpg`), 0..1. */
  jpegQuality?: number;
};

export class ImageAssetError extends Error {
  constructor(
    readonly code: "not-an-image-asset" | "format-unavailable" | "asset-changed" | "decode-failed" | "no-canvas",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ImageAssetError";
  }
}

function isDocument(source: unknown): source is PDFDocumentProxy {
  return !!source && typeof source === "object" && "getPage" in source && typeof (source as { getPage: unknown }).getPage === "function";
}

async function bytesOf(source: File | Uint8Array): Promise<Uint8Array> {
  return source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
}

/**
 * Bytes de una imagen en el formato pedido. Regenera los pixeles bajo demanda (el resultado de la extraccion no los
 * guarda): `png` (por defecto, con alfa), `jpg-original` (el flujo JPEG del PDF, sin recomprimir) o `jpg` (recomprimido,
 * alfa sobre blanco; solo en un navegador). `source` puede ser el documento de pdf.js ya abierto (no se cierra) o el
 * archivo / los bytes (se abre y se cierra aqui).
 */
export async function renderImageAsset(
  source: PDFDocumentProxy | File | Uint8Array,
  asset: ExtractedAsset,
  format: AssetFormat = "png",
  options: RenderImageOptions = {},
): Promise<Blob> {
  if (asset.ref.engine !== "image") throw new ImageAssetError("not-an-image-asset");
  const parsed = parseObjectId(asset.ref.objectId);
  if (!parsed) throw new ImageAssetError("not-an-image-asset", `objectId no valido: ${asset.ref.objectId}`);
  if (!asset.formats.includes(format)) throw new ImageAssetError("format-unavailable", `${format} no esta disponible para ${asset.id}`);
  const slicer = new Slicer(options.signal);

  if (format === "jpg-original") {
    if (!parsed.ref) throw new ImageAssetError("format-unavailable", "sin referencia de objeto");
    const bytes = options.bytes ?? (isDocument(source) ? await source.getData() : await bytesOf(source));
    const jpeg = (await buildJpegIndex(bytes)).get(parsed.ref);
    if (!jpeg || !readJpegHeader(jpeg.bytes)) throw new ImageAssetError("format-unavailable", "el JPEG original ya no esta en el documento");
    return new Blob([jpeg.bytes as unknown as BlobPart], { type: "image/jpeg" });
  }

  const ops = options.ops ?? (await defaultOps());
  const owned = !isDocument(source);
  const doc = isDocument(source) ? source : await openPdfDocument(await bytesOf(source));
  let page: PDFPageProxy | null = null;
  let pixels: PixelSource | null = null;
  let atlas: PixelSource | null = null;
  try {
    page = await doc.getPage(asset.ref.pageIndex + 1);
    const list = await pageOperatorList(page, parsed.withAnnotations);
    const { events } = walkImagePaints(list.fnArray, list.argsArray, ops, MAX_PAINTS_PER_PAGE);
    const event = events.find((candidate) => candidate.opIndex === parsed.opIndex && candidate.entry === parsed.entry && candidate.kind === parsed.kind);
    if (!event) throw new ImageAssetError("asset-changed", "la pintura de la imagen ya no esta en la pagina");

    const imgData = event.objId !== null ? await resolveObject(page, event.objId, options.signal) : event.inline;
    if (!imgData) throw new ImageAssetError("decode-failed");
    if (parsed.ref && event.kind === "xobject") {
      const ref = normRef((imgData as { ref?: unknown }).ref);
      if (ref && ref !== parsed.ref) throw new ImageAssetError("asset-changed", "el objeto de la pagina cambio");
    }
    if (event.atlas) {
      atlas = pixelSourceFor(event.inline, { kind: "image" });
      pixels = atlas ? cropSource(atlas, event.atlas) : null;
    } else {
      pixels = pixelSourceFor(imgData, { kind: event.kind === "mask" ? "mask" : "image", fill: event.fill });
    }
    if (!pixels) throw new ImageAssetError("decode-failed");
    if (pixels.width * pixels.height > EXTRACT_LIMITS.maxImageMegapixels * 1_000_000) throw new ImageAssetError("format-unavailable", "imagen de mas de 50 MP");
    try {
      return format === "jpg" ? await encodeSourceAsJpeg(pixels, slicer, options.jpegQuality) : await encodeSourceAsPng(pixels, slicer);
    } catch (error) {
      if (isAbortError(error) || error instanceof ImageAssetError) throw error;
      if (error instanceof Error && error.message === "canvas-unavailable") throw new ImageAssetError("no-canvas");
      throw error;
    }
  } finally {
    pixels?.close();
    atlas?.close();
    try {
      page?.cleanup();
    } catch {
      // ya liberada
    }
    if (owned) await closePdfDocument(doc);
  }
}

/** Conveniencia: el PNG del elemento. */
export function renderImageAssetPng(source: PDFDocumentProxy | File | Uint8Array, asset: ExtractedAsset, options?: RenderImageOptions): Promise<Blob> {
  return renderImageAsset(source, asset, "png", options);
}
