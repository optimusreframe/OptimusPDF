import type { Workbook } from "exceljs";
import {
  MAX_TABLE_CELLS,
  PdfError,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  extractDocumentBlocks,
  type DocBlock,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * Motor "PDF -> Excel".
 *
 * Reutiliza por completo la extraccion estructurada de `pdfToMarkdown.ts`
 * (`extractDocumentBlocks`): NO vuelve a leer el PDF con pdf.js ni
 * reimplementa la deteccion de tablas. Este modulo se limita a filtrar los
 * bloques de tipo `table` y volcarlos a un libro `exceljs`, una hoja por
 * tabla.
 *
 * Alcance explicito: se extrae TEXTO de tabla, tal cual lo reconstruye
 * `pageBlocks` (rejillas regulares por alineacion de columnas). NO se
 * extraen formulas (las celdas de un PDF nunca las tienen: un PDF no
 * guarda formulas, solo el texto ya renderizado) ni estilos de ninguna
 * clase (colores, bordes, anchos de columna). La primera fila de cada
 * tabla se escribe como una fila de datos mas, no como cabecera especial.
 *
 * OJO (por que `ocrFallback: false` es obligatorio aqui, no una opcion):
 * `extractDocumentBlocks` con OCR activado convierte una pagina escaneada
 * en parrafos de texto plano (`ocrBlocks` en `pdfToMarkdown.ts` solo
 * produce bloques `paragraph`, nunca `table` — el reconocimiento de
 * tesseract.js no reconstruye ninguna rejilla). Activar OCR aqui pagaria
 * el costo completo (descarga del modelo + reconocimiento de todas las
 * paginas escaneadas) sin ninguna posibilidad de terminar con una sola
 * tabla adicional: sería lento y confuso sin ganar nada. Por eso este
 * motor SIEMPRE pasa `ocrFallback: false`, sin exponerlo como opcion de la
 * herramienta.
 */

export type PdfToExcelOptions = {
  /**
   * Mismo campo que `PdfToMarkdownOptions.stripRepeated`: elimina antes de
   * buscar tablas las lineas que se repiten en la franja superior/inferior
   * de casi todas las paginas (numeracion, titulillo, aviso legal). No
   * decide si una tabla se detecta o no — las tablas casi nunca viven en
   * esa franja — pero evita que una de esas lineas repetidas cuele como
   * fila espuria en un caso limite.
   */
  stripRepeated: boolean;
};

export const DEFAULT_PDF_TO_EXCEL_OPTIONS: PdfToExcelOptions = {
  stripRepeated: true,
};

/**
 * Tope de hojas (= tablas) que UNA conversion esta dispuesta a
 * materializar. Sin este limite, un documento patologico con miles de
 * tablas diminutas — cada una individualmente muy por debajo de
 * `MAX_TABLE_CELLS` — generaria un libro con miles de hojas: inviable de
 * abrir/navegar en Excel y caro de serializar con `exceljs`, aunque el
 * presupuesto de celdas total nunca se dispare. 500 es generoso para
 * cualquier PDF real (un documento con mas de 500 tablas detectadas ya es
 * un caso extremo fuera de lo que esta herramienta esta pensada para
 * cubrir) pero corta esa degradacion patologica antes de escribir nada.
 */
export const MAX_TABLES_PER_DOCUMENT = 500;

/**
 * Limite nativo real de Excel para el contenido de UNA celda (32.767
 * caracteres). Por encima de eso, Excel trunca o corrompe la celda al
 * abrir el archivo segun la version; se trunca aqui con un indicador
 * honesto (sufijo "…") en vez de dejar que eso pase en silencio en manos
 * del usuario.
 */
export const MAX_CELL_CHARS = 32767;

/**
 * Presupuesto ACUMULATIVO de caracteres de celda (antes de truncar) sobre
 * TODO el documento, combinando todas las tablas. Cierra el hueco real de
 * que `MAX_TABLE_CELLS` x `MAX_CELL_CHARS` por si solos admiten un volumen
 * de texto teorico absurdo (mas de 6.500 millones de unidades UTF-16) —
 * ver el comentario junto a su uso en `blocksToWorkbook`. Mismo orden de
 * magnitud que `MAX_DOCUMENT_CHARACTERS` en `pdfToWord.ts` (5.000.000):
 * generoso para cualquier tabla real extraida de un PDF, muy por debajo
 * del limite teorico patologico.
 */
export const MAX_DOCUMENT_TEXT_CHARS = 10_000_000;

/**
 * Limite nativo REAL de `exceljs` (a su vez, limite de Excel) para el
 * numero de columnas de una fila: 16.384. Por encima de eso,
 * `worksheet.addRow` lanza un `Error` crudo, sin tipar, de la propia
 * libreria ("N is out of bounds. Excel supports columns from 1 to
 * 16384") que de otro modo caeria como `PdfError("unknown")` generico.
 * Se valida ANTES de escribir nada al workbook (ver `blocksToWorkbook`)
 * para poder fallar con honestidad (`PdfError("tooLarge")`) en vez de
 * dejar pasar la excepcion cruda.
 */
export const EXCEL_MAX_COLUMNS = 16384;

/**
 * Contador mutable, opcional, de cuantas celdas tuvo que truncar
 * `blocksToWorkbook` por superar `MAX_CELL_CHARS`. `truncateCellText` ya
 * deja una marca visible ("…") en la celda misma, pero eso solo lo ve
 * quien abre esa celda exacta; este contador es lo que permite a un
 * test (y, si algun dia se decide, a la UI) verificar de forma explicita
 * cuanta perdida de datos hubo en la conversion sin tener que inspeccionar
 * celda por celda.
 */
export type TruncationCounter = { count: number };

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

function truncateCellText(value: string, counter?: TruncationCounter): string {
  if (value.length <= MAX_CELL_CHARS) return value;
  if (counter) counter.count += 1;
  let cutLength = MAX_CELL_CHARS - 1;
  // No cortar a mitad de un par subrogado UTF-16: si el ultimo code unit
  // que quedaria dentro del corte es un high surrogate suelto (su low
  // surrogate cayo justo despues del limite), exceljs lo serializa como
  // U+FFFD -- se retrocede un caracter mas para no partir el par.
  const lastCode = value.charCodeAt(cutLength - 1);
  if (lastCode >= HIGH_SURROGATE_MIN && lastCode <= HIGH_SURROGATE_MAX) {
    cutLength -= 1;
  }
  return `${value.slice(0, cutLength)}…`;
}

/**
 * Filtra los bloques `table` de un documento (ver `extractDocumentBlocks`
 * en `pdfToMarkdown.ts`) y aplica, EN UNA SOLA PASADA, todo el presupuesto
 * que este motor esta dispuesto a materializar antes de que cualquier
 * consumidor (`blocksToWorkbook` aqui, `pdfToCsv.ts`) escriba una sola
 * hoja/fila de salida:
 *
 *  - `PdfError("noTablesFound")` si no hay ningun bloque `table`.
 *  - `PdfError("tooLarge")` si el numero de tablas supera
 *    `MAX_TABLES_PER_DOCUMENT`, si el ANCHO de cualquier fila supera
 *    `EXCEL_MAX_COLUMNS` (limite nativo de columnas de Excel — lo
 *    respetan tambien los consumidores no-Excel para mantener un unico
 *    presupuesto de ancho de fila en vez de uno por formato de salida), o
 *    si el volumen ACUMULADO de caracteres de celda de todo el documento
 *    supera `MAX_DOCUMENT_TEXT_CHARS`.
 *
 * Extraida de `blocksToWorkbook` para que `pdfToCsv.ts` reutilice EXACTAMENTE
 * la misma logica de filtrado+presupuesto ya probada aqui, en vez de
 * duplicarla: mismo comportamiento exacto, solo se mueve el codigo. El
 * presupuesto ACUMULADO de celdas (`MAX_TABLE_CELLS`) NO se valida aqui a
 * proposito: `blocksToWorkbook` lo aplica sobre una hoja `exceljs` por
 * tabla mientras recorre `tables`, y `pdfToCsv.ts` no tiene ese mismo
 * concepto de "hoja"; cada consumidor sigue aplicando ese presupuesto
 * concreto por su cuenta con la forma que le corresponda.
 *
 * Funcion PURA: no toca el DOM ni pdf.js, asi que se puede probar en
 * aislamiento con `DocBlock[]` construidos a mano.
 */
export function extractValidatedTables(blocks: DocBlock[]): string[][][] {
  const tables = blocks.filter(
    (block): block is Extract<DocBlock, { type: "table" }> =>
      block.type === "table",
  );
  if (tables.length === 0) throw new PdfError("noTablesFound");
  if (tables.length > MAX_TABLES_PER_DOCUMENT) throw new PdfError("tooLarge");

  // Fail fast: se valida el ANCHO de cada fila de cada tabla contra el
  // limite nativo de columnas de Excel ANTES de que cualquier consumidor
  // escriba una sola hoja/fila. `worksheet.addRow` de exceljs lanza un
  // Error crudo ("N is out of bounds. Excel supports columns from 1 to
  // 16384") si se le pasa una fila mas ancha; sin esta validacion previa,
  // ese error crudo terminaria bucketizado como `PdfError("unknown")`
  // generico por `toPdfError`, en vez de un `tooLarge` honesto.
  // Fail fast, misma pasada: presupuesto ACUMULATIVO de caracteres sobre
  // TODO el texto de celda del documento (antes de truncar), no solo del
  // numero de celdas. `MAX_TABLE_CELLS` (200.000) x `MAX_CELL_CHARS`
  // (32.767 cada una) admite en teoria mas de 6.500 millones de unidades
  // UTF-16 combinadas -- un PDF adversarial con celdas casi-al-limite en
  // volumen suficiente pasaria el presupuesto de CELDAS sin problema y
  // aun asi agotaria memoria del navegador antes de llegar a escribir la
  // salida. Se comprueba ANTES de escribir nada, igual que el resto de
  // presupuestos de este motor.
  let totalChars = 0;
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.length > EXCEL_MAX_COLUMNS) throw new PdfError("tooLarge");
      for (const cell of row) {
        totalChars += cell.length;
        if (totalChars > MAX_DOCUMENT_TEXT_CHARS) throw new PdfError("tooLarge");
      }
    }
  }

  return tables.map((table) => table.rows);
}

/**
 * Convierte los bloques ya extraidos de un documento (ver
 * `extractDocumentBlocks` en `pdfToMarkdown.ts`) en un libro `exceljs`:
 * una hoja nueva ("Tabla 1", "Tabla 2", ...) por cada bloque `table`
 * encontrado, en el orden en que aparecen en el documento. Cualquier otro
 * tipo de bloque (`heading`, `paragraph`, `list`, `codeBlock`,
 * `pageBreak`) se ignora.
 *
 * Funcion PURA salvo por el import perezoso de `exceljs` (mismo patron que
 * `excelToPdf.ts`/`wordToPdf.ts` con sus dependencias pesadas, para no
 * inflar el bundle de ninguna otra herramienta): no toca el DOM ni pdf.js,
 * asi que se puede probar en aislamiento con `DocBlock[]` construidos a
 * mano, sin pasar por extraccion de PDF real.
 *
 * Lanza `PdfError("noTablesFound")` si `blocks` no contiene ningun bloque
 * `table`; `PdfError("tooLarge")` si el numero de tablas, el total
 * acumulado de celdas (ver `MAX_TABLE_CELLS`, compartido con
 * `excelToPdf.ts`/`wordToPdf.ts`) o el ANCHO de cualquier fila individual
 * (ver `EXCEL_MAX_COLUMNS`, limite nativo de columnas de Excel) superan el
 * presupuesto — en los tres casos ANTES de crear la hoja que lo haria
 * superarse (o, para el ancho de fila, antes de crear cualquier hoja: se
 * valida el documento entero primero), para no dejar un libro parcialmente
 * escrito por encima del limite ni dejar pasar la excepcion cruda, sin
 * tipar, que lanza `exceljs` (`worksheet.addRow`) cuando una fila supera
 * las 16.384 columnas.
 *
 * `truncationCounter`, si se pasa, se incrementa una vez por cada celda
 * que `truncateCellText` tuvo que cortar por superar `MAX_CELL_CHARS`:
 * mecanismo verificable por test (ver `pdfToExcel.test.ts`) para confirmar
 * cuanta perdida de datos hubo, ademas de la marca "…" que ya queda en la
 * celda misma.
 */
export async function blocksToWorkbook(
  blocks: DocBlock[],
  truncationCounter?: TruncationCounter,
): Promise<Workbook> {
  const tables = extractValidatedTables(blocks);

  const { Workbook: WorkbookCtor } = await import("exceljs");
  const workbook = new WorkbookCtor();

  // Presupuesto de celdas ACUMULATIVO sobre TODAS las tablas del
  // documento combinadas (no por hoja) — misma leccion que ya documenta
  // `excelToPdf.ts` junto a `MAX_TABLE_CELLS`: varias tablas
  // individualmente bajo el limite pueden sumar, combinadas, muy por
  // encima de el.
  let used = 0;

  tables.forEach((rows, index) => {
    const cellCount = rows.reduce((sum, row) => sum + row.length, 0);
    used += cellCount;
    if (used > MAX_TABLE_CELLS) throw new PdfError("tooLarge");

    const worksheet = workbook.addWorksheet(`Tabla ${index + 1}`);
    for (const row of rows) {
      // Asignacion directa de un array de STRINGS a `addRow`: exceljs
      // guarda cada valor como `ValueType.String` (cadena literal), nunca
      // como formula, sin importar que el texto empiece por `=`, `+`, `-`
      // o `@` (los prefijos que Excel puede interpretar como inicio de
      // formula al ABRIR un archivo). Solo se interpretaria como formula
      // si se asignara un objeto `{ formula: ... }`, que este motor nunca
      // construye — el texto de una celda de tabla de PDF es siempre
      // texto plano. Confirmado con un test dedicado (ver
      // `pdfToExcel.test.ts`), no solo asumido.
      worksheet.addRow(row.map((cell) => truncateCellText(cell, truncationCounter)));
    }
  });

  return workbook;
}

/**
 * Convierte un PDF en un libro XLSX con una hoja por cada tabla detectada
 * en el documento. Ver el doc-comment del modulo para el alcance exacto
 * (texto de tabla, no formulas ni estilos) y por que `ocrFallback` va
 * siempre en `false`.
 */
export async function pdfToExcel(
  file: File,
  options: PdfToExcelOptions = DEFAULT_PDF_TO_EXCEL_OPTIONS,
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
          // Ver el OJO del doc-comment del modulo: nunca se activa OCR aqui,
          // una pagina escaneada jamas produce un bloque `table`.
          ocrFallback: false,
        },
        onProgress ? (value) => onProgress(Math.min(0.85, value * 0.85)) : undefined,
        signal,
      ));
    } catch (error) {
      // `extractDocumentBlocks` lanza `PdfError("empty")` por su cuenta
      // cuando NINGUNA pagina produjo contenido (p. ej. un PDF enteramente
      // escaneado con OCR desactivado a proposito, como es siempre el caso
      // aqui — ver el OJO del doc-comment del modulo). Desde la
      // perspectiva de esta herramienta especifica, "la extraccion no
      // encontro nada" y "no hay tablas" son la misma situacion honesta
      // para el usuario: se relanza como `PdfError("noTablesFound")`, el
      // mismo codigo que ya usa `blocksToWorkbook` para el resto de casos
      // sin tablas, en vez de dejar pasar el "empty" generico que no
      // explica por que esta herramienta en particular no produjo nada.
      // Cualquier OTRO codigo (`encrypted`, `corrupt`, `tooLarge`,
      // `cancelled`, ...) se propaga sin modificar.
      if (error instanceof PdfError && error.code === "empty") {
        throw new PdfError("noTablesFound");
      }
      throw error;
    }

    throwIfAborted(signal);
    const workbook = await blocksToWorkbook(blocks);
    onProgress?.(0.9);

    // OJO: igual que `excelToPdf.ts`/`wordToPdf.ts` con `pdfmake`,
    // `workbook.xlsx.writeBuffer()` no es cancelable a mitad de camino: es
    // mejor esfuerzo, se revisa `signal` justo antes de empezar, no
    // durante.
    throwIfAborted(signal);
    const buffer = await workbook.xlsx.writeBuffer();
    onProgress?.(1);

    return new Blob([buffer as ArrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  } catch (error) {
    throw toPdfError(error);
  }
}
