import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import {
  DEFAULT_EDIT_STYLE,
  MAX_FONT_SIZE,
  MIN_ELEMENT_SIDE,
  MIN_FONT_SIZE,
  MIN_LINE_LENGTH,
  MAX_STROKE_WIDTH,
  applyEdits,
  applyStyleToElement,
  groupElementsByPage,
  sanitizeElement,
  wrapText,
  type EditElement,
  type EditStyle,
  type EllipseElement,
  type HighlightElement,
  type ImageElement,
  type LineElement,
  type RectElement,
  type TextElement,
} from "@/lib/pdf/editPdf";

/**
 * `editPdf.ts` ANADE contenido usando la API vectorial de pdf-lib
 * (drawText/drawImage/drawRectangle/drawEllipse/drawLine): a diferencia de
 * `imagesToPdf`/`pdfToImages`/`scanToPdf`, ninguna de sus rutas toca
 * `canvas` ni `document` del DOM, asi que el motor completo (incluida
 * `applyEdits`) es ejercitable de punta a punta en Node.
 */

function textElement(overrides: Partial<TextElement> = {}): TextElement {
  return {
    id: "t1",
    pageIndex: 0,
    type: "text",
    text: "hola",
    x: 0.1,
    y: 0.1,
    width: 0.5,
    fontSize: 14,
    fontFamily: "helvetica",
    bold: false,
    italic: false,
    color: "#000000",
    ...overrides,
  };
}

function rectElement(overrides: Partial<RectElement> = {}): RectElement {
  return {
    id: "r1",
    pageIndex: 0,
    type: "rect",
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.2,
    strokeColor: "#e11d48",
    strokeWidth: 2,
    fill: false,
    fillColor: "#0d4bff",
    fillOpacity: 0.3,
    ...overrides,
  };
}

function ellipseElement(overrides: Partial<EllipseElement> = {}): EllipseElement {
  return {
    ...rectElement(overrides as Partial<RectElement>),
    id: overrides.id ?? "e1",
    type: "ellipse",
  } as EllipseElement;
}

function lineElement(overrides: Partial<LineElement> = {}): LineElement {
  return {
    id: "l1",
    pageIndex: 0,
    type: "line",
    x1: 0.1,
    y1: 0.1,
    x2: 0.6,
    y2: 0.6,
    strokeColor: "#e11d48",
    strokeWidth: 2,
    ...overrides,
  };
}

function highlightElement(overrides: Partial<HighlightElement> = {}): HighlightElement {
  return {
    id: "h1",
    pageIndex: 0,
    type: "highlight",
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.1,
    color: "#fff176",
    opacity: 0.4,
    ...overrides,
  };
}

/** PNG 1x1 real (mismo fixture que `imagesToPdf.test.ts`, sin dependencias extra). */
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function imageElement(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    id: "img1",
    pageIndex: 0,
    type: "image",
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.3,
    bytes: new Uint8Array(Buffer.from(MINIMAL_PNG_BASE64, "base64")),
    previewUrl: "",
    ratio: 1,
    ...overrides,
  };
}

async function createDocument(pageCount = 1): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([300, 300]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "test.pdf"): Promise<File> {
  const bytes = await document.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/pdf",
  });
}

describe("sanitizeElement — src/lib/pdf/editPdf.ts", () => {
  it("descarta texto vacio o solo espacios", () => {
    expect(sanitizeElement(textElement({ text: "   " }))).toBeNull();
    expect(sanitizeElement(textElement({ text: "" }))).toBeNull();
  });

  it("recorta x/width del texto a la pagina y limita fontSize a [MIN_FONT_SIZE, MAX_FONT_SIZE]", () => {
    const clamped = sanitizeElement(
      textElement({ x: 1.5, width: 2, fontSize: 999 }),
    ) as TextElement;
    expect(clamped.x).toBe(1);
    expect(clamped.width).toBeLessThanOrEqual(1 - clamped.x);
    expect(clamped.fontSize).toBe(MAX_FONT_SIZE);

    const tooSmall = sanitizeElement(textElement({ fontSize: 0 })) as TextElement;
    expect(tooSmall.fontSize).toBe(MIN_FONT_SIZE);
  });

  it("descarta lineas mas cortas que MIN_LINE_LENGTH y conserva las validas con strokeWidth acotado", () => {
    expect(
      sanitizeElement(lineElement({ x1: 0.5, y1: 0.5, x2: 0.5001, y2: 0.5001 })),
    ).toBeNull();

    const kept = sanitizeElement(
      lineElement({ strokeWidth: 999 }),
    ) as LineElement;
    expect(kept).not.toBeNull();
    expect(kept.strokeWidth).toBe(MAX_STROKE_WIDTH);
  });

  it("descarta rect/ellipse/highlight con caja degenerada (menor que MIN_ELEMENT_SIDE)", () => {
    expect(
      sanitizeElement(rectElement({ width: MIN_ELEMENT_SIDE / 2, height: 0.2 })),
    ).toBeNull();
    expect(
      sanitizeElement(ellipseElement({ width: 0.2, height: MIN_ELEMENT_SIDE / 2 })),
    ).toBeNull();
    expect(
      sanitizeElement(
        highlightElement({ width: MIN_ELEMENT_SIDE / 2, height: MIN_ELEMENT_SIDE / 2 }),
      ),
    ).toBeNull();
  });

  it("normaliza una caja dibujada con ancho/alto negativos (arrastre en cualquier direccion)", () => {
    const dragged = sanitizeElement(
      rectElement({ x: 0.5, y: 0.5, width: -0.2, height: -0.2 }),
    ) as RectElement;
    expect(dragged.x).toBeCloseTo(0.3);
    expect(dragged.y).toBeCloseTo(0.3);
    expect(dragged.width).toBeCloseTo(0.2);
    expect(dragged.height).toBeCloseTo(0.2);
  });

  it("descarta imagenes con menos de 4 bytes (no hay firma reconocible)", () => {
    expect(
      sanitizeElement(imageElement({ bytes: new Uint8Array([1, 2]) })),
    ).toBeNull();
  });

  it("descarta cualquier elemento con pageIndex negativo o no entero", () => {
    expect(sanitizeElement(textElement({ pageIndex: -1 }))).toBeNull();
    expect(sanitizeElement(rectElement({ pageIndex: 1.5 }))).toBeNull();
  });
});

describe("groupElementsByPage — src/lib/pdf/editPdf.ts", () => {
  it("agrupa por pagina conservando el orden de insercion y descarta los invalidos", () => {
    const elements: EditElement[] = [
      textElement({ id: "a", pageIndex: 1 }),
      rectElement({ id: "b", pageIndex: 0 }),
      textElement({ id: "c", pageIndex: 1 }),
      textElement({ id: "invalid", pageIndex: -1 }),
    ];

    const grouped = groupElementsByPage(elements);

    expect([...grouped.keys()].sort()).toEqual([0, 1]);
    expect(grouped.get(1)?.map((element) => element.id)).toEqual(["a", "c"]);
    expect(grouped.get(0)?.map((element) => element.id)).toEqual(["b"]);
  });
});

describe("applyStyleToElement — src/lib/pdf/editPdf.ts", () => {
  const style: EditStyle = {
    ...DEFAULT_EDIT_STYLE,
    fontFamily: "times",
    fontSize: 22,
    bold: true,
    italic: true,
    textColor: "#123456",
    strokeColor: "#abcdef",
    strokeWidth: 5,
    fill: true,
    fillColor: "#654321",
    fillOpacity: 0.9,
    highlightColor: "#00ff00",
    highlightOpacity: 0.6,
  };

  it("reaplica solo los campos de estilo que el tipo 'text' entiende", () => {
    const original = textElement({ x: 0.42 });
    const restyled = applyStyleToElement(original, style) as TextElement;

    expect(restyled.fontFamily).toBe("times");
    expect(restyled.fontSize).toBe(22);
    expect(restyled.bold).toBe(true);
    expect(restyled.italic).toBe(true);
    expect(restyled.color).toBe("#123456");
    // Geometria y contenido intactos.
    expect(restyled.x).toBe(0.42);
    expect(restyled.text).toBe(original.text);
  });

  it("reaplica los campos de forma en rect/ellipse sin tocar la geometria", () => {
    const restyled = applyStyleToElement(rectElement(), style) as RectElement;
    expect(restyled.strokeColor).toBe("#abcdef");
    expect(restyled.strokeWidth).toBe(5);
    expect(restyled.fill).toBe(true);
    expect(restyled.fillColor).toBe("#654321");
    expect(restyled.fillOpacity).toBe(0.9);
  });

  it("reaplica solo trazo en 'line' y color/opacidad en 'highlight'", () => {
    const restyledLine = applyStyleToElement(lineElement(), style) as LineElement;
    expect(restyledLine.strokeColor).toBe("#abcdef");
    expect(restyledLine.strokeWidth).toBe(5);

    const restyledHighlight = applyStyleToElement(
      highlightElement(),
      style,
    ) as HighlightElement;
    expect(restyledHighlight.color).toBe("#00ff00");
    expect(restyledHighlight.opacity).toBe(0.6);
  });
});

describe("wrapText — src/lib/pdf/editPdf.ts", () => {
  it("reparte el texto en varias lineas cuando excede maxWidth", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);

    const longText = "una frase bastante larga que no cabe en una sola linea corta";
    const maxWidth = font.widthOfTextAtSize("una frase", 14);
    const lines = wrapText(font, longText, 14, maxWidth);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, 14)).toBeLessThanOrEqual(maxWidth + 0.01);
    }
  });

  it("respeta los saltos de linea explicitos", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);

    const lines = wrapText(font, "linea uno\nlinea dos", 14, 1000);
    expect(lines).toEqual(["linea uno", "linea dos"]);
  });

  it("parte caracter a caracter una palabra mas ancha que maxWidth", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);

    const word = "supercalifragilisticoso";
    const maxWidth = font.widthOfTextAtSize("super", 14);
    const lines = wrapText(font, word, 14, maxWidth);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(word);
  });
});

describe("applyEdits — src/lib/pdf/editPdf.ts", () => {
  it("anade texto, forma y resaltado sobre un PDF existente sin perder paginas", async () => {
    const document = await createDocument(1);
    const originalBytes = await document.save({ useObjectStreams: true });
    const file = await toFile(document);

    const elements = new Map<number, EditElement[]>([
      [0, [textElement(), rectElement(), highlightElement()]],
    ]);

    const blob = await applyEdits(file, elements);
    const outputBytes = new Uint8Array(await blob.arrayBuffer());
    const result = await PDFDocument.load(outputBytes, { updateMetadata: false });

    expect(result.getPageCount()).toBe(1);
    // Se anadio contenido real: el documento de salida no es identico al de entrada.
    expect(outputBytes.byteLength).not.toBe(originalBytes.byteLength);
  });

  it("incrusta una imagen (PNG) como elemento sin lanzar", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const elements = new Map<number, EditElement[]>([[0, [imageElement()]]]);

    const blob = await applyEdits(file, elements);
    const outputBytes = new Uint8Array(await blob.arrayBuffer());
    const result = await PDFDocument.load(outputBytes, { updateMetadata: false });
    expect(result.getPageCount()).toBe(1);
  });

  it("con un mapa de elementos vacio, lanza PdfError('nothingSelected')", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    await expect(applyEdits(file, new Map())).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("si todas las paginas objetivo estan fuera de rango, lanza PdfError('nothingSelected')", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const elements = new Map<number, EditElement[]>([[5, [textElement({ pageIndex: 5 })]]]);

    await expect(applyEdits(file, elements)).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("con una senal ya abortada, lanza PdfError('cancelled') sin procesar nada", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const elements = new Map<number, EditElement[]>([[0, [textElement()]]]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      applyEdits(file, elements, undefined, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("un PDF corrupto o vacio da PdfError('corrupt')", async () => {
    const corrupt = new File([new Uint8Array([1, 2, 3, 4])], "corrupt.pdf", {
      type: "application/pdf",
    });
    const elements = new Map<number, EditElement[]>([[0, [textElement()]]]);

    await expect(applyEdits(corrupt, elements)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("un PDF sin paginas da PdfError('corrupt')", async () => {
    const document = await createDocument(0);
    const file = await toFile(document);
    const elements = new Map<number, EditElement[]>([[0, [textElement()]]]);

    await expect(applyEdits(file, elements)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("reporta progreso hasta 1 al terminar", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const elements = new Map<number, EditElement[]>([[0, [textElement()]]]);
    const seen: number[] = [];

    await applyEdits(file, elements, (value) => seen.push(value));

    expect(seen[seen.length - 1]).toBe(1);
  });
});
