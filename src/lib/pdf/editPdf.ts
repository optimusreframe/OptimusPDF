import {
  LineCapStyle,
  degrees,
  type PDFDocument,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  hexToPdfColor,
  loadPdf,
  normalizedRectToUserBox,
  originForCenter,
  savePdfToBlob,
  standardFontFor,
  throwIfAborted,
  toPdfError,
  toWinAnsiSafe,
  viewPointToUser,
  type PageGeometry,
  type PdfFontFamily,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor del editor de PDF.
 *
 * ANADE contenido nuevo (texto, imagenes, formas, resaltados) sobre las
 * paginas que ya existen. NO reescribe el texto original del documento:
 * el flujo de contenido de cada pagina se conserva intacto y lo nuevo se
 * pinta encima con la API vectorial de pdf-lib, asi que nada se
 * rasteriza y el texto de fondo sigue siendo seleccionable (a diferencia
 * de `redact.ts` o `compress.ts`, que si aplanan la pagina).
 *
 * Todas las coordenadas de los elementos son fracciones 0..1 medidas
 * sobre la pagina tal y como se ve en pantalla, con origen ARRIBA a la
 * izquierda igual que el DOM y que `RedactBox` en `redact.ts`. La
 * conversion al espacio de usuario del PDF (origen abajo-izquierda, con
 * `/Rotate` deshecho) la resuelven las utilidades de `core.ts`.
 */

/* ------------------------------------------------------------------ *
 * Tipos de elemento
 * ------------------------------------------------------------------ */

export type EditElementType =
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "highlight"
  | "check";

export const EDIT_ELEMENT_TYPES: readonly EditElementType[] = [
  "text",
  "image",
  "rect",
  "ellipse",
  "line",
  "highlight",
  "check",
] as const;

export type EditElementBase = {
  /** Identificador estable para React keys y para la seleccion. */
  id: string;
  pageIndex: number;
};

/** Caja normalizada 0..1 sobre la vista, origen arriba-izquierda. */
type BoxFields = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TextElement = EditElementBase &
  Omit<BoxFields, "height"> & {
    type: "text";
    text: string;
    /** Cuerpo en puntos PDF. El alto de la caja lo marca el contenido. */
    fontSize: number;
    fontFamily: PdfFontFamily;
    bold: boolean;
    italic: boolean;
    color: string;
  };

export type ImageElement = EditElementBase &
  BoxFields & {
    type: "image";
    /** Bytes del PNG/JPG subido; el formato se detecta por la firma. */
    bytes: Uint8Array;
    /** Data URL solo para la vista previa; el motor no la usa. */
    previewUrl: string;
    /** alto / ancho de la imagen original, para conservar proporcion. */
    ratio: number;
  };

type ShapeFields = {
  strokeColor: string;
  /** Grosor del borde en puntos PDF. */
  strokeWidth: number;
  fill: boolean;
  fillColor: string;
  fillOpacity: number;
};

export type RectElement = EditElementBase &
  BoxFields &
  ShapeFields & { type: "rect" };

export type EllipseElement = EditElementBase &
  BoxFields &
  ShapeFields & { type: "ellipse" };

export type LineElement = EditElementBase & {
  type: "line";
  /** Extremos normalizados 0..1 sobre la vista. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeColor: string;
  strokeWidth: number;
};

export type HighlightElement = EditElementBase &
  BoxFields & {
    type: "highlight";
    color: string;
    opacity: number;
  };

/** Simbolo del elemento de marca: visto bueno o aspa. */
export type CheckMark = "check" | "cross";

export type CheckElement = EditElementBase &
  BoxFields & {
    type: "check";
    mark: CheckMark;
    strokeColor: string;
    strokeWidth: number;
  };

export type EditElement =
  | TextElement
  | ImageElement
  | RectElement
  | EllipseElement
  | LineElement
  | HighlightElement
  | CheckElement;

/* ------------------------------------------------------------------ *
 * Constantes compartidas con la interfaz
 * ------------------------------------------------------------------ */

/** Lado minimo util de un elemento, en fraccion de pagina. */
export const MIN_ELEMENT_SIDE = 0.012;
/** Longitud minima util de una linea, en fraccion de la diagonal. */
export const MIN_LINE_LENGTH = 0.02;

export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;
export const MIN_STROKE_WIDTH = 0.5;
export const MAX_STROKE_WIDTH = 12;

/** Interlineado como multiplo del cuerpo. Lo replica la vista previa. */
export const LINE_HEIGHT_FACTOR = 1.25;

/** Opacidades ofrecidas para el relleno de formas y el resaltado. */
export const FILL_OPACITIES = [0.15, 0.3, 0.5, 0.75, 1] as const;

/**
 * Tinta por defecto del resaltado. Es un dato del documento (acaba
 * impreso en el PDF), no un token del tema de la interfaz.
 */
export const HIGHLIGHT_COLORS = [
  "#fff176",
  "#a5f3a0",
  "#9ad9ff",
  "#ffb4d1",
  "#ffd08a",
] as const;

export const DEFAULT_HIGHLIGHT_OPACITY = 0.4;

/** Segmento del simbolo: `[x1, y1, x2, y2]` en 0..1 dentro de su caja. */
export type CheckStroke = readonly [number, number, number, number];

/**
 * Trazos de cada simbolo, con origen arriba-izquierda igual que las
 * cajas. Los comparte la vista previa para que el SVG del lienzo y lo que
 * acaba en el PDF sean la misma figura.
 */
export const CHECK_STROKES: Record<CheckMark, readonly CheckStroke[]> = {
  check: [
    [0.14, 0.52, 0.4, 0.84],
    [0.4, 0.84, 0.86, 0.16],
  ],
  cross: [
    [0.16, 0.16, 0.84, 0.84],
    [0.84, 0.16, 0.16, 0.84],
  ],
};

/* ------------------------------------------------------------------ *
 * Estilo activo
 * ------------------------------------------------------------------ */

/**
 * Ajustes con los que nace el siguiente elemento. Vive aqui, junto a los
 * tipos, porque describe datos del documento (tinta, cuerpo, grosor) y
 * no apariencia de la interfaz.
 */
export type EditStyle = {
  fontFamily: PdfFontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textColor: string;
  strokeColor: string;
  strokeWidth: number;
  fill: boolean;
  fillColor: string;
  fillOpacity: number;
  highlightColor: string;
  highlightOpacity: number;
  checkMark: CheckMark;
};

export const DEFAULT_EDIT_STYLE: EditStyle = {
  fontFamily: "helvetica",
  fontSize: 14,
  bold: false,
  italic: false,
  textColor: "#000000",
  strokeColor: "#e11d48",
  strokeWidth: 2,
  fill: false,
  fillColor: "#0d4bff",
  fillOpacity: 0.3,
  highlightColor: HIGHLIGHT_COLORS[0],
  highlightOpacity: DEFAULT_HIGHLIGHT_OPACITY,
  checkMark: "check",
};

/**
 * Reaplica el estilo activo a un elemento ya creado. Solo toca los
 * campos que ese tipo entiende, asi que cambiar el grosor con un texto
 * seleccionado no lo altera.
 */
export function applyStyleToElement(
  element: EditElement,
  style: EditStyle,
): EditElement {
  switch (element.type) {
    case "text":
      return {
        ...element,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        bold: style.bold,
        italic: style.italic,
        color: style.textColor,
      };
    case "rect":
    case "ellipse":
      return {
        ...element,
        strokeColor: style.strokeColor,
        strokeWidth: style.strokeWidth,
        fill: style.fill,
        fillColor: style.fillColor,
        fillOpacity: style.fillOpacity,
      };
    case "line":
      return {
        ...element,
        strokeColor: style.strokeColor,
        strokeWidth: style.strokeWidth,
      };
    case "check":
      return {
        ...element,
        mark: style.checkMark,
        strokeColor: style.strokeColor,
        strokeWidth: style.strokeWidth,
      };
    case "highlight":
      return {
        ...element,
        color: style.highlightColor,
        opacity: style.highlightOpacity,
      };
    default:
      return element;
  }
}

/* ------------------------------------------------------------------ *
 * Saneado y agrupado
 * ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Normaliza una caja dibujada en cualquier direccion y la recorta a la pagina. */
function normalizeBox(box: BoxFields): BoxFields {
  const x = clamp01(Math.min(box.x, box.x + box.width));
  const y = clamp01(Math.min(box.y, box.y + box.height));
  return {
    x,
    y,
    width: Math.min(1 - x, Math.abs(box.width)),
    height: Math.min(1 - y, Math.abs(box.height)),
  };
}

/**
 * Descarta los elementos degenerados (una caja de dos pixeles, un texto
 * vacio, una imagen sin bytes) y recorta el resto a los limites de la
 * pagina. Devolver `null` es la senal de "este elemento no pinta nada".
 */
export function sanitizeElement(element: EditElement): EditElement | null {
  if (element.pageIndex < 0 || !Number.isInteger(element.pageIndex)) {
    return null;
  }

  if (element.type === "text") {
    if (element.text.trim().length === 0) return null;
    const x = clamp01(element.x);
    return {
      ...element,
      x,
      y: clamp01(element.y),
      width: clamp(element.width, MIN_ELEMENT_SIDE, 1 - x),
      fontSize: clamp(element.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE),
    };
  }

  if (element.type === "line") {
    const x1 = clamp01(element.x1);
    const y1 = clamp01(element.y1);
    const x2 = clamp01(element.x2);
    const y2 = clamp01(element.y2);
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (length < MIN_LINE_LENGTH) return null;
    return {
      ...element,
      x1,
      y1,
      x2,
      y2,
      strokeWidth: clamp(
        element.strokeWidth,
        MIN_STROKE_WIDTH,
        MAX_STROKE_WIDTH,
      ),
    };
  }

  const box = normalizeBox(element);
  if (box.width < MIN_ELEMENT_SIDE || box.height < MIN_ELEMENT_SIDE) {
    return null;
  }

  if (element.type === "image") {
    if (element.bytes.byteLength < 4) return null;
    return { ...element, ...box };
  }

  if (element.type === "highlight") {
    return { ...element, ...box, opacity: clamp(element.opacity, 0.05, 1) };
  }

  if (element.type === "check") {
    // Un simbolo sin trazo no se veria, asi que aqui el minimo no es 0.
    return {
      ...element,
      ...box,
      strokeWidth: clamp(
        element.strokeWidth,
        MIN_STROKE_WIDTH,
        MAX_STROKE_WIDTH,
      ),
    };
  }

  return {
    ...element,
    ...box,
    strokeWidth: clamp(element.strokeWidth, 0, MAX_STROKE_WIDTH),
    fillOpacity: clamp(element.fillOpacity, 0.05, 1),
  };
}

/**
 * Agrupa por pagina conservando el orden de creacion: dentro de una
 * pagina, lo que se anadio despues se pinta despues (y por tanto
 * encima), que es lo que el usuario ve en la vista previa.
 */
export function groupElementsByPage(
  elements: readonly EditElement[],
): Map<number, EditElement[]> {
  const grouped = new Map<number, EditElement[]>();
  for (const element of elements) {
    const clean = sanitizeElement(element);
    if (!clean) continue;
    const list = grouped.get(clean.pageIndex);
    if (list) list.push(clean);
    else grouped.set(clean.pageIndex, [clean]);
  }
  return grouped;
}

/* ------------------------------------------------------------------ *
 * Texto: reparto en lineas
 * ------------------------------------------------------------------ */

/** Parte una palabra mas ancha que la caja, caracter a caracter. */
function hardBreak(
  font: PDFFont,
  word: string,
  size: number,
  maxWidth: number,
): string[] {
  const parts: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = current + char;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Reparte el texto en lineas que caben en `maxWidth`. Los saltos de
 * linea explicitos se respetan: se separan ANTES de pasar por
 * `toWinAnsiSafe`, que convierte cualquier salto en espacio.
 */
export function wrapText(
  font: PDFFont,
  text: string,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const safe = toWinAnsiSafe(rawLine).trim();
    if (safe.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of safe.split(/\s+/)) {
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        if (current) {
          lines.push(current);
          current = "";
        }
        const pieces = hardBreak(font, word, size, maxWidth);
        lines.push(...pieces.slice(0, -1));
        current = pieces[pieces.length - 1] ?? "";
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }

  return lines;
}

/* ------------------------------------------------------------------ *
 * Dibujo de cada tipo
 * ------------------------------------------------------------------ */

/** Punto normalizado del DOM (origen arriba) al espacio de usuario. */
function normalizedPointToUser(
  geometry: PageGeometry,
  nx: number,
  ny: number,
): { x: number; y: number } {
  return viewPointToUser(
    geometry,
    nx * geometry.viewWidth,
    (1 - ny) * geometry.viewHeight,
  );
}

function drawTextElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: TextElement,
  font: PDFFont,
): void {
  const size = element.fontSize;
  const maxWidth = Math.max(1, element.width * geometry.viewWidth);
  const lines = wrapText(font, element.text, size, maxWidth);
  if (lines.length === 0) return;

  const lineHeight = size * LINE_HEIGHT_FACTOR;
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = Math.max(0, font.heightAtSize(size) - ascent);
  // Mismo reparto de "half-leading" que aplica el navegador en la vista
  // previa, para que lo generado caiga donde el usuario lo ve.
  const baselineFromLineTop = (lineHeight - (ascent + descent)) / 2 + ascent;

  const color = hexToPdfColor(element.color);
  // Se compensa el `/Rotate` para que el texto se lea recto en pantalla.
  const angle = geometry.rotation;
  const left = element.x * geometry.viewWidth;
  const top = element.y * geometry.viewHeight;

  lines.forEach((line, index) => {
    if (line.length === 0) return;
    const fromTop = top + index * lineHeight + baselineFromLineTop;
    const origin = viewPointToUser(
      geometry,
      left,
      geometry.viewHeight - fromTop,
    );
    page.drawText(line, {
      x: origin.x,
      y: origin.y,
      size,
      font,
      color,
      rotate: degrees(angle),
    });
  });
}

function drawImageElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: ImageElement,
  image: PDFImage,
): void {
  const width = Math.max(1, element.width * geometry.viewWidth);
  const height = Math.max(1, element.height * geometry.viewHeight);
  const center = normalizedPointToUser(
    geometry,
    element.x + element.width / 2,
    element.y + element.height / 2,
  );
  const angle = geometry.rotation;
  const origin = originForCenter(
    center.x,
    center.y,
    width,
    height,
    0,
    angle,
  );
  page.drawImage(image, {
    x: origin.x,
    y: origin.y,
    width,
    height,
    rotate: degrees(angle),
  });
}

function drawRectElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: RectElement,
): void {
  // `/Rotate` es siempre multiplo de 90, asi que la caja de la vista
  // sigue siendo un rectangulo recto en el espacio de usuario.
  const box = normalizedRectToUserBox(geometry, element);
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: element.fill ? hexToPdfColor(element.fillColor) : undefined,
    opacity: element.fill ? element.fillOpacity : undefined,
    borderColor:
      element.strokeWidth > 0 ? hexToPdfColor(element.strokeColor) : undefined,
    borderWidth: element.strokeWidth,
  });
}

function drawEllipseElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: EllipseElement,
): void {
  const box = normalizedRectToUserBox(geometry, element);
  page.drawEllipse({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    xScale: box.width / 2,
    yScale: box.height / 2,
    color: element.fill ? hexToPdfColor(element.fillColor) : undefined,
    opacity: element.fill ? element.fillOpacity : undefined,
    borderColor:
      element.strokeWidth > 0 ? hexToPdfColor(element.strokeColor) : undefined,
    borderWidth: element.strokeWidth,
  });
}

function drawLineElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: LineElement,
): void {
  page.drawLine({
    start: normalizedPointToUser(geometry, element.x1, element.y1),
    end: normalizedPointToUser(geometry, element.x2, element.y2),
    thickness: element.strokeWidth,
    color: hexToPdfColor(element.strokeColor),
    lineCap: LineCapStyle.Round,
  });
}

function drawCheckElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: CheckElement,
): void {
  const color = hexToPdfColor(element.strokeColor);
  for (const [x1, y1, x2, y2] of CHECK_STROKES[element.mark]) {
    page.drawLine({
      start: normalizedPointToUser(
        geometry,
        element.x + x1 * element.width,
        element.y + y1 * element.height,
      ),
      end: normalizedPointToUser(
        geometry,
        element.x + x2 * element.width,
        element.y + y2 * element.height,
      ),
      thickness: element.strokeWidth,
      color,
      lineCap: LineCapStyle.Round,
    });
  }
}

function drawHighlightElement(
  page: PDFPage,
  geometry: PageGeometry,
  element: HighlightElement,
): void {
  const box = normalizedRectToUserBox(geometry, element);
  // Sin borde: el resaltado imita un rotulador sobre el texto existente,
  // que sigue debajo y sigue siendo seleccionable.
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color: hexToPdfColor(element.color),
    opacity: element.opacity,
    borderWidth: 0,
  });
}

/* ------------------------------------------------------------------ *
 * Recursos empotrados (una sola vez por documento)
 * ------------------------------------------------------------------ */

function detectImageFormat(bytes: Uint8Array): "png" | "jpg" {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  throw new PdfError("invalidType");
}

class ResourceCache {
  private readonly fonts = new Map<string, Promise<PDFFont>>();
  private readonly images = new Map<Uint8Array, Promise<PDFImage>>();

  constructor(private readonly document: PDFDocument) {}

  font(element: TextElement): Promise<PDFFont> {
    const standard = standardFontFor(
      element.fontFamily,
      element.bold,
      element.italic,
    );
    const cached = this.fonts.get(standard);
    if (cached) return cached;
    const pending = this.document.embedFont(standard);
    this.fonts.set(standard, pending);
    return pending;
  }

  image(element: ImageElement): Promise<PDFImage> {
    const cached = this.images.get(element.bytes);
    if (cached) return cached;
    const format = detectImageFormat(element.bytes);
    const pending =
      format === "png"
        ? this.document.embedPng(element.bytes)
        : this.document.embedJpg(element.bytes);
    this.images.set(element.bytes, pending);
    return pending;
  }
}

/* ------------------------------------------------------------------ *
 * API publica
 * ------------------------------------------------------------------ */

/**
 * Aplica los elementos sobre el PDF y devuelve el documento resultante.
 *
 * Las paginas sin elementos no se tocan en absoluto. Las que si tienen
 * conservan su contenido original: lo nuevo se anade al final del flujo,
 * asi que queda encima sin destruir nada de lo que habia.
 */
export async function applyEdits(
  file: File,
  elementsByPage: Map<number, EditElement[]>,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    throwIfAborted(signal);
    if (elementsByPage.size === 0) throw new PdfError("nothingSelected");

    const document = await loadPdf(file);
    onProgress?.(0.1);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const cache = new ResourceCache(document);
    const targets = [...elementsByPage.keys()]
      .filter((index) => index >= 0 && index < pages.length)
      .sort((a, b) => a - b);
    if (targets.length === 0) throw new PdfError("nothingSelected");

    let done = 0;
    for (const index of targets) {
      throwIfAborted(signal);
      const page = pages[index];
      const geometry = getPageGeometry(page);

      for (const element of elementsByPage.get(index) ?? []) {
        const clean = sanitizeElement(element);
        if (!clean) continue;

        switch (clean.type) {
          case "text":
            drawTextElement(page, geometry, clean, await cache.font(clean));
            break;
          case "image":
            drawImageElement(page, geometry, clean, await cache.image(clean));
            break;
          case "rect":
            drawRectElement(page, geometry, clean);
            break;
          case "ellipse":
            drawEllipseElement(page, geometry, clean);
            break;
          case "line":
            drawLineElement(page, geometry, clean);
            break;
          case "highlight":
            drawHighlightElement(page, geometry, clean);
            break;
          case "check":
            drawCheckElement(page, geometry, clean);
            break;
        }
      }

      done += 1;
      onProgress?.(0.1 + (done / targets.length) * 0.8);
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
