import type { Content, TableCell } from "pdfmake";
import {
  estimateZipUncompressedBytes,
  findUnsupportedGlyph,
  isLegacyOleOfficeFile,
  isOoxmlZipFile,
  loadPdfMake,
  looksLikeEncryptedOoxml,
  MAX_DECOMPRESSED_OFFICE_BYTES,
  PdfError,
  readFileBytes,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor "Excel -> PDF".
 *
 * Convierte una hoja de calculo XLSX en un PDF con tablas nativas (texto
 * real, seleccionable) en vez de una captura visual. Todo ocurre en el
 * navegador: ningun byte del archivo sale del dispositivo.
 *
 *   1. `exceljs`  - parsea el XLSX (contenedor ZIP/OOXML) a un modelo de
 *                   filas y celdas en memoria.
 *   2. Este modulo recorre cada hoja seleccionada y arma un contenido de
 *      pdfmake: un titulo con el nombre de la hoja y una tabla con la
 *      primera fila en negrita (sin repetirla como cabecera de pagina:
 *      ver el comentario junto a `table` en `sheetToContent`).
 *   3. `pdfmake`  - maqueta y renderiza el documento a un Blob de PDF.
 *
 * exceljs y pdfmake son librerias pesadas usadas solo por esta
 * herramienta: se importan de forma perezosa (`import()`), igual que
 * `htmlToPdf.ts` hace con html2canvas/jsPDF, para no inflar el bundle de
 * ninguna otra pagina.
 */

export type ExcelToPdfOptions = {
  pageSize: "a4" | "letter";
  orientation: "portrait" | "landscape";
  /** "all" renderiza cada hoja como su propia seccion; "first" solo la primera. */
  sheet: "all" | "first";
};

export const DEFAULT_EXCEL_TO_PDF_OPTIONS: ExcelToPdfOptions = {
  pageSize: "a4",
  // Una hoja de calculo suele ser mas ancha que alta: horizontal es el
  // valor por defecto mas util, sobre todo con varias columnas.
  orientation: "landscape",
  sheet: "all",
};

/** Margen de pagina unico y fijo: en una tabla importa mas el padding de celda. */
const PAGE_MARGIN_PT = 24;

/* ------------------------------------------------------------------ *
 * Celda -> texto
 * ------------------------------------------------------------------ */

/**
 * Convierte el valor de una celda de exceljs en texto plano para la
 * tabla. No debe lanzar nunca: cualquier forma inesperada cae en
 * `String(value ?? "")`.
 */
function cellValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (value instanceof Date) {
    // Formato legible y agnostico de locale: fecha ISO (sin hora si es
    // medianoche, que es el caso tipico de una celda de solo-fecha).
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (Array.isArray(record.richText)) {
      return (record.richText as Array<{ text?: unknown }>)
        .map((run) => (typeof run?.text === "string" ? run.text : ""))
        .join("");
    }

    // Formula: se usa el resultado calculado, nunca la formula en si.
    //
    // OJO: exceljs's `FormulaValue._copyModel` omite la clave `result` por
    // completo cuando el resultado calculado es falsy (`0`, `""`, `false`)
    // o cuando no hay resultado cacheado (p.ej. `TODAY()` sin recalcular),
    // asi que comprobar `"result" in record` nunca coincide en esos casos
    // y el codigo caia al `String(value ?? "")` de mas abajo, imprimiendo
    // el objeto entero como "[object Object]". Se comprueba en su lugar la
    // presencia del marcador de formula: `record.result` puede ser
    // legitimamente `undefined` aqui, pero `cellValueToText(undefined)` ya
    // devuelve "" por la rama de null/undefined de arriba.
    if ("formula" in record || "sharedFormula" in record) {
      return cellValueToText(record.result);
    }

    if (typeof record.error === "string") {
      return record.error;
    }

    // Hyperlink: { text, hyperlink }.
    if (typeof record.text === "string") {
      return record.text;
    }

    return String(value ?? "");
  }

  return String(value ?? "");
}

/* ------------------------------------------------------------------ *
 * Hoja -> contenido de pdfmake
 * ------------------------------------------------------------------ */

/**
 * Cuantas celdas (filas visitadas x columnas) esta dispuesta a materializar
 * UNA LLAMADA COMPLETA a `excelToPdf` (todas las hojas seleccionadas, no
 * cada hoja por separado). `worksheet.rowCount` es `_lastRowNumber` de
 * exceljs (el mayor indice de fila usado, NO un recuento real): una sola
 * celda perdida a millones de filas de distancia lo infla sin limite. Este
 * presupuesto se aplica sobre filas/celdas realmente visitadas por
 * `eachRow`/`eachCell`, asi que corta el trabajo real en vez de fiarse de
 * ese numero.
 *
 * OJO: el contador (`CellBudget.used` mas abajo) es una unica instancia
 * COMPARTIDA entre todas las hojas de una misma llamada a `excelToPdf` —
 * no uno nuevo por hoja. Sin esto, un libro con, digamos, 10 hojas cada
 * una individualmente justo por debajo del limite podia producir una
 * tabla combinada muchas veces mayor que el limite, ya que cada hoja se
 * comprobaba contra el limite de forma independiente.
 */
const MAX_TABLE_CELLS = 200_000;

/** Contador de celdas compartido entre todas las hojas de una misma conversion. */
type CellBudget = { used: number };

function chargeCells(budget: CellBudget, count: number): void {
  budget.used += count;
  if (budget.used > MAX_TABLE_CELLS) throw new PdfError("tooLarge");
}

/**
 * Longitud maxima del texto renderizado de una celda. Limite intencional,
 * no un descuido: una celda con una cadena muy larga puede inflar la
 * altura de su fila lo suficiente para que pdfmake la maqueje mal (ver
 * `headerRows` mas abajo) o para disparar el costo de render/memoria de
 * esa fila. Se trunca con "…" en vez de rechazar el documento entero.
 */
const MAX_CELL_TEXT_LENGTH = 300;

type CellLike = {
  value: unknown;
  /** El resultado REAL cacheado de una formula (ver comentario mas abajo). */
  result?: unknown;
  /** Valor numerico de `ExcelJS.ValueType`; `ValueType.Merge` = celda esclava de un merge. */
  type: number;
};

/**
 * Texto final de una celda para la tabla: resuelve el valor real (ver OJO
 * de abajo para celdas de formula), aplica `cellValueToText`, luego
 * rechaza con honestidad si el texto tiene un glifo que Roboto no puede
 * dibujar (ver `findUnsupportedGlyph`) y por ultimo acota la longitud.
 */
function cellTextForRender(cell: CellLike): string {
  const value = cell.value;
  const record =
    value !== null && typeof value === "object" && !(value instanceof Date)
      ? (value as Record<string, unknown>)
      : null;

  // OJO: `cell.value` (via `FormulaValue._copyModel`, el getter publico de
  // exceljs) omite la clave `result` por completo cuando el resultado
  // cacheado es falsy (`0`, `""`, `false`), asi que leer `record.result`
  // aqui rendiria "" incluso para una formula que evalua correctamente a
  // `0`. exceljs expone el resultado real cacheado por una via SEPARADA:
  // el getter de nivel superior `Cell.result` (no `cell.value.result`), que
  // SI conserva el valor real incluso cuando `cell.value` lo omite.
  // Verificado empiricamente con un script suelto contra exceljs: para
  // `{ formula: "A1", result: 0 }`, `cell.value` es `{ formula: "A1" }`
  // (sin `result`) pero `cell.result` es `0`; para `{ formula: "A1" }` sin
  // resultado cacheado, `cell.result` es `undefined` (que
  // `cellValueToText` ya traduce a "").
  const resolved =
    record && ("formula" in record || "sharedFormula" in record) ? cell.result : value;

  const text = cellValueToText(resolved);
  if (findUnsupportedGlyph(text)) throw new PdfError("unsupportedScript");
  return text.length > MAX_CELL_TEXT_LENGTH
    ? `${text.slice(0, MAX_CELL_TEXT_LENGTH)}…`
    : text;
}

type RowLike = {
  eachCell: (
    options: { includeEmpty: boolean },
    callback: (cell: CellLike, colNumber: number) => void,
  ) => void;
};

type WorksheetLike = {
  name: string;
  columnCount: number;
  eachRow: (
    options: { includeEmpty: boolean },
    callback: (row: RowLike, rowNumber: number) => void,
  ) => void;
};

/**
 * Construye el titulo + tabla de una hoja, o `null` si la hoja no tiene
 * NINGUNA fila con datos reales.
 *
 * OJO (hoja vacia-pero-formateada): `worksheet.rowCount` es
 * `_lastRowNumber` de exceljs — cuenta filas con CUALQUIER metadato (ej.
 * un alto de fila personalizado), no filas con datos reales. Una hoja
 * donde, digamos, la fila 7 tiene un alto de fila fijado a mano pero
 * ninguna celda tiene valor alguno hace que `rowCount` reporte 7 mientras
 * que `eachRow({ includeEmpty: false })` no visita NINGUNA fila. Antes,
 * este motor decidia si una hoja era "renderizable" mirando
 * `rowCount > 0`, asi que esa hoja pasaba el filtro, `body` quedaba como
 * `[]` (array vacio, nunca se le empujo nada), y pdfmake lanzaba
 * `TypeError: Cannot read properties of undefined (reading 'length')` al
 * maquetar una tabla con `body: []` — abortando la conversion ENTERA,
 * perdiendo tambien los datos validos de cualquier otra hoja del libro.
 * Por eso la renderizabilidad ya no se decide antes de construir el
 * contenido: se construye primero, y si `body` termina vacio (sin
 * importar lo que diga `rowCount`), esta funcion devuelve `null` para que
 * la llamadora simplemente omita esta hoja sin abortar el resto.
 */
function sheetToContent(
  worksheet: WorksheetLike,
  mergeValueType: number,
  budget: CellBudget,
  signal?: AbortSignal,
): Content[] | null {
  const columnCount = Math.max(1, worksheet.columnCount);
  const body: TableCell[][] = [];
  let processedRows = 0;

  // `eachRow({ includeEmpty: false })` solo visita filas con datos reales
  // (a diferencia de recorrer `1..rowCount` con `getRow`, que materializa
  // un objeto Row por cada indice hasta el ultimo usado, aunque este a
  // millones de filas de distancia de cualquier dato real).
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    processedRows += 1;
    if (processedRows % 200 === 0) throwIfAborted(signal);

    const cells = new Array<string>(columnCount).fill("");
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber >= 1 && colNumber <= columnCount) {
        // OJO (celdas combinadas/merge): exceljs hace que cada celda
        // "esclava" de un rango combinado (ej. B1/C1 de un merge A1:C1)
        // devuelva el MISMO valor que la celda "maestra" (A1) al leer
        // `.value` — verificado empiricamente. Sin este chequeo, una fila
        // con un merge de 3 columnas renderizaria el valor de la maestra
        // TRIPLICADO en vez de una vez. exceljs distingue una celda
        // esclava de una normal por su `.type`: una esclava tiene
        // `type === ValueType.Merge` (confirmado leyendo
        // `node_modules/exceljs/lib/doc/cell.js`, getter `master`/`type`);
        // la maestra conserva su tipo real (String, Number, etc.). Se
        // renderiza la esclava como texto vacio; la maestra se sigue
        // viendo con su valor real en su propia posicion. No se intenta
        // reconstruir un `colSpan`/`rowSpan` de pdfmake: blanquear las
        // esclavas ya corrige el bug de integridad de datos (contenido
        // duplicado) de forma proporcionada, sin complicar el armado de
        // la tabla.
        cells[colNumber - 1] = cell.type === mergeValueType ? "" : cellTextForRender(cell);
      }
    });

    chargeCells(budget, columnCount);

    const isHeader = rowNumber === 1;
    body.push(
      cells.map((text) => ({
        text,
        bold: isHeader,
        // OJO: sin esto, una celda con una unica "palabra" muy larga y sin
        // espacios (ej. un identificador o token pegado) hace que pdfmake
        // calcule un `_minWidth` de columna igual al ancho de esa palabra
        // entera. Como todas las columnas comparten `widths: "*"`, ese
        // minWidth desmesurado de UNA columna contamina el calculo
        // compartido de las demas (`columnCalculator.js`: `starMaxMin` es
        // el maximo entre columnas), forzando a TODAS las columnas de la
        // tabla a un ancho igual de desmesurado. El resultado (verificado
        // empiricamente extrayendo texto con pdf.js) no es solo un
        // desborde visual: pdfmake termina sin escribir ningun texto en
        // las columnas siguientes, en ninguna fila de la hoja — se pierde
        // en silencio, el mismo tipo de fallo que la cabecera que
        // desaparecia. `wordBreak: "break-all"` le dice a pdfmake que
        // puede partir cualquier "palabra" por cualquier caracter, asi
        // que el ancho minimo de cualquier celda queda acotado al ancho
        // de un solo caracter, sin importar que tan largo o inquebrable
        // sea el contenido real.
        wordBreak: "break-all",
      })),
    );
  });

  // Hoja vacia-pero-formateada (ver OJO arriba): sin filas de datos
  // reales, no hay nada que tabular. Se omite esta hoja devolviendo
  // `null` en vez de construir una tabla con `body: []` (lo que hacia
  // que pdfmake abortara la conversion ENTERA). La llamadora decide si
  // el libro completo queda sin contenido tras omitir hojas asi.
  if (body.length === 0) return null;

  // OJO (titulo de hoja con glifo no soportado): `cellTextForRender`
  // valida cada texto de celda contra `findUnsupportedGlyph`, pero el
  // NOMBRE de la hoja (usado como titulo antes de la tabla) no pasaba por
  // ese mismo chequeo — una hoja llamada en chino/arabe/etc. renderizaria
  // su titulo en blanco aunque todas sus celdas fueran texto latino. Se
  // comprueba aqui, DESPUES de confirmar que la hoja tiene datos reales
  // (si `body` esta vacio ya se devolvio `null` arriba y el nombre nunca
  // se usa como titulo, asi que no hace falta validarlo).
  if (findUnsupportedGlyph(worksheet.name)) throw new PdfError("unsupportedScript");

  return [
    {
      text: worksheet.name,
      fontSize: 13,
      bold: true,
      margin: [0, 12, 0, 6],
    },
    {
      table: {
        // OJO: `headerRows: 1` (repetir la fila 1 como cabecera de pagina)
        // puede hacer que pdfmake DESCARTE por completo la fila 1, sin
        // ningun error, cuando su altura renderizada es inusualmente alta
        // (ej. una celda con una cadena larga). El PDF resultante es
        // valido y no vacio, solo le falta la cabecera entera. Se sacrifica
        // el "la cabecera se repite en cada pagina" a cambio de eliminar
        // ese modo de fallo silencioso; la fila 1 se sigue viendo en
        // negrita (`isHeader` arriba), solo que ya no como header repetido.
        widths: new Array(columnCount).fill("*"),
        body,
      },
      layout: "lightHorizontalLines",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * API de la herramienta
 * ------------------------------------------------------------------ */

export async function excelToPdf(
  file: File,
  options: ExcelToPdfOptions = DEFAULT_EXCEL_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    throwIfAborted(signal);
    const bytes = await readFileBytes(file);
    if (bytes.byteLength === 0) throw new PdfError("empty");
    onProgress?.(0.2);

    // El formato legado se detecta ANTES que nada: exceljs no sabe leer
    // el binario OLE2 de Office 97-2003 y lanzaria un error generico de
    // parseo en vez de esta causa concreta.
    //
    // OJO: un .xlsx moderno protegido con contrasena TAMBIEN se guarda
    // como contenedor OLE2 (misma firma), asi que hay que descartar
    // primero que sea justo eso antes de asumir el formato legado.
    if (isLegacyOleOfficeFile(bytes)) {
      if (looksLikeEncryptedOoxml(bytes)) throw new PdfError("encrypted");
      throw new PdfError("legacyOfficeFormat");
    }
    if (!isOoxmlZipFile(bytes)) throw new PdfError("corrupt");

    // Presupuesto de descompresion: una estimacion barata (solo lee el
    // directorio central del ZIP, no infla nada) del total de bytes que
    // `exceljs.load()` tendria que materializar. Sin esto, un XLSX
    // manipulado de unos pocos KB puede expandirse a cientos de MB (o mas)
    // dentro del parseo, con el consiguiente pico de memoria/crash, antes
    // de que este motor tenga oportunidad de rechazarlo con honestidad.
    const estimatedBytes = estimateZipUncompressedBytes(bytes);
    if (estimatedBytes !== null && estimatedBytes > MAX_DECOMPRESSED_OFFICE_BYTES) {
      throw new PdfError("tooLarge");
    }

    throwIfAborted(signal);
    const { Workbook, ValueType } = await import("exceljs");
    const workbook = new Workbook();
    try {
      // exceljs 4.4.0 declares `load(buffer: Buffer, ...)`, pero su propio
      // `index.d.ts` fusiona un `Buffer extends ArrayBuffer` ambiental que
      // choca con el `Buffer` generico de @types/node recientes (le exige
      // miembros de ArrayBuffer redimensionable que Node no tiene). En
      // tiempo de ejecucion `Xlsx#load` reenvia el dato tal cual a
      // `JSZip.loadAsync`, que acepta `Uint8Array` sin conversion alguna
      // (confirmado leyendo `node_modules/exceljs/lib/xlsx/xlsx.js` y su
      // build de navegador): el `any` de aqui evita ese roce de tipos de
      // terceros sin fingir un tipo que no es real.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(bytes as any);
    } catch (error) {
      if (error instanceof PdfError) throw error;
      throw toPdfError(error);
    }
    onProgress?.(0.5);

    if (workbook.worksheets.length === 0) throw new PdfError("empty");

    const selected =
      options.sheet === "first" ? workbook.worksheets.slice(0, 1) : workbook.worksheets;

    // OJO: la renderizabilidad de cada hoja YA NO se decide de antemano
    // con `worksheet.rowCount > 0` (ver el comentario de `sheetToContent`
    // sobre hojas vacias-pero-formateadas). Se construye el contenido de
    // cada hoja seleccionada y se omiten en silencio las que resulten sin
    // datos reales (`sheetToContent` devuelve `null`); solo si NINGUNA
    // hoja seleccionada tiene datos reales se considera el libro vacio.
    //
    // El presupuesto de celdas (`budget`) es una unica instancia
    // compartida entre todas las hojas de esta llamada (ver
    // `MAX_TABLE_CELLS`): antes cada hoja se medía contra el limite por
    // separado, asi que varias hojas individualmente bajo el limite
    // podian sumar, combinadas, muy por encima de el.
    const budget: CellBudget = { used: 0 };
    const content: Content[] = [];
    for (const worksheet of selected) {
      throwIfAborted(signal);
      const sheetContent = sheetToContent(worksheet, ValueType.Merge, budget, signal);
      if (sheetContent) content.push(...sheetContent);
    }
    if (content.length === 0) throw new PdfError("empty");

    const pdfMake = await loadPdfMake();

    throwIfAborted(signal);
    const pdfDocument = pdfMake.createPdf({
      pageSize: options.pageSize === "a4" ? "A4" : "LETTER",
      pageOrientation: options.orientation,
      pageMargins: PAGE_MARGIN_PT,
      defaultStyle: { fontSize: 9 },
      content,
    });

    const blob = await pdfDocument.getBlob();
    onProgress?.(0.9);

    throwIfAborted(signal);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
