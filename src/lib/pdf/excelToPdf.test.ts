import { describe, expect, it } from "vitest";
import * as ExcelJS from "exceljs";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  DEFAULT_EXCEL_TO_PDF_OPTIONS,
  excelToPdf,
  type ExcelToPdfOptions,
} from "@/lib/pdf/excelToPdf";
import { PdfError } from "@/lib/pdf/core";

/**
 * Fixture real: un .xlsx de verdad, construido en memoria con exceljs
 * (la misma libreria que lee el motor) y volcado a bytes con
 * `workbook.xlsx.writeBuffer()`. Asi las pruebas ejercitan el parseo real
 * de exceljs, no un mock.
 *
 * La hoja "Ventas" incluye deliberadamente:
 *  - Texto distintivo en celdas de datos ("ManzanaRarezaQ7", etc.) para
 *    poder verificar que sobrevive hasta el PDF final.
 *  - Una celda de cabecera (fila 1) con una cadena larga (~270 caracteres,
 *    varias palabras reales con espacios para que pdfmake pueda partirla
 *    en lineas): el repro empirico del bug de cabecera-que-desaparece era
 *    justo esto (una celda de la fila 1 con texto largo hacia que
 *    pdfmake descartara toda la fila silenciosamente).
 *
 *    Una cadena larga SIN espacios (un solo "token" repetido, ej. 280
 *    "L" seguidas) disparaba un problema distinto y mas severo: pdfmake
 *    no lograba ubicar ese token inquebrable en la columna y terminaba
 *    sin renderizar NINGUNA columna salvo la primera, en TODAS las filas
 *    de la hoja, no solo la cabecera (ni el cap de 300 caracteres lo
 *    evitaba: el trigger es la inquebrabilidad, no el largo). Ya
 *    corregido con `wordBreak: "break-all"` en `sheetToContent` — ver el
 *    caso dedicado mas abajo en este archivo que reproduce exactamente
 *    ese escenario.
 *  - Celdas de formula con resultado truthy (un numero distintivo) y con
 *    resultado falsy o sin cache: el repro empirico de "[object Object]"
 *    pasaba con los falsy (`0`, `false`, sin formula recalculada), porque
 *    `"result" in record` nunca los detectaba.
 *
 * OJO (verificado empiricamente con un script suelto contra el propio
 * exceljs, ver evidencia del informe): el getter publico `cell.value` de
 * exceljs (via `FormulaValue._copyModel`) omite la clave `result` para
 * CUALQUIER resultado falsy, incluso recien asignado en memoria y sin
 * pasar por disco. Es decir, `{ formula: "A2", result: 0 }` y
 * `{ formula: "A2" }` (sin resultado cacheado) acaban siendo
 * indistinguibles para quien lee `cell.value`: ambos llegan a este motor
 * como `{ formula: "A2" }`. El fix (`"formula" in record` en vez de
 * `"result" in record`) hace que ese caso rinda "" (via la rama
 * null/undefined de `cellValueToText`), no "[object Object]" — es el
 * comportamiento mas correcto alcanzable dado ese limite de exceljs, y
 * es exactamente lo que el fix documenta como seguro. Por eso la prueba
 * de "renderiza el valor real" usa un resultado truthy (que exceljs SI
 * conserva), y la prueba del bug de "[object Object]" usa resultados
 * falsy o sin cache para comprobar que ya no se imprime el objeto entero.
 */
/** Fragmento distintivo que se repite dentro de la cabecera larga de abajo. */
const HEADER_LONG_MARKER = "Encabezado extenso de prueba";

async function buildWorkbookFile(
  name = "reporte.xlsx",
  options: { emptySecondSheet?: boolean } = {},
): Promise<File> {
  const workbook = new ExcelJS.Workbook();

  const sheet1 = workbook.addWorksheet("Ventas");
  const encabezadoLargo = `${HEADER_LONG_MARKER} `.repeat(9); // ~270 caracteres
  sheet1.addRow([
    "ProductoUnicoXYZQ",
    "Cantidad",
    "Fecha",
    "FormulaTruthy",
    "FormulaFalsy",
    encabezadoLargo,
  ]);
  sheet1.addRow([
    "ManzanaRarezaQ7",
    7,
    new Date("2024-01-15T00:00:00.000Z"),
    { formula: "A2", result: 4242 },
    { formula: "A2", result: 0 },
    "corta",
  ]);
  sheet1.addRow([
    "Peras",
    5,
    new Date("2024-02-20T00:00:00.000Z"),
    { formula: "A3", result: 4242 },
    { formula: "A3" }, // sin resultado cacheado (ej. TODAY() sin recalcular)
    "corta",
  ]);
  sheet1.addRow([
    "Naranjas",
    8,
    new Date("2024-03-01T00:00:00.000Z"),
    { formula: "A4", result: 4242 },
    { formula: "A4", result: false },
    "corta",
  ]);

  const sheet2 = workbook.addWorksheet("Resumen");
  if (!options.emptySecondSheet) {
    sheet2.addRow(["Total", "Promedio"]);
    sheet2.addRow([23, 7.67]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function loadResult(blob: Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/**
 * Extrae el texto real de todas las paginas de un PDF con pdf.js, para
 * comprobar que el contenido de las celdas sobrevive de verdad hasta el
 * documento final (no solo que el Blob sea "no vacio y releible", que es
 * una prueba demasiado debil: un PDF con la cabecera entera descartada o
 * con "[object Object]" en vez de un numero sigue siendo un blob no vacio
 * que pdf-lib puede releer sin problema).
 *
 * Se usa el build `"pdfjs-dist/legacy/build/pdf.mjs"` directamente (en
 * vez de `core.ts`'s `getPdfJs()`, pensado para navegador con worker) por
 * el mismo motivo que `detectFields.test.ts`: ese build analiza
 * documentos (`getTextContent`) en Node sin DOM, sin necesitar canvas ni
 * worker.
 */
async function extractPdfText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes });
  const document = await task.promise;
  let text = "";
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    text += `${content.items
      .map((item) => ("str" in item ? (item as { str: string }).str : ""))
      .join(" ")}\n`;
  }
  // `document` (PDFDocumentProxy) no expone `destroy()` en este build; el
  // ciclo de vida se libera a traves de la propia tarea de carga, igual
  // que hace `closePdfDocument` en `core.ts`.
  await task.destroy();
  return text;
}

/** Firma OLE2 de Office 97-2003, con o sin el stream `EncryptedPackage`. */
function buildOleBytes(withEncryptedPackageToken: boolean): Uint8Array {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const bytes = new Uint8Array(withEncryptedPackageToken ? 128 : 64);
  signature.forEach((byte, index) => {
    bytes[index] = byte;
  });

  if (withEncryptedPackageToken) {
    // Los nombres de stream OLE2 se guardan en UTF-16LE: se codifica el
    // token a mano, igual que `looksLikeEncryptedOoxml` lo busca.
    const token = "EncryptedPackage";
    const offset = 16;
    for (let i = 0; i < token.length; i += 1) {
      const code = token.charCodeAt(i);
      bytes[offset + i * 2] = code & 0xff;
      bytes[offset + i * 2 + 1] = (code >> 8) & 0xff;
    }
  }

  return bytes;
}

/**
 * ZIP hecho a mano cuyo directorio central declara un tamano
 * descomprimido enorme (400 MB), sin que el archivo realmente pese eso:
 * `estimateZipUncompressedBytes` solo lee los registros del directorio
 * central (no infla ninguna entrada), asi que basta con que esos
 * registros y el EOCD sean validos para que la funcion calcule el total
 * declarado. La seccion "local" de 31 bytes es puro relleno: ni
 * `isOoxmlZipFile` (que solo mira los 4 primeros bytes) ni
 * `estimateZipUncompressedBytes` (que busca el EOCD desde el final hacia
 * atras) llegan a leerla.
 */
function buildFakeZipDeclaringHugeUncompressedSize(): Uint8Array {
  const LOCAL_SECTION_SIZE = 31;
  const CENTRAL_HEADER_SIZE = 46;
  const NAME_LENGTH = 1;
  const CENTRAL_SECTION_SIZE = CENTRAL_HEADER_SIZE + NAME_LENGTH;
  const EOCD_SIZE = 22;
  const HUGE_UNCOMPRESSED_SIZE = 400 * 1024 * 1024; // > MAX_DECOMPRESSED_OFFICE_BYTES (300 MB)

  const totalSize = LOCAL_SECTION_SIZE + CENTRAL_SECTION_SIZE + EOCD_SIZE;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  // Firma de cabecera de archivo local (0x04034b50): lo unico que
  // `isOoxmlZipFile` comprueba.
  view.setUint32(0, 0x04034b50, true);

  const centralOffset = LOCAL_SECTION_SIZE;
  view.setUint32(centralOffset, 0x02014b50, true); // firma de directorio central
  view.setUint32(centralOffset + 24, HUGE_UNCOMPRESSED_SIZE, true); // tamano sin comprimir (declarado)
  view.setUint16(centralOffset + 28, NAME_LENGTH, true); // longitud del nombre
  view.setUint16(centralOffset + 30, 0, true); // longitud "extra"
  view.setUint16(centralOffset + 32, 0, true); // longitud del comentario
  bytes[centralOffset + CENTRAL_HEADER_SIZE] = 0x61; // nombre: "a"

  const eocdOffset = centralOffset + CENTRAL_SECTION_SIZE;
  view.setUint32(eocdOffset, 0x06054b50, true); // firma EOCD
  view.setUint16(eocdOffset + 8, 1, true); // entradas en este disco
  view.setUint16(eocdOffset + 10, 1, true); // entradas totales
  view.setUint32(eocdOffset + 12, CENTRAL_SECTION_SIZE, true); // tamano del directorio central
  view.setUint32(eocdOffset + 16, centralOffset, true); // offset del directorio central

  return bytes;
}

describe("excelToPdf — src/lib/pdf/excelToPdf.ts", () => {
  it("convierte un .xlsx real (2 hojas) en un Blob de PDF no vacio con las opciones por defecto, y el contenido real (cabecera larga, celdas de formula falsy) sobrevive", async () => {
    const file = await buildWorkbookFile();
    const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const text = await extractPdfText(blob);

    // Texto distintivo de celdas de datos normales.
    expect(text).toContain("ProductoUnicoXYZQ");
    expect(text).toContain("ManzanaRarezaQ7");

    // Fix "cabecera que desaparece": la celda larga de la fila 1 debe
    // seguir presente (antes, `headerRows: 1` la descartaba entera y en
    // silencio cuando la fila resultaba inusualmente alta).
    expect(text).toContain(HEADER_LONG_MARKER);

    // Fix "[object Object]", caso con resultado cacheado (truthy): debe
    // imprimir el valor real de la formula, no el objeto entero.
    expect(text).toContain("4242");

    // Fix "[object Object]", casos con resultado falsy (`0`, `false`) o
    // sin resultado cacheado en absoluto: exceljs (via `cell.value`) ya
    // no expone esos resultados de vuelta (ver comentario de
    // `buildWorkbookFile`), asi que lo unico verificable con honestidad
    // es que YA NO se imprime el objeto de formula entero.
    expect(text).not.toContain("[object Object]");
  });

  it("el PDF generado es valido: se puede releer con @cantoo/pdf-lib y tiene al menos 1 pagina", async () => {
    const file = await buildWorkbookFile();
    const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);

    const document = await loadResult(blob);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("con sheet: 'first', el resultado sigue siendo un PDF valido y no vacio", async () => {
    const file = await buildWorkbookFile();
    const options: ExcelToPdfOptions = { ...DEFAULT_EXCEL_TO_PDF_OPTIONS, sheet: "first" };
    const blob = await excelToPdf(file, options);

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    const document = await loadResult(blob);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("un .xls legado (OLE2) lanza PdfError('legacyOfficeFormat')", async () => {
    const bytes = buildOleBytes(false);
    const file = new File([bytes as unknown as BlobPart], "viejo.xls", {
      type: "application/vnd.ms-excel",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "legacyOfficeFormat",
    });
  });

  it("un .xlsx cifrado con contrasena (OLE2 con stream 'EncryptedPackage') lanza PdfError('encrypted'), no 'legacyOfficeFormat'", async () => {
    const bytes = buildOleBytes(true);
    const file = new File([bytes as unknown as BlobPart], "protegido.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "encrypted",
    });
  });

  it("un archivo vacio (0 bytes) lanza PdfError('empty')", async () => {
    const file = new File([], "vacio.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("bytes basura (ni ZIP ni OLE2) lanzan PdfError('corrupt')", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const file = new File([bytes as unknown as BlobPart], "basura.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("un libro con una hoja sin filas de datos lanza PdfError('empty')", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Vacia");
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "sin-datos.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("PdfError es instanceof PdfError (sanity del tipo de error)", async () => {
    const file = new File([], "vacio2.xlsx");
    try {
      await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      throw new Error("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
    }
  });

  it("una celda con texto chino lanza PdfError('unsupportedScript') (Roboto no puede dibujarlo)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Hoja1");
    sheet.addRow(["Nombre", "Valor"]);
    sheet.addRow(["产品名称", 42]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "chino.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "unsupportedScript",
    });
  });

  it("una celda con texto arabe lanza PdfError('unsupportedScript')", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Hoja1");
    sheet.addRow(["Nombre", "Valor"]);
    sheet.addRow(["مرحبا", 1]);
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "arabe.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "unsupportedScript",
    });
  });

  it(
    "una hoja dispersa (dato real en fila 2 y en fila 5000, huecas en medio) se convierte rapido: prueba que se usa iteracion dispersa (eachRow), no 1..rowCount con getRow " +
      "[proxy honesto de la fila 1.048.576 del bug original: reproducir ese caso completo arriesgaria un test lento/inestable, pero un hueco mas chico ya seria costoso bajo el bucle viejo]",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Dispersa");
      sheet.getCell("A2").value = "ValorFilaDosXYZ";
      sheet.getCell("A5000").value = "ValorFilaLejanaXYZ";

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "dispersa.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const start = Date.now();
      const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(10000);
      expect(blob.size).toBeGreaterThan(0);

      const text = await extractPdfText(blob);
      expect(text).toContain("ValorFilaDosXYZ");
      expect(text).toContain("ValorFilaLejanaXYZ");
    },
  );

  it(
    "una hoja con mas de MAX_TABLE_CELLS (200.000) celdas reales lanza PdfError('tooLarge')",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Grande");
      const columns = 300;
      const rows = 700; // 300 x 700 = 210.000 > 200.000
      for (let r = 0; r < rows; r += 1) {
        sheet.addRow(new Array(columns).fill(0).map((_, c) => c));
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "grande.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
        code: "tooLarge",
      });
    },
  );

  it("un ZIP cuyo directorio central declara un tamano descomprimido enorme (>300 MB) lanza PdfError('tooLarge') antes de llegar a exceljs.load()", async () => {
    const bytes = buildFakeZipDeclaringHugeUncompressedSize();
    const file = new File([bytes as unknown as BlobPart], "bomba.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "tooLarge",
    });
  });

  it(
    "una hoja vacia-pero-formateada (fila con alto personalizado pero sin ninguna celda con valor) ya no aborta la conversion entera: se omite y las demas hojas con datos reales sobreviven " +
      "[repro empirico: `worksheet.rowCount` cuenta filas con CUALQUIER metadato, no datos reales; una hoja asi pasaba el viejo filtro `rowCount > 0`, " +
      "producia un `table.body: []` y pdfmake lanzaba un TypeError que se propagaba como PdfError('unknown'), perdiendo tambien la hoja valida]",
    async () => {
      const workbook = new ExcelJS.Workbook();

      const vacia = workbook.addWorksheet("SoloFormato");
      // Ninguna celda de esta hoja tiene valor: solo se fija el alto de
      // una fila lejana, que es justo lo que infla `rowCount` sin dejar
      // rastro para `eachRow({ includeEmpty: false })`.
      vacia.getRow(7).height = 30;
      expect(vacia.rowCount).toBeGreaterThan(0);

      const conDatos = workbook.addWorksheet("ConDatos");
      conDatos.addRow(["ColumnaRealXYZ", "OtraColumnaXYZ"]);
      conDatos.addRow(["ValorRealSobreviveXYZ", 99]);

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "vacia-formateada.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBeGreaterThan(0);

      const text = await extractPdfText(blob);
      expect(text).toContain("ColumnaRealXYZ");
      expect(text).toContain("ValorRealSobreviveXYZ");
    },
  );

  it("un libro donde TODAS las hojas son vacias-pero-formateadas (sin datos reales en ninguna) lanza PdfError('empty')", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet1 = workbook.addWorksheet("SoloFormato1");
    sheet1.getRow(3).height = 20;
    const sheet2 = workbook.addWorksheet("SoloFormato2");
    sheet2.getColumn(2).width = 40;

    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "todas-vacias.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it(
    "el presupuesto MAX_TABLE_CELLS se aplica al TOTAL de la conversion, no por hoja: varias hojas individualmente bajo el limite pero combinadas por encima lanzan PdfError('tooLarge')",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const columns = 300;
      const rowsPerSheet = 400; // 300 x 400 = 120.000 por hoja (bajo 200.000)
      const sheetCount = 3; // 3 x 120.000 = 360.000 combinado (> 200.000)

      for (let s = 0; s < sheetCount; s += 1) {
        const sheet = workbook.addWorksheet(`Hoja${s}`);
        for (let r = 0; r < rowsPerSheet; r += 1) {
          sheet.addRow(new Array(columns).fill(0).map((_, c) => c));
        }
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "combinada-grande.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
        code: "tooLarge",
      });
    },
  );

  it(
    "celdas de formula con resultado falsy (0, false) y truthy renderizan su valor REAL via `cell.result`, no en blanco ni '[object Object]' " +
      "[cell.value (FormulaValue._copyModel) omite `result` para resultados falsy; cell.result (el getter de nivel superior de exceljs) si lo conserva]",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Formulas");
      sheet.addRow(["Etiqueta", "Valor"]);
      sheet.addRow(["FilaFormulaCero", { formula: "A1", result: 0 }]);
      sheet.addRow(["FilaFormulaFalse", { formula: "A1", result: false }]);
      sheet.addRow(["FilaFormulaNormal", { formula: "A1", result: 4242 }]);

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "formulas-falsy.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      const text = await extractPdfText(blob);

      expect(text).toContain("FilaFormulaCero");
      expect(text).toContain("FilaFormulaFalse");
      expect(text).toContain("FilaFormulaNormal");
      expect(text).toContain("4242");
      expect(text).not.toContain("[object Object]");
      // El literal "0" y "false" deben sobrevivir como texto real de celda,
      // no quedar en blanco (verificable buscando el patron completo de la
      // fila: etiqueta seguida, en algun punto del texto extraido, del
      // valor real de la formula).
      expect(text).toMatch(/FilaFormulaCero[\s\S]*?0/);
      expect(text).toMatch(/FilaFormulaFalse[\s\S]*?false/);
    },
  );

  it(
    "celdas combinadas (merge) no duplican el valor de la maestra en las esclavas: el texto distintivo aparece una sola vez por celda logica " +
      "[exceljs hace que B1/C1 de un merge A1:C1 devuelvan el mismo `.value` que A1; se blanquean las esclavas via `cell.type === ValueType.Merge`]",
    async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("ConMerge");
      sheet.addRow(["QuarterMasterXYZ", null, null, "AdyacenteXYZ"]);
      sheet.mergeCells("A1:C1");
      sheet.addRow(["fila2col1", "fila2col2", "fila2col3", "fila2col4"]);

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "merge.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      const text = await extractPdfText(blob);

      expect(text).toContain("QuarterMasterXYZ");
      expect(text).toContain("AdyacenteXYZ");

      // Antes del fix, el merge de 3 columnas hacia que "QuarterMasterXYZ"
      // apareciera 3 veces (una por celda del rango) en vez de 1.
      const occurrences = text.split("QuarterMasterXYZ").length - 1;
      expect(occurrences).toBe(1);
    },
  );

  it("una hoja cuyo NOMBRE tiene texto chino (contenido de celdas todo latino) lanza PdfError('unsupportedScript') por el titulo de la hoja", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("你好");
    sheet.addRow(["Nombre", "Valor"]);
    sheet.addRow(["SoloLatino", 42]);

    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "nombre-chino.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "unsupportedScript",
    });
  });

  it("una hoja cuyo NOMBRE tiene texto arabe (contenido de celdas todo latino) lanza PdfError('unsupportedScript') por el titulo de la hoja", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("مرحبا");
    sheet.addRow(["Nombre", "Valor"]);
    sheet.addRow(["SoloLatino", 1]);

    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    const file = new File([bytes as unknown as BlobPart], "nombre-arabe.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS)).rejects.toMatchObject({
      code: "unsupportedScript",
    });
  });

  it(
    "una celda con un token largo sin espacios (250 caracteres, bajo el limite de truncado) ya no hace desaparecer el resto de columnas de la hoja " +
      "[repro empirico: `widths: '*'` comparte un mismo minWidth entre todas las columnas — el minWidth desmesurado de UNA celda inquebrable " +
      "contaminaba el de las demas y pdfmake terminaba sin escribir NINGUN texto en las columnas siguientes, en ninguna fila; " +
      "`wordBreak: 'break-all'` en cada celda acota el minWidth al ancho de un solo caracter]",
    async () => {
      const tokenLargoSinEspacios = "T".repeat(250);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("ConTokenLargo");
      sheet.addRow(["ColUnoXYZ", "ColDosXYZ", "ColTresXYZ", tokenLargoSinEspacios, "ColCincoXYZ"]);
      sheet.addRow(["ValorUnoXYZ", "ValorDosXYZ", "ValorTresXYZ", "corta", "ValorCincoXYZ"]);

      const buffer = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(buffer as ArrayBuffer);
      const file = new File([bytes as unknown as BlobPart], "token-largo.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const blob = await excelToPdf(file, DEFAULT_EXCEL_TO_PDF_OPTIONS);
      const text = await extractPdfText(blob);

      // Antes del fix, solo la primera columna sobrevivia: ninguna de las
      // siguientes aserciones pasaba (todas las columnas 2-5, en ambas
      // filas, faltaban del todo del texto extraido).
      expect(text).toContain("ColUnoXYZ");
      expect(text).toContain("ColDosXYZ");
      expect(text).toContain("ColTresXYZ");
      expect(text).toContain("ColCincoXYZ");
      expect(text).toContain("ValorUnoXYZ");
      expect(text).toContain("ValorDosXYZ");
      expect(text).toContain("ValorTresXYZ");
      expect(text).toContain("ValorCincoXYZ");
      expect(text).toContain("corta");
      // El propio token largo tambien debe sobrevivir (partido en varias
      // lineas dentro de su columna, pero presente).
      expect(text).toContain("T".repeat(10));
    },
  );
});
