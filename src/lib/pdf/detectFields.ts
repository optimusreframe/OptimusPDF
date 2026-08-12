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

/**
 * Deteccion de campos de texto rellenables sobre un PDF ya cargado.
 *
 * Tres detectores independientes alimentan una unica lista. Ninguno
 * bloquea a los demas si falla (un widget roto, una pagina que no se
 * puede analizar): lo peor que puede pasar es que aporte menos campos,
 * nunca que tire abajo la deteccion entera. La colocacion, edicion y
 * borrado manual del usuario (`FieldPlacer`/`FieldFormPanel`) siempre
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

/**
 * Recorre `/AcroForm/Fields` con la misma tolerancia que `unlock.ts` ya
 * aplica a este arbol: un campo o un widget que no se puede leer se
 * salta, nunca tira abajo el resto de la deteccion.
 */
export function detectAcroFormFields(document: PDFDocument): DetectedField[] {
  const results: DetectedField[] = [];

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

    for (const widget of widgets) {
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
          pageIndex,
          rect: userBoxToNormalizedRect(geometry, rect),
          label: safeFieldName(field),
          source: "acroform",
          confidence: "high",
        });
      } catch {
        // Un widget con datos invalidos no debe tirar a los demas.
      }
    }
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * 2. Heuristica vectorial (confianza media)
 * ------------------------------------------------------------------ */

/** Grosor maximo (en puntos PDF) para contar como raya/subrayado. */
export const VECTOR_MAX_HEIGHT_PT = 6;
/** Ancho minimo (en puntos PDF) para contar como hueco util. */
export const VECTOR_MIN_WIDTH_PT = 30;
/** Distancia horizontal maxima entre una etiqueta y el hueco a su derecha. */
const LABEL_SAME_LINE_MAX_GAP_PT = 90;
/** Distancia vertical maxima entre una etiqueta y el hueco justo debajo. */
const LABEL_ABOVE_MAX_GAP_PT = 20;
/** Tolerancia de columna para una etiqueta situada encima del hueco. */
const LABEL_ABOVE_COLUMN_TOLERANCE_PT = 60;

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

type LabelCandidate = {
  text: string;
  /** Extremo derecho del texto, en espacio de usuario del PDF. */
  right: number;
  /** Extremo izquierdo del texto, en espacio de usuario del PDF. */
  left: number;
  /** Linea base, en espacio de usuario del PDF. */
  baseline: number;
  height: number;
};

/**
 * Etiqueta mas cercana a un hueco candidato: o bien termina justo a su
 * izquierda en la misma linea ("Cliente: ____"), o bien queda justo
 * encima alineada por la columna izquierda (rotulo sobre una raya).
 */
export function nearestLabel(
  items: readonly LabelCandidate[],
  box: Box,
): string | undefined {
  let best: { text: string; gap: number } | null = null;

  for (const item of items) {
    const sameLine =
      Math.abs(item.baseline - box.y) <= Math.max(item.height, box.height) + 4;
    const toTheLeft =
      item.right <= box.x + 2 && box.x - item.right <= LABEL_SAME_LINE_MAX_GAP_PT;

    const above =
      item.baseline >= box.y + box.height - 2 &&
      item.baseline - (box.y + box.height) <= LABEL_ABOVE_MAX_GAP_PT;
    const columnAligned =
      Math.abs(item.left - box.x) <= LABEL_ABOVE_COLUMN_TOLERANCE_PT;

    let gap: number | null = null;
    if (sameLine && toTheLeft) gap = box.x - item.right;
    else if (above && columnAligned) gap = item.baseline - (box.y + box.height);
    if (gap === null) continue;

    if (!best || gap < best.gap) best = { text: item.text, gap };
  }

  return best?.text;
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

/**
 * Recorre la lista de operadores de una pagina buscando rectangulos
 * finos y anchos (candidatos a subrayado/hueco). Usa la caja envolvente
 * (`minMax`) de cada trazo tras aplicarle la matriz acumulada en vez de
 * decodificar el detalle de cada segmento: es mas robusto entre
 * versiones de pdf.js y sigue siendo geometria vectorial real, no una
 * suposicion sobre pixeles.
 */
export type VectorPageResult = {
  /** Falso cuando la pagina no tiene texto extraible: la trata el detector raster. */
  hasText: boolean;
  fields: DetectedField[];
};

/** Exportado para poder probarlo con un `PDFPageProxy` real de pdf.js (ver test). */
export async function detectVectorFieldsOnPage(
  page: PDFPageProxy,
  pageIndex: number,
  geometry: PageGeometry,
  OPS: PdfJsOps,
  idPrefix: string,
): Promise<VectorPageResult> {
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList(),
  ]);

  const labelItems: LabelCandidate[] = [];
  for (const item of textContent.items) {
    if (!("str" in item) || item.str.trim().length === 0) continue;
    const transform = item.transform as number[];
    const height = item.height || Math.abs(transform[3]) || 10;
    labelItems.push({
      text: item.str.trim(),
      left: transform[4],
      right: transform[4] + item.width,
      baseline: transform[5],
      height,
    });
  }
  // Pagina sin texto extraible: es esencialmente una imagen, y de ahi no
  // hay etiquetas con que cruzar nada. La trata el detector raster.
  if (labelItems.length === 0) return { hasText: false, fields: [] };

  const paintOps = paintingOps(OPS);
  const results: DetectedField[] = [];
  const stack: Matrix[] = [];
  let current: Matrix = IDENTITY_MATRIX;
  let counter = 0;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === OPS.save) {
      stack.push(current);
      continue;
    }
    if (fn === OPS.restore) {
      current = stack.pop() ?? IDENTITY_MATRIX;
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
    const box: Box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };

    if (box.height > VECTOR_MAX_HEIGHT_PT || box.width < VECTOR_MIN_WIDTH_PT) {
      continue;
    }

    counter += 1;
    results.push({
      id: `${idPrefix}-${pageIndex}-${counter}`,
      pageIndex,
      rect: userBoxToNormalizedRect(geometry, box),
      label: nearestLabel(labelItems, box),
      source: "heuristic-vector",
      confidence: "medium",
    });
  }

  return { hasText: true, fields: results };
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
 * se llama sobre paginas sin texto extraible (imagen practicamente
 * pura): el render y `getImageData` necesitan un `HTMLCanvasElement` de
 * verdad, asi que esta parte, igual que `renderPageToCanvas` en
 * `core.ts`, solo se ejerce en el navegador.
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

  return bands.map((band, index) => {
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

/* ------------------------------------------------------------------ *
 * Orquestador
 * ------------------------------------------------------------------ */

/**
 * Ejecuta los tres detectores y devuelve una unica lista. Un fallo en
 * una pagina o un detector concreto nunca tira abajo a los demas: en el
 * peor caso, esa pagina aporta cero campos y el usuario los coloca a
 * mano (`FieldPlacer`/`FieldFormPanel`, siempre disponibles).
 */
export async function detectFields(file: File): Promise<DetectedField[]> {
  let pdfLibDocument: PDFDocument;
  try {
    pdfLibDocument = await loadPdf(file);
  } catch (error) {
    throw toPdfError(error);
  }

  const results: DetectedField[] = detectAcroFormFields(pdfLibDocument);

  let pdfjsDocument: PDFDocumentProxy;
  try {
    pdfjsDocument = await openPdfDocument(file);
  } catch {
    // Sin pdf.js solo queda lo que dio AcroForm; el resto sigue siendo
    // manual. No es un fallo del que la interfaz deba enterarse.
    return results;
  }

  try {
    const OPS = (await getPdfJs()).OPS as unknown as PdfJsOps;
    const pages = pdfLibDocument.getPages();

    for (let index = 0; index < pdfjsDocument.numPages; index += 1) {
      let page: PDFPageProxy | null = null;
      try {
        page = await pdfjsDocument.getPage(index + 1);
        const geometry = pages[index] ? getPageGeometry(pages[index]) : null;
        const vector: VectorPageResult = geometry
          ? await detectVectorFieldsOnPage(page, index, geometry, OPS, "vec")
          : { hasText: true, fields: [] };

        if (vector.hasText) {
          // Pagina con texto real: la heuristica vectorial ya la cubre
          // (aunque no haya encontrado ningun hueco). El detector raster
          // es solo para paginas esencialmente-imagen.
          results.push(...vector.fields);
        } else {
          results.push(...(await detectRasterFieldsOnPage(page, index)));
        }
      } catch {
        // Una pagina que no se puede analizar no bloquea a las demas.
      } finally {
        page?.cleanup();
      }
    }
  } finally {
    await closePdfDocument(pdfjsDocument);
  }

  return results;
}
