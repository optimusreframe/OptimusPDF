import { PDFTextField, type PDFDocument, type PDFField } from "@cantoo/pdf-lib";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  type Box,
  type NormalizedRect,
  type PageGeometry,
  closePdfDocument,
  getPageGeometry,
  getPdfJs,
  loadPdf,
  openPdfDocument,
  renderPageToCanvas,
  toPdfError,
  userBoxToNormalizedRect,
} from "@/lib/pdf/core";
import {
  MAX_SLOTS_PER_DOCUMENT,
  MAX_SLOTS_PER_PAGE,
  REFERENCE_UNIT_PT,
  SLOT_MAX_THICKNESS_PT,
  SLOT_MIN_WIDTH_PT,
  documentUnit,
  findFillSlots,
  nearestLabel,
  underscoreSegments,
  type DashMark,
  type PaintedBox,
  type RawText,
  type Seg,
  type VerticalSeg,
} from "@/lib/pdf/detectSlots";

/**
 * Deteccion de campos de texto rellenables sobre un PDF ya cargado.
 *
 * Tres detectores independientes alimentan una unica lista (el raster, solo a
 * peticion). Ninguno
 * bloquea a los demas si falla (un widget roto, una pagina que no se
 * puede analizar): lo peor que puede pasar es que aporte menos campos,
 * nunca que tire abajo la deteccion entera. La colocacion, edicion y
 * borrado manual del usuario (`DocumentCanvas`) siempre
 * esta disponible, tenga o no exito esta deteccion.
 */

export type FieldSource =
  | "acroform"
  | "heuristic-vector"
  | "heuristic-raster"
  /** Anadido a mano por el usuario; no lo produce ningun detector. */
  | "manual";

export type FieldConfidence = "high" | "medium" | "low";

/**
 * Tipo de campo de texto. `"initials"` aqui es un campo de texto corto
 * (2-4 letras escritas a mano por teclado) -- NO tiene relacion con
 * `SignatureFieldType["initials"]` de `src/lib/pdf/sign.ts`, que es un
 * hueco de imagen (trazo capturado) atado a un firmante concreto.
 */
export type DetectedFieldType = "text" | "checkbox" | "date" | "initials";
export const DETECTED_FIELD_TYPES: readonly DetectedFieldType[] = [
  "text",
  "checkbox",
  "date",
  "initials",
] as const;

export type DetectedField = {
  id: string;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda, igual que `SignatureField.rect`. */
  rect: NormalizedRect;
  /** Sugerencia de nombre a partir de una etiqueta cercana. */
  label?: string;
  source: FieldSource;
  confidence: FieldConfidence;
  /**
   * Ausente = `"text"` (nunca se escribe "text" explicitamente, ver
   * `fieldTypeOf`): asi, todo campo ya guardado antes de que este tipo
   * existiera (borradores, configs exportadas) se sigue leyendo como
   * texto libre sin ninguna migracion.
   */
  type?: DetectedFieldType;
  /**
   * Etiqueta («tag») del dato que lleva el campo (Dirección, Nombre, Teléfono...): una clave de `docLibrary/dataKeys.ts`
   * o una propia de la persona (`custom.*`). Es lo que une los campos que repiten un mismo dato (se rellenan solos
   * entre si) y lo que indexa la memoria de valores (`lib/valueHistory.ts`). Ausente = sin etiqueta (el campo funciona
   * como siempre); borradores, configuraciones y plantillas anteriores no la traen. Se lee con `tagOf` (`lib/fieldTags.ts`),
   * que descarta lo que no tenga forma de clave.
   */
  tag?: string;
};

/** Tipo efectivo de un campo, con el default de "ausente = texto libre" ya resuelto. */
export function fieldTypeOf(field: DetectedField): DetectedFieldType {
  return field.type ?? "text";
}

/**
 * "Relleno" depende del tipo: una casilla cuenta como completa en
 * cuanto se coloca (no marcarla es una respuesta valida, ej. "no
 * consiento"), nunca como pendiente eterno en el aviso de campos sin
 * rellenar.
 */
export function isFieldFilled(
  field: DetectedField,
  value: string | undefined,
): boolean {
  if (fieldTypeOf(field) === "checkbox") return true;
  return (value ?? "").trim().length > 0;
}

/**
 * Valor tal como se empotra en el PDF final. Solo ASCII a proposito:
 * `Helvetica.encodeText("✓")` de `@cantoo/pdf-lib` no lanza, pero
 * imprime un "?" en silencio (WinAnsi no tiene glifo de check) -- una
 * casilla marcada se empotra como "X", no como un simbolo de check.
 */
export function embeddedValueFor(
  field: DetectedField,
  value: string,
  language: "es" | "en",
): string {
  const type = fieldTypeOf(field);
  if (type === "checkbox") return value ? "X" : "";
  if (type === "date") return formatIsoDate(value, language);
  return value;
}

/** `"YYYY-MM-DD"` (lo que da `<input type="date">`) a fecha legible en el idioma activo. */
export function formatIsoDate(iso: string, language: "es" | "en"): string {
  if (!iso) return "";
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
    dateStyle: "medium",
  }).format(parsed);
}

/* ------------------------------------------------------------------ *
 * 1. AcroForm (confianza alta)
 * ------------------------------------------------------------------ */

function safeFieldName(field: PDFField): string | undefined {
  try {
    const name = field.getName();
    return name.trim().length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Un widget de campo de texto AcroForm con el identificador estable (`acro-N`) que usan la deteccion y el relleno. */
export type AcroFormTextWidget = {
  id: string;
  field: PDFTextField;
  /** Posicion del widget dentro de `field.acroField.getWidgets()`. */
  widgetIndex: number;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista (origen arriba-izquierda). */
  rect: NormalizedRect;
};

/**
 * Recorre `/AcroForm/Fields` con la misma tolerancia que `unlock.ts` ya
 * aplica a este arbol: un campo o un widget que no se puede leer se
 * salta, nunca tira abajo el resto de la deteccion. Es la UNICA fuente de los
 * ids `acro-N`: la deteccion (`detectAcroFormFields`) y el relleno de formularios
 * (`fillForm.ts`, que escribe `/V` en el campo que corresponde a cada id) la comparten,
 * asi un id detectado siempre se puede volver a encontrar en el PDF.
 */
export function walkAcroFormTextWidgets(document: PDFDocument): AcroFormTextWidget[] {
  const results: AcroFormTextWidget[] = [];

  let fields: PDFField[];
  try {
    fields = document.getForm().getFields();
  } catch {
    return results;
  }

  const pages = document.getPages();
  const pageRefs = pages.map((page) => page.ref.toString());
  const geometries = pages.map((page) => getPageGeometry(page));

  let counter = 0;
  for (const field of fields) {
    if (!(field instanceof PDFTextField)) continue;

    let widgets: ReturnType<(typeof field)["acroField"]["getWidgets"]>;
    try {
      widgets = field.acroField.getWidgets();
    } catch {
      continue;
    }

    for (let widgetIndex = 0; widgetIndex < widgets.length; widgetIndex += 1) {
      const widget = widgets[widgetIndex];
      try {
        const pageRef = widget.P()?.toString();
        const pageIndex = pageRef ? pageRefs.indexOf(pageRef) : -1;
        // Sin pagina identificada no se puede colocar el campo con seguridad.
        if (pageIndex < 0) continue;
        const geometry = geometries[pageIndex];
        const rect = widget.getRectangle();
        counter += 1;
        results.push({
          id: `acro-${counter}`,
          field,
          widgetIndex,
          pageIndex,
          rect: userBoxToNormalizedRect(geometry, rect),
        });
      } catch {
        // Un widget con datos invalidos no debe tirar a los demas.
      }
    }
  }

  return results;
}

export function detectAcroFormFields(document: PDFDocument): DetectedField[] {
  return walkAcroFormTextWidgets(document).map((widget) => ({
    id: widget.id,
    pageIndex: widget.pageIndex,
    rect: widget.rect,
    label: safeFieldName(widget.field),
    source: "acroform",
    confidence: "high",
  }));
}

/* ------------------------------------------------------------------ *
 * 2. Heuristica vectorial CONSERVADORA (confianza media)
 * ------------------------------------------------------------------ */

export {
  MAX_SLOTS_PER_DOCUMENT,
  MAX_SLOTS_PER_PAGE,
  SLOT_MAX_THICKNESS_PT as VECTOR_MAX_HEIGHT_PT,
  SLOT_MIN_WIDTH_PT as VECTOR_MIN_WIDTH_PT,
  nearestLabel,
};

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

/** Compone dos matrices afines 2D: `inner` se aplica primero, `outer` despues. */
function composeMatrix(outer: Matrix, inner: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = inner;
  const [a2, b2, c2, d2, e2, f2] = outer;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

function applyMatrix(
  matrix: Matrix,
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Luminancia 0..1 de un color "#rrggbb" (el formato en que pdf.js entrega los colores de relleno). */
function hexLuminance(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) return undefined;
  const [r, g, b] = [match[1], match[2], match[3]].map((hex) => parseInt(hex, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** OPS que efectivamente pintan la ruta (relleno y/o trazo, no solo recorte). */
function paintingOps(OPS: PdfJsOps): ReadonlySet<number> {
  return new Set([
    OPS.fill,
    OPS.eoFill,
    OPS.stroke,
    OPS.closeStroke,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
}

/** Subconjunto de la enumeracion `OPS` de pdf.js que usa este detector. */
export type PdfJsOps = {
  /** Grosor de trazo (opcional: sin el, un trazo se mide solo por su geometria). */
  setLineWidth?: number;
  /** Patron de trazo discontinuo (opcional: sin el, una raya discontinua no se distingue de una continua). */
  setDash?: number;
  /** Color de relleno RGB (opcional: sin el, no se sabe si una caja esta sombreada). */
  setFillRGBColor?: number;
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
};

export type VectorPageResult = {
  /** Falso cuando la pagina no tiene texto extraible: la trata el detector raster (solo a peticion). */
  hasText: boolean;
  fields: DetectedField[];
  /** Confianza numerica de cada campo (mismo orden): sirve para el tope por documento. */
  scores: number[];
};

/** Alto del campo que se ofrece sobre una raya (la raya sola mide ~1 pt y no se podria tocar). */
const SLOT_FIELD_HEIGHT_PT = 14;

/**
 * Recorre la lista de operadores de una pagina y decide, con `findFillSlots`,
 * que rayas son un hueco de relleno de verdad: aisladas, con etiqueta, fuera
 * de tablas y de cajas, con un tope por pagina. Usa la caja envolvente
 * (`minMax`) de cada trazo tras aplicarle la matriz acumulada en vez de
 * decodificar el detalle de cada segmento: es mas robusto entre versiones de
 * pdf.js y sigue siendo geometria vectorial real, no una suposicion sobre pixeles.
 * Exportado para poder probarlo con un `PDFPageProxy` real de pdf.js (ver test).
 */
export type PageGeometryItems = {
  texts: RawText[];
  segments: Seg[];
  verticals: VerticalSeg[];
  boxes: PaintedBox[];
  /** Marcas cortas sueltas (puntos, guiones) de rayas punteadas o discontinuas. */
  dashes: DashMark[];
};

/** Tope de marcas sueltas que se recogen por pagina (una pagina con miles es un patron, no un campo). */
const MAX_DASH_MARKS_PER_PAGE = 6000;

/** Lee de una pagina de pdf.js los textos y las rayas, verticales y cajas pintadas (espacio de usuario). */
export async function collectPageGeometry(
  page: PDFPageProxy,
  OPS: PdfJsOps,
): Promise<PageGeometryItems> {
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList(),
  ]);

  const rawTexts: RawText[] = [];
  for (const item of textContent.items) {
    if (!("str" in item) || item.str.trim().length === 0) continue;
    const transform = item.transform as number[];
    // Texto girado o vertical: no sirve de etiqueta de una raya horizontal.
    if (Math.abs(transform[1]) > 0.1 * Math.max(Math.abs(transform[0]), 0.01)) continue;
    const height = item.height || Math.abs(transform[3]) || 10;
    rawTexts.push({
      text: item.str.trim(),
      raw: item.str,
      left: transform[4],
      right: transform[4] + item.width,
      baseline: transform[5],
      height,
    });
  }
  const paintOps = paintingOps(OPS);
  const bothOps = new Set([OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, ...bothOps]);
  // Los umbrales de forma se miden en la unidad tipografica del documento, no en puntos.
  const sc = documentUnit(rawTexts) / REFERENCE_UNIT_PT;
  const maxThin = SLOT_MAX_THICKNESS_PT * sc;
  const minWidth = SLOT_MIN_WIDTH_PT * sc;
  const dashes: DashMark[] = [];
  const segments: Seg[] = [];
  const verticals: VerticalSeg[] = [];
  const boxes: PaintedBox[] = [];
  const stack: Array<{ matrix: Matrix; lineWidth: number; shade: number; dashed: boolean }> = [];
  /** Trazo discontinuo vigente. */
  let dashed = false;
  let current: Matrix = IDENTITY_MATRIX;
  let lineWidth = 1;
  /** Luminancia (0 negro, 1 blanco) del color de relleno vigente. */
  let shade = 0;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === OPS.save) {
      stack.push({ matrix: current, lineWidth, shade, dashed });
      continue;
    }
    if (fn === OPS.restore) {
      const top = stack.pop();
      current = top?.matrix ?? IDENTITY_MATRIX;
      lineWidth = top?.lineWidth ?? 1;
      shade = top?.shade ?? 0;
      dashed = top?.dashed ?? false;
      continue;
    }
    if (OPS.setDash !== undefined && fn === OPS.setDash) {
      const pattern = Array.isArray(args) && Array.isArray(args[0]) ? (args[0] as number[]) : [];
      dashed = pattern.some((value) => value > 0);
      continue;
    }
    if (OPS.setFillRGBColor !== undefined && fn === OPS.setFillRGBColor) {
      shade = hexLuminance(Array.isArray(args) ? args[0] : undefined) ?? shade;
      continue;
    }
    if (OPS.setLineWidth !== undefined && fn === OPS.setLineWidth) {
      const value = Array.isArray(args) ? Number(args[0]) : Number.NaN;
      if (Number.isFinite(value)) lineWidth = value;
      continue;
    }
    if (fn === OPS.transform) {
      const matrix = args as Matrix;
      if (matrix?.length === 6) current = composeMatrix(current, matrix);
      continue;
    }
    if (fn !== OPS.constructPath) continue;

    const [paintOp, , minMax] = args as [number, unknown, ArrayLike<number>];
    if (!paintOps.has(paintOp)) continue;
    if (!minMax || minMax.length < 4) continue;
    const [minX, minY, maxX, maxY] = Array.from(minMax);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) continue;

    const corners = [
      applyMatrix(current, minX, minY),
      applyMatrix(current, maxX, minY),
      applyMatrix(current, minX, maxY),
      applyMatrix(current, maxX, maxY),
    ];
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const width = x1 - x0;
    const height = y1 - y0;
    // Un trazo (stroke) mide su grosor en el estado grafico, no en la geometria del camino.
    const stroked = strokeOps.has(paintOp);
    const [ma, mb, mc, md] = current;
    const strokeWidth = stroked ? lineWidth * Math.sqrt(Math.abs(ma * md - mb * mc)) : 0;

    if (height <= maxThin && width >= minWidth) {
      segments.push({ x0, x1, y: (y0 + y1) / 2, thickness: Math.max(height, strokeWidth), fromText: -1, dashed: stroked && dashed });
    } else if (width <= maxThin && height >= 8 * sc) {
      verticals.push({ x: (x0 + x1) / 2, y0, y1 });
    } else if (width > maxThin && height > maxThin) {
      const strokes = paintOp === OPS.stroke || paintOp === OPS.closeStroke || bothOps.has(paintOp);
      const fills = paintOp === OPS.fill || paintOp === OPS.eoFill || bothOps.has(paintOp);
      boxes.push({ x0, y0, x1, y1, fill: fills, stroke: strokes, shade: fills ? shade : undefined });
    } else if (height <= maxThin && width > 0.05 && dashes.length < MAX_DASH_MARKS_PER_PAGE) {
      dashes.push({ x0, x1, y: (y0 + y1) / 2, thickness: Math.max(height, strokeWidth) });
    }
  }

  return { texts: rawTexts, segments, verticals, boxes, dashes };
}

export async function detectVectorFieldsOnPage(
  page: PDFPageProxy,
  pageIndex: number,
  geometry: PageGeometry,
  OPS: PdfJsOps,
  idPrefix: string,
): Promise<VectorPageResult> {
  const { texts: rawTexts, segments, verticals, boxes, dashes } = await collectPageGeometry(page, OPS);
  // Pagina sin texto extraible: es esencialmente una imagen, y de ahi no
  // hay etiquetas con que cruzar nada. La trata el detector raster.
  if (rawTexts.length === 0) return { hasText: false, fields: [], scores: [] };

  // Los guiones bajos de texto ("Nombre: ________") son rayas como las demas.
  const underscores = underscoreSegments(rawTexts);

  const slots = findFillSlots(
    {
      segments: [...segments, ...underscores],
      dashes,
      verticals,
      boxes,
      texts: rawTexts,
      pageWidth: geometry.box.width,
      pageHeight: geometry.box.height,
    },
    MAX_SLOTS_PER_PAGE,
  );

  const fields: DetectedField[] = [];
  const scores: number[] = [];
  // En la unidad tipografica del documento: un formulario ampliado ofrece un hueco mas alto.
  const fieldHeight = SLOT_FIELD_HEIGHT_PT * (documentUnit(rawTexts) / REFERENCE_UNIT_PT);
  slots.forEach((slot, order) => {
    // La raya ocupa ~1 pt: el campo ofrece el alto de una linea escrita justo encima.
    const height = slot.kind === "above" ? Math.min(fieldHeight, 10 * (fieldHeight / SLOT_FIELD_HEIGHT_PT)) : fieldHeight;
    const box: Box = {
      x: slot.box.x,
      y: slot.box.y,
      width: slot.box.width,
      height: Math.max(height, slot.box.height),
    };
    fields.push({
      id: `${idPrefix}-${pageIndex}-${order + 1}`,
      pageIndex,
      rect: userBoxToNormalizedRect(geometry, box),
      label: slot.label,
      source: "heuristic-vector",
      confidence: "medium",
    });
    scores.push(slot.score);
  });

  return { hasText: true, fields, scores };
}

/* ------------------------------------------------------------------ *
 * 3. Heuristica raster (confianza baja, experimental)
 * ------------------------------------------------------------------ */

/** Luminancia por debajo de la cual un pixel cuenta como "oscuro". */
const RASTER_DARK_THRESHOLD = 120;
/** Fraccion minima de la anchura que debe cubrir una fila oscura para contar como raya. */
const RASTER_MIN_ROW_COVERAGE = 0.4;
/** Grosor maximo (en filas) de una raya candidata. */
const RASTER_MAX_BAND_ROWS = 6;
/** Anchura minima de una raya, como fraccion de la anchura de la imagen. */
const RASTER_MIN_BAND_WIDTH_FRACTION = 0.15;
/** Alto del hueco sugerido justo encima de la raya, como fraccion del alto de la imagen. */
const RASTER_FIELD_HEIGHT_FRACTION = 0.035;

export type DarkBand = {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
};

/**
 * Analisis puro de proyeccion de filas sobre luminancia ya decodificada
 * (sin `HTMLCanvasElement`, para poder probarlo directamente en Node).
 * Busca bandas horizontales finas y anchas: candidatas a raya/subrayado
 * de un documento escaneado sin texto extraible.
 */
export function detectDarkBands(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
): DarkBand[] {
  if (width <= 0 || height <= 0) return [];

  const rowCoverage: number[] = [];
  const rowStartCol: number[] = [];
  const rowEndCol: number[] = [];

  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    let start = -1;
    let end = -1;
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      if (luminance[base + x] < RASTER_DARK_THRESHOLD) {
        dark += 1;
        if (start < 0) start = x;
        end = x;
      }
    }
    rowCoverage.push(dark / width);
    rowStartCol.push(start);
    rowEndCol.push(end);
  }

  const bands: DarkBand[] = [];
  let bandStart = -1;

  const closeBand = (endRowExclusive: number) => {
    if (bandStart < 0) return;
    const rows = endRowExclusive - bandStart;
    if (rows <= RASTER_MAX_BAND_ROWS) {
      let colStart = width;
      let colEnd = 0;
      for (let y = bandStart; y < endRowExclusive; y += 1) {
        if (rowStartCol[y] >= 0) colStart = Math.min(colStart, rowStartCol[y]);
        if (rowEndCol[y] >= 0) colEnd = Math.max(colEnd, rowEndCol[y]);
      }
      if (colEnd > colStart && colEnd - colStart >= width * RASTER_MIN_BAND_WIDTH_FRACTION) {
        bands.push({ rowStart: bandStart, rowEnd: endRowExclusive - 1, colStart, colEnd });
      }
    }
    bandStart = -1;
  };

  for (let y = 0; y < height; y += 1) {
    if (rowCoverage[y] >= RASTER_MIN_ROW_COVERAGE) {
      if (bandStart < 0) bandStart = y;
    } else {
      closeBand(y);
    }
  }
  closeBand(height);

  return bands;
}

/** Convierte una imagen RGBA (`ImageData.data`) en luminancia por pixel. */
export function toLuminance(rgba: ArrayLike<number>): Float32Array {
  const length = Math.floor(rgba.length / 4);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const offset = index * 4;
    out[index] =
      0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
  }
  return out;
}

/**
 * Renderiza la pagina y aplica `detectDarkBands` sobre sus pixeles. Solo
 * se llama a peticion («Buscar huecos en páginas escaneadas») sobre paginas
 * sin texto extraible: el render y `getImageData` necesitan un
 * `HTMLCanvasElement` de verdad, asi que esta parte, igual que
 * `renderPageToCanvas` en `core.ts`, solo se ejerce en el navegador.
 */
async function detectRasterFieldsOnPage(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<DetectedField[]> {
  const canvas = await renderPageToCanvas(page, { maxWidth: 1000, intent: "print" });
  const context = canvas.getContext("2d");
  if (!context) return [];

  const { width, height } = canvas;
  const image = context.getImageData(0, 0, width, height);
  const luminance = toLuminance(image.data);
  const bands = detectDarkBands(luminance, width, height);

  const fieldHeight = Math.max(1, Math.round(height * RASTER_FIELD_HEIGHT_FRACTION));

  return bands.slice(0, MAX_SLOTS_PER_PAGE).map((band, index) => {
    const top = Math.max(0, band.rowStart - fieldHeight);
    return {
      id: `raster-${pageIndex}-${index}`,
      pageIndex,
      rect: {
        x: band.colStart / width,
        y: top / height,
        width: (band.colEnd - band.colStart) / width,
        height: (band.rowStart - top) / height,
      },
      source: "heuristic-raster" as const,
      confidence: "low" as const,
    };
  });
}

/**
 * Busca huecos en paginas ESCANEADAS (sin capa de texto) a peticion de la
 * persona: la heuristica raster no corre sola ni se muestra por defecto porque
 * toma por hueco cualquier raya oscura de una foto. `pageIndexes` limita la
 * busqueda; sin ella se miran todas las paginas sin texto. Tope por pagina
 * (`MAX_SLOTS_PER_PAGE`) y por documento (`MAX_SLOTS_PER_DOCUMENT`).
 */
export async function detectRasterFields(
  file: File,
  pageIndexes?: readonly number[],
): Promise<DetectedField[]> {
  const pdfjsDocument = await openPdfDocument(file);
  const found: DetectedField[] = [];
  try {
    const wanted = pageIndexes
      ? [...new Set(pageIndexes)].filter((index) => index >= 0 && index < pdfjsDocument.numPages)
      : Array.from({ length: pdfjsDocument.numPages }, (_, index) => index);
    for (const index of wanted) {
      if (found.length >= MAX_SLOTS_PER_DOCUMENT) break;
      let page: PDFPageProxy | null = null;
      try {
        page = await pdfjsDocument.getPage(index + 1);
        if (!pageIndexes && (await pageHasText(page))) continue;
        found.push(...(await detectRasterFieldsOnPage(page, index)));
      } catch {
        // Una pagina que no se puede analizar no bloquea a las demas.
      } finally {
        page?.cleanup();
      }
    }
  } finally {
    await closePdfDocument(pdfjsDocument);
  }
  return found.slice(0, MAX_SLOTS_PER_DOCUMENT);
}

/** La pagina trae texto extraible (si no, es una imagen/escaneo). */
export async function pageHasText(page: PDFPageProxy): Promise<boolean> {
  const content = await page.getTextContent();
  return content.items.some((item) => "str" in item && item.str.trim().length > 0);
}

/* ------------------------------------------------------------------ *
 * Orquestador
 * ------------------------------------------------------------------ */

export type DetectFieldsOptions = {
  /**
   * Ejecuta tambien la heuristica raster en las paginas sin texto. Apagado por
   * defecto: solo se usa a peticion explicita (`detectRasterFields`).
   */
  raster?: boolean;
};

/** Lo que el orquestador necesita ya abierto: permite probarlo en Node con el build «legacy» de pdf.js. */
export type DetectionSources = {
  pdfLib: PDFDocument;
  pdfjs: PDFDocumentProxy;
  OPS: PdfJsOps;
};

/**
 * Pone el tope por documento: se quedan los huecos de mayor confianza y se
 * devuelven en el orden en que estaban. Los campos AcroForm reales no cuentan:
 * son del documento, no una suposicion.
 */
export function capSuggested(
  fields: readonly DetectedField[],
  scores: readonly number[],
  limit: number = MAX_SLOTS_PER_DOCUMENT,
): DetectedField[] {
  if (fields.length <= limit) return [...fields];
  const keep = new Set(
    fields
      .map((field, index) => ({ field, score: scores[index] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.field),
  );
  return fields.filter((field) => keep.has(field));
}

/** Los tres detectores sobre documentos ya abiertos (ver `detectFields`). */
export async function detectFieldsFromSources(
  { pdfLib, pdfjs, OPS }: DetectionSources,
  options: DetectFieldsOptions = {},
): Promise<DetectedField[]> {
  const real = detectAcroFormFields(pdfLib);
  const pages = pdfLib.getPages();
  const suggested: DetectedField[] = [];
  const scores: number[] = [];
  const raster: DetectedField[] = [];

  for (let index = 0; index < pdfjs.numPages; index += 1) {
    let page: PDFPageProxy | null = null;
    try {
      page = await pdfjs.getPage(index + 1);
      const geometry = pages[index] ? getPageGeometry(pages[index]) : null;
      const vector: VectorPageResult = geometry
        ? await detectVectorFieldsOnPage(page, index, geometry, OPS, "vec")
        : { hasText: true, fields: [], scores: [] };

      if (vector.hasText) {
        suggested.push(...vector.fields);
        scores.push(...vector.scores);
      } else if (options.raster) {
        raster.push(...(await detectRasterFieldsOnPage(page, index)));
      }
    } catch {
      // Una pagina que no se puede analizar no bloquea a las demas.
    } finally {
      page?.cleanup();
    }
  }

  return [
    ...real,
    ...capSuggested(suggested, scores),
    ...raster.slice(0, MAX_SLOTS_PER_DOCUMENT),
  ];
}

/**
 * Ejecuta los detectores y devuelve una unica lista: los campos AcroForm
 * reales (siempre) y, ademas, huecos SUGERIDOS por la heuristica vectorial
 * conservadora (con tope por pagina y por documento). La heuristica raster
 * (paginas escaneadas) NO corre por defecto: ver `detectRasterFields`.
 * Un fallo en una pagina o un detector concreto nunca tira abajo a los demas:
 * en el peor caso, esa pagina aporta cero campos y el usuario los coloca a
 * mano (`DocumentCanvas`, siempre disponibles).
 */
export async function detectFields(
  file: File,
  options: DetectFieldsOptions = {},
): Promise<DetectedField[]> {
  let pdfLibDocument: PDFDocument;
  try {
    pdfLibDocument = await loadPdf(file);
  } catch (error) {
    throw toPdfError(error);
  }

  let pdfjsDocument: PDFDocumentProxy;
  try {
    pdfjsDocument = await openPdfDocument(file);
  } catch {
    // Sin pdf.js solo queda lo que dio AcroForm; el resto sigue siendo
    // manual. No es un fallo del que la interfaz deba enterarse.
    return detectAcroFormFields(pdfLibDocument);
  }

  try {
    const OPS = (await getPdfJs()).OPS as unknown as PdfJsOps;
    return await detectFieldsFromSources(
      { pdfLib: pdfLibDocument, pdfjs: pdfjsDocument, OPS },
      options,
    );
  } finally {
    await closePdfDocument(pdfjsDocument);
  }
}

/** Un campo que es solo una SUGERENCIA de la heuristica (no un AcroForm real ni uno puesto a mano). */
export function isSuggestedField(field: DetectedField): boolean {
  return field.source === "heuristic-vector" || field.source === "heuristic-raster";
}

/**
 * Sugerencia que nadie ha tocado: sin valor. No cuenta como campo pendiente,
 * no se muestra si el interruptor «Campos sugeridos» esta apagado y no entra
 * en los avisos. En cuanto la persona escribe en ella (o la mueve, o le cambia
 * el tipo) pasa a ser un campo suyo.
 */
export function isSuggestionOnly(
  field: DetectedField,
  value: string | undefined,
): boolean {
  return isSuggestedField(field) && (value ?? "").trim().length === 0;
}
