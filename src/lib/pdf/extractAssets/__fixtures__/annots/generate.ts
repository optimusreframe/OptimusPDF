/**
 * CORPUS SINTETICO del motor de anotaciones (U7.2 / parte de U7.5): PDFs generados con pdf-lib, de forma REPRODUCIBLE (sin azar ni
 * fechas), cada uno con su VERDAD de terreno. Nada de datos reales: los textos son inventados y las «firmas» son curvas por formula.
 *
 * Solo para pruebas (Vitest y la inyeccion E2E): no lo importa la aplicacion.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { AssetKind, AssetSource } from "../../types";

/* ---------------------------------------------------------------------------------------------------------------- */
/* Verdad                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

export type AnnotClass = "ink" | "stamp" | "sig" | "wm-ab" | "wm-c";

export type TruthItem = {
  /** Clase de metrica. */
  cls: AnnotClass;
  /** Descripcion humana (se muestra en el informe). */
  tag: string;
  source: AssetSource;
  kind?: AssetKind;
  /** Paginas (0-based) donde debe aparecer. Con una sola, la primera ocurrencia debe estar en ella. */
  pages: number[];
  /** Solo marcas de texto: el texto exacto. */
  text?: string;
  /** Solo capas: el nombre de la capa. */
  layerName?: string;
  /** Rango de confianza esperado. */
  minConfidence?: number;
  maxConfidence?: number;
  /** Debe incluir un motivo que contenga este texto (en minusculas). */
  reasonIncludes?: string;
  /** Debe poder descargarse (`formats` no vacio) o no. */
  downloadable?: boolean;
  /** Debe acompanarse del aviso `digital-signature`. */
  digitalSignature?: boolean;
};

export type AnnotFixture = {
  name: string;
  description: string;
  bytes: Uint8Array;
  truth: TruthItem[];
  /** Avisos `digital-signature` esperados (paginas 0-based). */
  digitalSignaturePages?: number[];
  /** Candidatas de imagen translucida esperadas (deteccion (d), solo informativa). */
  translucentImagePages?: number[];
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Utilidades de dibujo                                                                                              */
/* ---------------------------------------------------------------------------------------------------------------- */

const W = 612;
const H = 792;

export type Pt = [number, number];

/** Garabato tipo firma: curva con bucles dentro de la caja (x, y, ancho, alto), en puntos de usuario. */
export function wave(x: number, y: number, w: number, h: number, loops: number, phase = 0, steps = 60): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push([x + t * w + Math.sin(2 * Math.PI * loops * t + phase) * h * 0.18, y + h * 0.5 + Math.cos(2 * Math.PI * loops * t + phase) * h * 0.4 * (1 - 0.35 * t)]);
  }
  return points;
}

/** Elipse como circuito poligonal fino (para un dibujo a mano alzada). */
export function loop(cx: number, cy: number, rx: number, ry: number, steps = 48): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (2 * Math.PI * i) / steps;
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return points;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function strokeOps(points: readonly Pt[], origin: Pt = [0, 0]): string {
  return points.map(([x, y], i) => `${fmt(x - origin[0])} ${fmt(y - origin[1])} ${i === 0 ? "m" : "l"}`).join(" ");
}

function boundsOf(strokes: readonly (readonly Pt[])[], pad: number): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const stroke of strokes) {
    for (const [x, y] of stroke) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

async function newDoc(): Promise<{ doc: PDFDocument; font: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer("OptimusPDF fixtures");
  doc.setCreator("OptimusPDF fixtures");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

/** Pagina de cuerpo con un titulo y lineas de texto inventadas (el fondo sobre el que se prueban las anotaciones). */
function bodyPage(doc: PDFDocument, font: PDFFont, bold: PDFFont, title: string, lines = 12): PDFPage {
  const page = doc.addPage([W, H]);
  page.drawText(title, { x: 56, y: 730, size: 18, font: bold, color: rgb(0.1, 0.1, 0.12) });
  for (let i = 0; i < lines; i += 1) {
    page.drawText(`Linea ${i + 1} de texto de prueba para el documento sintetico ${title}.`, { x: 56, y: 690 - i * 22, size: 10, font, color: rgb(0.15, 0.15, 0.18) });
  }
  return page;
}

function register(doc: PDFDocument, dict: Record<string, unknown>): PDFRef {
  return doc.context.register(doc.context.obj(dict as never));
}

function addAnnotation(doc: PDFDocument, page: PDFPage, ref: PDFRef): void {
  const existing = page.node.lookup(PDFName.of("Annots"));
  if (existing instanceof PDFArray) existing.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

function formStream(doc: PDFDocument, bbox: [number, number, number, number], content: string, resources?: Record<string, unknown>): PDFRef {
  const stream = doc.context.stream(content, { Type: "XObject", Subtype: "Form", BBox: bbox, ...(resources ? { Resources: resources } : {}) } as never);
  return doc.context.register(stream);
}

function addField(doc: PDFDocument, ref: PDFRef): void {
  let form = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(form instanceof PDFDict)) {
    form = doc.context.obj({ Fields: [], SigFlags: 3 });
    doc.catalog.set(PDFName.of("AcroForm"), form);
  }
  const fields = (form as PDFDict).lookup(PDFName.of("Fields"));
  if (fields instanceof PDFArray) fields.push(ref);
}

const PAGE_NAMES = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho"];

/* ---------------------------------------------------------------------------------------------------------------- */
/* Anotaciones                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

type InkSpec = { strokes: Pt[][]; color: [number, number, number]; width: number; withAp?: boolean; flags?: number };

function addInk(doc: PDFDocument, page: PDFPage, spec: InkSpec): void {
  const [x0, y0, x1, y1] = boundsOf(spec.strokes, spec.width);
  const withAp = spec.withAp !== false;
  const [r, g, b] = spec.color;
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: "Ink",
    Rect: [x0, y0, x1, y1],
    InkList: spec.strokes.map((stroke) => stroke.flatMap(([x, y]) => [fmt(x), fmt(y)].map(Number))),
    C: [r, g, b],
    BS: { W: spec.width },
    F: spec.flags ?? 4,
    P: page.ref,
    CA: 1,
  };
  if (withAp) {
    const content = `${r} ${g} ${b} RG ${spec.width} w 1 J 1 j ${spec.strokes.map((s) => `${strokeOps(s, [x0, y0])} S`).join(" ")}`;
    dict.AP = { N: formStream(doc, [0, 0, x1 - x0, y1 - y0], content) };
  }
  addAnnotation(doc, page, register(doc, dict));
}

function addStamp(doc: PDFDocument, page: PDFPage, rect: [number, number, number, number], kind: "box" | "circle", color: [number, number, number], label: string, name = "Approved"): void {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const [r, g, b] = color;
  let content = `${r} ${g} ${b} RG ${r} ${g} ${b} rg 3 w `;
  if (kind === "box") {
    content += `3 3 ${fmt(w - 6)} ${fmt(h - 6)} re S 0.5 w `;
  } else {
    const rx = w / 2 - 3;
    const ry = h / 2 - 3;
    const k = 0.5523;
    const cx = w / 2;
    const cy = h / 2;
    content +=
      `${fmt(cx + rx)} ${fmt(cy)} m ` +
      `${fmt(cx + rx)} ${fmt(cy + ry * k)} ${fmt(cx + rx * k)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c ` +
      `${fmt(cx - rx * k)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ry * k)} ${fmt(cx - rx)} ${fmt(cy)} c ` +
      `${fmt(cx - rx)} ${fmt(cy - ry * k)} ${fmt(cx - rx * k)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c ` +
      `${fmt(cx + rx * k)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ry * k)} ${fmt(cx + rx)} ${fmt(cy)} c S `;
  }
  content += `BT /F1 ${fmt(Math.min(16, h / 3))} Tf ${fmt(w / 2 - label.length * 4)} ${fmt(h / 2 - 4)} Td (${label}) Tj ET`;
  const ap = formStream(doc, [0, 0, w, h], content, { Font: { F1: register(doc, { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold" }) } });
  addAnnotation(doc, page, register(doc, { Type: "Annot", Subtype: "Stamp", Rect: rect, Name: PDFName.of(name), F: 4, P: page.ref, AP: { N: ap } }));
}

type SigSpec = {
  rect: [number, number, number, number];
  name: string;
  appearance?: "strokes" | "text" | "none";
  /** Con `/V`: firma digital falsa de relleno (NO es criptograficamente valida: solo la estructura). */
  signed?: boolean;
};

function addSigWidget(doc: PDFDocument, page: PDFPage, spec: SigSpec): void {
  const [x0, y0, x1, y1] = spec.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    T: PDFString.of(spec.name),
    Rect: spec.rect,
    F: 4,
    P: page.ref,
  };
  const appearance = spec.appearance ?? "strokes";
  if (appearance === "strokes") {
    const stroke = wave(4, 4, w - 8, h - 8, 3);
    dict.AP = { N: formStream(doc, [0, 0, w, h], `0.05 0.15 0.6 RG 2 w 1 J 1 j ${strokeOps(stroke)} S`) };
  } else if (appearance === "text") {
    dict.AP = {
      N: formStream(doc, [0, 0, w, h], `0.4 g 0.5 w 0.5 0.5 ${fmt(w - 1)} ${fmt(h - 1)} re S 0 g BT /F1 8 Tf 6 ${fmt(h - 14)} Td (Digitally signed by Fixture Persona) Tj 0 -10 Td (Date: 2026.01.01) Tj ET`, {
        Font: { F1: register(doc, { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }) },
      }),
    };
  }
  if (spec.signed) {
    dict.V = register(doc, {
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      Name: PDFString.of("Persona Ficticia"),
      M: PDFString.of("D:20260101000000Z"),
      ByteRange: [0, 0, 0, 0],
      Contents: PDFHexString.of("00".repeat(48)),
    });
  }
  const ref = register(doc, dict);
  addAnnotation(doc, page, ref);
  addField(doc, ref);
}

function addWatermarkAnnotation(doc: PDFDocument, page: PDFPage, rect: [number, number, number, number], text: string): void {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  const ap = formStream(doc, [0, 0, w, h], `0.6 g BT /F1 ${fmt(h * 0.6)} Tf 4 ${fmt(h * 0.25)} Td (${text}) Tj ET`, {
    Font: { F1: register(doc, { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold" }) },
  });
  addAnnotation(doc, page, register(doc, { Type: "Annot", Subtype: "Watermark", Rect: rect, F: 4, P: page.ref, AP: { N: ap }, FixedPrint: { Type: "FixedPrint", Matrix: [1, 0, 0, 1, 0, 0], H: 0, V: 0 } }));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Capas opcionales                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

type LayerSpec = { name: string; visible: boolean; draw: (fonts: { regular: string; bold: string }, alpha: (value: number) => string) => string };

/** Operadores de texto girado `angle` grados con el color gris `gray` (se usan dentro de un flujo propio, sin la API de dibujo de pdf-lib). */
function textOps(font: string, text: string, x: number, y: number, size: number, angle: number, color: [number, number, number]): string {
  const rad = (angle * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const r3 = (n: number): number => Math.round(n * 1000) / 1000;
  return `${color.join(" ")} rg BT /${font} ${size} Tf ${r3(c)} ${r3(s)} ${r3(-s)} ${r3(c)} ${x} ${y} Tm (${text}) Tj ET`;
}

function addRawContent(doc: PDFDocument, page: PDFPage, content: string): void {
  page.node.addContentStream(doc.context.register(doc.context.stream(content)));
}

function pageFontKeys(page: PDFPage, regular: PDFFont, bold: PDFFont): { regular: string; bold: string } {
  return { regular: page.node.newFontDictionary("FReg", regular.ref).decodeText(), bold: page.node.newFontDictionary("FBold", bold.ref).decodeText() };
}

function addLayers(doc: PDFDocument, pages: PDFPage[], layers: LayerSpec[], regular: PDFFont, bold: PDFFont): void {
  const refs = layers.map((layer) => register(doc, { Type: "OCG", Name: PDFString.of(layer.name) }));
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({
      OCGs: refs,
      D: { Order: refs, ON: refs.filter((_, i) => layers[i].visible), OFF: refs.filter((_, i) => !layers[i].visible) },
    } as never),
  );
  for (const page of pages) {
    const resources = page.node.Resources();
    if (!resources) continue;
    const props: Record<string, PDFRef> = {};
    layers.forEach((_, i) => {
      props[`MC${i}`] = refs[i];
    });
    resources.set(PDFName.of("Properties"), doc.context.obj(props as never));
    const fonts = pageFontKeys(page, regular, bold);
    // Opacidad de relleno (`ca`) como estado grafico: «/GSx gs» dentro del grupo.
    const alpha = (value: number): string => `/${page.node.newExtGState("GSwm", register(doc, { Type: "ExtGState", ca: value, CA: value })).decodeText()} gs`;
    addRawContent(doc, page, layers.map((layer, i) => `/OC /MC${i} BDC q ${layer.draw(fonts, alpha)} Q EMC`).join("\n"));
  }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Form XObject de sello                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

function addFormStamp(doc: PDFDocument, page: PDFPage, origin: Pt, color: [number, number, number], shape: "circle" | "box", label: string, size = 100): void {
  const [r, g, b] = color;
  const r2 = size / 2 - 4;
  const c = size / 2;
  const k = 0.5523;
  let content = `${r} ${g} ${b} RG ${r} ${g} ${b} rg 3 w `;
  if (shape === "circle") {
    content +=
      `${fmt(c + r2)} ${fmt(c)} m ${fmt(c + r2)} ${fmt(c + r2 * k)} ${fmt(c + r2 * k)} ${fmt(c + r2)} ${fmt(c)} ${fmt(c + r2)} c ` +
      `${fmt(c - r2 * k)} ${fmt(c + r2)} ${fmt(c - r2)} ${fmt(c + r2 * k)} ${fmt(c - r2)} ${fmt(c)} c ` +
      `${fmt(c - r2)} ${fmt(c - r2 * k)} ${fmt(c - r2 * k)} ${fmt(c - r2)} ${fmt(c)} ${fmt(c - r2)} c ` +
      `${fmt(c + r2 * k)} ${fmt(c - r2)} ${fmt(c + r2)} ${fmt(c - r2 * k)} ${fmt(c + r2)} ${fmt(c)} c S `;
  } else {
    content += `4 ${fmt(size * 0.25)} ${fmt(size - 8)} ${fmt(size * 0.5)} re S `;
  }
  content += `BT /F1 12 Tf ${fmt(c - label.length * 3.5)} ${fmt(c - 4)} Td (${label}) Tj ET`;
  const form = formStream(doc, [0, 0, size, size], content, { Font: { F1: register(doc, { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold" }) } });
  const key = page.node.newXObject("Stamp", form).decodeText();
  addRawContent(doc, page, `q 1 0 0 1 ${origin[0]} ${origin[1]} cm /${key} Do Q`);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Corpus                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

const PNG_1X1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));

async function save(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export async function makeInkMulti(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p1 = bodyPage(doc, font, bold, "Ink varios trazos y colores");
  addInk(doc, p1, { strokes: [wave(100, 120, 190, 60, 3), wave(110, 100, 150, 30, 2, 1)], color: [0.05, 0.1, 0.7], width: 2.5 });
  addInk(doc, p1, { strokes: [wave(330, 130, 160, 50, 4)], color: [0.85, 0.1, 0.1], width: 3 });
  addInk(doc, p1, { strokes: [wave(120, 300, 220, 70, 2.5, 0.5)], color: [0.05, 0.05, 0.05], width: 1.2, withAp: false });
  const p2 = bodyPage(doc, font, bold, "Ink dibujo");
  addInk(doc, p2, { strokes: [loop(300, 400, 150, 130)], color: [0.9, 0.5, 0], width: 3 });
  return {
    name: "ink-multi",
    description: "4 anotaciones Ink: tres de proporcion de firma (azul con 2 trazos, roja, negra sin /AP) y un circulo grande (dibujo).",
    bytes: await save(doc),
    truth: [
      { cls: "ink", tag: "ink azul 2 trazos", source: "ink-annot", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true, reasonIncludes: "2 trazos" },
      { cls: "ink", tag: "ink rojo", source: "ink-annot", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
      { cls: "ink", tag: "ink negro sin AP", source: "ink-annot", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
      { cls: "ink", tag: "ink circulo", source: "ink-annot", kind: "drawing", pages: [1], minConfidence: 0.7, downloadable: true },
    ],
  };
}

export async function makeStampAnnot(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Sellos en anotacion");
  addStamp(doc, p, [60, 520, 200, 590], "box", [0.8, 0.05, 0.05], "APROBADO");
  addStamp(doc, p, [380, 500, 480, 600], "circle", [0.05, 0.15, 0.75], "FIRMA", "SignHere");
  return {
    name: "stamp-annot",
    description: "2 anotaciones Stamp con apariencia: caja roja «APROBADO» y circulo azul.",
    bytes: await save(doc),
    truth: [
      { cls: "stamp", tag: "stamp caja roja", source: "stamp-annot", kind: "stamp", pages: [0], minConfidence: 0.85, downloadable: true },
      { cls: "stamp", tag: "stamp circulo azul (SignHere)", source: "stamp-annot", kind: "signature", pages: [0], minConfidence: 0.6, downloadable: true, reasonIncludes: "firma" },
    ],
  };
}

export async function makeSigWidgets(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p1 = bodyPage(doc, font, bold, "Campos de firma");
  addSigWidget(doc, p1, { rect: [60, 120, 250, 180], name: "SigConApariencia", appearance: "strokes" });
  addSigWidget(doc, p1, { rect: [330, 120, 520, 180], name: "SigVacio", appearance: "none" });
  const p2 = bodyPage(doc, font, bold, "Campos de firma 2");
  addSigWidget(doc, p2, { rect: [60, 120, 250, 180], name: "SigFirmado", appearance: "strokes", signed: true });
  addSigWidget(doc, p2, { rect: [330, 100, 540, 180], name: "SigTexto", appearance: "text", signed: true });
  return {
    name: "sig-widgets",
    description: "4 campos /Sig: con apariencia de trazos, vacio, con /V (firma digital falsa) y trazos, y con /V con apariencia de texto.",
    bytes: await save(doc),
    truth: [
      { cls: "sig", tag: "sig con apariencia", source: "sig-widget", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
      { cls: "sig", tag: "sig vacio", source: "sig-widget", kind: "signature", pages: [0], maxConfidence: 0.2, downloadable: false, reasonIncludes: "vacío" },
      { cls: "sig", tag: "sig firmado /V", source: "sig-widget", kind: "signature", pages: [1], minConfidence: 0.7, downloadable: true, digitalSignature: true, reasonIncludes: "firmado digitalmente" },
      { cls: "sig", tag: "sig con /V y texto", source: "sig-widget", kind: "signature", pages: [1], maxConfidence: 0.4, downloadable: true, digitalSignature: true, reasonIncludes: "texto" },
    ],
    digitalSignaturePages: [1, 1],
  };
}

export async function makeOcgWatermark(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const pages = [0, 1, 2].map((i) => bodyPage(doc, font, bold, `Capas ${PAGE_NAMES[i]}`));
  addLayers(
    doc,
    pages,
    [
      // Translucido y diagonal EN TODAS las paginas: lo entrega la capa (a); la deteccion de texto (c) no debe repetirlo.
      { name: "Watermark", visible: true, draw: (f, alpha) => `${alpha(0.3)} ${textOps(f.bold, "COPIA CONTROLADA", 120, 300, 54, 35, [0.7, 0.7, 0.7])}` },
      { name: "Capa de notas", visible: true, draw: () => "0.2 0.6 0.3 rg 400 80 120 40 re f" },
    ],
    font,
    bold,
  );
  return {
    name: "ocg-watermark",
    description: "3 paginas con dos capas: «Watermark» (texto gris girado) y «Capa de notas» (rectangulo verde, no es marca de agua).",
    bytes: await save(doc),
    truth: [{ cls: "wm-ab", tag: "capa Watermark", source: "ocg", kind: "watermark", pages: [0, 1, 2], layerName: "Watermark", minConfidence: 0.85, downloadable: true }],
  };
}

export async function makeOcgHidden(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const pages = [bodyPage(doc, font, bold, "Capa oculta por defecto")];
  addLayers(doc, pages, [{ name: "Marca de agua", visible: false, draw: (f) => textOps(f.bold, "BORRADOR", 100, 380, 80, 30, [0.8, 0.2, 0.2]) }], font, bold);
  return {
    name: "ocg-hidden",
    description: "1 capa «Marca de agua» apagada por defecto con el texto BORRADOR.",
    bytes: await save(doc),
    truth: [{ cls: "wm-ab", tag: "capa Marca de agua oculta", source: "ocg", kind: "watermark", pages: [0], layerName: "Marca de agua", minConfidence: 0.85, downloadable: true, reasonIncludes: "oculta" }],
  };
}

export async function makeWatermarkAnnot(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Anotacion Watermark");
  addWatermarkAnnotation(doc, p, [100, 380, 500, 470], "CONFIDENCIAL");
  return {
    name: "watermark-annot",
    description: "1 anotacion /Subtype /Watermark con apariencia de texto gris.",
    bytes: await save(doc),
    truth: [{ cls: "wm-ab", tag: "anotacion Watermark", source: "stamp-annot", kind: "watermark", pages: [0], minConfidence: 0.85, downloadable: true, reasonIncludes: "watermark" }],
  };
}

export async function makeTextWatermark6(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  for (let i = 0; i < 6; i += 1) {
    const page = bodyPage(doc, font, bold, `Texto translucido ${PAGE_NAMES[i]}`);
    page.drawText("USO INTERNO", { x: 110, y: 250, size: 64, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(40) });
  }
  return {
    name: "text-watermark-6",
    description: "6 paginas con «USO INTERNO» diagonal, translucido (ca=0,2) en todas.",
    bytes: await save(doc),
    truth: [{ cls: "wm-c", tag: "texto diagonal en 6/6", source: "text", kind: "watermark", pages: [0, 1, 2, 3, 4, 5], text: "USO INTERNO", minConfidence: 0.7, downloadable: true, reasonIncludes: "repetido en 6 de 6" }],
  };
}

export async function makeTextWatermarkTiled(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  for (let i = 0; i < 4; i += 1) {
    const page = bodyPage(doc, font, bold, `Mosaico ${PAGE_NAMES[i]}`);
    for (const [x, y] of [[60, 160], [60, 460], [300, 300]] as Array<[number, number]>) {
      page.drawText("Muestra", { x, y, size: 30, font, color: rgb(0.6, 0.6, 0.6), opacity: 0.25, rotate: degrees(30) });
    }
  }
  return {
    name: "text-watermark-tiled",
    description: "4 paginas con el texto «Muestra» en mosaico (3 veces por pagina), diagonal y translucido.",
    bytes: await save(doc),
    truth: [{ cls: "wm-c", tag: "mosaico en 4/4", source: "text", kind: "watermark", pages: [0, 1, 2, 3], text: "Muestra", minConfidence: 0.7, downloadable: true }],
  };
}

export async function makeTextWatermarkSinglePage(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  for (let i = 0; i < 6; i += 1) {
    const page = bodyPage(doc, font, bold, `Solo una pagina ${PAGE_NAMES[i]}`);
    if (i === 2) page.drawText("Nota interna de revision", { x: 90, y: 260, size: 48, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(40) });
    // Titulo grande OPACO: no es translucido, no cuenta aunque sea grande.
    if (i === 4) page.drawText("TITULO GRANDE", { x: 60, y: 600, size: 48, font: bold, color: rgb(0.1, 0.1, 0.1) });
  }
  return {
    name: "text-watermark-1of6",
    description: "6 paginas; texto diagonal translucido en una sola (no debe contar) y un titulo grande opaco.",
    bytes: await save(doc),
    truth: [],
  };
}

export async function makeFormStamps(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p1 = bodyPage(doc, font, bold, "Sellos de contenido");
  addFormStamp(doc, p1, [380, 480], [0.85, 0.05, 0.05], "circle", "RECIBIDO");
  // Señuelos: un rectangulo gris grande y un circulo negro: no son sellos de color saturado.
  addFormStamp(doc, p1, [60, 480], [0.4, 0.4, 0.4], "box", "GRIS");
  addFormStamp(doc, p1, [60, 100], [0.05, 0.05, 0.05], "circle", "NEGRO");
  const p2 = bodyPage(doc, font, bold, "Sellos de contenido 2");
  addFormStamp(doc, p2, [380, 480], [0.85, 0.05, 0.05], "circle", "RECIBIDO");
  const p3 = bodyPage(doc, font, bold, "Sellos de contenido 3");
  addFormStamp(doc, p3, [100, 200], [0.05, 0.2, 0.75], "box", "VERIFICADO", 120);
  return {
    name: "form-stamps",
    description: "Sello circular rojo «RECIBIDO» (Form XObject) repetido en 2 paginas, sello rectangular azul y dos senuelos sin color saturado.",
    bytes: await save(doc),
    truth: [
      { cls: "stamp", tag: "sello circular rojo (x2)", source: "form", kind: "stamp", pages: [0, 1], minConfidence: 0.5, maxConfidence: 0.75, downloadable: true, reasonIncludes: "circular" },
      { cls: "stamp", tag: "sello rectangular azul", source: "form", kind: "stamp", pages: [2], minConfidence: 0.5, maxConfidence: 0.75, downloadable: true, reasonIncludes: "rectangular" },
    ],
  };
}

export async function makeDecoys(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Senuelos sin elementos");
  const note = (dict: Record<string, unknown>): void => addAnnotation(doc, p, register(doc, { Type: "Annot", P: p.ref, F: 4, ...dict }));
  note({ Subtype: "Link", Rect: [56, 600, 200, 620], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.invalid/") } });
  note({ Subtype: "Highlight", Rect: [56, 560, 300, 575], QuadPoints: [56, 575, 300, 575, 56, 560, 300, 560], C: [1, 1, 0] });
  note({ Subtype: "Text", Rect: [400, 700, 420, 720], Contents: PDFString.of("Nota de prueba"), Name: "Note" });
  note({ Subtype: "FreeText", Rect: [56, 300, 300, 340], Contents: PDFString.of("Texto libre"), DA: PDFString.of("0 0 0 rg /Helv 12 Tf") });
  note({ Subtype: "Widget", FT: "Tx", T: PDFString.of("campoTexto"), Rect: [56, 200, 250, 225], V: PDFString.of("Valor") });
  // Una Ink OCULTA (bandera Hidden) no se extrae: el visor tampoco la muestra.
  addInk(doc, p, { strokes: [wave(300, 150, 150, 40, 3)], color: [0, 0, 0], width: 2, flags: 2 | 4 });
  return {
    name: "decoys",
    description: "Enlace, resaltado, nota, texto libre, campo de texto y una Ink con la bandera Hidden: ninguno debe dar un elemento.",
    bytes: await save(doc),
    truth: [],
  };
}

export async function makeTranslucentImages(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const png = await doc.embedPng(PNG_1X1);
  for (let i = 0; i < 6; i += 1) {
    const page = bodyPage(doc, font, bold, `Imagen translucida ${PAGE_NAMES[i]}`);
    page.drawImage(png, { x: 80, y: 200, width: 450, height: 380, opacity: 0.2 });
  }
  return {
    name: "translucent-image-6",
    description: "Imagen grande translucida (ca=0,2) repetida en 6 paginas: solo candidata (d); la imagen la entrega el motor de imagenes.",
    bytes: await save(doc),
    truth: [],
    translucentImagePages: [0, 1, 2, 3, 4, 5],
  };
}

export async function makeMixed(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const pages = [0, 1, 2, 3].map((i) => bodyPage(doc, font, bold, `Mixto ${PAGE_NAMES[i]}`));
  for (const page of pages) page.drawText("ESTADO DE CUENTA", { x: 130, y: 280, size: 58, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.18, rotate: degrees(38) });
  addInk(doc, pages[0], { strokes: [wave(90, 110, 200, 60, 3)], color: [0.05, 0.1, 0.7], width: 2.2 });
  addStamp(doc, pages[1], [380, 520, 520, 590], "box", [0.8, 0.05, 0.05], "PAGADO");
  addSigWidget(doc, pages[2], { rect: [60, 120, 260, 190], name: "SigMix", appearance: "strokes", signed: true });
  addFormStamp(doc, pages[3], [380, 400], [0.85, 0.05, 0.05], "circle", "COPIA");
  return {
    name: "mixed",
    description: "4 paginas con de todo: Ink, Stamp, /Sig firmado, sello de contenido y texto translucido repetido.",
    bytes: await save(doc),
    truth: [
      { cls: "ink", tag: "ink mixto", source: "ink-annot", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
      { cls: "stamp", tag: "stamp mixto", source: "stamp-annot", kind: "stamp", pages: [1], minConfidence: 0.85, downloadable: true },
      { cls: "sig", tag: "sig mixto firmado", source: "sig-widget", kind: "signature", pages: [2], minConfidence: 0.7, downloadable: true, digitalSignature: true },
      { cls: "stamp", tag: "sello de contenido mixto", source: "form", kind: "stamp", pages: [3], minConfidence: 0.5, downloadable: true },
      { cls: "wm-c", tag: "texto mixto 4/4", source: "text", kind: "watermark", pages: [0, 1, 2, 3], text: "ESTADO DE CUENTA", minConfidence: 0.7, downloadable: true },
    ],
    digitalSignaturePages: [2],
  };
}

/** Documento «cargado» para medir tiempos: `pages` paginas con una Ink, un Stamp, un texto translucido repetido y un /Sig cada 5. */
export async function makeBusyDocument(pages: number): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const truth: TruthItem[] = [];
  for (let i = 0; i < pages; i += 1) {
    const page = bodyPage(doc, font, bold, `Carga ${i + 1}`, 30);
    page.drawText("BORRADOR INTERNO", { x: 100, y: 260, size: 60, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(38) });
    addInk(doc, page, { strokes: [wave(90, 90, 200, 60, 3)], color: [0.05, 0.1, 0.7], width: 2.2 });
    addStamp(doc, page, [380, 80, 520, 150], "box", [0.8, 0.05, 0.05], "PAGADO");
    truth.push({ cls: "ink", tag: `ink ${i}`, source: "ink-annot", kind: "signature", pages: [i] }, { cls: "stamp", tag: `stamp ${i}`, source: "stamp-annot", kind: "stamp", pages: [i] });
    if (i % 5 === 0) {
      addSigWidget(doc, page, { rect: [60, 200, 250, 260], name: `Firma${i}`, appearance: "strokes" });
      truth.push({ cls: "sig", tag: `sig ${i}`, source: "sig-widget", kind: "signature", pages: [i] });
    }
  }
  truth.push({ cls: "wm-c", tag: "texto en todas", source: "text", kind: "watermark", pages: Array.from({ length: pages }, (_, i) => i), text: "BORRADOR INTERNO" });
  return { name: `busy-${pages}`, description: `${pages} paginas con Ink, Stamp, /Sig y texto translucido en cada una.`, bytes: await save(doc), truth };
}

/** Pagina con `/Rotate 90`: la firma se dibujo en la orientacion que VE el usuario, asi que en el espacio de usuario esta girada. */
export async function makeRotatedPage(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Pagina girada 90 grados");
  p.setRotation(degrees(90));
  // Trazos definidos en la VISTA (x a la derecha, y hacia abajo, 792 x 612): en usuario, x = y_vista, y = x_vista.
  const inView = wave(120, 380, 260, 70, 3).map(([vx, vy]) => [vy, vx] as Pt);
  addInk(doc, p, { strokes: [inView], color: [0.05, 0.1, 0.7], width: 2.4 });
  addStamp(doc, p, [60, 300, 130, 420], "box", [0.8, 0.05, 0.05], "GIRADO");
  return {
    name: "rotated-page",
    description: "Pagina con /Rotate 90: una Ink de proporcion de firma EN LA VISTA (alta en usuario) y un sello.",
    bytes: await save(doc),
    truth: [
      { cls: "ink", tag: "ink en pagina girada", source: "ink-annot", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
      { cls: "stamp", tag: "stamp en pagina girada", source: "stamp-annot", kind: "stamp", pages: [0], minConfidence: 0.85, downloadable: true },
    ],
  };
}

/** Bordes de la regla del 50 %: justo la mitad cuenta; un tercio, no; texto pequeno translucido y texto diagonal opaco, tampoco. */
export async function makeWatermarkEdges(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  for (let i = 0; i < 6; i += 1) {
    const page = bodyPage(doc, font, bold, `Bordes ${PAGE_NAMES[i]}`);
    if (i % 2 === 0) page.drawText("CONFIDENCIAL", { x: 120, y: 260, size: 60, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(35) });
    if (i === 1 || i === 4) page.drawText("REVISADO POR LEGAL", { x: 80, y: 330, size: 40, font: bold, color: rgb(0.5, 0.5, 0.5), opacity: 0.2, rotate: degrees(35) });
    page.drawText("pie de pagina translucido", { x: 56, y: 40, size: 9, font, color: rgb(0.2, 0.2, 0.2), opacity: 0.4 });
    page.drawText("COPIA FIEL", { x: 100, y: 120, size: 44, font: bold, color: rgb(0.3, 0.3, 0.3), rotate: degrees(20) });
  }
  return {
    name: "watermark-edges",
    description: "6 paginas: «CONFIDENCIAL» en 3 (50 %, cuenta), «REVISADO POR LEGAL» en 2 (33 %, no), pie translucido pequeno y «COPIA FIEL» diagonal OPACO (no cuentan).",
    bytes: await save(doc),
    truth: [{ cls: "wm-c", tag: "justo el 50 %", source: "text", kind: "watermark", pages: [0, 2, 4], text: "CONFIDENCIAL", minConfidence: 0.6, downloadable: true, reasonIncludes: "repetido en 3 de 6" }],
  };
}

/** Senuelos de sellos: figuras rojas que NO son sellos (enorme, una raya, solo texto) y un Stamp sin apariencia (no pinta nada). */
export async function makeStampDecoys(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Senuelos de sellos");
  const big = formStream(doc, [0, 0, 500, 500], "0.85 0.05 0.05 RG 0.85 0.05 0.05 rg 4 w 10 10 480 480 re S", {});
  const kBig = p.node.newXObject("Big", big).decodeText();
  const line = formStream(doc, [0, 0, 200, 10], "0.85 0.05 0.05 RG 3 w 0 5 m 200 5 l S", {});
  const kLine = p.node.newXObject("Line", line).decodeText();
  const onlyText = formStream(doc, [0, 0, 120, 30], "0.1 0.2 0.8 rg BT /F1 14 Tf 4 8 Td (SOLO TEXTO) Tj ET", { Font: { F1: register(doc, { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica-Bold" }) } });
  const kText = p.node.newXObject("Txt", onlyText).decodeText();
  addRawContent(doc, p, `q 0.5 0 0 0.5 300 150 cm /${kBig} Do Q q 1 0 0 1 60 140 cm /${kLine} Do Q q 1 0 0 1 60 100 cm /${kText} Do Q`);
  addAnnotation(doc, p, register(doc, { Type: "Annot", Subtype: "Stamp", Rect: [400, 600, 500, 650], Name: PDFName.of("Draft"), F: 4, P: p.ref }));
  return {
    name: "stamp-decoys",
    description: "Form XObjects rojos que no son sellos (500 pt de lado, una linea, solo texto) y un Stamp sin /AP: nada que extraer.",
    bytes: await save(doc),
    truth: [],
  };
}

/** Campos /Sig con las propiedades en el PADRE (`/Kids`), como los crean muchas herramientas: `FT`, `T` y `/V` se heredan. */
export async function makeSigKids(): Promise<AnnotFixture> {
  const { doc, font, bold } = await newDoc();
  const p = bodyPage(doc, font, bold, "Campos /Sig con padre");
  const widgetAp = (): PDFRef => formStream(doc, [0, 0, 190, 60], `0.05 0.15 0.6 RG 2 w 1 J 1 j ${strokeOps(wave(4, 4, 182, 52, 3))} S`);
  const sigValue = register(doc, { Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of("00".repeat(32)) });
  const parentSigned = doc.context.nextRef();
  const parentOpen = doc.context.nextRef();
  const kidSigned = register(doc, { Type: "Annot", Subtype: "Widget", Parent: parentSigned, Rect: [60, 120, 250, 180], F: 4, P: p.ref, AP: { N: widgetAp() } });
  const kidOpen = register(doc, { Type: "Annot", Subtype: "Widget", Parent: parentOpen, Rect: [330, 120, 520, 180], F: 4, P: p.ref, AP: { N: widgetAp() } });
  doc.context.assign(parentSigned, doc.context.obj({ FT: "Sig", T: PDFString.of("FirmaPadreFirmada"), V: sigValue, Kids: [kidSigned] } as never));
  doc.context.assign(parentOpen, doc.context.obj({ FT: "Sig", T: PDFString.of("FirmaPadreSinValor"), Kids: [kidOpen] } as never));
  addAnnotation(doc, p, kidSigned);
  addAnnotation(doc, p, kidOpen);
  addField(doc, parentSigned);
  addField(doc, parentOpen);
  return {
    name: "sig-kids",
    description: "Dos campos /Sig cuyos FT, T y /V estan en el padre: uno con /V (firmado) y otro sin valor.",
    bytes: await save(doc),
    truth: [
      { cls: "sig", tag: "sig hijo firmado", source: "sig-widget", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true, digitalSignature: true },
      { cls: "sig", tag: "sig hijo sin valor", source: "sig-widget", kind: "signature", pages: [0], minConfidence: 0.7, downloadable: true },
    ],
    digitalSignaturePages: [0],
  };
}

/** PDF «firmado» por el propio `signPdfMulti` (imagenes insertadas, sin /Sig ni anotaciones): este motor no debe inventar nada. */
export async function makeSignedByOptimus(): Promise<AnnotFixture> {
  const { signPdfMulti } = await import("@/lib/pdf/sign");
  const { doc, font, bold } = await newDoc();
  bodyPage(doc, font, bold, "Contrato firmado por OptimusPDF");
  bodyPage(doc, font, bold, "Contrato firmado por OptimusPDF 2");
  const original = await save(doc);
  const signature = await signaturePng();
  const blob = await signPdfMulti(new File([original as unknown as BlobPart], "contrato.pdf", { type: "application/pdf" }), {
    placements: [
      { kind: "image", png: signature, pageIndex: 0, rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.08 } },
      { kind: "image", png: signature, pageIndex: 1, rect: { x: 0.55, y: 0.8, width: 0.3, height: 0.08 } },
    ],
  });
  return {
    name: "signed-by-optimus",
    description: "PDF firmado por signPdfMulti: las firmas son IMAGENES (las entrega el motor de imagenes), sin /Sig ni anotaciones.",
    bytes: new Uint8Array(await blob.arrayBuffer()),
    truth: [],
  };
}

/** PNG (RGBA, fondo transparente) de una firma sintetica: discos de 2 px a lo largo de una curva por formula (sin canvas: Node y navegador). */
async function signaturePng(): Promise<Uint8Array> {
  const { encodePngBytes } = await import("@/lib/image/inkExtract");
  const width = 300;
  const height = 90;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [px, py] of wave(10, 10, 280, 70, 4, 0, 400)) {
    const cx = Math.round(px);
    const cy = Math.round(height - py);
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        if (dx * dx + dy * dy > 5) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        data.set([16, 42, 128, 255], (y * width + x) * 4);
      }
    }
  }
  return encodePngBytes({ width, height, data });
}

/** Corpus completo, en orden fijo. */
export async function buildAnnotCorpus(): Promise<AnnotFixture[]> {
  return [
    await makeInkMulti(),
    await makeStampAnnot(),
    await makeSigWidgets(),
    await makeOcgWatermark(),
    await makeOcgHidden(),
    await makeWatermarkAnnot(),
    await makeTextWatermark6(),
    await makeTextWatermarkTiled(),
    await makeTextWatermarkSinglePage(),
    await makeFormStamps(),
    await makeDecoys(),
    await makeTranslucentImages(),
    await makeMixed(),
    await makeRotatedPage(),
    await makeWatermarkEdges(),
    await makeStampDecoys(),
    await makeSigKids(),
    await makeSignedByOptimus(),
  ];
}
