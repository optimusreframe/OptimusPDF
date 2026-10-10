import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import {
  applyOp,
  createEditSession,
  imageAddOp,
  redo,
  shapeItem,
  splitForExport,
  type EditShapeElement,
  undo,
  type EditOp,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import { duplicateOp, shapeFromGesture } from "@/app/edit-pdf/editElements";
import { metricsFor } from "@/app/edit-pdf/editTestUtils";
import {
  DEFAULT_EDIT_STYLE,
  applyEdits,
  groupElementsByPage,
  type CheckElement,
  type EditElement,
  type EllipseElement,
  type HighlightElement,
  type ImageElement,
  type LineElement,
  type RectElement,
} from "@/lib/pdf/editPdf";

/**
 * Equivalencia de la exportacion con el editor anterior (W5-U4b): lo que la
 * sesion exporta (`splitForExport` -> `groupElementsByPage` -> `applyEdits`) es,
 * para los MISMOS elementos, el mismo PDF que daria el motor llamado a mano como
 * hacia `EditToolClient`. La bateria de elementos es la de `editPdf.test.ts`.
 */

const PAGE = 300;
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = new Uint8Array(Buffer.from(MINIMAL_PNG_BASE64, "base64"));

const rect: RectElement = {
  id: "r1",
  pageIndex: 0,
  type: "rect",
  x: 0.1,
  y: 0.1,
  width: 0.3,
  height: 0.2,
  strokeColor: "#e11d48",
  strokeWidth: 2,
  fill: true,
  fillColor: "#0d4bff",
  fillOpacity: 0.3,
};
const ellipse: EllipseElement = { ...rect, id: "e1", type: "ellipse", x: 0.5, y: 0.15, fill: false };
const line: LineElement = {
  id: "l1",
  pageIndex: 0,
  type: "line",
  x1: 0.1,
  y1: 0.5,
  x2: 0.6,
  y2: 0.7,
  strokeColor: "#0f9d68",
  strokeWidth: 3,
};
const highlight: HighlightElement = {
  id: "h1",
  pageIndex: 0,
  type: "highlight",
  x: 0.1,
  y: 0.8,
  width: 0.4,
  height: 0.06,
  color: "#fff176",
  opacity: 0.4,
};
const check: CheckElement = {
  id: "c1",
  pageIndex: 0,
  type: "check",
  x: 0.7,
  y: 0.7,
  width: 0.1,
  height: 0.1,
  mark: "cross",
  strokeColor: "#e11d48",
  strokeWidth: 2,
};
const image: ImageElement = {
  id: "i1",
  pageIndex: 0,
  type: "image",
  x: 0.6,
  y: 0.3,
  width: 0.25,
  height: 0.25,
  bytes: PNG,
  previewUrl: "data:image/png;base64," + MINIMAL_PNG_BASE64,
  ratio: 1,
};

const ALL: EditElement[] = [rect, ellipse, line, highlight, check, image];

function sessionOf(elements: readonly EditElement[]): EditSession {
  let session = createEditSession();
  let now = 1000;
  for (const element of elements) {
    const op: EditOp =
      element.type === "image" ? imageAddOp(element) : { type: "add", item: shapeItem(element as EditShapeElement) };
    session = applyOp(session, op, (now += 1000));
  }
  return session;
}

async function makeFile(pages = 1): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([PAGE, PAGE]);
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes as unknown as BlobPart], "t.pdf", { type: "application/pdf" });
}

function content(doc: PDFDocument, index = 0): string {
  const node = doc.getPage(index).node;
  const contents = node.Contents();
  if (!contents) return ""; // pagina en blanco sin tocar: sin flujo de contenido
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => node.context.lookup(ref) as PDFRawStream)
      : [contents as PDFRawStream];
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
}

async function exportContent(file: File, elements: EditElement[], page = 0): Promise<string> {
  const blob = await applyEdits(file, groupElementsByPage(elements));
  const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
  return content(doc, page);
}

describe("exportar los elementos de la sesion = exportar los del editor anterior", () => {
  it("splitForExport devuelve los mismos elementos que se anadieron, en el mismo orden", () => {
    const { elements, textEdits } = splitForExport(sessionOf(ALL));
    expect(textEdits).toEqual([]);
    expect(elements.map((e) => e.id)).toEqual(ALL.map((e) => e.id));
    for (const [index, element] of elements.entries()) {
      expect(element, ALL[index].type).toEqual(ALL[index]);
    }
  });

  it("el PDF resultante es identico: mismos operadores de dibujo, misma imagen", async () => {
    const file = await makeFile();
    const legacy = await exportContent(file, ALL);
    const viaSession = await exportContent(file, splitForExport(sessionOf(ALL)).elements);
    expect(viaSession).toBe(legacy);
    expect(legacy).toContain(" l\n"); // trazos de rectangulo, linea y marca
    expect(legacy).toContain("/Image"); // la imagen se embebe, no se rasteriza
  });

  it("mover y redimensionar en la sesion exporta lo mismo que dibujar ya en esa posicion", async () => {
    let session = sessionOf([rect, ellipse, image]);
    session = applyOp(session, { type: "move", id: "r1", dx: 0.1, dy: 0.05 }, 20_000);
    session = applyOp(session, { type: "resize", id: "e1", box: { x: 0.4, y: 0.2, width: 0.2, height: 0.3 } }, 30_000);
    session = applyOp(session, { type: "resize", id: "i1", box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } }, 40_000);
    const expected: EditElement[] = [
      { ...rect, x: 0.2, y: 0.15000000000000002 },
      { ...ellipse, x: 0.4, y: 0.2, width: 0.2, height: 0.3 },
      { ...image, x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    ];
    const file = await makeFile();
    expect(await exportContent(file, splitForExport(session).elements)).toBe(await exportContent(file, expected));
  });

  it("el estilo cambiado en la sesion (restyle) se exporta como en el editor anterior", async () => {
    let session = sessionOf([rect, line, highlight, check]);
    session = applyOp(session, { type: "restyle", id: "r1", patch: { strokeColor: "#000000", strokeWidth: 6, fill: false } }, 20_000);
    session = applyOp(session, { type: "restyle", id: "l1", patch: { strokeColor: "#e11d48", strokeWidth: 8 } }, 30_000);
    session = applyOp(session, { type: "restyle", id: "h1", patch: { color: "#9ad9ff", opacity: 0.75 } }, 40_000);
    session = applyOp(session, { type: "restyle", id: "c1", patch: { mark: "check", strokeWidth: 4 } }, 50_000);
    const expected: EditElement[] = [
      { ...rect, strokeColor: "#000000", strokeWidth: 6, fill: false },
      { ...line, strokeColor: "#e11d48", strokeWidth: 8 },
      { ...highlight, color: "#9ad9ff", opacity: 0.75 },
      { ...check, mark: "check", strokeWidth: 4 },
    ];
    const file = await makeFile();
    expect(await exportContent(file, splitForExport(session).elements)).toBe(await exportContent(file, expected));
  });

  it("una linea reformada (reshape) se exporta con sus extremos nuevos", async () => {
    const session = applyOp(sessionOf([line]), { type: "reshape", id: "l1", points: { x1: 0.8, y1: 0.2, x2: 0.2, y2: 0.8 } }, 20_000);
    const file = await makeFile();
    const expected = [{ ...line, x1: 0.8, y1: 0.2, x2: 0.2, y2: 0.8 }];
    expect(await exportContent(file, splitForExport(session).elements)).toBe(await exportContent(file, expected));
  });

  it("deshacer deja la exportacion como antes y rehacer la recupera", async () => {
    const file = await makeFile();
    const base = sessionOf([rect]);
    const moved = applyOp(base, { type: "move", id: "r1", dx: 0.2, dy: 0 }, 20_000);
    const before = await exportContent(file, splitForExport(base).elements);
    const after = await exportContent(file, splitForExport(moved).elements);
    expect(after).not.toBe(before);
    expect(await exportContent(file, splitForExport(undo(moved)).elements)).toBe(before);
    expect(await exportContent(file, splitForExport(redo(undo(moved))).elements)).toBe(after);
  });

  it("un elemento borrado no se exporta y un duplicado se exporta dos veces", async () => {
    const file = await makeFile();
    const session = sessionOf([rect]);
    const dup = applyOp(session, duplicateOp(session.items[0])!, 20_000);
    expect(splitForExport(dup).elements).toHaveLength(2);
    const removed = applyOp(dup, { type: "remove", id: "r1" }, 30_000);
    expect(splitForExport(removed).elements).toHaveLength(1);
    const content1 = await exportContent(file, splitForExport(removed).elements);
    expect(content1).toContain(" l\n");
  });

  it("dibujar con el gesto de la interfaz exporta la caja que se vio", async () => {
    const metrics = metricsFor([0, 0, PAGE, PAGE], 0, PAGE);
    const el = shapeFromGesture({
      tool: "rect",
      metrics,
      pageIndex: 0,
      id: "g1",
      start: { x: 0.25, y: 0.25 },
      end: { x: 0.75, y: 0.5 },
      tap: false,
      style: { ...DEFAULT_EDIT_STYLE, fill: false, strokeWidth: 2 },
    })!;
    const session = applyOp(createEditSession(), { type: "add", item: shapeItem(el) }, 1);
    const file = await makeFile();
    const text = await exportContent(file, splitForExport(session).elements);
    // Esquina superior izquierda en (75, 75 desde arriba) = (75, 225) en el PDF; 150 x 75 pt.
    expect(text).toContain("1 0 0 1 75 225 cm");
    expect(text).toContain("150 0 l\n150 75 l");
  });

  it("los elementos de cada pagina van a su pagina", async () => {
    const file = await makeFile(3);
    const items = [
      { ...rect, pageIndex: 2, id: "p2" },
      { ...ellipse, pageIndex: 0, id: "p0" },
    ];
    const blob = await applyEdits(file, groupElementsByPage(splitForExport(sessionOf(items)).elements));
    const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
    expect(content(doc, 2)).toContain(" l\n"); // el rectangulo, en su pagina
    expect(content(doc, 1)).not.toContain(" l\n"); // la pagina del medio, intacta
    expect(content(doc, 0)).toContain(" c\n"); // la elipse es una curva
  });

  it("una imagen sin sus bytes en la sesion no se exporta (y no rompe)", () => {
    const session = sessionOf([image]);
    const stripped: EditSession = { ...session, assets: {} };
    expect(splitForExport(stripped).elements).toHaveLength(0);
  });
});
