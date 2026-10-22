import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { loadJSZip } from "@/lib/pdf/lazyZip";
import { createPrepareSession, yieldToMain, type PrepareSession } from "@/lib/image/prepareBrowser";
import {
  DEFAULT_IMAGE_PRESET,
  ESTIMATE_HEAD_BYTES,
  IMAGE_PRESETS,
  ImagePrepareError,
  readImageHeader,
  type ImagePresetId,
} from "@/lib/image/prepareForPdf";
import {
  MARGIN_POINTS,
  SHEET_POINTS,
  layoutPhotoGrid,
  pixelsNeededForRect,
  type PhotosPerPage,
  type PhotoSize,
} from "@/lib/pdf/photoGrid";
import {
  orientationMatrix,
  orientedSize,
  type ExifOrientation,
} from "@/lib/pdf/jpegOrientation";
import { uniqueZipName, zipNameKey } from "@/lib/pdf/entryNames";
import {
  PdfError,
  savePdfToBlob,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor "imagenes -> PDF".
 *
 * Modulo puro (sin React) que se ejecuta en el navegador: los bytes de
 * las imagenes nunca salen del dispositivo. `scanToPdf.ts` reutiliza la
 * composicion de paginas de este archivo para las capturas de camara.
 *
 * Calidad de imagen: cada foto pasa por `src/lib/image/prepareForPdf.ts` antes de incrustarse (reduce y reencoda las
 * fotos grandes SIN ampliar nunca y solo si ahorra >= 15 %; los archivos originales no se tocan). El preset
 * `original` conserva los bytes de JPEG/PNG tal cual, como hacia antes este motor.
 */

/* ------------------------------------------------------------------ *
 * Tipos de layout
 * ------------------------------------------------------------------ */

/** Orientacion de la pagina; `auto` la deduce del lado mayor de la imagen. */
export type ImageOrientation = "portrait" | "landscape" | "auto";

/** `fit` genera una pagina del tamano exacto de la imagen mas el margen. */
export type ImagePageSize = "a4" | "letter" | "fit";

export type ImageMargin = "none" | "small" | "large";

export type ImageLayout = {
  orientation: ImageOrientation;
  pageSize: ImagePageSize;
  margin: ImageMargin;
  /**
   * Fotos por hoja (1 por defecto: una pagina por imagen, como siempre). Con 2, 4, 6, 8 o 10 se compone una cuadricula de
   * 2 columnas (ver `photoGrid.ts`); con varias fotos «Ajustar» usa A4.
   */
  photosPerPage?: PhotosPerPage;
};

export const DEFAULT_IMAGE_LAYOUT: ImageLayout = {
  orientation: "auto",
  pageSize: "a4",
  margin: "none",
};

/** Puntos PostScript (1 pt = 1/72") de los tamanos estandar en vertical. */
const PAGE_SIZES: Record<Exclude<ImagePageSize, "fit">, [number, number]> = {
  a4: [SHEET_POINTS.a4.width, SHEET_POINTS.a4.height],
  letter: [SHEET_POINTS.letter.width, SHEET_POINTS.letter.height],
};

export const MARGINS: Record<ImageMargin, number> = MARGIN_POINTS;

/** Tamano de hoja en vertical (puntos) de una opcion de tamano; `fit` no tiene tamano propio (A4 con varias fotos). */
export function pageSizeInPoints(pageSize: ImagePageSize): { width: number; height: number } {
  const [width, height] = PAGE_SIZES[pageSize === "fit" ? "a4" : pageSize];
  return { width, height };
}

/* ------------------------------------------------------------------ *
 * Utilidades de canvas / decodificacion
 * ------------------------------------------------------------------ */

/**
 * Envuelve `canvas.toBlob` en una promesa. Vive aqui porque es la unica
 * pieza de canvas compartida por los tres motores de conversion
 * (`imagesToPdf`, `pdfToImages` y `scanToPdf`).
 */
import { canvasToBlob } from "@/lib/pdf/canvasBlob";
export { canvasToBlob };

type EmbeddedImage = { image: PDFImage; orientation: ExifOrientation };

export type ImageBatchStats = {
  photos: number;
  /** Suma del peso de los archivos originales. */
  sourceBytes: number;
  /** Fotos cuyos bytes cambiaron (reducidas, reencodadas o convertidas). */
  changed: number;
};

export function emptyBatchStats(): ImageBatchStats {
  return { photos: 0, sourceBytes: 0, changed: 0 };
}

/**
 * Incrusta una imagen en el documento. La foto se prepara primero (`prepareImage`): un JPEG que se conserva se incrusta tal
 * cual (pdf-lib no mira EXIF, asi que se devuelve su orientacion para dibujarlo girado); una foto reencodada o convertida
 * sale ya derecha (el navegador aplico la orientacion al decodificar) y se incrusta con orientacion 1.
 */
async function embedImage(
  document: PDFDocument,
  source: Blob,
  session: PrepareSession,
  preset: ImagePresetId,
  signal: AbortSignal | undefined,
  stats: ImageBatchStats | undefined,
  fitMaxSide?: number,
): Promise<EmbeddedImage> {
  let prepared;
  try {
    prepared = await session.prepare(source, preset, signal, fitMaxSide);
  } catch (error) {
    if (error instanceof ImagePrepareError) throw new PdfError(error.code === "cancelled" ? "cancelled" : "invalidType");
    throw error;
  }
  if (stats) {
    stats.photos += 1;
    stats.sourceBytes += prepared.originalBytes;
    if (prepared.changed) stats.changed += 1;
  }
  try {
    const image =
      prepared.format === "jpeg" ? await document.embedJpg(prepared.bytes) : await document.embedPng(prepared.bytes);
    return { image, orientation: prepared.orientation };
  } catch {
    // pdf-lib lanza errores de parseo propios cuando el archivo miente
    // sobre su formato: para el usuario es simplemente un tipo invalido.
    throw new PdfError("invalidType");
  }
}

/* ------------------------------------------------------------------ *
 * Composicion de paginas
 * ------------------------------------------------------------------ */

type PageBox = { pageWidth: number; pageHeight: number; margin: number };

function resolvePageBox(
  layout: ImageLayout,
  imageWidth: number,
  imageHeight: number,
): PageBox {
  const margin = MARGINS[layout.margin];

  if (layout.pageSize === "fit") {
    // El tamano de pagina lo dicta la imagen: la orientacion ya viene dada.
    return {
      pageWidth: imageWidth + margin * 2,
      pageHeight: imageHeight + margin * 2,
      margin,
    };
  }

  const [shortSide, longSide] = PAGE_SIZES[layout.pageSize];
  const landscape =
    layout.orientation === "landscape" ||
    (layout.orientation === "auto" && imageWidth > imageHeight);

  return {
    pageWidth: landscape ? longSide : shortSide,
    pageHeight: landscape ? shortSide : longSide,
    margin,
  };
}

/** Anade una pagina con la imagen centrada dentro del area util. */
function addImagePage(
  document: PDFDocument,
  image: PDFImage,
  layout: ImageLayout,
  orientation: ExifOrientation = 1,
): void {
  // Dimensiones de la imagen YA girada: mandan en la orientacion automatica y en «Ajustar».
  const shown = orientedSize(Math.max(1, image.width), Math.max(1, image.height), orientation);
  const imageWidth = shown.width;
  const imageHeight = shown.height;
  const { pageWidth, pageHeight, margin } = resolvePageBox(
    layout,
    imageWidth,
    imageHeight,
  );

  const boxWidth = Math.max(1, pageWidth - margin * 2);
  const boxHeight = Math.max(1, pageHeight - margin * 2);
  const scale = Math.min(boxWidth / imageWidth, boxHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;

  const page = document.addPage([pageWidth, pageHeight]);
  drawImageInBox(
    page,
    image,
    orientation,
    { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height },
  );
}

/** Dibuja la imagen (con su orientacion EXIF, si la trae) llenando `box`, que ya es del tamano de la imagen vista. */
function drawImageInBox(
  page: PDFPage,
  image: PDFImage,
  orientation: ExifOrientation,
  box: { x: number; y: number; width: number; height: number },
): void {
  if (orientation === 1) {
    page.drawImage(image, box);
    return;
  }
  // Imagen con orientacion EXIF: se dibuja con la matriz que la gira (y la refleja si hace falta).
  const name = page.node.newXObject("Image", image.ref);
  const [a, b, c, d, e, f] = orientationMatrix(orientation, Math.max(1, image.width), Math.max(1, image.height), box);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(name), popGraphicsState());
}

/**
 * Preparacion de las fotos de un lote: preset elegido, cancelacion, avisos de progreso y estadisticas. Todo opcional:
 * sin nada se usa el preset recomendado (`DEFAULT_IMAGE_PRESET`) y una sesion propia.
 */
export type ImagePrep = {
  preset?: ImagePresetId;
  signal?: AbortSignal;
  /** Sesion ya creada (comparte el worker entre varias llamadas); sin ella se crea y se cierra aqui. */
  session?: PrepareSession;
  /** Antes de preparar cada foto: posicion (1..total) y total. */
  onPhotoStart?: (position: number, total: number) => void;
  /** Se va rellenando con lo que ocurre: fotos, peso de los originales y cuantas se sustituyeron. */
  stats?: ImageBatchStats;
};

/** Proporcion de una foto leida de su cabecera (sin decodificar), o `null` si no se pudo. */
async function readDisplaySize(source: Blob): Promise<PhotoSize | null> {
  try {
    const head = new Uint8Array(await source.slice(0, ESTIMATE_HEAD_BYTES).arrayBuffer());
    const header = readImageHeader(head);
    return header.displayWidth && header.displayHeight ? { width: header.displayWidth, height: header.displayHeight } : null;
  } catch {
    return null;
  }
}

/**
 * Varias fotos por hoja. Para cada hoja: se lee la proporcion de sus fotos (cabecera), se compone una vez para saber
 * cuantos pixeles necesita cada foto por el sitio que ocupa (a `cellPpi` del preset), se preparan las fotos con ese tope
 * (de una en una) y se vuelve a componer con las proporciones reales antes de dibujar.
 */
async function buildGridPages(
  document: PDFDocument,
  sources: Blob[],
  layout: ImageLayout,
  perPage: PhotosPerPage,
  preset: ImagePresetId,
  session: PrepareSession,
  prep: ImagePrep,
  onProgress: ProgressCallback | undefined,
  progressTo: number,
): Promise<void> {
  const options = {
    perPage,
    pageSize: pageSizeInPoints(layout.pageSize),
    orientation: layout.orientation,
    margin: MARGINS[layout.margin],
  };
  const ppi = IMAGE_PRESETS[preset].cellPpi;
  const total = sources.length;
  for (let start = 0; start < total; start += perPage) {
    const group = sources.slice(start, start + perPage);
    const provisional = layoutPhotoGrid(
      await Promise.all(group.map(async (source) => (await readDisplaySize(source)) ?? { width: 4, height: 3 })),
      options,
    )[0];
    const embedded: EmbeddedImage[] = [];
    for (let position = 0; position < group.length; position += 1) {
      throwIfAborted(prep.signal);
      prep.onPhotoStart?.(start + position + 1, total);
      const fit = ppi > 0 ? pixelsNeededForRect(provisional.photos[position].rect, ppi) : undefined;
      embedded.push(await embedImage(document, group[position], session, preset, prep.signal, prep.stats, fit));
      onProgress?.(((start + position + 1) / total) * progressTo);
      // Cede el hilo entre fotos: el progreso se pinta y los toques se atienden aunque no haya nada que decodificar.
      await yieldToMain();
    }
    const [sheet] = layoutPhotoGrid(
      embedded.map(({ image, orientation }) =>
        orientedSize(Math.max(1, image.width), Math.max(1, image.height), orientation),
      ),
      options,
    );
    const page = document.addPage([sheet.pageWidth, sheet.pageHeight]);
    for (const placed of sheet.photos) {
      const item = embedded[placed.index];
      drawImageInBox(page, item.image, item.orientation, placed.rect);
    }
  }
}

/**
 * Construye un unico PDF con una pagina (o una hoja con varias fotos) por imagen. Es el nucleo que
 * comparten la herramienta de imagenes y la de escaneo con camara.
 */
export async function buildPdfFromImages(
  sources: Blob[],
  layout: ImageLayout = DEFAULT_IMAGE_LAYOUT,
  onProgress?: ProgressCallback,
  progressTo = 1,
  prep: ImagePrep = {},
): Promise<PDFDocument> {
  if (sources.length === 0) throw new PdfError("empty");

  const preset = prep.preset ?? DEFAULT_IMAGE_PRESET;
  const session = prep.session ?? createPrepareSession();
  try {
    const document = await PDFDocument.create();
    const perPage = layout.photosPerPage ?? 1;
    if (perPage > 1) {
      await buildGridPages(document, sources, layout, perPage, preset, session, prep, onProgress, progressTo);
      return document;
    }
    for (let index = 0; index < sources.length; index += 1) {
      throwIfAborted(prep.signal);
      prep.onPhotoStart?.(index + 1, sources.length);
      const { image, orientation } = await embedImage(document, sources[index], session, preset, prep.signal, prep.stats);
      addImagePage(document, image, layout, orientation);
      onProgress?.(((index + 1) / sources.length) * progressTo);
      await yieldToMain();
    }
    return document;
  } finally {
    if (!prep.session) session.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * API de la herramienta
 * ------------------------------------------------------------------ */

export type ImagesToPdfOptions = ImageLayout & {
  /** `true` (por defecto) une todo en un PDF; `false` genera un ZIP. */
  merge: boolean;
  /**
   * Orden e inclusion final de las imagenes, como indices de `files`.
   * Si se omite se usan todas en el orden de subida.
   */
  order?: number[];
  /** Calidad de imagen (ver `prepareForPdf.ts`). Sin ella, la recomendada. */
  quality?: ImagePresetId;
};

export const DEFAULT_IMAGES_TO_PDF_OPTIONS: ImagesToPdfOptions = {
  ...DEFAULT_IMAGE_LAYOUT,
  photosPerPage: 1,
  merge: true,
  quality: DEFAULT_IMAGE_PRESET,
};

export type ImagesToPdfResult = {
  blob: Blob;
  /** `pdf` cuando se unen todas; `zip` cuando hay un PDF por imagen. */
  kind: "pdf" | "zip";
  /** Numero de PDFs generados. */
  count: number;
  /** Fotos preparadas, peso de los originales y cuantas se sustituyeron por una version mas ligera. */
  stats: ImageBatchStats;
};

/** Extras de una ejecucion: cancelacion y aviso antes de preparar cada foto. */
export type ImagesToPdfRun = {
  signal?: AbortSignal;
  onPhotoStart?: (position: number, total: number) => void;
};

function replaceExtension(filename: string, extension: string): string {
  const dot = filename.lastIndexOf(".");
  const base = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return `${base || "imagen"}.${extension}`;
}

/**
 * Nombre de la entrada del ZIP para una imagen: `foto.jpg` -> `foto.pdf`, y si ya existe
 * (sin distinguir mayusculas ni forma Unicode) `foto (2).pdf`, `foto (3).pdf`... Termina siempre:
 * el contador de `uniqueZipName` crece y tiene tope. `used` guarda claves, no nombres.
 */
export function uniquePdfEntryName(filename: string, used: Set<string>): string {
  return uniqueZipName(replaceExtension(filename, "pdf"), used, {
    startAt: 2,
    key: zipNameKey,
  });
}

function resolveOrder(files: File[], order?: number[]): number[] {
  // `undefined` = todavia no hay plan explicito: se usan todas.
  // Un array vacio si es un plan, y significa "no queda ninguna imagen".
  if (!order) return files.map((_, index) => index);
  return order.filter((index) => index >= 0 && index < files.length);
}

/**
 * Convierte imagenes (JPG, PNG y cualquier formato que el navegador sepa
 * decodificar) en PDF. Devuelve un unico documento o un ZIP con un PDF
 * por imagen segun `merge`.
 */
export async function imagesToPdf(
  files: File[],
  options: ImagesToPdfOptions = DEFAULT_IMAGES_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
  run: ImagesToPdfRun = {},
): Promise<ImagesToPdfResult> {
  if (files.length === 0) throw new PdfError("empty");

  const indices = resolveOrder(files, options.order);
  if (indices.length === 0) throw new PdfError("empty");

  const layout: ImageLayout = {
    orientation: options.orientation,
    pageSize: options.pageSize,
    margin: options.margin,
    photosPerPage: options.merge ? (options.photosPerPage ?? 1) : 1,
  };
  const stats = emptyBatchStats();
  const session = createPrepareSession();
  const prep: ImagePrep = {
    preset: options.quality ?? DEFAULT_IMAGE_PRESET,
    signal: run.signal,
    session,
    onPhotoStart: run.onPhotoStart,
    stats,
  };

  try {
    if (options.merge) {
      const document = await buildPdfFromImages(
        indices.map((index) => files[index]),
        layout,
        onProgress,
        0.9,
        prep,
      );
      throwIfAborted(run.signal);
      const blob = await savePdfToBlob(document);
      onProgress?.(1);
      return { blob, kind: "pdf", count: 1, stats };
    }

    const Zip = await loadJSZip();
    const zip = new Zip();
    const used = new Set<string>();

    for (let position = 0; position < indices.length; position += 1) {
      throwIfAborted(run.signal);
      const file = files[indices[position]];
      const document = await buildPdfFromImages([file], layout, undefined, 1, {
        ...prep,
        onPhotoStart: run.onPhotoStart ? () => run.onPhotoStart?.(position + 1, indices.length) : undefined,
      });
      const pdf = await savePdfToBlob(document);

      zip.file(uniquePdfEntryName(file.name, used), pdf);

      onProgress?.(((position + 1) / indices.length) * 0.9);
    }

    // Sin compresion: un PDF ya viene comprimido y el ZIP solo agrupa.
    const blob = await zip.generateAsync({ type: "blob" });
    onProgress?.(1);
    return { blob, kind: "zip", count: indices.length, stats };
  } catch (error) {
    throw toPdfError(error);
  } finally {
    session.dispose();
  }
}
