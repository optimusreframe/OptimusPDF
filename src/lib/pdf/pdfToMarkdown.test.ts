import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@/lib/pdf/core";
import {
  DEFAULT_OCR_FAILURE_MARKER,
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  applyTransform,
  bodyFontSize,
  buildDocument,
  buildLines,
  buildMarkdown,
  escapeInline,
  extractMarkdownPages,
  findRepeatedLines,
  matchListMarker,
  type MarkdownPage,
  type MarkdownTextItem,
  type PdfToMarkdownOptions,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * `pdfToMarkdown.ts` esta partido a proposito en dos capas:
 *
 *  - PURA: `buildLines`, `bodyFontSize`, `matchListMarker`,
 *    `escapeInline`, `findRepeatedLines`, `applyTransform` y
 *    `buildMarkdown`. Todo lo que convierte geometria en Markdown vive
 *    aqui y no depende de navegador: es lo que cubre esta suite.
 *  - NAVEGADOR: `extractMarkdownPages` y `pdfToMarkdown`, que sacan esa
 *    geometria con pdf.js y hacen OCR con tesseract.js.
 *
 * LIMITACION DE ENTORNO (ya comprobada en `compare.test.ts` y
 * `core.test.ts` de este mismo proyecto): pdf.js no arranca bajo
 * `environment: "node"` de Vitest — pide `DOMMatrix`, avisa de que en
 * Node hace falta el build `legacy` y despues intenta resolver
 * `PDF_WORKER_SRC` ("/pdf.worker.min.mjs", una ruta pensada para
 * servirse desde `public/`) como si fuera un modulo de Node. tesseract.js
 * ademas necesita un `canvas` real. Por eso la extraccion de texto REAL
 * con pdf.js y el flujo completo de `pdfToMarkdown` (con pdf.js real) NO
 * tienen test aqui: se verificaron a mano en el navegador con PDFs reales
 * (documento con titulos/listas/codigo/tabla y un PDF escaneado sin capa
 * de texto para el camino de OCR).
 *
 * Lo que SI se prueba aqui (mismo patron que `pdfToImages.test.ts`): la
 * logica de reserva de OCR de `extractMarkdownPages` — reintento de
 * creacion del worker, degradacion elegante por pagina, resultados
 * parciales y el error especifico cuando NINGUNA pagina se pudo resolver
 * — sustituyendo `openPdfDocument`/`renderPageToCanvas`/`closePdfDocument`
 * de `@/lib/pdf/core` y `createWorker` de `tesseract.js` por dobles
 * controlados. El codigo REAL de `extractMarkdownPages` corre sin tocar;
 * solo sus dependencias de pdf.js/tesseract.js estan sustituidas.
 */

const FAKE_OPS = vi.hoisted(() => ({
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 83,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: vi.fn(),
    renderPageToCanvas: vi.fn(),
    closePdfDocument: vi.fn(async () => {}),
    // pdf.js real no arranca en Node: solo se necesita la enumeracion `OPS` para medir imagenes.
    getPdfJs: vi.fn(async () => ({ OPS: FAKE_OPS })),
  };
});

vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(),
  OEM: { LSTM_ONLY: 1 },
}));

/* ------------------------------------------------------------------ *
 * Ayudantes de fixture
 * ------------------------------------------------------------------ */

function makeItem(
  text: string,
  x: number,
  y: number,
  size = 11,
  extra: Partial<MarkdownTextItem> = {},
): MarkdownTextItem {
  return {
    text,
    x,
    y,
    width: text.length * size * 0.5,
    fontSize: size,
    bold: false,
    italic: false,
    monospace: false,
    ...extra,
  };
}

function makePage(
  items: MarkdownTextItem[],
  overrides: Partial<MarkdownPage> = {},
): MarkdownPage {
  return {
    pageNumber: 1,
    width: 612,
    height: 792,
    source: "text",
    items,
    ...overrides,
  };
}

/** Linea de cuerpo que llega al borde derecho (no corta el parrafo). */
function bodyLine(text: string, y: number, x = 72, width = 440) {
  return makeItem(text, x, y, 11, { width });
}

function options(patch: Partial<PdfToMarkdownOptions> = {}) {
  return { ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS, ...patch };
}

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */

describe("applyTransform — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("la matriz identidad deja el punto donde estaba", () => {
    expect(applyTransform([1, 0, 0, 1, 0, 0], 72, 692)).toEqual({
      x: 72,
      y: 692,
    });
  });

  it("la matriz de viewport de pdf.js (escala 1, sin rotar) voltea el eje Y", () => {
    // viewport.transform de una pagina carta sin /Rotate: [1,0,0,-1,0,792].
    expect(applyTransform([1, 0, 0, -1, 0, 792], 72, 692)).toEqual({
      x: 72,
      y: 100,
    });
  });

  it("una pagina rotada 90 grados enderaza el punto al espacio de vista", () => {
    // viewport.transform con /Rotate 90 sobre una pagina 612x792: [0,1,1,0,-0,-0].
    expect(applyTransform([0, 1, 1, 0, 0, 0], 72, 692)).toEqual({
      x: 692,
      y: 72,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Lineas
 * ------------------------------------------------------------------ */

describe("buildLines — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("agrupa por linea base y ordena de izquierda a derecha", () => {
    const page = makePage([
      makeItem("mundo", 120, 100),
      makeItem("Hola", 72, 100.4),
      makeItem("Segunda linea", 72, 118),
    ]);
    const lines = buildLines(page);

    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hola mundo");
    expect(lines[1].text).toBe("Segunda linea");
  });

  it("ordena las lineas de arriba abajo (y crece hacia abajo)", () => {
    const page = makePage([
      makeItem("abajo", 72, 300),
      makeItem("arriba", 72, 100),
    ]);
    expect(buildLines(page).map((line) => line.text)).toEqual([
      "arriba",
      "abajo",
    ]);
  });

  it("inserta un espacio cuando el hueco entre fragmentos lo justifica", () => {
    // "uno" mide 3*11*0.5 = 16.5 -> borde derecho 88.5; el hueco a 95 es
    // mayor que 11*0.22 pero menor que 11*1.2: es un espacio, no columna.
    const page = makePage([makeItem("uno", 72, 100), makeItem("dos", 95, 100)]);
    const line = buildLines(page)[0];

    expect(line.text).toBe("uno dos");
    expect(line.cells).toEqual(["uno dos"]);
  });

  it("un hueco ancho parte la linea en celdas (pista de tabla)", () => {
    const page = makePage([makeItem("uno", 72, 100), makeItem("dos", 240, 100)]);
    const line = buildLines(page)[0];

    expect(line.cells).toEqual(["uno", "dos"]);
    expect(line.cellStarts).toEqual([72, 240]);
    expect(line.text).toBe("uno dos");
  });

  it("marca la linea como negrita o monoespaciada segun la mayoria de caracteres", () => {
    const page = makePage([
      makeItem("Titulo en negrita", 72, 100, 11, { bold: true }),
      makeItem("const x = 1;", 72, 130, 11, { monospace: true }),
    ]);
    const lines = buildLines(page);

    expect(lines[0].bold).toBe(true);
    expect(lines[0].monospace).toBe(false);
    expect(lines[1].monospace).toBe(true);
  });

  it("pagina sin fragmentos utiles -> sin lineas", () => {
    expect(buildLines(makePage([makeItem("   ", 72, 100)]))).toEqual([]);
  });
});

describe("bodyFontSize — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("devuelve el cuerpo que cubre mas caracteres, no el mas grande", () => {
    const page = makePage([
      makeItem("TITULO", 72, 60, 28),
      makeItem("texto corrido con muchos caracteres de cuerpo", 72, 100, 11),
      makeItem("mas texto corrido del mismo cuerpo once", 72, 118, 11),
    ]);
    expect(bodyFontSize([page])).toBe(11);
  });

  it("sin texto devuelve un cuerpo por defecto razonable", () => {
    expect(bodyFontSize([makePage([])])).toBe(12);
  });
});

/* ------------------------------------------------------------------ *
 * Marcadores y escapado
 * ------------------------------------------------------------------ */

describe("matchListMarker — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("reconoce vinetas tipograficas y guiones", () => {
    expect(matchListMarker("• primero")?.rest).toBe("primero");
    expect(matchListMarker("- segundo")?.rest).toBe("segundo");
    expect(matchListMarker("– tercero")?.ordered).toBe(false);
  });

  it("reconoce listas numeradas conservando el numero", () => {
    const marker = matchListMarker("3. tercero");
    expect(marker?.ordered).toBe(true);
    expect(marker?.number).toBe(3);
    expect(marker?.rest).toBe("tercero");
    expect(matchListMarker("4) cuarto")?.number).toBe(4);
  });

  it("no confunde texto normal ni guiones sueltos con listas", () => {
    expect(matchListMarker("texto normal")).toBeNull();
    expect(matchListMarker("-")).toBeNull();
    expect(matchListMarker("2024 fue un ano raro")).toBeNull();
    expect(matchListMarker("correo-electronico")).toBeNull();
  });
});

describe("escapeInline — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("escapa lo que se leeria como sintaxis al principio de linea", () => {
    expect(escapeInline("# no es un titulo")).toBe("\\# no es un titulo");
    expect(escapeInline("> no es una cita")).toBe("\\> no es una cita");
    expect(escapeInline("1. no es una lista")).toBe("1\\. no es una lista");
    expect(escapeInline("- no es una vineta")).toBe("\\- no es una vineta");
  });

  it("no toca el texto normal ni los caracteres en medio de la linea", () => {
    expect(escapeInline("Una frase con # en medio")).toBe(
      "Una frase con # en medio",
    );
    expect(escapeInline("C# y F#")).toBe("C# y F#");
  });
});

/* ------------------------------------------------------------------ *
 * Titulos
 * ------------------------------------------------------------------ */

describe("buildMarkdown — titulos", () => {
  it("mapea los tamanos distintos a H1/H2/H3 por orden de tamano", () => {
    const page = makePage([
      makeItem("Titulo principal", 72, 60, 24),
      bodyLine("Texto de cuerpo con bastantes caracteres para fijar la mediana", 90),
      makeItem("Seccion", 72, 140, 16),
      bodyLine("Mas texto de cuerpo para que la mediana siga siendo once", 170),
      makeItem("Subseccion", 72, 210, 13),
      bodyLine("Y todavia mas texto de cuerpo del mismo tamano de siempre", 240),
    ]);
    const { markdown, stats } = buildMarkdown([page], options());

    expect(markdown).toContain("# Titulo principal");
    expect(markdown).toContain("## Seccion");
    expect(markdown).toContain("### Subseccion");
    expect(stats.headings).toBe(3);
  });

  it("una linea corta en negrita del mismo cuerpo baja al ultimo nivel", () => {
    const page = makePage([
      makeItem("Titulo principal", 72, 60, 20),
      makeItem("Apartado en negrita", 72, 100, 11, { bold: true }),
      bodyLine("Texto de cuerpo con bastantes caracteres para fijar la mediana", 130),
      bodyLine("Segunda linea de cuerpo con caracteres suficientes tambien", 148),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown).toContain("# Titulo principal");
    expect(markdown).toContain("## Apartado en negrita");
  });

  it("una linea larga en negrita que acaba en punto NO es un titulo", () => {
    const long =
      "Este parrafo va entero en negrita porque el autor queria destacarlo, y termina como una frase normal.";
    const page = makePage([
      makeItem(long, 72, 100, 11, { bold: true, width: 440 }),
      bodyLine("Texto de cuerpo normal con caracteres suficientes aqui", 130),
    ]);
    const { markdown, stats } = buildMarkdown([page], options());

    expect(stats.headings).toBe(0);
    expect(markdown).toContain(long);
  });

  it("un bloque de varias lineas seguidas en negrita NO es una pila de titulos", () => {
    // Caso real detectado con un contrato de verdad: un aviso legal en
    // mayusculas y negrita salia como cinco ### seguidos.
    const page = makePage([
      makeItem("AVISO LEGAL PARA EL CLIENTE", 72, 100, 11, { bold: true }),
      makeItem("SEGUN LA LEY DE CONTRATOS", 72, 118, 11, { bold: true }),
      makeItem("ESTE DOCUMENTO OBLIGA A AMBAS", 72, 136, 11, { bold: true }),
      bodyLine("Texto de cuerpo normal con caracteres suficientes despues", 200),
      bodyLine("y otra linea de cuerpo normal para fijar bien la mediana", 218),
    ]);
    const { stats, markdown } = buildMarkdown([page], options());

    expect(stats.headings).toBe(0);
    expect(markdown).not.toContain("#");
  });

  it("tres lineas grandes seguidas son un bloque destacado, no tres titulos", () => {
    const page = makePage([
      makeItem("PRIMERA LINEA DEL AVISO", 72, 60, 14),
      makeItem("SEGUNDA LINEA DEL AVISO", 72, 82, 14),
      makeItem("TERCERA LINEA DEL AVISO", 72, 104, 14),
      bodyLine("Texto de cuerpo con bastantes caracteres para fijar la mediana", 160),
      bodyLine("y otra linea de cuerpo para que la mediana sea la de siempre", 178),
    ]);
    expect(buildMarkdown([page], options()).stats.headings).toBe(0);
  });

  it("dos titulos grandes seguidos siguen siendo titulos (manda el tamano)", () => {
    const page = makePage([
      makeItem("Titulo en dos lineas", 72, 60, 20),
      makeItem("que sigue igual de grande", 72, 88, 20),
      bodyLine("Texto de cuerpo con bastantes caracteres para fijar la mediana", 130),
      bodyLine("y otra linea de cuerpo para que la mediana sea la de siempre", 148),
    ]);
    expect(buildMarkdown([page], options()).stats.headings).toBe(2);
  });

  it("con detectHeadings desactivado todo sale como parrafo", () => {
    const page = makePage([
      makeItem("Titulo principal", 72, 60, 24),
      bodyLine("Texto de cuerpo con bastantes caracteres para fijar la mediana", 100),
    ]);
    const { markdown, stats } = buildMarkdown(
      [page],
      options({ detectHeadings: false }),
    );

    expect(markdown).not.toContain("#");
    expect(stats.headings).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Parrafos
 * ------------------------------------------------------------------ */

describe("buildMarkdown — parrafos", () => {
  it("une las lineas de un mismo parrafo en una sola linea de Markdown", () => {
    const page = makePage([
      bodyLine("Primera linea del parrafo que llega al margen derecho", 100),
      bodyLine("segunda linea del parrafo que tambien llega al margen", 118),
      makeItem("y un final corto.", 72, 136, 11, { width: 120 }),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown.trim()).toBe(
      "Primera linea del parrafo que llega al margen derecho segunda linea del parrafo que tambien llega al margen y un final corto.",
    );
  });

  it("un salto vertical grande abre un parrafo nuevo", () => {
    const page = makePage([
      bodyLine("Primera linea del parrafo que llega al margen derecho", 100),
      bodyLine("Parrafo distinto despues de un hueco vertical amplio", 200),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown.trim().split("\n\n")).toHaveLength(2);
  });

  it("deshace la particion silabica al unir dos lineas", () => {
    const page = makePage([
      bodyLine("Un texto con una palabra par-", 100),
      bodyLine("tida entre dos lineas del parrafo que llega al margen", 118),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown).toContain("palabra partida entre dos lineas");
  });

  it("una sangria de primera linea abre parrafo aunque el hueco sea normal", () => {
    const page = makePage([
      bodyLine("Primera linea del parrafo que llega al margen derecho", 100),
      makeItem("Parrafo nuevo con sangria de primera linea", 100, 118, 11, {
        width: 400,
      }),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown.trim().split("\n\n")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Listas
 * ------------------------------------------------------------------ */

describe("buildMarkdown — listas", () => {
  it("normaliza vinetas a '- ' y conserva los numeros de las ordenadas", () => {
    const page = makePage([
      makeItem("• primero", 72, 100),
      makeItem("• segundo", 72, 118),
      makeItem("3. tercero", 72, 160),
      makeItem("4. cuarto", 72, 178),
    ]);
    const { markdown, stats } = buildMarkdown([page], options());

    expect(markdown).toContain("- primero\n- segundo");
    expect(markdown).toContain("3. tercero\n4. cuarto");
    expect(stats.listItems).toBe(4);
  });

  it("reconstruye un nivel de anidamiento a partir de la sangria", () => {
    const page = makePage([
      makeItem("• primero", 72, 100),
      makeItem("• anidado", 90, 118),
      makeItem("• vuelta al primer nivel", 72, 136),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown).toContain("- primero\n  - anidado\n- vuelta al primer nivel");
  });

  it("pega la continuacion de un item al item anterior", () => {
    const page = makePage([
      makeItem("• un item que sigue en la", 72, 100),
      makeItem("linea siguiente sangrada", 84, 118),
      makeItem("• otro item", 72, 136),
    ]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown).toContain(
      "- un item que sigue en la linea siguiente sangrada",
    );
    expect(markdown).toContain("- otro item");
  });
});

/* ------------------------------------------------------------------ *
 * Codigo
 * ------------------------------------------------------------------ */

describe("buildMarkdown — bloques de codigo", () => {
  it("encierra en vallas un bloque monoespaciado minoritario y conserva la sangria", () => {
    const items: MarkdownTextItem[] = [];
    for (let index = 0; index < 8; index += 1) {
      items.push(bodyLine(`Linea de texto normal numero ${index} bien larga`, 100 + index * 18));
    }
    items.push(makeItem("function saluda() {", 72, 300, 10, { monospace: true }));
    items.push(makeItem("return 1;", 90, 318, 10, { monospace: true }));
    items.push(makeItem("}", 72, 336, 10, { monospace: true }));

    const { markdown, stats } = buildMarkdown([makePage(items)], options());

    expect(stats.codeBlocks).toBe(1);
    expect(markdown).toContain("```\nfunction saluda() {\n   return 1;\n}\n```");
  });

  it("un documento entero en monoespaciada NO se convierte en un bloque de codigo", () => {
    const page = makePage([
      makeItem("Todo el documento va en Courier porque si", 72, 100, 11, {
        monospace: true,
        width: 440,
      }),
      makeItem("y la segunda linea tambien va en Courier", 72, 118, 11, {
        monospace: true,
        width: 440,
      }),
    ]);
    const { markdown, stats } = buildMarkdown([page], options());

    expect(stats.codeBlocks).toBe(0);
    expect(markdown).not.toContain("```");
  });
});

/* ------------------------------------------------------------------ *
 * Tablas
 * ------------------------------------------------------------------ */

describe("buildMarkdown — tablas", () => {
  const tableItems = () => [
    makeItem("Producto", 72, 100),
    makeItem("Precio", 300, 100),
    makeItem("Camisa", 72, 120),
    makeItem("20", 300, 120),
    makeItem("Pantalon", 72, 140),
    makeItem("35", 300, 140),
  ];

  it("convierte una rejilla regular de tres filas en una tabla GFM", () => {
    const { markdown, stats } = buildMarkdown(
      [makePage(tableItems())],
      options(),
    );

    expect(stats.tables).toBe(1);
    expect(markdown).toContain("| Producto | Precio |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| Camisa | 20 |");
    expect(markdown).toContain("| Pantalon | 35 |");
  });

  it("dos filas no bastan: se quedan como parrafos", () => {
    const page = makePage([
      makeItem("Producto", 72, 100),
      makeItem("Precio", 300, 100),
      makeItem("Camisa", 72, 120),
      makeItem("20", 300, 120),
    ]);
    const { stats, markdown } = buildMarkdown([page], options());

    expect(stats.tables).toBe(0);
    expect(markdown).not.toContain("| --- |");
  });

  it("columnas desalineadas no se dan por tabla", () => {
    const page = makePage([
      makeItem("Producto", 72, 100),
      makeItem("Precio", 300, 100),
      makeItem("Camisa", 72, 120),
      makeItem("20", 420, 120),
      makeItem("Pantalon", 72, 140),
      makeItem("35", 200, 140),
    ]);
    expect(buildMarkdown([page], options()).stats.tables).toBe(0);
  });

  it("con detectTables desactivado la rejilla sale como texto", () => {
    const { markdown, stats } = buildMarkdown(
      [makePage(tableItems())],
      options({ detectTables: false }),
    );

    expect(stats.tables).toBe(0);
    expect(markdown).not.toContain("| --- |");
    expect(markdown).toContain("Producto Precio");
  });

  it("escapa las barras verticales que vienen dentro de una celda", () => {
    const page = makePage([
      makeItem("A|B", 72, 100),
      makeItem("C", 300, 100),
      makeItem("uno", 72, 120),
      makeItem("dos", 300, 120),
      makeItem("tres", 72, 140),
      makeItem("cuatro", 300, 140),
    ]);
    expect(buildMarkdown([page], options()).markdown).toContain("| A\\|B | C |");
  });
});

/* ------------------------------------------------------------------ *
 * Encabezados y pies repetidos
 * ------------------------------------------------------------------ */

describe("findRepeatedLines / buildMarkdown — pies repetidos", () => {
  const withFooter = (number: number) =>
    makePage(
      [
        bodyLine(`Contenido unico de la pagina numero ${number} bien largo`, 300),
        makeItem(`Pagina ${number} de 3`, 250, 750),
      ],
      { pageNumber: number },
    );

  it("detecta la linea que se repite en la franja inferior de casi todas las paginas", () => {
    const pages = [withFooter(1), withFooter(2), withFooter(3)];
    const lines = pages.map((page) => buildLines(page));
    const repeated = findRepeatedLines(pages, lines);

    expect(repeated.has("pagina # de #")).toBe(true);
  });

  it("no busca repeticiones con menos de tres paginas", () => {
    const pages = [withFooter(1), withFooter(2)];
    const lines = pages.map((page) => buildLines(page));

    expect(findRepeatedLines(pages, lines).size).toBe(0);
  });

  it("el pie repetido desaparece del Markdown y el contenido no", () => {
    const pages = [withFooter(1), withFooter(2), withFooter(3)];
    const { markdown } = buildMarkdown(pages, options());

    expect(markdown).not.toContain("Pagina 1 de 3");
    expect(markdown).toContain("Contenido unico de la pagina numero 2");
  });

  it("con stripRepeated desactivado el pie se conserva", () => {
    const pages = [withFooter(1), withFooter(2), withFooter(3)];
    const { markdown } = buildMarkdown(pages, options({ stripRepeated: false }));

    expect(markdown).toContain("Pagina 1 de 3");
  });
});

/* ------------------------------------------------------------------ *
 * Paginas, OCR y estadisticas
 * ------------------------------------------------------------------ */

describe("buildMarkdown — paginas, OCR y estadisticas", () => {
  it("una pagina de OCR se emite como parrafos planos", () => {
    const page = makePage([], {
      source: "ocr",
      ocrText: "Primera linea\nsegunda linea\n\nOtro parrafo distinto",
    });
    const { markdown, stats } = buildMarkdown([page], options());

    expect(markdown).toContain("Primera linea segunda linea");
    expect(markdown).toContain("Otro parrafo distinto");
    expect(stats.ocrPages).toBe(1);
    expect(stats.textPages).toBe(0);
  });

  it("las paginas sin texto se cuentan y no aportan nada al documento", () => {
    const pages = [
      makePage([bodyLine("Pagina con texto de verdad y caracteres bastantes", 100)]),
      makePage([], { source: "empty", pageNumber: 2 }),
    ];
    const { markdown, stats } = buildMarkdown(pages, options());

    expect(stats.emptyPages).toBe(1);
    expect(stats.textPages).toBe(1);
    expect(markdown.trim().split("\n\n")).toHaveLength(1);
  });

  it("pageSeparators mete una regla horizontal entre paginas", () => {
    const pages = [
      makePage([bodyLine("Contenido de la primera pagina con caracteres", 100)]),
      makePage([bodyLine("Contenido de la segunda pagina con caracteres", 100)], {
        pageNumber: 2,
      }),
    ];

    expect(
      buildMarkdown(pages, options({ pageSeparators: true })).markdown,
    ).toContain("\n\n---\n\n");
    expect(
      buildMarkdown(pages, options({ pageSeparators: false })).markdown,
    ).not.toContain("---");
  });

  it("documento vacio -> Markdown vacio y estadisticas a cero", () => {
    const { markdown, stats } = buildMarkdown([], options());

    expect(markdown.trim()).toBe("");
    expect(stats.pages).toBe(0);
    expect(stats.headings).toBe(0);
  });

  it("las estadisticas cuadran con lo emitido", () => {
    const page = makePage([
      makeItem("Titulo", 72, 60, 22),
      bodyLine("Un parrafo de cuerpo con caracteres suficientes para todo", 100),
      makeItem("• uno", 72, 140),
      makeItem("• dos", 72, 158),
    ]);
    const { markdown, stats } = buildMarkdown([page], options());

    expect(stats.pages).toBe(1);
    expect(stats.textPages).toBe(1);
    expect(stats.headings).toBe(1);
    expect(stats.listItems).toBe(2);
    expect(stats.characters).toBe(markdown.length);
  });

  it("el Markdown termina siempre en un unico salto de linea", () => {
    const page = makePage([bodyLine("Una sola linea de contenido en la pagina", 100)]);
    const { markdown } = buildMarkdown([page], options());

    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Golden byte a byte: fixture combinado, regresion del refactor de
 * `pageBlocks`/`buildMarkdown` a bloques estructurados (`DocBlock[]`)
 * ------------------------------------------------------------------ */

/**
 * Fixture combinado: titulo, lista mixta anidada (ordenada + no ordenada),
 * tabla de 3 columnas x 3 filas, bloque de codigo con indentacion,
 * parrafo con caracteres especiales de Markdown (`#`, `*`, `|`, numero
 * seguido de punto al inicio de linea), una pagina `source: "ocr"` y
 * varias paginas.
 *
 * El Markdown que produce se capturo con `buildMarkdown` ANTES del
 * refactor que separo la construccion de bloques (`pageBlocks`,
 * `ocrBlocks`) de su renderizado (`renderBlockToMarkdown`). El test de
 * mas abajo compara ese string capturado, byte a byte, contra lo que
 * produce el `buildMarkdown` YA refactorizado: es el gate de regresion
 * mas importante del refactor, asi que si algo lo rompe es un bug real
 * del refactor, no un fixture que haya que "ajustar".
 */
function buildGoldenFixture(): MarkdownPage[] {
  const page1 = makePage(
    [
      makeItem("Titulo del documento", 72, 60, 22),
      bodyLine(
        "Parrafo de cuerpo con caracteres suficientes para fijar la mediana del documento",
        100,
      ),
      bodyLine(
        "segunda linea del mismo parrafo que tambien llega al margen derecho",
        118,
      ),
      makeItem(
        "# no es titulo * ni enfasis | ni celda 1. tampoco es lista",
        72,
        160,
        11,
        { width: 440 },
      ),
      // Lista mixta: ordenada y no ordenada, con un nivel anidado.
      makeItem("1. primero", 72, 200),
      makeItem("2. segundo", 72, 218),
      makeItem("• anidado bajo el segundo", 90, 236),
      makeItem("• vuelta a nivel base", 72, 254),
      // Tabla de 3 columnas x 3 filas (cabecera + 2).
      makeItem("Producto", 72, 300),
      makeItem("Cantidad", 260, 300),
      makeItem("Precio", 440, 300),
      makeItem("Camisa", 72, 320),
      makeItem("2", 260, 320),
      makeItem("20", 440, 320),
      makeItem("Pantalon", 72, 340),
      makeItem("1", 260, 340),
      makeItem("35", 440, 340),
      // Bloque de codigo con indentacion.
      makeItem("function saluda() {", 72, 420, 10, { monospace: true }),
      makeItem("return 1;", 90, 438, 10, { monospace: true }),
      makeItem("}", 72, 456, 10, { monospace: true }),
    ],
    { pageNumber: 1 },
  );

  const page2 = makePage([], {
    pageNumber: 2,
    source: "ocr",
    ocrText:
      "Primera linea de OCR\nsegunda linea de OCR\n\nOtro parrafo de OCR distinto",
  });

  const page3 = makePage(
    [
      bodyLine(
        "Tercera pagina con contenido normal y caracteres suficientes para el parrafo",
        100,
      ),
    ],
    { pageNumber: 3 },
  );

  return [page1, page2, page3];
}

/** Capturado con el `buildMarkdown` ANTERIOR al refactor a `DocBlock[]`. */
const GOLDEN_MARKDOWN =
  "# Titulo del documento\n\nParrafo de cuerpo con caracteres suficientes para fijar la mediana del documento segunda linea del mismo parrafo que tambien llega al margen derecho\n\n\\# no es titulo * ni enfasis | ni celda 1. tampoco es lista\n\n1. primero\n2. segundo\n  - anidado bajo el segundo\n- vuelta a nivel base\n\n| Producto | Cantidad | Precio |\n| --- | --- | --- |\n| Camisa | 2 | 20 |\n| Pantalon | 1 | 35 |\n\n```\nfunction saluda() {\n   return 1;\n}\n```\n\nPrimera linea de OCR segunda linea de OCR\n\nOtro parrafo de OCR distinto\n\nTercera pagina con contenido normal y caracteres suficientes para el parrafo\n";

describe("buildMarkdown — golden byte a byte (fixture combinado)", () => {
  it("reproduce EXACTAMENTE el Markdown capturado antes del refactor a bloques estructurados", () => {
    const { markdown } = buildMarkdown(buildGoldenFixture(), options());
    expect(markdown).toBe(GOLDEN_MARKDOWN);
  });
});

/* ------------------------------------------------------------------ *
 * buildDocument — bloques estructurados (DocBlock[])
 * ------------------------------------------------------------------ */

describe("buildDocument — src/lib/pdf/pdfToMarkdown.ts", () => {
  it("sobre el fixture combinado produce la misma secuencia de tipos que renderiza buildMarkdown, con un pageBreak entre cada par de paginas con contenido", () => {
    const { blocks, stats } = buildDocument(buildGoldenFixture(), options());

    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "list",
      "table",
      "codeBlock",
      "pageBreak",
      "paragraph",
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
    expect(stats.headings).toBe(1);
    expect(stats.tables).toBe(1);
    expect(stats.codeBlocks).toBe(1);
    expect(stats.listItems).toBe(4);
    expect(stats.textPages).toBe(2);
    expect(stats.ocrPages).toBe(1);
  });

  it("heading conserva el texto crudo (sin escapar) y el nivel calculado", () => {
    const page = makePage([
      makeItem("# Titulo con caracter de Markdown", 72, 60, 22),
      bodyLine(
        "Texto de cuerpo con caracteres suficientes para fijar la mediana",
        100,
      ),
    ]);
    const { blocks } = buildDocument([page], options());

    expect(blocks.find((block) => block.type === "heading")).toEqual({
      type: "heading",
      level: 1,
      text: "# Titulo con caracter de Markdown",
    });
  });

  it("paragraph.bold es true solo si TODAS las lineas unidas son negrita", () => {
    const page = makePage([
      makeItem("Primera linea en negrita que continua,", 72, 100, 11, {
        bold: true,
        width: 440,
      }),
      makeItem(
        "segunda linea tambien en negrita que cierra el parrafo entero",
        72,
        118,
        11,
        { bold: true, width: 440 },
      ),
    ]);
    const { blocks } = buildDocument([page], options());

    expect(blocks.find((block) => block.type === "paragraph")).toMatchObject({
      bold: true,
    });
  });

  it("un parrafo formado por una linea en negrita y una que no lo es da bold=false (AND conservador)", () => {
    const page = makePage([
      makeItem("Primera linea en negrita que continua,", 72, 100, 11, {
        bold: true,
        width: 440,
      }),
      bodyLine(
        "segunda linea sin negrita que cierra el mismo parrafo entero",
        118,
      ),
    ]);
    const { blocks } = buildDocument([page], options());
    const paragraphs = blocks.filter((block) => block.type === "paragraph");

    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toMatchObject({ bold: false });
  });

  it("table.rows son celdas crudas, sin escapar el caracter de barra vertical", () => {
    const page = makePage([
      makeItem("A|B", 72, 100),
      makeItem("C", 300, 100),
      makeItem("uno", 72, 120),
      makeItem("dos", 300, 120),
      makeItem("tres", 72, 140),
      makeItem("cuatro", 300, 140),
    ]);
    const { blocks } = buildDocument([page], options());

    expect(blocks.find((block) => block.type === "table")).toEqual({
      type: "table",
      rows: [
        ["A|B", "C"],
        ["uno", "dos"],
        ["tres", "cuatro"],
      ],
    });
  });

  it("codeBlock.lines conserva la sangria de espacios calculada para el bloque", () => {
    const items: MarkdownTextItem[] = [];
    for (let index = 0; index < 8; index += 1) {
      items.push(
        bodyLine(`Linea de texto normal numero ${index} bien larga`, 100 + index * 18),
      );
    }
    items.push(makeItem("function saluda() {", 72, 300, 10, { monospace: true }));
    items.push(makeItem("return 1;", 90, 318, 10, { monospace: true }));
    items.push(makeItem("}", 72, 336, 10, { monospace: true }));

    const { blocks } = buildDocument([makePage(items)], options());

    expect(blocks.find((block) => block.type === "codeBlock")).toEqual({
      type: "codeBlock",
      lines: ["function saluda() {", "   return 1;", "}"],
    });
  });

  it("un pageBreak seguido inmediatamente de una tabla es un bloque independiente, no una propiedad de otro bloque", () => {
    const pages = [
      makePage(
        [bodyLine("Contenido de la primera pagina con caracteres suficientes", 100)],
        { pageNumber: 1 },
      ),
      makePage(
        [
          makeItem("Producto", 72, 100),
          makeItem("Precio", 300, 100),
          makeItem("Camisa", 72, 120),
          makeItem("20", 300, 120),
          makeItem("Pantalon", 72, 140),
          makeItem("35", 300, 140),
        ],
        { pageNumber: 2 },
      ),
    ];
    const { blocks } = buildDocument(pages, options());

    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "pageBreak",
      "table",
    ]);
    expect(blocks[1]).toEqual({ type: "pageBreak" });
  });

  it("dos paginas vacias consecutivas no insertan pageBreak espurios entre ellas", () => {
    const pages = [
      makePage(
        [bodyLine("Contenido de la primera pagina con caracteres suficientes", 100)],
        { pageNumber: 1 },
      ),
      makePage([], { pageNumber: 2, source: "empty" }),
      makePage([], { pageNumber: 3, source: "empty" }),
      makePage(
        [bodyLine("Contenido de la ultima pagina con caracteres suficientes", 100)],
        { pageNumber: 4 },
      ),
    ];
    const { blocks, stats } = buildDocument(pages, options());

    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
    expect(stats.emptyPages).toBe(2);
  });

  it("una corrida de lista con niveles y ordenes mixtos forma un solo bloque; una corrida adyacente distinta forma el suyo propio", () => {
    const page = makePage([
      makeItem("1. primero", 72, 100),
      makeItem("• anidado", 90, 118),
      makeItem("2. segundo", 72, 136),
      bodyLine(
        "Parrafo que separa las dos corridas de lista con caracteres suficientes",
        250,
      ),
      makeItem("• otro primero", 72, 300),
      makeItem("• otro anidado", 90, 318),
    ]);
    const { blocks } = buildDocument([page], options());

    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph", "list"]);

    const [firstList, , secondList] = blocks;
    if (firstList.type !== "list" || secondList.type !== "list") {
      throw new Error("se esperaban bloques de lista");
    }

    expect(firstList.items).toEqual([
      { level: 0, ordered: true, number: 1, text: "primero" },
      { level: 1, ordered: false, number: 0, text: "anidado" },
      { level: 0, ordered: true, number: 2, text: "segundo" },
    ]);
    expect(secondList.items).toEqual([
      { level: 0, ordered: false, number: 0, text: "otro primero" },
      { level: 1, ordered: false, number: 0, text: "otro anidado" },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * extractMarkdownPages — reserva de OCR (pdf.js y tesseract.js
 * sustituidos, ver cabecera del archivo)
 * ------------------------------------------------------------------ */

type FakePdfPage = {
  getViewport: (opts: {
    scale: number;
  }) => { width: number; height: number; transform: number[] };
  getTextContent: () => Promise<{
    items: unknown[];
    styles?: Record<string, unknown>;
  }>;
  cleanup: ReturnType<typeof vi.fn>;
  commonObjs: { has: (name: string) => boolean };
};

type FakePdfDocument = {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  loadingTask: { destroy: ReturnType<typeof vi.fn> };
};

/** Pagina con `chars` caracteres de texto real (0 fuerza el camino OCR). */
function makeFakePdfPage(chars: number): FakePdfPage {
  const items =
    chars > 0
      ? [
          {
            str: "x".repeat(chars),
            width: chars * 6,
            height: 12,
            transform: [12, 0, 0, -12, 72, 700],
            fontName: "F1",
          },
        ]
      : [];
  return {
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({ items, styles: {} }),
    cleanup: vi.fn(),
    commonObjs: { has: () => false },
  };
}

function makeFakePdfDocument(pages: FakePdfPage[]): FakePdfDocument {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => pages[number - 1]),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

type FakeTesseractWorker = {
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function makeFakeWorker(text: string): FakeTesseractWorker {
  return {
    recognize: vi.fn(async () => ({ data: { text } })),
    terminate: vi.fn(async () => {}),
  };
}

const openPdfDocumentMock = vi.mocked(core.openPdfDocument);
const renderPageToCanvasMock = vi.mocked(core.renderPageToCanvas);
const closePdfDocumentMock = vi.mocked(core.closePdfDocument);

async function getCreateWorkerMock() {
  const tesseract = await import("tesseract.js");
  return vi.mocked(tesseract.createWorker);
}

describe("extractMarkdownPages — reserva de OCR (pdf.js/tesseract.js sustituidos)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    renderPageToCanvasMock.mockImplementation(
      async () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement,
    );
  });

  it("pagina con poco texto y OCR activado: la pagina sale como 'ocr' con el texto reconocido", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    const worker = makeFakeWorker("Texto reconocido por OCR.");
    createWorkerMock.mockResolvedValueOnce(worker as never);

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages).toHaveLength(1);
    expect(pages[0].source).toBe("ocr");
    expect(pages[0].ocrText).toBe("Texto reconocido por OCR.");
    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);
  });

  it("con ocrFallback desactivado, una pagina sin texto sale como 'empty' y no se crea worker", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();

    const pages = await extractMarkdownPages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
      ocrFallback: false,
    });

    expect(pages[0].source).toBe("empty");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("un fallo transitorio al crear el worker se reintenta una vez y la pagina se resuelve normalmente", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    const worker = makeFakeWorker("Reconocido tras reintentar.");
    createWorkerMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(worker as never);

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(pages[0].source).toBe("ocr");
    expect(pages[0].ocrText).toBe("Reconocido tras reintentar.");
  });

  it("si el worker falla tambien al reintentar, la pagina se marca 'ocrFailed' con el aviso y el documento sigue con las demas paginas", async () => {
    const failingPage = makeFakePdfPage(0);
    const okPage = makeFakePdfPage(0);
    const document = makeFakePdfDocument([failingPage, okPage]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    const workerForSecondPage = makeFakeWorker("Segunda pagina reconocida.");
    createWorkerMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(workerForSecondPage as never);

    const pages = await extractMarkdownPages(
      new Blob(["pdf"]),
      DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
      undefined,
      undefined,
      "[marcador de fallo de OCR]",
    );

    expect(pages).toHaveLength(2);
    expect(pages[0].source).toBe("ocrFailed");
    expect(pages[0].ocrText).toBe("[marcador de fallo de OCR]");
    // La segunda pagina consigue su propio worker desde cero: el fallo de
    // la primera no tira abajo el resto del documento.
    expect(pages[1].source).toBe("ocr");
    expect(pages[1].ocrText).toBe("Segunda pagina reconocida.");
  });

  it("un fallo de reconocimiento (worker ya creado) tambien se aisla por pagina", async () => {
    // Segunda pagina con texto real: sin ella, un documento de UNA sola
    // pagina que falla por completo dispararia el escalado a error total
    // (ver el test de "si NINGUNA pagina logra resolverse..." mas abajo),
    // que es el comportamiento correcto pero no lo que este test quiere
    // observar (el aislamiento por pagina en si).
    const document = makeFakePdfDocument([makeFakePdfPage(0), makeFakePdfPage(50)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    const worker = {
      recognize: vi
        .fn()
        .mockRejectedValueOnce(new Error("RuntimeError: unreachable")),
      terminate: vi.fn(async () => {}),
    };
    createWorkerMock.mockResolvedValueOnce(worker as never);

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("ocrFailed");
    // El worker roto se descarta (se intenta terminar) en vez de
    // reutilizarse para la siguiente pagina.
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("si NINGUNA pagina logra resolverse por OCR, se lanza un PdfError con el codigo clasificado (no 'unknown')", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(extractMarkdownPages(new Blob(["pdf"]))).rejects.toMatchObject(
      { code: "ocrNetworkFailure" },
    );
    // Aun asi se cierra el documento: el fallo no deja recursos colgando.
    expect(closePdfDocumentMock).toHaveBeenCalledWith(document);
  });

  it("un error de motor (no de red) al fallar toda la reserva de OCR se clasifica como 'ocrEngineFailure'", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockRejectedValue(
      new Error("RuntimeError: memory access out of bounds"),
    );

    await expect(extractMarkdownPages(new Blob(["pdf"]))).rejects.toMatchObject(
      { code: "ocrEngineFailure" },
    );
  });

  it("si al menos una pagina de texto normal tiene contenido, un fallo de OCR en otra pagina NO aborta el documento", async () => {
    const textPage = makeFakePdfPage(50); // >= MIN_CHARS_FOR_TEXT_PAGE
    const scannedPage = makeFakePdfPage(0);
    const document = makeFakePdfDocument([textPage, scannedPage]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("text");
    expect(pages[1].source).toBe("ocrFailed");
  });

  it("DEFAULT_OCR_FAILURE_MARKER se usa cuando no se pasa un texto propio", async () => {
    // Segunda pagina con texto real: el documento no lanza (hay contenido
    // real en alguna parte), asi que se puede inspeccionar el marcador
    // por defecto que recibio la primera pagina (la que fallo).
    const document = makeFakePdfDocument([makeFakePdfPage(0), makeFakePdfPage(50)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const pages = await extractMarkdownPages(new Blob(["pdf"]));
    expect(pages[0].source).toBe("ocrFailed");
    expect(pages[0].ocrText).toBe(DEFAULT_OCR_FAILURE_MARKER);
  });
});

/* ------------------------------------------------------------------ *
 * Texto real corto vs. pagina escaneada (W6-D)
 * ------------------------------------------------------------------ */

/** Pagina con `text` de verdad y, si se pide, una imagen que cubre `coverage` de la pagina. */
function makeTextPage(text: string, coverage = 0): FakePdfPage & { getOperatorList: () => Promise<unknown> } {
  const page = makeFakePdfPage(0);
  const items = [
    { str: text, width: text.length * 6, height: 12, transform: [12, 0, 0, -12, 72, 700], fontName: "F1" },
  ];
  const side = Math.sqrt(coverage * 612 * 792);
  return {
    ...page,
    getTextContent: async () => ({ items, styles: {} }),
    getOperatorList: async () => ({
      fnArray: coverage > 0 ? [FAKE_OPS.save, FAKE_OPS.transform, FAKE_OPS.paintImageXObject, FAKE_OPS.restore] : [],
      argsArray: coverage > 0 ? [null, [side, 0, 0, side, 0, 0], ["img", 10, 10], null] : [],
    }),
  };
}

describe("extractMarkdownPages — texto real corto: no se descarta por OCR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    renderPageToCanvasMock.mockImplementation(
      async () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement,
    );
  });

  it("una pagina con «Fin del texto» (13 caracteres, sin imagen) sale como 'text' y NO se lanza el OCR", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeTextPage("Fin del texto")]) as never);
    const createWorkerMock = await getCreateWorkerMock();

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("text");
    expect(pages[0].items.map((item) => item.text)).toEqual(["Fin del texto"]);
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("una pagina con poco texto que es casi toda una imagen (escaneo con un numero de pagina) SI se reconoce", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeTextPage("12", 0.9)]) as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockResolvedValueOnce(makeFakeWorker("Contenido del escaneo.") as never);

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("ocr");
    expect(pages[0].ocrText).toBe("Contenido del escaneo.");
  });

  // Regresion (W6-D): un «&» solo se sustituia por la lectura del OCR («8»).
  it("paginas con un unico caracter legible («&», «é», «—», «1») conservan ese texto aunque el OCR este activado", async () => {
    for (const text of ["&", "é", "—", "1", "Fin."]) {
      vi.clearAllMocks();
      openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeTextPage(text)]) as never);
      const createWorkerMock = await getCreateWorkerMock();

      const pages = await extractMarkdownPages(new Blob(["pdf"]));

      expect(pages[0].source, text).toBe("text");
      expect(pages[0].items.map((item) => item.text), text).toEqual([text]);
      expect(createWorkerMock, text).not.toHaveBeenCalled();
    }
  });

  it("poco texto real con una imagen pequena (un logo) se queda como texto", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeTextPage("Portada", 0.05)]) as never);
    const createWorkerMock = await getCreateWorkerMock();

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("text");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("si el OCR no puede ejecutarse en una pagina-imagen con algo de texto, se conserva ese texto (no el aviso de fallo)", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeTextPage("Anexo 3", 0.9)]) as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const pages = await extractMarkdownPages(new Blob(["pdf"]));

    expect(pages[0].source).toBe("text");
    expect(pages[0].items.map((item) => item.text)).toEqual(["Anexo 3"]);
  });
});

describe("extractMarkdownPages — sin red el OCR no cuelga la conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    renderPageToCanvasMock.mockImplementation(
      async () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement,
    );
  });

  it("un motor que no responde falla a los 20 s con ocrNetworkFailure (antes: esperaba para siempre)", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeFakePdfPage(0)]) as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockImplementation(() => new Promise(() => {}));

    const attempt = extractMarkdownPages(new Blob(["pdf"]));
    const outcome = attempt.then(
      () => "ok",
      (error: { code?: string }) => error.code,
    );
    await vi.advanceTimersByTimeAsync(19_000);
    // Aun dentro del margen: sigue esperando.
    expect(await Promise.race([outcome, Promise.resolve("pendiente")])).toBe("pendiente");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe("ocrNetworkFailure");
    // Un motor sin respuesta no se reintenta (ya se espero) ni se vuelve a esperar por cada pagina.
    expect(createWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("con varias paginas-imagen y un motor mudo solo se espera UNA vez; las paginas de texto salen intactas", async () => {
    const document = makeFakePdfDocument([makeFakePdfPage(60), makeFakePdfPage(0), makeFakePdfPage(0), makeFakePdfPage(0)]);
    openPdfDocumentMock.mockResolvedValueOnce(document as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockImplementation(() => new Promise(() => {}));

    const result = extractMarkdownPages(new Blob(["pdf"]));
    await vi.advanceTimersByTimeAsync(21_000);
    const pages = await result;

    expect(pages.map((page) => page.source)).toEqual(["text", "ocrFailed", "ocrFailed", "ocrFailed"]);
    expect(createWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("cancelar durante la espera del motor corta al instante con 'cancelled'", async () => {
    openPdfDocumentMock.mockResolvedValueOnce(makeFakePdfDocument([makeFakePdfPage(0)]) as never);
    const createWorkerMock = await getCreateWorkerMock();
    createWorkerMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const outcome = extractMarkdownPages(new Blob(["pdf"]), DEFAULT_PDF_TO_MARKDOWN_OPTIONS, undefined, controller.signal).then(
      () => "ok",
      (error: { code?: string }) => error.code,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe("cancelled");
  });
});
