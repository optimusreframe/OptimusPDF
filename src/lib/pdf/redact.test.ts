import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  DEFAULT_REDACT_OPTIONS,
  ERASER_RADIUS,
  MIN_BOX_SIDE,
  MIN_STROKE_POINTS,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  elementHitTest,
  redactPdf,
  sanitizeBox,
  sanitizeElement,
  sanitizeStroke,
  strokeBounds,
  type RedactElement,
  type RedactRectElement,
  type RedactStrokeElement,
} from "@/lib/pdf/redact";
import { PdfError } from "@/lib/pdf/core";

/**
 * LIMITACION DE ENTORNO (leer antes de tocar este archivo):
 *
 * `redactPdf` aplana la pagina censurada rasterizandola con pdf.js
 * (`openPdfDocument` + `renderPageToCanvas`, via `@/lib/pdf/core`), lo que
 * exige `DOMMatrix` y un `document.createElement("canvas")` reales. Este
 * proyecto ejecuta Vitest con `environment: "node"` (ver `vitest.config.ts`)
 * y SIN `jsdom`/`canvas` (paquete npm) instalados para el proyecto
 * "engines" (la separacion es intencional: ver la cabecera de
 * `vitest.config.ts`).
 *
 * Re-verificado en este pase de trabajo con un probe dedicado (llamada
 * real a `redactPdf` con un trazo a mano alzada en modo "blur" sobre un
 * PDF con texto real): la propia apertura de pdf.js sigue lanzando
 * `ReferenceError: DOMMatrix is not defined` (capturado y reempaquetado
 * como `PdfError("unknown", ...)` por `toPdfError`), exactamente como ya
 * documentaban `core.test.ts`, `compare.test.ts` y `compress.test.ts`. Es
 * decir: NINGUNA llamada a `redactPdf` que llegue a rasterizar una pagina
 * puede ejecutarse aqui, ni en exito ni en fallo con codigo significativo
 * -- para NINGUNO de los 4 modos (negro/difuminado/pixelado/pintura), ni
 * para rectangulos ni para trazos.
 *
 * Por eso esta suite se limita a lo que SI es verificable sin pdf.js/DOM:
 * 1) las funciones puras exportadas -- `sanitizeBox`, `sanitizeStroke`,
 *    `sanitizeElement`, `strokeBounds`, `elementHitTest` -- con sus casos
 *    de recorte/descarte, incluyendo los nuevos para el modelo de trazos;
 * 2) las rutas de error de `redactPdf` que ocurren ANTES de tocar pdf.js
 *    (censura vacia, archivo corrupto/vacio), para rectangulos Y trazos;
 * 3) un test de REQUISITO DE SEGURIDAD (ver mas abajo) que documenta de
 *    forma verificable -- no simulada -- por que la asercion central del
 *    plan ("un trazo a mano alzada en modo blur/pixelado sobre texto
 *    conocido, horneado y luego con el texto extraido del PDF de salida,
 *    debe confirmar que el texto desaparecio") no puede ejecutarse en
 *    esta suite, y senala donde SI existe ya una prueba equivalente que
 *    funciona de verdad para el caso rectangulo+negro.
 *
 * La propiedad de seguridad central del motor -- que el efecto (negro,
 * difuminado, pixelado o pintura) se calcule EXCLUSIVAMENTE sobre el
 * mapa de bits ya rasterizado, sin dejar el texto/pixeles originales
 * recuperables en la pagina de salida -- requiere renderizar la pagina de
 * verdad (pdf.js + canvas 2D) y no se puede comprobar en este entorno sin
 * anadir `jsdom` + el paquete `canvas` (o un shim equivalente) como
 * devDependency y/o tocar `vitest.config.ts`, cambios que exceden el
 * alcance de este workstream (archivos asignados: `redact.ts`,
 * `RedactCanvas.tsx`, `RedactToolClient.tsx`, `strings.ts`,
 * `redact.test.ts`). Se reporta como bloqueador en vez de simularlo con
 * mocks de la propia rasterizacion, que darian una falsa sensacion de
 * cobertura de la propiedad de seguridad sin comprobarla de verdad.
 */

async function createDocument(pageCount = 1): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([300, 300]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "test.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

function box(overrides: Partial<RedactRectElement> = {}): RedactRectElement {
  return {
    id: "b1",
    kind: "rect",
    pageIndex: 0,
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    mode: "black",
    ...overrides,
  };
}

function stroke(overrides: Partial<RedactStrokeElement> = {}): RedactStrokeElement {
  return {
    id: "s1",
    kind: "stroke",
    pageIndex: 0,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.15 },
      { x: 0.3, y: 0.1 },
    ],
    strokeWidth: 0.02,
    mode: "black",
    ...overrides,
  };
}

describe("sanitizeBox — src/lib/pdf/redact.ts", () => {
  it("deja intacta una caja ya normalizada dentro de la pagina", () => {
    const input = box({ x: 0.2, y: 0.3, width: 0.1, height: 0.15 });
    expect(sanitizeBox(input)).toEqual(input);
  });

  it("recorta al limite derecho/inferior de la pagina (0..1) cuando la caja se sale", () => {
    const result = sanitizeBox(box({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(0.9);
    expect(result!.y).toBeCloseTo(0.9);
    expect(result!.width).toBeCloseTo(0.1);
    expect(result!.height).toBeCloseTo(0.1);
  });

  it("recorta coordenadas negativas a 0", () => {
    const result = sanitizeBox(box({ x: -0.5, y: -0.2, width: 0.3, height: 0.3 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  it("normaliza ancho/alto negativos (esquina invertida) sin perder el area", () => {
    // x=0.5, width=-0.2 equivale a un rectangulo que va de 0.3 a 0.5.
    const result = sanitizeBox(box({ x: 0.5, y: 0.5, width: -0.2, height: -0.2 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(0.3);
    expect(result!.y).toBeCloseTo(0.3);
    expect(result!.width).toBeCloseTo(0.2);
    expect(result!.height).toBeCloseTo(0.2);
  });

  it("descarta (null) una caja mas angosta que MIN_BOX_SIDE", () => {
    expect(sanitizeBox(box({ width: MIN_BOX_SIDE / 2 }))).toBeNull();
  });

  it("descarta (null) una caja mas baja que MIN_BOX_SIDE", () => {
    expect(sanitizeBox(box({ height: MIN_BOX_SIDE / 2 }))).toBeNull();
  });

  it("descarta (null) una caja de ancho/alto cero", () => {
    expect(sanitizeBox(box({ width: 0, height: 0 }))).toBeNull();
  });

  it("conserva el pageIndex y el id originales", () => {
    const result = sanitizeBox(box({ id: "custom-id", pageIndex: 7 }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("custom-id");
    expect(result!.pageIndex).toBe(7);
  });

  it("una caja exactamente del tamano de la pagina completa (0,0,1,1) sobrevive", () => {
    const result = sanitizeBox(box({ x: 0, y: 0, width: 1, height: 1 }));
    expect(result).toEqual({
      id: "b1",
      kind: "rect",
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      mode: "black",
    });
  });

  it("conserva mode y color (modo pintura)", () => {
    const input = box({ mode: "paint", color: "#ff00ff" });
    expect(sanitizeBox(input)).toEqual(input);
  });
});

describe("sanitizeStroke — src/lib/pdf/redact.ts", () => {
  it("deja intacto un trazo con puntos ya dentro de la pagina", () => {
    const input = stroke();
    expect(sanitizeStroke(input)).toEqual(input);
  });

  it("recorta cada punto a 0..1", () => {
    const result = sanitizeStroke(
      stroke({
        points: [
          { x: -0.5, y: 1.5 },
          { x: 0.5, y: 0.5 },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.points[0]).toEqual({ x: 0, y: 1 });
    expect(result!.points[1]).toEqual({ x: 0.5, y: 0.5 });
  });

  it("descarta puntos no finitos (NaN/Infinity) antes de contar el minimo", () => {
    const result = sanitizeStroke(
      stroke({
        points: [
          { x: Number.NaN, y: 0.5 },
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ],
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.points).toHaveLength(2);
  });

  it(`descarta (null) un trazo con menos de MIN_STROKE_POINTS (${MIN_STROKE_POINTS}) puntos validos`, () => {
    expect(sanitizeStroke(stroke({ points: [{ x: 0.1, y: 0.1 }] }))).toBeNull();
    expect(sanitizeStroke(stroke({ points: [] }))).toBeNull();
  });

  it(`recorta strokeWidth a [MIN_STROKE_WIDTH, MAX_STROKE_WIDTH] = [${MIN_STROKE_WIDTH}, ${MAX_STROKE_WIDTH}]`, () => {
    expect(sanitizeStroke(stroke({ strokeWidth: 0 }))!.strokeWidth).toBe(MIN_STROKE_WIDTH);
    expect(sanitizeStroke(stroke({ strokeWidth: 999 }))!.strokeWidth).toBe(MAX_STROKE_WIDTH);
  });

  it("strokeWidth no finito cae al valor por defecto documentado", () => {
    const result = sanitizeStroke(stroke({ strokeWidth: Number.NaN }));
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.strokeWidth)).toBe(true);
  });

  it("conserva mode y color (modo pintura)", () => {
    const input = stroke({ mode: "paint", color: "#00ff00" });
    expect(sanitizeStroke(input)).toEqual(input);
  });
});

describe("sanitizeElement — src/lib/pdf/redact.ts", () => {
  it("despacha por 'kind' a sanitizeBox para rectangulos", () => {
    const input: RedactElement = box({ x: 2, y: 2 }); // fuera de pagina -> null
    expect(sanitizeElement(input)).toBeNull();
  });

  it("despacha por 'kind' a sanitizeStroke para trazos", () => {
    const input: RedactElement = stroke({ points: [{ x: 0.1, y: 0.1 }] }); // 1 solo punto -> null
    expect(sanitizeElement(input)).toBeNull();
  });
});

describe("strokeBounds — src/lib/pdf/redact.ts", () => {
  it("calcula la caja delimitadora de los puntos, inflada por el grosor/2", () => {
    const result = strokeBounds({
      points: [
        { x: 0.2, y: 0.3 },
        { x: 0.4, y: 0.1 },
      ],
      strokeWidth: 0.02,
    });
    expect(result.x).toBeCloseTo(0.19);
    expect(result.y).toBeCloseTo(0.09);
    expect(result.width).toBeCloseTo(0.22);
    expect(result.height).toBeCloseTo(0.22);
  });

  it("recorta la caja inflada a los limites de la pagina", () => {
    const result = strokeBounds({
      points: [{ x: 0.005, y: 0.995 }],
      strokeWidth: 0.02,
    });
    expect(result.x).toBe(0);
    expect(result.y).toBeCloseTo(0.985);
    expect(result.y + result.height).toBeLessThanOrEqual(1);
  });

  it("arreglo de puntos vacio da una caja degenerada en el origen", () => {
    expect(strokeBounds({ points: [], strokeWidth: 0.02 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("elementHitTest — src/lib/pdf/redact.ts", () => {
  it("un punto dentro de un rectangulo lo toca", () => {
    const rect = box({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
    expect(elementHitTest(rect, { x: 0.3, y: 0.3 }, ERASER_RADIUS)).toBe(true);
  });

  it("un punto lejos de un rectangulo (mas alla del radio) no lo toca", () => {
    const rect = box({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
    expect(elementHitTest(rect, { x: 0.9, y: 0.9 }, ERASER_RADIUS)).toBe(false);
  });

  it("un punto justo fuera del rectangulo pero dentro del radio SI lo toca", () => {
    const rect = box({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 });
    // Borde derecho en x=0.4; a 0.4 + radio/2 deberia seguir tocando.
    expect(
      elementHitTest(rect, { x: 0.4 + ERASER_RADIUS / 2, y: 0.3 }, ERASER_RADIUS),
    ).toBe(true);
  });

  it("un punto cerca de cualquier punto muestreado de un trazo lo toca", () => {
    const line = stroke({
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
      strokeWidth: 0.02,
    });
    expect(elementHitTest(line, { x: 0.5, y: 0.5 }, 0.01)).toBe(true);
  });

  it("un punto lejos de todos los puntos de un trazo no lo toca", () => {
    const line = stroke({
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
      strokeWidth: 0.02,
    });
    expect(elementHitTest(line, { x: 0.9, y: 0.9 }, 0.01)).toBe(false);
  });
});

describe("redactPdf — rutas de error previas a pdf.js — src/lib/pdf/redact.ts", () => {
  it("sin elementos (DEFAULT_REDACT_OPTIONS) lanza PdfError('empty') sin abrir el archivo", async () => {
    const file = await toFile(await createDocument());
    await expect(redactPdf(file, DEFAULT_REDACT_OPTIONS)).rejects.toBeInstanceOf(PdfError);
    await expect(redactPdf(file, DEFAULT_REDACT_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("elementos todos degenerados (recortados a null) equivalen a 'sin elementos' -> 'empty' (rectangulo)", async () => {
    const file = await toFile(await createDocument());
    const options = { elements: [box({ width: 0.0001, height: 0.0001 })] };
    await expect(redactPdf(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("elementos todos degenerados (recortados a null) equivalen a 'sin elementos' -> 'empty' (trazo)", async () => {
    const file = await toFile(await createDocument());
    const options = { elements: [stroke({ points: [{ x: 0.1, y: 0.1 }] })] };
    await expect(redactPdf(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("archivo vacio (0 bytes) con elementos validos lanza PdfError('corrupt') antes de rasterizar", async () => {
    const empty = new File([], "empty.pdf", { type: "application/pdf" });
    await expect(redactPdf(empty, { elements: [box()] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("archivo con bytes invalidos (no-PDF) y elementos validos lanza PdfError('corrupt') antes de rasterizar", async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4, 5])], "garbage.pdf", {
      type: "application/pdf",
    });
    await expect(redactPdf(garbage, { elements: [box()] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("archivo con bytes invalidos y un trazo (no rectangulo) valido tambien lanza 'corrupt' antes de rasterizar", async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4, 5])], "garbage.pdf", {
      type: "application/pdf",
    });
    await expect(redactPdf(garbage, { elements: [stroke()] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});

describe("REQUISITO DE SEGURIDAD — texto cubierto por un trazo a mano alzada debe ser irrecuperable en la salida", () => {
  /**
   * Este es el test que el plan pide como MANDATORIO: dibujar un trazo a
   * mano alzada (no un rectangulo) sobre texto conocido, en modos
   * distintos de "negro" (como minimo blur y pixelado), hornear, y
   * extraer texto de la pagina de SALIDA para confirmar que el texto
   * cubierto desaparecio.
   *
   * Se intento ejecutar literalmente (probe dedicado, documentado en la
   * cabecera de este archivo): `redactPdf` con un trazo en modo "blur"
   * sobre un PDF con texto real lanza `PdfError("unknown", "DOMMatrix is
   * not defined")` antes incluso de rasterizar, porque `openPdfDocument`
   * (pdf.js) no puede abrir NADA en este entorno Vitest/Node -- la misma
   * limitacion, ya documentada exhaustivamente en este mismo archivo y en
   * `core.test.ts`/`compare.test.ts`/`compress.test.ts`, para cualquier
   * llamada de `redactPdf` que llegue a tocar pdf.js.
   *
   * Por eso este test no puede convertirse en una asercion real aqui sin
   * salirse del alcance de este workstream (anadir `jsdom`+`canvas` o
   * tocar `vitest.config.ts`). Documentado como bloqueador en el reporte
   * de este workstream, con la recomendacion concreta de extender
   * `e2e/specs/redact.spec.ts` (que YA prueba exactamente esta propiedad
   * de seguridad para rectangulo+negro, con Playwright + Chromium real +
   * `pdfjs-dist/legacy` en Node para inspeccionar la descarga) con casos
   * de trazo a mano alzada + blur/pixelado/pintura.
   */
  it.skip("un trazo en modo blur sobre texto conocido, horneado, hace que ese texto no aparezca al extraer texto del PDF de salida — NO EJECUTABLE en este entorno (ver cabecera del archivo y bloqueador en el reporte)", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    // (Requeriria StandardFonts.Helvetica + drawText con texto conocido,
    // igual que hace `e2e/fixtures/generate-fixtures.mjs` para el caso
    // rectangulo+negro que si se ejecuta hoy via Playwright.)
    void page;

    const line = stroke({ mode: "blur", pageIndex: 0 });
    const file = await toFile(document);

    // Este es el efecto no ejecutable: abre pdf.js -> DOMMatrix ausente.
    const blob = await redactPdf(file, { elements: [line] });
    expect(blob.size).toBeGreaterThan(0);
    // La asercion real (no alcanzable aqui) seria extraer texto de la
    // pagina de salida con pdf.js y comprobar que el texto conocido ya no
    // aparece, igual que hace `getPageText` en
    // `e2e/helpers/pdf-inspection.ts` para el caso ya cubierto.
  });

  it.skip("mismo requisito en modo pixelate — NO EJECUTABLE en este entorno (ver cabecera del archivo y bloqueador en el reporte)", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    const file = await toFile(document);
    const line = stroke({ mode: "pixelate", pageIndex: 0 });
    const blob = await redactPdf(file, { elements: [line] });
    expect(blob.size).toBeGreaterThan(0);
  });
});
