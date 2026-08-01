import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { MAX_DECOMPRESSED_OFFICE_BYTES, PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_WORD_TO_PDF_OPTIONS,
  sanitizePdfmakeContent,
  wordToPdf,
  type WordToPdfOptions,
} from "@/lib/pdf/wordToPdf";

/**
 * `wordToPdf.ts` solo referencia el global `window` (via
 * `html-to-pdfmake`, que necesita `window.DOMParser` para parsear el HTML
 * que devuelve `mammoth`). En un navegador real ese `window` ya existe;
 * aqui, en el proyecto "engines" de Vitest (entorno "node", sin jsdom por
 * defecto — ver `vitest.config.ts`), hay que aportarlo explicitamente
 * antes de llamar al motor. Se limpia despues para no dejar un `window`
 * global colgado que otro archivo de este mismo paquete no espere.
 */
let originalWindow: unknown;

// `jsdom` no trae tipos publicados; se tipa en el sitio de uso con una
// unica asercion en vez de anadir un `.d.ts` nuevo al repo (mismo motivo
// que `HtmlToPdfmakeFn` en `wordToPdf.ts`).
type JsdomModule = { JSDOM: new (html: string) => { window: unknown } };

beforeAll(async () => {
  originalWindow = (globalThis as { window?: unknown }).window;
  // @ts-expect-error -- "jsdom" no trae tipos publicados en npm.
  const jsdomModule = await import("jsdom");
  const { JSDOM } = jsdomModule as unknown as JsdomModule;
  const dom = new JSDOM("");
  (globalThis as { window?: unknown }).window = dom.window;
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

/** Firma OLE2 de los .doc/.xls/.ppt legados (Office 97-2003). */
const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

/**
 * Token unico (no una palabra real) para verificar que el texto de verdad
 * sobrevive la conversion, no solo que "algo" se genero. Sin espacios ni
 * puntuacion para que la extraccion de texto de pdf.js no lo parta en
 * fragmentos y la comprobacion de substring sea inequivoca.
 */
const DISTINCTIVE_TOKEN = "PalabraClaveDeVerificacionXK492";

async function buildRealDocx(): Promise<Buffer> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: "Titulo de prueba",
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun("Texto normal, "),
              new TextRun({ text: "texto en negrita", bold: true }),
              new TextRun(" y "),
              new TextRun({ text: "texto en cursiva", italics: true }),
              new TextRun("."),
            ],
          }),
          new Paragraph({
            text: DISTINCTIVE_TOKEN,
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}

function docxFile(bytes: Buffer, name = "documento.docx"): File {
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/**
 * Extrae el texto real de un PDF generado, usando `pdfjs-dist` en Node.
 *
 * `getPdfJs()`/`openPdfDocument()` de `core.ts` estan pensados para el
 * navegador (worker servido como asset estatico) y revientan en Node con
 * `DOMMatrix is not defined`; el build
 * `"pdfjs-dist/legacy/build/pdf.mjs"` si funciona en Node sin DOM alguno
 * para *analizar* un documento (`getTextContent`, sin renderizar nada a
 * canvas) -- mismo patron ya usado en `detectFields.test.ts` para
 * construir fixtures de verdad a partir de un PDF real. Se confirmo
 * empiricamente antes de asumirlo: correr este mismo archivo con
 * `pdfjs-dist` a secas revienta; con el build "legacy" no.
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
    for (const item of content.items) {
      if ("str" in item) text += `${item.str} `;
    }
  }
  await document.loadingTask.destroy();
  return text;
}

const OPTIONS: WordToPdfOptions = DEFAULT_WORD_TO_PDF_OPTIONS;

describe("wordToPdf — src/lib/pdf/wordToPdf.ts", () => {
  it("convierte un .docx real en un Blob de PDF no vacio, y el texto sobrevive de verdad", async () => {
    const bytes = await buildRealDocx();
    const blob = await wordToPdf(docxFile(bytes), OPTIONS);

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(0);

    // La comprobacion de mas alto valor: no basta con que el PDF exista y
    // sea releible, el texto de verdad del documento fuente tiene que
    // aparecer en el PDF resultante (esto es justo lo que un bug de
    // corrupcion silenciosa -- glifo en blanco, contenido descartado --
    // dejaria pasar si solo se comprueba "el blob no esta vacio").
    const extracted = await extractPdfText(blob);
    expect(extracted).toContain(DISTINCTIVE_TOKEN);
    expect(extracted).toContain("Titulo de prueba");
    expect(extracted).toContain("texto en negrita");
  });

  it("el PDF generado es estructuralmente valido (releido con @cantoo/pdf-lib)", async () => {
    const bytes = await buildRealDocx();
    const blob = await wordToPdf(docxFile(bytes), OPTIONS);

    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const reread = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    expect(reread.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("un .doc legado (OLE2) da PdfError('legacyOfficeFormat')", async () => {
    const legacy = Buffer.concat([OLE_SIGNATURE, Buffer.alloc(64)]);
    const file = new File([legacy as unknown as BlobPart], "viejo.doc", {
      type: "application/msword",
    });

    await expect(wordToPdf(file, OPTIONS)).rejects.toMatchObject({
      code: "legacyOfficeFormat",
    });
  });

  it("un .docx moderno cifrado (OLE2 + stream EncryptedPackage) da PdfError('encrypted'), no 'legacyOfficeFormat'", async () => {
    // Un .docx protegido con contrasena (MS-OFFCRYPTO) tambien envuelve
    // el paquete en un contenedor OLE2: mismo bloque de bytes que
    // `viejo.doc` de la prueba anterior comparte firma, PERO trae el
    // nombre de stream "EncryptedPackage" codificado en UTF-16LE (asi es
    // como MS-CFB guarda nombres de stream) en algun punto del sector de
    // directorio. Sin distinguir esto, el archivo cifrado real se
    // rechazaria con el mensaje equivocado ("usa el formato moderno")
    // cuando el problema de verdad es que hace falta la contrasena.
    const token = "EncryptedPackage";
    const utf16le = Buffer.alloc(token.length * 2);
    for (let i = 0; i < token.length; i += 1) {
      utf16le.writeUInt16LE(token.charCodeAt(i), i * 2);
    }
    const encrypted = Buffer.concat([
      OLE_SIGNATURE,
      Buffer.alloc(32),
      utf16le,
      Buffer.alloc(32),
    ]);
    const file = new File([encrypted as unknown as BlobPart], "protegido.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    await expect(wordToPdf(file, OPTIONS)).rejects.toMatchObject({
      code: "encrypted",
    });
  });

  it("un archivo vacio (0 bytes) da PdfError('empty')", async () => {
    const empty = new File([], "vacio.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    await expect(wordToPdf(empty, OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("bytes basura (ni ZIP ni OLE2) dan PdfError('corrupt')", async () => {
    const garbage = Buffer.from("esto no es un docx ni un doc valido");
    const file = new File([garbage as unknown as BlobPart], "basura.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    await expect(wordToPdf(file, OPTIONS)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("reporta progreso hasta 1 al terminar, siempre entre 0 y 1", async () => {
    const bytes = await buildRealDocx();
    const seen: number[] = [];

    await wordToPdf(docxFile(bytes), OPTIONS, (value) => seen.push(value));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("DEFAULT_WORD_TO_PDF_OPTIONS: valores por defecto documentados", () => {
    expect(DEFAULT_WORD_TO_PDF_OPTIONS).toEqual({
      pageSize: "a4",
      orientation: "portrait",
      margin: "small",
    });
  });

  describe("texto en alfabetos que Roboto no puede dibujar", () => {
    it("un .docx con texto en chino da PdfError('unsupportedScript')", async () => {
      const document = new Document({
        sections: [
          {
            children: [new Paragraph({ text: "你好，这是一个测试文档。" })],
          },
        ],
      });
      const bytes = await Packer.toBuffer(document);

      await expect(wordToPdf(docxFile(bytes), OPTIONS)).rejects.toMatchObject({
        code: "unsupportedScript",
      });
    });

    it("un .docx con texto en arabe da PdfError('unsupportedScript')", async () => {
      const document = new Document({
        sections: [
          {
            children: [new Paragraph({ text: "هذا مستند اختبار." })],
          },
        ],
      });
      const bytes = await Packer.toBuffer(document);

      await expect(wordToPdf(docxFile(bytes), OPTIONS)).rejects.toMatchObject({
        code: "unsupportedScript",
      });
    });

    it("un .docx con espanol, cirilico y griego SI se convierte (Roboto los cubre)", async () => {
      const document = new Document({
        sections: [
          {
            children: [
              new Paragraph({ text: "Documento en espanol con acentos: nino, cancion." }),
              new Paragraph({ text: "Привет, мир! Это тестовый документ." }),
              new Paragraph({ text: "Καλημέρα κόσμε, αυτό είναι ένα έγγραφο δοκιμής." }),
            ],
          },
        ],
      });
      const bytes = await Packer.toBuffer(document);

      const blob = await wordToPdf(docxFile(bytes), OPTIONS);
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe("tablas con filas de distinto largo (celdas combinadas/divididas)", () => {
    it("un .docx real con una tabla desigual (3 celdas y luego 1) no aborta la conversion", async () => {
      // Construido con la API de alto nivel de `docx`: nada le impide
      // crear filas con distinto numero de celdas (no valida columnas),
      // y `mammoth` lo convierte tal cual a un <table> HTML desigual --
      // se confirmo empiricamente que esto reproduce el mismo arbol de
      // contenido (`table.body` con filas de largo 3 y 1) que hace que
      // pdfmake lance "Malformed table row, a cell is undefined." antes
      // del arreglo.
      const document = new Document({
        sections: [
          {
            children: [
              new Table({
                rows: [
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("CeldaA1")] }),
                      new TableCell({ children: [new Paragraph("CeldaB1")] }),
                      new TableCell({ children: [new Paragraph("CeldaC1")] }),
                    ],
                  }),
                  new TableRow({
                    children: [
                      new TableCell({ children: [new Paragraph("CeldaA2")] }),
                    ],
                  }),
                ],
              }),
              new Paragraph("Texto despues de la tabla desigual"),
            ],
          },
        ],
      });
      const bytes = await Packer.toBuffer(document);

      const blob = await wordToPdf(docxFile(bytes), OPTIONS);
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBeGreaterThan(0);

      const extracted = await extractPdfText(blob);
      expect(extracted).toContain("CeldaA1");
      expect(extracted).toContain("CeldaB1");
      expect(extracted).toContain("CeldaC1");
      expect(extracted).toContain("CeldaA2");
      expect(extracted).toContain("Texto despues de la tabla desigual");
    });

    it("sanitizePdfmakeContent rellena una fila corta con celdas de texto vacio", () => {
      const input = [
        {
          table: {
            body: [
              [{ text: "A1" }, { text: "B1" }, { text: "C1" }],
              [{ text: "A2" }],
            ],
          },
        },
      ];

      const output = sanitizePdfmakeContent(input) as Array<{
        table: { body: unknown[][] };
      }>;

      expect(output[0].table.body[0]).toEqual([
        { text: "A1" },
        { text: "B1" },
        { text: "C1" },
      ]);
      expect(output[0].table.body[1]).toEqual([
        { text: "A2" },
        { text: "" },
        { text: "" },
      ]);
    });

    it("sanitizePdfmakeContent omite una tabla vacia (<table></table>) en vez de dejarla pasar", () => {
      // La API de alto nivel de `docx` no deja construir una `Table` con
      // `rows: []` (lanza "Invalid array length" al empaquetar), asi que
      // este caso se prueba directamente contra el arbol de contenido --
      // exactamente la forma que produce `html-to-pdfmake` para
      // `<table></table>` (`{table: {body: []}}`, comprobado
      // empiricamente), que hoy hace que pdfmake lance "Cannot read
      // properties of undefined (reading 'length')".
      const input = [
        { text: "antes" },
        { table: { body: [] } },
        { text: "despues" },
      ];

      const output = sanitizePdfmakeContent(input);

      expect(output).toEqual([{ text: "antes" }, { text: "despues" }]);
    });
  });

  describe("imagenes en formatos que pdfmake no reconoce", () => {
    it("un .docx real con una imagen GIF no aborta la conversion (se sustituye por un aviso)", async () => {
      // GIF 1x1 transparente, el clasico de 43 bytes. `docx` acepta
      // `type: "gif"` en `ImageRun`; se confirmo empiricamente que
      // `mammoth` lo vuelca como `<img src="data:image/gif;base64,...">`,
      // que es justo el formato que `DocMeasure.js` de pdfmake rechaza
      // (solo reconoce jpeg/png) con "Invalid image: ...", abortando hoy
      // la conversion entera.
      const gifBytes = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        "base64",
      );
      const document = new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [
                  new ImageRun({
                    type: "gif",
                    data: gifBytes,
                    transformation: { width: 10, height: 10 },
                  }),
                ],
              }),
              new Paragraph("Texto despues de la imagen GIF"),
            ],
          },
        ],
      });
      const bytes = await Packer.toBuffer(document);

      const blob = await wordToPdf(docxFile(bytes), OPTIONS);
      expect(blob.type).toBe("application/pdf");
      expect(blob.size).toBeGreaterThan(0);

      const extracted = await extractPdfText(blob);
      expect(extracted).toContain("Texto despues de la imagen GIF");
    });

    it("sanitizePdfmakeContent sustituye una imagen no-JPEG/PNG por un texto de aviso", () => {
      const input = [
        { text: "antes" },
        { image: "data:image/gif;base64,AAAA" },
        { text: "despues" },
      ];

      const output = sanitizePdfmakeContent(input) as unknown[];

      expect(output[1]).toEqual({
        text: "[Imagen no compatible omitida]",
        italics: true,
        color: "#888888",
      });
    });

    it("sanitizePdfmakeContent deja intacta una imagen JPEG/PNG valida", () => {
      const input = [{ image: "data:image/png;base64,AAAA" }];

      const output = sanitizePdfmakeContent(input) as unknown[];

      expect(output[0]).toEqual({ image: "data:image/png;base64,AAAA" });
    });
  });

  describe("bomba de descompresion (ZIP cuyo total declarado excede el limite)", () => {
    /**
     * Construye a mano los bytes minimos de un ZIP (cabecera local +
     * registro de directorio central + EOCD) cuyo tamano SIN COMPRIMIR
     * declarado supera `MAX_DECOMPRESSED_OFFICE_BYTES`, sin necesitar
     * datos reales de ese tamano: `estimateZipUncompressedBytes` solo lee
     * los campos de tamano del directorio central (nunca infla nada), asi
     * que unos bytes de "archivo" vacios (tamano comprimido = 0) bastan
     * para ejercitar la funcion de verdad -- mismos desplazamientos que
     * documenta `core.ts`, no un mock de la funcion.
     */
    function buildOversizedZipBytes(): Uint8Array {
      const filename = Buffer.from("a");
      const localHeaderSize = 30 + filename.length;
      const centralHeaderSize = 46 + filename.length;
      const eocdSize = 22;

      const buffer = Buffer.alloc(localHeaderSize + centralHeaderSize + eocdSize);

      // -- Cabecera local de archivo (PK\x03\x04) --
      buffer.writeUInt32LE(0x04034b50, 0);
      buffer.writeUInt16LE(20, 4); // version necesaria
      buffer.writeUInt16LE(0, 6); // flags
      buffer.writeUInt16LE(0, 8); // metodo (0 = sin comprimir)
      buffer.writeUInt16LE(0, 10); // hora
      buffer.writeUInt16LE(0, 12); // fecha
      buffer.writeUInt32LE(0, 14); // crc32
      buffer.writeUInt32LE(0, 18); // tamano comprimido (0: sin datos reales)
      buffer.writeUInt32LE(0, 22); // tamano sin comprimir (no se lee aqui)
      buffer.writeUInt16LE(filename.length, 26);
      buffer.writeUInt16LE(0, 28); // extra length
      filename.copy(buffer, 30);

      const centralOffset = localHeaderSize;
      const oversized = MAX_DECOMPRESSED_OFFICE_BYTES + 1024;

      // -- Registro de directorio central (PK\x01\x02) --
      let offset = centralOffset;
      buffer.writeUInt32LE(0x02014b50, offset);
      buffer.writeUInt16LE(20, offset + 4); // version que lo creo
      buffer.writeUInt16LE(20, offset + 6); // version necesaria
      buffer.writeUInt16LE(0, offset + 8); // flags
      buffer.writeUInt16LE(0, offset + 10); // metodo
      buffer.writeUInt16LE(0, offset + 12); // hora
      buffer.writeUInt16LE(0, offset + 14); // fecha
      buffer.writeUInt32LE(0, offset + 16); // crc32
      buffer.writeUInt32LE(0, offset + 20); // tamano comprimido
      buffer.writeUInt32LE(oversized, offset + 24); // tamano SIN comprimir declarado
      buffer.writeUInt16LE(filename.length, offset + 28);
      buffer.writeUInt16LE(0, offset + 30); // extra length
      buffer.writeUInt16LE(0, offset + 32); // comment length
      buffer.writeUInt16LE(0, offset + 34); // disco de inicio
      buffer.writeUInt16LE(0, offset + 36); // atributos internos
      buffer.writeUInt32LE(0, offset + 38); // atributos externos
      buffer.writeUInt32LE(0, offset + 42); // offset de la cabecera local
      filename.copy(buffer, offset + 46);

      const eocdOffset = centralOffset + centralHeaderSize;

      // -- Fin de directorio central (PK\x05\x06) --
      offset = eocdOffset;
      buffer.writeUInt32LE(0x06054b50, offset);
      buffer.writeUInt16LE(0, offset + 4); // numero de disco
      buffer.writeUInt16LE(0, offset + 6); // disco donde empieza el directorio central
      buffer.writeUInt16LE(1, offset + 8); // entradas en este disco
      buffer.writeUInt16LE(1, offset + 10); // entradas totales
      buffer.writeUInt32LE(centralHeaderSize, offset + 12); // tamano del directorio central
      buffer.writeUInt32LE(centralOffset, offset + 16); // offset del directorio central
      buffer.writeUInt16LE(0, offset + 20); // longitud del comentario

      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

    it("un ZIP cuyo directorio central declara mas de MAX_DECOMPRESSED_OFFICE_BYTES da PdfError('tooLarge') antes de llegar a mammoth", async () => {
      const bytes = buildOversizedZipBytes();
      const file = new File([bytes as unknown as BlobPart], "bomba.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

      await expect(wordToPdf(file, OPTIONS)).rejects.toMatchObject({
        code: "tooLarge",
      });
    });
  });

  describe("limites de tamano de tabla (gridSpan/colspan desmesurado y tablas gigantes)", () => {
    // La API de alto nivel de `docx` no deja declarar un `gridSpan` (fusion
    // de columnas) arbitrariamente grande a traves de `TableCell` -- solo
    // expone fusiones reales (`columnSpan` limitado por las columnas que
    // de verdad existen en la fila). Reproducir el defecto de verdad
    // requeriria fabricar XML `w:tbl` a mano, fuera del alcance util de
    // esta prueba. En su lugar, igual que las pruebas ya existentes de
    // "tabla vacia" e "imagen no soportada" mas arriba en este archivo, se
    // ejercita `sanitizePdfmakeContent` de forma directa con el arbol de
    // contenido sintetico que `html-to-pdfmake` produciria DESPUES de
    // expandir un `colspan`/`gridSpan` desmesurado (un objeto-marcador de
    // posicion por columna abarcada en el `body` de la tabla) -- la misma
    // forma que Codex verifico empiricamente que un .docx real produce.

    it("una fila con mas celdas que el tope por fila da PdfError('tooLarge') sin llegar a pdfmake", () => {
      const oversizedRow = Array.from({ length: 501 }, (_, index) => ({
        text: `celda${index}`,
      }));
      const input = [{ table: { body: [oversizedRow] } }];

      expect(() => sanitizePdfmakeContent(input)).toThrowError(
        expect.objectContaining({ code: "tooLarge" }),
      );
    });

    it("una tabla cuyo total de celdas (filas x columna mas ancha) supera el tope da PdfError('tooLarge')", () => {
      // 401 filas x 500 celdas = 200.500 celdas totales: cada fila por si
      // sola respeta el tope por fila (500, ni una celda mas), pero el
      // total agregado supera el tope combinado -- justo el eje que el
      // tope por fila NO cubre por si solo (un `gridSpan` repartido en
      // muchas filas mas moderadas, en vez de concentrado en una sola).
      const row = Array.from({ length: 500 }, (_, index) => ({
        text: `c${index}`,
      }));
      const body = Array.from({ length: 401 }, () => row);
      const input = [{ table: { body } }];

      expect(() => sanitizePdfmakeContent(input)).toThrowError(
        expect.objectContaining({ code: "tooLarge" }),
      );
    });

    it("una tabla normal (pocas columnas, pocas filas) no se ve afectada por los nuevos topes", () => {
      const input = [
        {
          table: {
            body: [
              [{ text: "A1" }, { text: "B1" }, { text: "C1" }],
              [{ text: "A2" }, { text: "B2" }, { text: "C2" }],
              [{ text: "A3" }, { text: "B3" }, { text: "C3" }],
            ],
          },
        },
      ];

      const output = sanitizePdfmakeContent(input) as Array<{
        table: { body: unknown[][] };
      }>;

      expect(output[0].table.body).toEqual([
        [{ text: "A1" }, { text: "B1" }, { text: "C1" }],
        [{ text: "A2" }, { text: "B2" }, { text: "C2" }],
        [{ text: "A3" }, { text: "B3" }, { text: "C3" }],
      ]);
    });

    it("calcular la columna mas ancha con un array de argumentos ya NO usa spread (regresion empirica del RangeError)", () => {
      // Confirmado empiricamente (fuera de este archivo, con un script de
      // Node aislado) que `Math.max(...array)` revienta con
      // "RangeError: Maximum call stack size exceeded" en algun punto
      // entre 100.000 y 125.000 argumentos en el motor V8 que corre esta
      // suite -- 100.000 todavia funciona, 125.000 ya no. 150.000 filas
      // cruza ese umbral con margen (igual que Codex reporto para una
      // tabla de Word de ~125.000 filas o mas), sin acercarse al tope de
      // celdas totales del defecto anterior (150.000 filas x 1 celda =
      // 150.000 celdas, por debajo del tope de 200.000): esto aisla la
      // regresion de calculo de ancho maximo de la comprobacion del tope
      // de tamano, para que una no enmascare a la otra.
      const body = Array.from({ length: 150_000 }, (_, index) => [
        { text: `f${index}` },
      ]);
      const input = [{ table: { body } }];

      let output: unknown;
      expect(() => {
        output = sanitizePdfmakeContent(input);
      }).not.toThrow();

      const table = (output as Array<{ table: { body: unknown[][] } }>)[0]
        .table;
      expect(table.body.length).toBe(150_000);
      expect(table.body[0]).toEqual([{ text: "f0" }]);
      expect(table.body[149_999]).toEqual([{ text: "f149999" }]);
    });

    it("una tabla con muchas filas Y de sobra por encima del tope de celdas da un PdfError limpio, nunca un RangeError crudo", () => {
      // Combina los dos ejes a la vez: bastantes filas como para que el
      // calculo de ancho maximo con la version ANTERIOR de este codigo ya
      // hubiera reventado con RangeError (ver prueba anterior), Y ademas
      // un total de celdas que excede el tope combinado (150.000 filas x
      // 2 celdas = 300.000, por encima de 200.000). El punto de esta
      // prueba es unicamente que nunca escape un RangeError sin tipar --
      // cualquier `PdfError` (de cualquier `code`) es un resultado
      // correcto aqui, no necesariamente `tooLarge` especificamente,
      // aunque en la practica es el que se espera con el arreglo actual.
      const body = Array.from({ length: 150_000 }, (_, index) =>
        index === 0
          ? [{ text: "a" }, { text: "b" }]
          : [{ text: `f${index}` }],
      );
      const input = [{ table: { body } }];

      let caught: unknown;
      try {
        sanitizePdfmakeContent(input);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(PdfError);
      expect(typeof (caught as PdfError).code).toBe("string");
    });
  });
});
