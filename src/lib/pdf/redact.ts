import { PDFDocument } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  loadPdf,
  openPdfDocument,
  readFileBytes,
  renderPageToCanvas,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/canvasBlob";

/**
 * Motor de censura.
 *
 * Tapar con un rectangulo negro dibujado ENCIMA no censura nada: el
 * texto sigue en el archivo y se recupera con copiar y pegar o con
 * cualquier extractor. Aqui la pagina afectada se aplana de verdad: se
 * rasteriza con pdf.js, se pinta CADA elemento (rectangulo o trazo a mano
 * alzada) directamente sobre ese mapa de bits -- nunca sobre el contenido
 * vectorial original -- y se monta una pagina nueva con esa imagen. Lo
 * que quedaba debajo deja de existir en el archivo de salida.
 *
 * GARANTIA DE SEGURIDAD (leer antes de tocar este archivo): todo efecto
 * (negro, difuminado, pixelado o pintura de color) se calcula EXCLUSIVAMENTE
 * a partir de los pixeles ya rasterizados de `canvas` (la pagina completa
 * ya convertida a mapa de bits por `renderPageToCanvas`). Ninguna funcion
 * de este archivo lee texto, trazados vectoriales ni ningun dato "vivo"
 * del PDF original para calcular un efecto -- todas (`paintFlatRegion`,
 * `paintBlurRegion`, `paintPixelateRegion`, `bakeRectElement`,
 * `bakeStrokeElement`) reciben como entrada unicamente el propio `canvas`
 * ya rasterizado (o un recorte de sus pixeles hecho con `drawImage`), y
 * el resultado se compone de vuelta sobre ESE MISMO canvas antes del
 * unico paso final: codificar el canvas entero a JPEG y montarlo como
 * pagina de imagen. No existe ninguna ruta en la que un efecto se calcule
 * sobre otra cosa que no sea ese mapa de bits, ni una superposicion
 * translucida sobre contenido sin rasterizar.
 *
 * CONSECUENCIA REAL: las paginas censuradas se convierten en imagen (su
 * texto deja de ser seleccionable). Las paginas sin elementos se copian
 * intactas, asi que un documento largo con una sola censura conserva el
 * resto tal cual.
 *
 * El render usa SIEMPRE `intent: "print"`: con `"display"` pdf.js
 * encadena los pasos con `requestAnimationFrame` y el proceso se congela
 * si la pestana deja de pintar.
 */

/** Punto normalizado 0..1 sobre la pagina renderizada. */
export type RedactPoint = { x: number; y: number };

/** Efecto aplicado sobre el mapa de bits ya rasterizado de la pagina. */
export type RedactMode = "black" | "blur" | "pixelate" | "paint";

type RedactElementBase = {
  /** Identificador estable para React keys y para el borrador. */
  id: string;
  pageIndex: number;
  mode: RedactMode;
  /** Color del efecto; solo tiene efecto cuando `mode === "paint"`. */
  color?: string;
};

/** Rectangulo normalizado 0..1 sobre la pagina renderizada (origen arriba-izquierda). */
export type RedactRectElement = RedactElementBase & {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Trazo a mano alzada: lista ordenada de puntos 0..1 + grosor. */
export type RedactStrokeElement = RedactElementBase & {
  kind: "stroke";
  /** Puntos en el orden en que se dibujaron. */
  points: RedactPoint[];
  /** Grosor del trazo, en fraccion del ANCHO de la pagina (mismo espacio que `x`). */
  strokeWidth: number;
};

export type RedactElement = RedactRectElement | RedactStrokeElement;

/** Alias retrocompatible: el nombre original solo cubria rectangulos. */
export type RedactBox = RedactRectElement;

export type RedactOptions = {
  elements: RedactElement[];
};

export const DEFAULT_REDACT_OPTIONS: RedactOptions = { elements: [] };

/** Lado minimo de un rectangulo util, en fraccion de pagina. */
export const MIN_BOX_SIDE = 0.01;

/** Un trazo con menos puntos que este no aporta area util. */
export const MIN_STROKE_POINTS = 2;

/** Grosor de trazo por defecto y limites, en fraccion del ancho de pagina. */
export const DEFAULT_STROKE_WIDTH = 0.028;
export const MIN_STROKE_WIDTH = 0.006;
export const MAX_STROKE_WIDTH = 0.12;

/** Radio por defecto del borrador (v1: borra elementos enteros que toca). */
export const ERASER_RADIUS = 0.025;

/** Color de pintura por defecto cuando el usuario no elige otro. */
export const DEFAULT_PAINT_COLOR = "#ef4444";

/**
 * Margen de seguridad (en pixeles del canvas final) que se suma al
 * grosor real del trazo antes de calcular la region a censurar: el area
 * que cubre un trazo a mano alzada nunca es un rectangulo exacto como el
 * que ya garantiza `sanitizeBox` para los rectangulos, asi que se infla
 * un poco para no dejar un borde de pixeles sin tratar junto al trazo.
 */
const STROKE_SAFETY_MARGIN_PX = 2;

/** Resolucion del aplanado: 2x ~ 144 DPI. */
const RASTER_SCALE = 2;
const MAX_RASTER_SIDE = 4000;
const RASTER_QUALITY = 0.85;

/**
 * Negro puro. No es un color de interfaz sino tinta: se pinta sobre el
 * mapa de bits de la pagina, fuera del sistema de tokens del diseno.
 */
const REDACTION_INK = "#000000";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampStrokeWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STROKE_WIDTH;
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, value));
}

/** Descarta rectangulos degenerados y recorta a los limites de la pagina. */
export function sanitizeBox(box: RedactRectElement): RedactRectElement | null {
  const x = clamp01(Math.min(box.x, box.x + box.width));
  const y = clamp01(Math.min(box.y, box.y + box.height));
  const width = Math.min(1 - x, Math.abs(box.width));
  const height = Math.min(1 - y, Math.abs(box.height));
  if (width < MIN_BOX_SIDE || height < MIN_BOX_SIDE) return null;
  return { ...box, x, y, width, height };
}

/** Recorta los puntos a la pagina y descarta trazos sin suficiente forma. */
export function sanitizeStroke(stroke: RedactStrokeElement): RedactStrokeElement | null {
  const points = stroke.points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
  if (points.length < MIN_STROKE_POINTS) return null;
  return { ...stroke, points, strokeWidth: clampStrokeWidth(stroke.strokeWidth) };
}

export function sanitizeElement(element: RedactElement): RedactElement | null {
  return element.kind === "rect" ? sanitizeBox(element) : sanitizeStroke(element);
}

function groupByPage(elements: RedactElement[]): Map<number, RedactElement[]> {
  const grouped = new Map<number, RedactElement[]>();
  for (const element of elements) {
    const clean = sanitizeElement(element);
    if (!clean) continue;
    const list = grouped.get(clean.pageIndex) ?? [];
    list.push(clean);
    grouped.set(clean.pageIndex, list);
  }
  return grouped;
}

/**
 * Caja delimitadora de un trazo en el mismo espacio 0..1 que sus puntos,
 * inflada por la mitad de su grosor. Pura y sin DOM: la usa tanto la UI
 * (boton de borrar, resaltado del borrador) como, potencialmente, tests.
 */
export function strokeBounds(
  stroke: Pick<RedactStrokeElement, "points" | "strokeWidth">,
): { x: number; y: number; width: number; height: number } {
  if (stroke.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const pad = stroke.strokeWidth / 2;
  const x = clamp01(minX - pad);
  const y = clamp01(minY - pad);
  const right = clamp01(maxX + pad);
  const bottom = clamp01(maxY + pad);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * True si `point` (0..1) toca el elemento con un margen `radius` (0..1).
 * Logica pura reutilizada por el borrador de la UI: quita el elemento
 * entero que toca (comportamiento v1, ver plan).
 */
export function elementHitTest(
  element: RedactElement,
  point: RedactPoint,
  radius: number,
): boolean {
  if (element.kind === "rect") {
    return (
      point.x >= element.x - radius &&
      point.x <= element.x + element.width + radius &&
      point.y >= element.y - radius &&
      point.y <= element.y + element.height + radius
    );
  }
  const reach = radius + element.strokeWidth / 2;
  return element.points.some(
    (p) => Math.hypot(p.x - point.x, p.y - point.y) <= reach,
  );
}

type PixelRect = { x: number; y: number; width: number; height: number };

function blurRadiusFor(rect: PixelRect): number {
  return Math.max(8, Math.round(Math.min(rect.width, rect.height) * 0.18));
}

function pixelCellFor(rect: PixelRect): number {
  return Math.max(6, Math.round(Math.min(rect.width, rect.height) / 8));
}

/** Relleno solido (negro o color de pintura). */
function paintFlatRegion(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

/**
 * Difumina la region `rect` de `source` (SIEMPRE el propio mapa de bits
 * ya rasterizado, nunca contenido vectorial) y compone el resultado de
 * vuelta en `ctx` en el mismo lugar.
 */
function paintBlurRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  rect: PixelRect,
): void {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const blurPx = blurRadiusFor(rect);

  const crop = document.createElement("canvas");
  crop.width = width;
  crop.height = height;
  const cropCtx = crop.getContext("2d");
  if (!cropCtx) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  cropCtx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  const blurred = document.createElement("canvas");
  blurred.width = width;
  blurred.height = height;
  const blurredCtx = blurred.getContext("2d");
  if (!blurredCtx) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  blurredCtx.filter = `blur(${blurPx}px)`;
  blurredCtx.drawImage(crop, 0, 0);

  ctx.drawImage(blurred, rect.x, rect.y, rect.width, rect.height);
  crop.width = 0;
  crop.height = 0;
  blurred.width = 0;
  blurred.height = 0;
}

/**
 * Pixelado clasico: reduce la region a una miniatura y la vuelve a
 * ampliar sin suavizado. Igual que `paintBlurRegion`, la entrada es
 * siempre el mapa de bits ya rasterizado.
 */
function paintPixelateRegion(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  rect: PixelRect,
): void {
  const cell = pixelCellFor(rect);
  const cols = Math.max(1, Math.round(rect.width / cell));
  const rows = Math.max(1, Math.round(rect.height / cell));

  const small = document.createElement("canvas");
  small.width = cols;
  small.height = rows;
  const smallCtx = small.getContext("2d");
  if (!smallCtx) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  smallCtx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, cols, rows);

  const wasSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, cols, rows, rect.x, rect.y, rect.width, rect.height);
  ctx.imageSmoothingEnabled = wasSmoothing;
  small.width = 0;
  small.height = 0;
}

/** Aplica el efecto elegido sobre `rect`, leyendo pixeles solo de `canvas`. */
function applyModeToRegion(
  ctx: CanvasRenderingContext2D,
  canvas: CanvasImageSource,
  rect: PixelRect,
  mode: RedactMode,
  color: string | undefined,
): void {
  switch (mode) {
    case "black":
      paintFlatRegion(ctx, rect, REDACTION_INK);
      return;
    case "paint":
      paintFlatRegion(ctx, rect, color ?? DEFAULT_PAINT_COLOR);
      return;
    case "blur":
      paintBlurRegion(ctx, canvas, rect);
      return;
    case "pixelate":
      paintPixelateRegion(ctx, canvas, rect);
      return;
  }
}

function bakeRectElement(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  element: RedactRectElement,
): void {
  const rect: PixelRect = {
    x: element.x * canvas.width,
    y: element.y * canvas.height,
    width: element.width * canvas.width,
    height: element.height * canvas.height,
  };
  applyModeToRegion(ctx, canvas, rect, element.mode, element.color);
}

/**
 * Hornea un trazo a mano alzada. El efecto se calcula sobre un recorte
 * del PROPIO `canvas` ya rasterizado (nunca sobre otra cosa), y luego se
 * recompone de vuelta solo dentro de la silueta real del trazo (mas el
 * margen de seguridad): una mascara alfa dibujada con el mismo grosor de
 * linea se usa como `destination-in`, asi que fuera de la tinta del
 * trazo la pagina queda intacta y dentro de ella queda 100% el efecto.
 */
function bakeStrokeElement(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  element: RedactStrokeElement,
): void {
  const width = canvas.width;
  const height = canvas.height;
  const pointsPx = element.points.map((p) => ({ x: p.x * width, y: p.y * height }));
  const widthPx = Math.max(1, element.strokeWidth * width);
  const pad = widthPx / 2 + STROKE_SAFETY_MARGIN_PX;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of pointsPx) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const boundX = Math.max(0, Math.floor(minX - pad));
  const boundY = Math.max(0, Math.floor(minY - pad));
  const boundRight = Math.min(width, Math.ceil(maxX + pad));
  const boundBottom = Math.min(height, Math.ceil(maxY + pad));
  const regionWidth = boundRight - boundX;
  const regionHeight = boundBottom - boundY;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  const region = document.createElement("canvas");
  region.width = regionWidth;
  region.height = regionHeight;
  const regionCtx = region.getContext("2d");
  if (!regionCtx) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  // Recorte de pixeles: SIEMPRE del `canvas` de pagina ya rasterizado.
  regionCtx.drawImage(
    canvas,
    boundX,
    boundY,
    regionWidth,
    regionHeight,
    0,
    0,
    regionWidth,
    regionHeight,
  );

  applyModeToRegion(
    regionCtx,
    region,
    { x: 0, y: 0, width: regionWidth, height: regionHeight },
    element.mode,
    element.color,
  );

  // Mascara con la silueta real del trazo (mismo grosor + margen).
  const mask = document.createElement("canvas");
  mask.width = regionWidth;
  mask.height = regionHeight;
  const maskCtx = mask.getContext("2d");
  if (!maskCtx) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }
  maskCtx.lineCap = "round";
  maskCtx.lineJoin = "round";
  maskCtx.strokeStyle = "#ffffff";
  maskCtx.lineWidth = widthPx + STROKE_SAFETY_MARGIN_PX * 2;
  maskCtx.beginPath();
  const localPoints = pointsPx.map((p) => ({ x: p.x - boundX, y: p.y - boundY }));
  localPoints.forEach((point, index) => {
    if (index === 0) maskCtx.moveTo(point.x, point.y);
    else maskCtx.lineTo(point.x, point.y);
  });
  if (localPoints.length === 1) {
    // Un solo punto (toque sin arrastre): remata en punto redondo.
    maskCtx.lineTo(localPoints[0].x + 0.01, localPoints[0].y);
  }
  maskCtx.stroke();

  regionCtx.globalCompositeOperation = "destination-in";
  regionCtx.drawImage(mask, 0, 0);
  regionCtx.globalCompositeOperation = "source-over";

  // Composicion final: solo la tinta del trazo reemplaza pixeles de pagina.
  ctx.drawImage(region, boundX, boundY);

  region.width = 0;
  region.height = 0;
  mask.width = 0;
  mask.height = 0;
}

function bakeElement(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  element: RedactElement,
): void {
  if (element.kind === "rect") bakeRectElement(ctx, canvas, element);
  else bakeStrokeElement(ctx, canvas, element);
}

export async function redactPdf(
  file: File,
  options: RedactOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const elementsByPage = groupByPage(options.elements);
  if (elementsByPage.size === 0) throw new PdfError("empty");

  let viewer: PDFDocumentProxy | null = null;
  try {
    const source = await loadPdf(file);
    const total = source.getPageCount();
    if (total === 0) throw new PdfError("corrupt");

    viewer = await openPdfDocument(file);
    const output = await PDFDocument.create();

    for (let index = 0; index < total; index += 1) {
      const elements = elementsByPage.get(index);

      if (!elements || elements.length === 0) {
        // Pagina sin censuras: se copia tal cual, sin perder calidad.
        const [copied] = await output.copyPages(source, [index]);
        output.addPage(copied);
      } else {
        const page = await viewer.getPage(index + 1);
        // Viewport a escala 1: puntos PDF con la rotacion ya aplicada.
        const base = page.getViewport({ scale: 1 });
        const longest = Math.max(base.width, base.height, 1);
        const scale = Math.max(
          0.1,
          Math.min(RASTER_SCALE, MAX_RASTER_SIDE / longest),
        );

        const canvas = await renderPageToCanvas(page, {
          scale,
          // Obligatorio: rasterizado fuera de pantalla.
          intent: "print",
        });
        const context = canvas.getContext("2d");
        if (!context) {
          throw new PdfError("unknown", "Canvas 2D context unavailable");
        }

        // Orden de dibujo = orden en que el usuario creo cada elemento,
        // asi que un trazo posterior puede pintar sobre uno anterior tal
        // como se veia en la vista previa.
        for (const element of elements) {
          bakeElement(context, canvas, element);
        }

        const jpeg = await canvasToBlob(canvas, "image/jpeg", RASTER_QUALITY);
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();

        const image = await output.embedJpg(await readFileBytes(jpeg));
        const target = output.addPage([base.width, base.height]);
        target.drawImage(image, {
          x: 0,
          y: 0,
          width: base.width,
          height: base.height,
        });
      }

      onProgress?.(((index + 1) / total) * 0.92);
    }

    const blob = await savePdfToBlob(output);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (viewer) await closePdfDocument(viewer);
  }
}
