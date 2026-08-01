import { PdfError, throwIfAborted, toPdfError, type ProgressCallback } from "@/lib/pdf/core";
import { extractValidatedTables } from "@/lib/pdf/pdfToExcel";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  extractDocumentBlocks,
  type DocBlock,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * Motor "PDF -> Extraer tablas" (CSV/JSON).
 *
 * Hermano de `pdfToExcel.ts`: reutiliza por completo `extractDocumentBlocks`
 * de `pdfToMarkdown.ts` (misma deteccion de tablas, mismo `ocrFallback:
 * false` obligatorio — ver el OJO del doc-comment de `pdfToExcel.ts`, se
 * aplica identico aqui: una pagina escaneada nunca produce un bloque
 * `table`) y el mismo filtrado+presupuesto ya probado, extraido a
 * `extractValidatedTables` en `pdfToExcel.ts` para que ninguno de los dos
 * motores duplique esa logica.
 *
 * A diferencia de `pdfToExcel.ts` (que vuelca las tablas a un workbook
 * `exceljs`, un formato binario con su propio limite nativo de columnas
 * por fila), este motor solo serializa TEXTO plano (CSV o JSON): no hay
 * limite de "columnas de hoja de calculo" que aplicar en la serializacion
 * en si, mas alla del presupuesto ya validado por `extractValidatedTables`
 * (que sigue aplicando `EXCEL_MAX_COLUMNS` como tope de ANCHO de fila
 * compartido, no como limite especifico de Excel).
 *
 * Alcance identico a `pdfToExcel.ts`: se extrae TEXTO de tabla, tal cual
 * lo reconstruye `pageBlocks` (rejillas regulares por alineacion de
 * columnas). NO se reconstruyen formulas, graficos ni el formato visual
 * de la tabla original. Si el PDF son paginas escaneadas, esta
 * herramienta no encuentra ninguna tabla (no hace OCR aqui).
 */

export type PdfToCsvFormat = "csv" | "json";

export type PdfToCsvOptions = {
  /** Formato de salida: CSV (por defecto) o JSON. */
  format: PdfToCsvFormat;
  /**
   * Mismo campo que `PdfToMarkdownOptions.stripRepeated` /
   * `PdfToExcelOptions.stripRepeated`: elimina antes de buscar tablas las
   * lineas que se repiten en la franja superior/inferior de casi todas
   * las paginas (numeracion, titulillo, aviso legal).
   */
  stripRepeated: boolean;
};

export const DEFAULT_PDF_TO_CSV_OPTIONS: PdfToCsvOptions = {
  format: "csv",
  stripRepeated: true,
};

/**
 * Escapado CSV estandar (RFC 4180): un valor que contiene coma, comilla
 * doble o salto de linea se envuelve entre comillas dobles, y cualquier
 * comilla doble interna se duplica. El resto de valores se deja tal cual,
 * sin comillas innecesarias.
 */
function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

/**
 * Serializa una o varias tablas ya validadas (ver `extractValidatedTables`
 * en `pdfToExcel.ts`) a un unico bloque de texto CSV.
 *
 * Si solo hay UNA tabla, la salida es simplemente el CSV de esa tabla, sin
 * ningun encabezado extra. Si hay VARIAS, cada tabla va precedida de un
 * comentario `# Tabla N` (N en base 1, en el orden en que aparecen en el
 * documento) y separada de la siguiente por una linea en blanco: un
 * comentario `#` no es parte del formato CSV estandar, pero es la
 * convencion mas comun para anotar un archivo CSV sin romper ningun
 * parser real (se ignora como comentario o, en el peor caso, como una fila
 * de una sola celda) y evita inventar un delimitador de tablas propio.
 */
export function tablesToCsv(tables: string[][][]): string {
  if (tables.length === 1) {
    return rowsToCsv(tables[0]);
  }
  return tables
    .map((rows, index) => `# Tabla ${index + 1}\r\n${rowsToCsv(rows)}`)
    .join("\r\n\r\n");
}

/**
 * Serializa una o varias tablas ya validadas a JSON: un array de objetos
 * `{ table: N, rows: string[][] }` (N en base 1, mismo orden que en el
 * documento). Forma elegida por ser la mas directa de re-parsear sin
 * ambiguedad (a diferencia de, por ejemplo, un array de arrays de arrays,
 * que no deja sitio para el numero de tabla) y por ser simetrica con el
 * "# Tabla N" que usa `tablesToCsv` para el mismo proposito en texto
 * plano.
 */
export function tablesToJson(tables: string[][][]): string {
  const payload = tables.map((rows, index) => ({ table: index + 1, rows }));
  return JSON.stringify(payload, null, 2);
}

/**
 * Convierte los bloques ya extraidos de un documento en el texto de salida
 * (CSV o JSON) segun `format`. Funcion PURA: no toca el DOM ni pdf.js, se
 * puede probar en aislamiento con `DocBlock[]` construidos a mano.
 *
 * Lanza `PdfError("noTablesFound")`/`PdfError("tooLarge")` a traves de
 * `extractValidatedTables` (ver ese doc-comment en `pdfToExcel.ts` para el
 * detalle exacto de cada presupuesto).
 */
export function blocksToText(blocks: DocBlock[], format: PdfToCsvFormat): string {
  const tables = extractValidatedTables(blocks);
  return format === "json" ? tablesToJson(tables) : tablesToCsv(tables);
}

/**
 * Convierte un PDF en un archivo de texto (CSV o JSON) con SOLO las
 * tablas detectadas en el documento. Ver el doc-comment del modulo para
 * el alcance exacto y por que `ocrFallback` va siempre en `false`.
 */
export async function pdfToCsv(
  file: File,
  options: PdfToCsvOptions = DEFAULT_PDF_TO_CSV_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    throwIfAborted(signal);

    let blocks: DocBlock[];
    try {
      ({ blocks } = await extractDocumentBlocks(
        file,
        {
          ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
          stripRepeated: options.stripRepeated,
          // Ver el OJO del doc-comment de `pdfToExcel.ts`: nunca se activa
          // OCR aqui, una pagina escaneada jamas produce un bloque `table`.
          ocrFallback: false,
        },
        onProgress ? (value) => onProgress(Math.min(0.85, value * 0.85)) : undefined,
        signal,
      ));
    } catch (error) {
      // Mismo criterio que `pdfToExcel.ts`: "la extraccion no encontro
      // nada" y "no hay tablas" son, desde la perspectiva de esta
      // herramienta especifica, la misma situacion honesta para el
      // usuario.
      if (error instanceof PdfError && error.code === "empty") {
        throw new PdfError("noTablesFound");
      }
      throw error;
    }

    throwIfAborted(signal);
    const text = blocksToText(blocks, options.format);
    onProgress?.(0.95);

    throwIfAborted(signal);
    const mimeType = options.format === "json" ? "application/json" : "text/csv";
    onProgress?.(1);

    return new Blob([text], { type: `${mimeType};charset=utf-8` });
  } catch (error) {
    throw toPdfError(error);
  }
}
