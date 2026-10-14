import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  type PDFFont,
} from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createCanvas } from "@napi-rs/canvas";
import { jsPDF } from "jspdf";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTextEdits } from "@/lib/pdf/editTextExport";
import {
  glyphsMatch,
  isolateSharedContents,
  parseToUnicode,
  removeOriginalText,
  standardFontNameFor,
} from "@/lib/pdf/editTextRemove";
import { glyphProfile } from "@/lib/pdf/editTextProfile";
import { applyPageAssembly } from "@/lib/pdf/pageAssembly";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";
import { draftEditForBlock } from "@/app/edit-pdf/editCanvasMath";
import { analyzePageText } from "@/lib/pdf/textBlocks";
import { openWithPdfjs } from "@/lib/pdf/textBlocksFixtures";

/**
 * Wave 8 · F2: el texto original de un bloque editado se QUITA del flujo de
 * contenido. Cada caso genera un PDF real con pdf-lib (o con operadores
 * escritos a mano), aplica la edicion y comprueba con herramientas ajenas al
 * codigo bajo prueba:
 *  - pdf.js `getTextContent` (y `pdftotext` de poppler si esta instalado): el
 *    original ya no se extrae, el nuevo si y el resto queda identico;
 *  - pdf.js renderizado sobre canvas: fuera de la zona editada, 0 pixeles
 *    distintos respecto al PDF de partida;
 *  - pdf-lib vuelve a abrir el resultado.
 */

const STANDARD_FONTS_URL = path.join(process.cwd(), "public", "standard_fonts") + "/";
const FONTS_DIR = path.join(process.cwd(), "public", "fonts");

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
function getPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

type Item = { str: string; x: number; y: number; width: number };

async function extract(bytes: Uint8Array, pageNumber = 1): Promise<Item[]> {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_URL }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.length === 0) continue;
      items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
    }
    return items;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const strings = async (bytes: Uint8Array, page = 1) => (await extract(bytes, page)).map((i) => i.str);

let pdftotextAvailable: boolean | null = null;
function pdftotext(bytes: Uint8Array): string | null {
  if (pdftotextAvailable === null) {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      pdftotextAvailable = true;
    } catch {
      pdftotextAvailable = false;
    }
  }
  if (!pdftotextAvailable) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimus-f2-"));
  const file = path.join(dir, "in.pdf");
  fs.writeFileSync(file, bytes);
  try {
    return execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Raster = { width: number; height: number; data: Uint8ClampedArray; toPx: (x: number, y: number) => [number, number] };

async function render(bytes: Uint8Array, pageNumber = 1, scale = 2): Promise<Raster> {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONTS_URL }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    await page.render({ canvasContext: context, viewport } as never).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      data: image.data,
      toPx: (x, y) => {
        const [px, py] = viewport.convertToViewportPoint(x, y);
        return [px, py];
      },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

type Zone = { x: number; y: number; width: number; height: number };

/** Pixeles distintos entre dos renders, dentro y fuera de `zone` (espacio de usuario). */
function diffPixels(a: Raster, b: Raster, zone: Zone, margin = 2): { inside: number; outside: number } {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  const [zx0, zy1] = a.toPx(zone.x, zone.y);
  const [zx1, zy0] = a.toPx(zone.x + zone.width, zone.y + zone.height);
  const x0 = Math.min(zx0, zx1) - margin;
  const x1 = Math.max(zx0, zx1) + margin;
  const y0 = Math.min(zy0, zy1) - margin;
  const y1 = Math.max(zy0, zy1) + margin;
  let inside = 0;
  let outside = 0;
  for (let py = 0; py < a.height; py += 1) {
    for (let px = 0; px < a.width; px += 1) {
      const o = (py * a.width + px) * 4;
      const same = a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2];
      if (same) continue;
      if (px >= x0 && px < x1 && py >= y0 && py < y1) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}

function countIn(r: Raster, zone: Zone, predicate: (rgb: [number, number, number]) => boolean): number {
  const [zx0, zy1] = r.toPx(zone.x, zone.y);
  const [zx1, zy0] = r.toPx(zone.x + zone.width, zone.y + zone.height);
  let total = 0;
  for (let py = Math.floor(Math.min(zy0, zy1)); py < Math.ceil(Math.max(zy0, zy1)); py += 1) {
    for (let px = Math.floor(Math.min(zx0, zx1)); px < Math.ceil(Math.max(zx0, zx1)); px += 1) {
      const o = (py * r.width + px) * 4;
      if (predicate([r.data[o], r.data[o + 1], r.data[o + 2]])) total += 1;
    }
  }
  return total;
}

const isDark = ([r, g, b]: [number, number, number]) => r < 90 && g < 90 && b < 90;
const isBlue = ([r, g, b]: [number, number, number]) => b > 150 && r < 90 && g < 120;

async function pageContent(bytes: Uint8Array, index = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  let out = "";
  for (const entry of refs) {
    const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (stream instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Constructores de PDF
 * ------------------------------------------------------------------ */

/** Pagina 300x200 con el contenido escrito a mano; `F1` es Helvetica salvo que se de otra. */
async function rawPdf(
  content: string,
  options: { font?: StandardFonts; pages?: number; extra?: (doc: PDFDocument, font: PDFFont) => Promise<void> | void } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(options.font ?? StandardFonts.Helvetica);
  for (let i = 0; i < (options.pages ?? 1); i += 1) {
    const page = doc.addPage([300, 200]);
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
  }
  await options.extra?.(doc, font);
  return doc.save();
}

function edit(overrides: Partial<TextEdit> = {}): TextEdit {
  return {
    id: "e1",
    blockId: "p0-b0",
    pageIndex: 0,
    box: { x: 40, y: 95, width: 100, height: 24 },
    coverBox: { x: 40, y: 95, width: 100, height: 24 },
    text: "Nuevo",
    fontSize: 20,
    color: "#0000ff",
    align: "left",
    fontKey: "helvetica",
    bold: false,
    italic: false,
    rotation: 0,
    cover: { color: "#ffffff", padding: 1 },
    ...overrides,
  };
}

const removed = (w: { kind: string }[] | undefined) => w?.some((x) => x.kind === "original-text-removed") === true;
const remains = (w: { kind: string }[] | undefined) =>
  (w?.find((x) => x.kind === "original-text-remains") as { reason?: string } | undefined) ?? null;

/** Comprobaciones comunes: pdf.js, pdftotext, pdf-lib y pixeles fuera de la zona. */
async function expectRemoved(
  source: Uint8Array,
  result: Uint8Array,
  options: { gone: string[]; present: string[]; zone: Zone; page?: number; untouched?: string[] },
): Promise<void> {
  const page = options.page ?? 1;
  const after = await strings(result, page);
  const before = await strings(source, page);
  for (const gone of options.gone) {
    expect(before.join(" ")).toContain(gone);
    expect(after.join(" ")).not.toContain(gone);
  }
  for (const present of options.present) expect(after.join(" ")).toContain(present);
  for (const text of options.untouched ?? []) expect(after.join(" ")).toContain(text);
  const text = pdftotext(result);
  if (text !== null) {
    for (const gone of options.gone) expect(text).not.toContain(gone);
    for (const present of options.present) expect(text).toContain(present);
  }
  const loaded = await PDFDocument.load(result);
  expect(loaded.getPageCount()).toBeGreaterThan(0);
  const diff = diffPixels(await render(source, page), await render(result, page), options.zone);
  expect(diff.outside).toBe(0);
  expect(diff.inside).toBeGreaterThan(0);
}

/* ------------------------------------------------------------------ *
 * Casos
 * ------------------------------------------------------------------ */

describe("removeOriginalText — src/lib/pdf/editTextRemove.ts", () => {
  it("fuente estandar (Helvetica): el original desaparece de pdf.js y pdftotext, el nuevo aparece y el resto no cambia", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET BT /F1 12 Tf 40 30 Td (Pie de pagina) Tj ET");
    const result = await applyTextEdits(source, [edit({ text: "Cambiado", originalGlyphs: glyphProfile("Original") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(remains(result.warningsByEdit.e1)).toBeNull();
    await expectRemoved(source, result.bytes, {
      gone: ["Original"],
      present: ["Cambiado"],
      untouched: ["Pie de pagina"],
      zone: { x: 39, y: 94, width: 102, height: 26 },
    });
    // En el flujo ya no esta la cadena (ni en claro ni en hex).
    const content = await pageContent(result.bytes);
    expect(content).not.toContain("(Original)");
    expect(content).toContain("(Pie de pagina)");
  });

  it("fuente estandar (Times) con Td relativo y varias lineas en el mismo BT: solo caen las lineas del bloque", async () => {
    const source = await rawPdf(
      "BT /F1 20 Tf 40 150 Td (Linea uno) Tj 0 -24 Td (Linea dos) Tj 0 -60 Td (Otra cosa) Tj ET",
      { font: StandardFonts.TimesRoman },
    );
    const result = await applyTextEdits(source, [
      edit({ box: { x: 40, y: 120, width: 120, height: 52 }, coverBox: { x: 40, y: 120, width: 120, height: 52 }, text: "Bloque" }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, {
      gone: ["Linea uno", "Linea dos"],
      present: ["Bloque"],
      untouched: ["Otra cosa"],
      zone: { x: 39, y: 119, width: 122, height: 54 },
    });
    const otra = (await extract(result.bytes)).find((i) => i.str === "Otra cosa")!;
    expect(otra.x).toBeCloseTo(40, 3);
    expect(otra.y).toBeCloseTo(66, 3);
  });

  it("TrueType embebida con subconjunto (Identity-H, 2 bytes por codigo): se quita y el resto queda", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const ttf = fs.readFileSync(path.join(FONTS_DIR, "LiberationSans-Regular.ttf"));
    const font = await doc.embedFont(ttf, { subset: true });
    const page = doc.addPage([300, 200]);
    page.drawText("Importe 1.250,00", { x: 40, y: 100, size: 18, font });
    page.drawText("Cliente ACME", { x: 40, y: 60, size: 18, font });
    const source = await doc.save();
    const width = font.widthOfTextAtSize("Importe 1.250,00", 18);
    const result = await applyTextEdits(source, [
      edit({
        box: { x: 40, y: 95, width, height: 22 },
        coverBox: { x: 40, y: 95, width, height: 22 },
        text: "Importe 999,00",
        fontSize: 18,
        originalGlyphs: glyphProfile("Importe 1.250,00"),
      }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, {
      gone: ["1.250,00"],
      present: ["999,00"],
      untouched: ["Cliente ACME"],
      zone: { x: 39, y: 94, width: width + 2, height: 24 },
    });
  });

  it("TJ con kerning: el bloque entero (con sus ajustes) se quita y un vecino a la derecha en el mismo TJ no se mueve", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td [(Ori) -30 (gi) 25 (nal)] TJ ET BT /F1 20 Tf 200 100 Td (Fin) Tj ET");
    const before = await extract(source);
    const result = await applyTextEdits(source, [edit({ text: "X", originalGlyphs: glyphProfile("Original") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, {
      gone: ["Original"],
      present: ["X"],
      untouched: ["Fin"],
      zone: { x: 39, y: 94, width: 102, height: 26 },
    });
    const finBefore = before.find((i) => i.str === "Fin")!;
    const finAfter = (await extract(result.bytes)).find((i) => i.str === "Fin")!;
    expect(finAfter.x).toBeCloseTo(finBefore.x, 3);
  });

  it("linea parcial: solo cae el tramo del bloque y el resto de la linea no se desplaza ni un punto", async () => {
    // Una sola linea en tres Tj consecutivos: "Precio: " + "100" + " EUR".
    const content = "BT /F1 20 Tf 40 100 Td (Precio: ) Tj (100) Tj ( EUR) Tj ET";
    const source = await rawPdf(content);
    const before = await extract(source);
    // Caja exacta del tramo "100" con las metricas reales de Helvetica a 20 pt.
    const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const x = 40 + helvetica.widthOfTextAtSize("Precio: ", 20);
    const width = helvetica.widthOfTextAtSize("100", 20);
    const result = await applyTextEdits(source, [
      edit({
        box: { x, y: 95, width, height: 24 },
        coverBox: { x, y: 95, width, height: 24 },
        text: "250",
      }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(before.map((i) => i.str).join("")).toContain("100");
    // Fuera de la caja de "100" (margen 2 px) ni un pixel cambia: "Precio: " y " EUR" siguen donde estaban.
    await expectRemoved(source, result.bytes, {
      gone: ["100"],
      present: ["250"],
      untouched: ["Precio", "EUR"],
      zone: { x: x - 1, y: 94, width: width + 2, height: 26 },
    });
    // Los tres glifos salen del operador y queda SOLO su avance como ajuste de TJ entre los vecinos.
    expect(await pageContent(result.bytes)).toMatch(/\(Precio: \) Tj \[-\d+(\.\d+)?\] TJ \( EUR\) Tj/);
    // El avance se conservo como ajuste de TJ en el flujo.
    const stream = await pageContent(result.bytes);
    expect(stream).toContain("TJ");
    expect(stream).not.toContain("(100)");
    expect(stream).toContain("(Precio: )");
  });

  it("dos bloques casi pegados: solo cae el editado y el vecino conserva su posicion exacta", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (AAA) Tj ET BT /F1 20 Tf 82 100 Td (BBB) Tj ET");
    const before = await extract(source);
    const result = await applyTextEdits(source, [
      edit({
        box: { x: 40, y: 95, width: 41, height: 24 },
        coverBox: { x: 40, y: 95, width: 41, height: 24 },
        obstacles: [{ id: "p0-b1", box: { x: 82, y: 95, width: 41, height: 24 } }],
        text: "ZZ",
      }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const after = await extract(result.bytes);
    expect(after.map((i) => i.str).join(" ")).not.toContain("AAA");
    expect(after.map((i) => i.str).join(" ")).toContain("BBB");
    // Antes pdf.js funde "AAA" y "BBB" (2 pt de hueco) en un fragmento que empieza en 40;
    // despues "BBB" es un fragmento propio que empieza exactamente donde se escribio (82).
    expect(before.some((i) => i.str.includes("BBB"))).toBe(true);
    const bbbAfter = after.find((i) => i.str === "BBB")!;
    expect(bbbAfter.x).toBeCloseTo(82, 3);
    // Y en pixeles: fuera de la caja de "AAA" no cambia nada.
    const diff = diffPixels(await render(source), await render(result.bytes), { x: 39, y: 94, width: 43, height: 26 });
    expect(diff.outside).toBe(0);
    const text = pdftotext(result.bytes);
    if (text !== null) {
      expect(text).not.toContain("AAA");
      expect(text).toContain("BBB");
    }
  });

  it("caja que invade a un vecino declarado (obstacles): no se borra NADA y se avisa ambiguous", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (AAA) Tj ET BT /F1 20 Tf 82 100 Td (BBB) Tj ET");
    const result = await applyTextEdits(source, [
      edit({
        // Caja demasiado ancha: cubre tambien "BBB", que es un bloque vecino.
        box: { x: 40, y: 95, width: 90, height: 24 },
        coverBox: { x: 40, y: 95, width: 90, height: 24 },
        obstacles: [{ id: "p0-b1", box: { x: 82, y: 95, width: 41, height: 24 } }],
        text: "ZZ",
        cover: { color: null, padding: 0 },
      }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const names = (await strings(result.bytes)).join(" ");
    expect(names).toContain("AAA");
    expect(names).toContain("BBB");
  });

  it("texto en un Form XObject propio de la pagina: se quita dentro del XObject", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    const xobject = doc.context.register(
      doc.context.stream("BT /F1 20 Tf 0 0 Td (Dentro) Tj ET BT /F1 20 Tf 0 -50 Td (Queda) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, -100, 300, 100],
        Matrix: [1, 0, 0, 1, 40, 100],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Fuera" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, {
      gone: ["Dentro"],
      present: ["Fuera"],
      untouched: ["Queda"],
      zone: { x: 39, y: 94, width: 102, height: 26 },
    });
  });

  it("texto en un Form XObject COMPARTIDO por dos paginas: no se toca y se avisa shared-xobject", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const xobject = doc.context.register(
      doc.context.stream("BT /F1 20 Tf 0 0 Td (Original) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, -20, 300, 40],
        Matrix: [1, 0, 0, 1, 40, 100],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.setXObject(PDFName.of("Fx"), xobject);
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
    }
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
    expect(await strings(result.bytes, 1)).toContain("Original");
    expect(await strings(result.bytes, 2)).toEqual(["Original"]);
  });

  it("texto girado 90 grados: se quita y la cobertura envolvente no toca nada mas", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText("Vertical", { x: 100, y: 40, size: 20, font, rotate: degrees(90) });
    page.drawText("Plano", { x: 150, y: 100, size: 20, font });
    const source = await doc.save();
    const length = font.widthOfTextAtSize("Vertical", 20);
    const cover = { x: 80, y: 36, width: 25, height: length + 8 };
    const result = await applyTextEdits(source, [
      edit({ box: cover, coverBox: cover, text: "Subida", rotation: 90 }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, {
      gone: ["Vertical"],
      present: ["Subida"],
      untouched: ["Plano"],
      zone: { x: 79, y: 35, width: 27, height: length + 10 },
    });
  });

  it("fuente Type3: no se toca y se mantiene el aviso original-text-remains con reason type3", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const glyph = doc.context.register(doc.context.stream("1000 0 0 0 750 750 d1 0 0 750 750 re f"));
    const type3 = doc.context.register(
      doc.context.obj({
        Type: "Font",
        Subtype: "Type3",
        FontBBox: [0, 0, 750, 750],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { square: glyph },
        Encoding: { Type: "Encoding", Differences: [97, "square"] },
        FirstChar: 97,
        LastChar: 97,
        Widths: [1000],
        Resources: {},
      }),
    );
    page.node.setFontDictionary(PDFName.of("T3"), type3);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("BT /T3 20 Tf 40 100 Td (aaa) Tj ET")));
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "type3" });
    expect(await pageContent(result.bytes)).toContain("(aaa) Tj");
  });

  it("texto invisible (Tr 3, capa OCR) y de recorte (Tr 7): no se quitan y se avisa con su razon", async () => {
    const invisible = await rawPdf("BT /F1 20 Tf 3 Tr 40 100 Td (Oculto) Tj ET");
    const r1 = await applyTextEdits(invisible, [edit({ text: "Nuevo" })]);
    expect(remains(r1.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "invisible" });
    expect(await pageContent(r1.bytes)).toContain("(Oculto) Tj");
    const clip = await rawPdf("q BT /F1 20 Tf 7 Tr 40 100 Td (Mascara) Tj ET 0 0 1 rg 0 0 300 200 re f Q");
    const r2 = await applyTextEdits(clip, [edit({ text: "Nuevo" })]);
    expect(remains(r2.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "clip" });
    expect(await pageContent(r2.bytes)).toContain("(Mascara) Tj");
  });

  it("caja sin texto debajo (bloque de otra fuente de datos): aviso not-found y el flujo queda intacto", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 30 Td (Abajo) Tj ET");
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "not-found" });
    expect(await strings(result.bytes)).toContain("Abajo");
  });

  it("pagina con varias ediciones: cada bloque editado desaparece y los demas quedan en su sitio", async () => {
    const source = await rawPdf(
      "BT /F1 20 Tf 40 160 Td (Uno) Tj ET BT /F1 20 Tf 40 120 Td (Dos) Tj ET BT /F1 20 Tf 40 80 Td (Tres) Tj ET BT /F1 20 Tf 40 40 Td (Cuatro) Tj ET",
    );
    const before = await extract(source);
    const result = await applyTextEdits(source, [
      edit({ id: "a", blockId: "p0-b0", box: { x: 40, y: 155, width: 60, height: 24 }, coverBox: { x: 40, y: 155, width: 60, height: 24 }, text: "1" }),
      edit({ id: "c", blockId: "p0-b2", box: { x: 40, y: 75, width: 60, height: 24 }, coverBox: { x: 40, y: 75, width: 60, height: 24 }, text: "3" }),
    ]);
    expect(removed(result.warningsByEdit.a)).toBe(true);
    expect(removed(result.warningsByEdit.c)).toBe(true);
    const after = await extract(result.bytes);
    const names = after.map((i) => i.str);
    expect(names).not.toContain("Uno");
    expect(names).not.toContain("Tres");
    expect(names).toEqual(expect.arrayContaining(["Dos", "Cuatro", "1", "3"]));
    for (const kept of ["Dos", "Cuatro"]) {
      const b = before.find((i) => i.str === kept)!;
      const a = after.find((i) => i.str === kept)!;
      expect(a.x).toBeCloseTo(b.x, 3);
      expect(a.y).toBeCloseTo(b.y, 3);
    }
    const text = pdftotext(result.bytes);
    if (text !== null) {
      expect(text).not.toContain("Uno");
      expect(text).not.toContain("Tres");
      expect(text).toContain("Dos");
      expect(text).toContain("Cuatro");
    }
  });

  it("operadores ' y \": se quitan conservando el salto de linea y el espaciado del resto", async () => {
    const source = await rawPdf("BT /F1 20 Tf 24 TL 40 124 Td (Arriba) Tj (Original) ' 2 0.5 (Abajo) \" ET");
    const before = await extract(source);
    const result = await applyTextEdits(source, [edit({ text: "Nuevo", originalGlyphs: glyphProfile("Original") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const after = await extract(result.bytes);
    expect(after.map((i) => i.str)).not.toContain("Original");
    for (const kept of ["Arriba", "Abajo"]) {
      const b = before.find((i) => i.str.startsWith(kept))!;
      const a = after.find((i) => i.str.startsWith(kept))!;
      expect(a.x).toBeCloseTo(b.x, 3);
      expect(a.y).toBeCloseTo(b.y, 3);
      expect(a.width).toBeCloseTo(b.width, 2);
    }
  });

  it("la zona editada queda como se espera: sin tinta oscura del original y con el texto nuevo azul", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET");
    const result = await applyTextEdits(source, [edit({ text: "Nuevo", cover: { color: "#ffffff", padding: 1 } })]);
    const raster = await render(result.bytes);
    const zone = { x: 39, y: 94, width: 102, height: 26 };
    expect(countIn(raster, zone, isDark)).toBe(0);
    expect(countIn(raster, zone, isBlue)).toBeGreaterThan(10);
  });

  it("imagen en linea (BI/ID/EI) y graficos antes del texto no rompen el analisis", async () => {
    const source = await rawPdf(
      "q 0 0 1 rg 10 10 50 50 re f Q q 20 0 0 20 200 150 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q BT /F1 20 Tf 40 100 Td (Original) Tj ET",
    );
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    await expectRemoved(source, result.bytes, { gone: ["Original"], present: ["Nuevo"], zone: { x: 39, y: 94, width: 102, height: 26 } });
  });

  it("removeOriginalText directo: devuelve un resultado por edicion y no lanza con un flujo roto", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("BT /F9 20 Tf 40 100 Td (Sin fuente) Tj ET")));
    const outcomes = removeOriginalText(doc, page, [edit()]);
    expect(outcomes).toEqual([{ editId: "e1", removed: false, glyphs: 0, reason: "widths" }]);
  });

  it("standardFontNameFor reconoce alias de Arial, Times New Roman y Courier New", () => {
    expect(standardFontNameFor("ABCDEF+Arial-BoldMT")).toBe("Helvetica-Bold");
    expect(standardFontNameFor("TimesNewRomanPS-ItalicMT")).toBe("Times-Italic");
    expect(standardFontNameFor("CourierNewPSMT")).toBe("Courier");
    expect(standardFontNameFor("Helvetica")).toBe("Helvetica");
    expect(standardFontNameFor("Roboto-Regular")).toBeNull();
  });
});

describe("integracion con applyTextEdits", () => {
  it("texto nuevo (sin blockId) no dispara ni quita nada", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET");
    const result = await applyTextEdits(source, [edit({ blockId: undefined, coverBox: undefined, cover: { color: null, padding: 0 }, box: { x: 40, y: 20, width: 100, height: 24 } })]);
    expect(result.warningsByEdit.e1 ?? []).toEqual([]);
    expect(await strings(result.bytes)).toEqual(expect.arrayContaining(["Original", "Nuevo"]));
  });

  it("acepta un PDFDocument ya cargado (vista previa) con dos ediciones a la vez", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET BT /F1 20 Tf 40 40 Td (Segundo) Tj ET");
    const doc = await PDFDocument.load(source);
    const result = await applyTextEdits(doc, [
      edit({ text: "Uno" }),
      edit({ id: "e2", blockId: "p0-b1", box: { x: 40, y: 35, width: 100, height: 24 }, coverBox: { x: 40, y: 35, width: 100, height: 24 }, text: "Dos" }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(removed(result.warningsByEdit.e2)).toBe(true);
    const names = await strings(result.bytes);
    expect(names).not.toContain("Original");
    expect(names).not.toContain("Segundo");
    expect(names).toEqual(expect.arrayContaining(["Uno", "Dos"]));
  });
});


/* ------------------------------------------------------------------ *
 * F2 · correcciones del verificador (REFUTED): flujos y XObjects compartidos,
 * validacion de glifos, filtro de tamano y ToUnicode
 * ------------------------------------------------------------------ */

const allText = async (bytes: Uint8Array, pages: number) => {
  const out: string[] = [];
  for (let i = 1; i <= pages; i += 1) out.push((await strings(bytes, i)).join(" "));
  return out;
};

const sameDiff = async (a: Uint8Array, aPage: number, b: Uint8Array, bPage: number) => {
  const none: Zone = { x: 0, y: 0, width: 0, height: 0 };
  return diffPixels(await render(a, aPage), await render(b, bPage), none, 0);
};

describe("F2 · flujo de contenido compartido entre paginas (copy-on-write)", () => {
  const shared = "BT /F1 20 Tf 40 100 Td (Original) Tj ET BT /F1 12 Tf 40 30 Td (Pie comun) Tj ET";

  /** Dos paginas con el MISMO flujo `/Contents` (lo que deja duplicar una pagina con el motor). */
  async function twoPagesSameStream(): Promise<{ bytes: Uint8Array; ref: PDFRef }> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ref = doc.context.register(doc.context.stream(shared));
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.setFontDictionary(PDFName.of("F1"), font.ref);
      page.node.set(PDFName.of("Contents"), ref);
    }
    return { bytes: await doc.save(), ref };
  }

  it("dos paginas con el mismo flujo: editar la 1 quita SU texto y la 2 conserva el suyo (pdf.js, pdftotext y 0 px)", async () => {
    const { bytes: source } = await twoPagesSameStream();
    const loaded = await PDFDocument.load(source);
    const contents = loaded.getPages().map((p) => p.node.get(PDFName.of("Contents"))?.toString());
    expect(contents[0]).toBe(contents[1]); // precondicion: de verdad comparten el flujo
    const result = await applyTextEdits(source, [edit({ text: "Nuevo", originalGlyphs: glyphProfile("Original") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).not.toContain("Original");
    expect(p1).toContain("Nuevo");
    expect(p1).toContain("Pie comun");
    expect(p2).toContain("Original"); // el texto AJENO sigue
    expect(p2).not.toContain("Nuevo");
    const text = pdftotext(result.bytes);
    if (text !== null) {
      expect(text.split("Original").length - 1).toBe(1); // solo la copia de la pagina 2
      expect(text).toContain("Nuevo");
    }
    // Pagina 2: ni un pixel de diferencia. Pagina 1: nada fuera de la zona editada.
    expect((await sameDiff(source, 2, result.bytes, 2)).outside).toBe(0);
    const diff1 = diffPixels(await render(source, 1), await render(result.bytes, 1), { x: 39, y: 94, width: 102, height: 26 });
    expect(diff1.outside).toBe(0);
    expect(diff1.inside).toBeGreaterThan(0);
    // Los paginas ya no comparten flujo y el original esta intacto byte a byte.
    const after = await PDFDocument.load(result.bytes);
    const refs = after.getPages().map((p) => p.node.get(PDFName.of("Contents"))?.toString());
    expect(refs[0]).not.toBe(refs[1]);
    expect(await pageContent(result.bytes, 1)).toBe(await pageContent(source, 1));
  });

  it("ambas paginas editadas a la vez: cada una pierde el suyo y conserva el otro texto", async () => {
    const { bytes: source } = await twoPagesSameStream();
    const result = await applyTextEdits(source, [
      edit({ id: "e1", text: "Uno" }),
      edit({ id: "e2", pageIndex: 1, blockId: "p1-b0", text: "Dos" }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(removed(result.warningsByEdit.e2)).toBe(true);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).not.toContain("Original");
    expect(p2).not.toContain("Original");
    expect(p1).toContain("Uno");
    expect(p2).toContain("Dos");
    expect(p1).not.toContain("Dos");
    expect(p2).not.toContain("Uno");
    expect(p1).toContain("Pie comun");
    expect(p2).toContain("Pie comun");
  });

  it("/Contents como array con un flujo compartido solo a medias: el compartido se clona, el propio se reescribe en su sitio", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const a = doc.context.register(doc.context.stream("BT /F1 20 Tf 40 100 Td (Original) Tj ET"));
    const b = doc.context.register(doc.context.stream("BT /F1 20 Tf 40 50 Td (Propio) Tj ET"));
    const c = doc.context.register(doc.context.stream("BT /F1 20 Tf 40 50 Td (Ajeno) Tj ET"));
    for (const second of [b, c]) {
      const page = doc.addPage([300, 200]);
      page.node.setFontDictionary(PDFName.of("F1"), font.ref);
      page.node.set(PDFName.of("Contents"), doc.context.obj([a, second]));
    }
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).not.toContain("Original");
    expect(p1).toContain("Propio");
    expect(p1).toContain("Nuevo");
    expect(p2).toContain("Original");
    expect(p2).toContain("Ajeno");
    expect((await sameDiff(source, 2, result.bytes, 2)).outside).toBe(0);
    // Edicion sobre el flujo PROPIO (b) con a compartido: sigue funcionando sin tocar la pagina 2.
    const own = await applyTextEdits(source, [
      edit({ text: "Mio", box: { x: 40, y: 45, width: 100, height: 24 }, coverBox: { x: 40, y: 45, width: 100, height: 24 } }),
    ]);
    expect(removed(own.warningsByEdit.e1)).toBe(true);
    const [q1, q2] = await allText(own.bytes, 2);
    expect(q1).not.toContain("Propio");
    expect(q1).toContain("Original");
    expect(q2).toContain("Ajeno");
    expect(q2).toContain("Original");
  });

  it("el array /Contents es un objeto indirecto compartido por las dos paginas: tampoco se reescribe en su sitio", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const stream = doc.context.register(doc.context.stream(shared));
    const array = doc.context.register(doc.context.obj([stream]));
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.setFontDictionary(PDFName.of("F1"), font.ref);
      page.node.set(PDFName.of("Contents"), array);
    }
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).not.toContain("Original");
    expect(p2).toContain("Original");
  });

  it("pagina duplicada con el motor de paginas (pageAssembly) y luego editada: la copia conserva su texto", async () => {
    const source = await rawPdf(shared);
    const dup = await applyPageAssembly(source, [
      { kind: "existing", sourceIndex: 0, rotation: 0 },
      { kind: "existing", sourceIndex: 0, rotation: 0, copy: true },
    ]);
    const loaded = await PDFDocument.load(dup.bytes);
    expect(loaded.getPageCount()).toBe(2);
    const contents = loaded.getPages().map((p) => p.node.get(PDFName.of("Contents"))?.toString());
    expect(contents[0]).toBe(contents[1]); // el motor comparte el flujo: es el caso del defecto
    expect(await allText(dup.bytes, 2)).toEqual(["Original Pie comun", "Original Pie comun"]);
    const result = await applyTextEdits(dup.bytes, [edit({ text: "Nuevo", originalGlyphs: glyphProfile("Original") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(remains(result.warningsByEdit.e1)).toBeNull();
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).not.toContain("Original");
    expect(p1).toContain("Nuevo");
    expect(p2).toContain("Original");
    expect(p2).toContain("Pie comun");
    const text = pdftotext(result.bytes);
    if (text !== null) expect(text.split("Original").length - 1).toBe(1);
    expect((await sameDiff(dup.bytes, 2, result.bytes, 2)).outside).toBe(0);
  });
});

describe("F2 · Form XObject pintado varias veces o usado por otros", () => {
  async function xobjectDoc(options: { paints: string; annotation?: boolean }): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const xobject = doc.context.register(
      doc.context.stream("BT /F1 20 Tf 0 0 Td (Original) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, -20, 300, 40],
        Matrix: [1, 0, 0, 1, 40, 100],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    const page = doc.addPage([300, 200]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(options.paints)));
    if (options.annotation) {
      const annot = doc.context.register(
        doc.context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [40, 80, 200, 140], F: 4, AP: { N: xobject } }),
      );
      page.node.set(PDFName.of("Annots"), doc.context.obj([annot]));
    }
    return doc.save();
  }

  it("el mismo XObject pintado DOS veces en la pagina (otra matriz): no se reescribe, las dos copias quedan y se avisa shared-xobject", async () => {
    const source = await xobjectDoc({ paints: "q /Fx Do Q q 1 0 0 1 0 -80 cm /Fx Do Q" });
    expect(await strings(source)).toEqual(["Original", "Original"]);
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
    const names = await strings(result.bytes);
    expect(names.filter((n) => n === "Original")).toHaveLength(2); // ninguna copia pierde su texto
    expect(names).toContain("Nuevo");
    // El segundo, fuera de la zona editada, no cambia ni un pixel.
    const diff = diffPixels(await render(source), await render(result.bytes), { x: 39, y: 94, width: 102, height: 26 });
    expect(diff.outside).toBe(0);
    const text = pdftotext(result.bytes);
    if (text !== null) expect(text.split("Original").length - 1).toBe(2);
  });

  it("pintado dos veces y la edicion cae en la SEGUNDA pintada: tambien se deja (el orden ya no decide)", async () => {
    const source = await xobjectDoc({ paints: "q 1 0 0 1 0 80 cm /Fx Do Q q /Fx Do Q" });
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
    expect((await strings(result.bytes)).filter((n) => n === "Original")).toHaveLength(2);
  });

  it("un XObject pintado UNA vez sigue limpiandose en su sitio (sin regresion)", async () => {
    const source = await xobjectDoc({ paints: "q /Fx Do Q" });
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    expect(await strings(result.bytes)).not.toContain("Original");
  });

  it("dos paginas con flujos propios pero el MISMO /Resources indirecto: el XObject lo usa tambien la otra y no se toca", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const xobject = doc.context.register(
      doc.context.stream("BT /F1 20 Tf 0 0 Td (Original) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, -20, 300, 40],
        Matrix: [1, 0, 0, 1, 40, 100],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    const resources = doc.context.register(doc.context.obj({ XObject: { Fx: xobject } }));
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.set(PDFName.of("Resources"), resources);
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
    }
    const source = await doc.save();
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
    expect(await strings(result.bytes, 2)).toEqual(["Original"]);
  });

  it("el XObject lo usa ademas una anotacion (apariencia): no se reescribe", async () => {
    const source = await xobjectDoc({ paints: "q /Fx Do Q", annotation: true });
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
  });
});

describe("F2 · validacion de los glifos quitados contra el texto del bloque", () => {
  it("cobertura ~10 % mas estrecha que el texto real: no se marca eliminado, no se quita NADA y se avisa ambiguous", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET");
    const helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const full = helvetica.widthOfTextAtSize("Original", 20);
    const narrow = { x: 40, y: 95, width: full * 0.85, height: 24 };
    // Sin perfil (como antes): quita lo que cae en la caja y queda un resto extraible.
    const legacy = await applyTextEdits(source, [edit({ box: narrow, coverBox: narrow, text: "Nuevo" })]);
    expect(removed(legacy.warningsByEdit.e1)).toBe(true);
    // Con el perfil del texto original: no cuadra, asi que no se fia.
    const result = await applyTextEdits(source, [
      edit({ box: narrow, coverBox: narrow, text: "Nuevo", originalGlyphs: glyphProfile("Original") }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    expect(await pageContent(result.bytes)).toContain("(Original)");
    expect(await strings(result.bytes)).toContain("Original");
  });

  it("sobran glifos: texto de OTRO bloque dentro de la caja (sin declarar como vecino) no se borra", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ( y vecino) Tj ET");
    const wide = { x: 40, y: 95, width: 220, height: 24 };
    const result = await applyTextEdits(source, [
      edit({ box: wide, coverBox: wide, text: "Nuevo", originalGlyphs: glyphProfile("Original") }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    expect(await pageContent(result.bytes)).toContain("( y vecino)");
  });

  it("glyphsMatch: exacto con ToUnicode, con holgura de ligaduras sin el, y rechaza los que faltan o sobran", () => {
    const exact = (text: string) => ({ text, exact: true });
    const letters = (word: string) => [...word].map(exact);
    expect(glyphsMatch(glyphProfile("Total 1250"), [...letters("Total"), exact(" "), ...letters("1250")])).toBe(true);
    expect(glyphsMatch(glyphProfile("Total 1250"), [...letters("Total"), ...letters("125")])).toBe(false); // falta uno
    expect(glyphsMatch(glyphProfile("Total 1250"), [...letters("Total"), ...letters("12500")])).toBe(false); // sobra uno
    // Ligadura fi con ToUnicode: un glifo, dos caracteres.
    expect(glyphsMatch(glyphProfile("fino"), [exact("ﬁ"), ...letters("no")])).toBe(true);
    // Sin ToUnicode (estimacion de un caracter por codigo): la ligadura se admite, pero no mas de lo posible.
    const approx = (text: string) => ({ text, exact: false });
    expect(glyphsMatch(glyphProfile("office"), [...["o", "ÿ", "c", "e"].map(approx)])).toBe(true);
    expect(glyphsMatch(glyphProfile("fino"), [...["f", "i", "n", "o", "x"].map(approx)])).toBe(false);
    // Un codigo sin entrada puede ser un espacio.
    expect(glyphsMatch(glyphProfile("ab"), [exact("a"), exact("b"), null])).toBe(true);
    expect(glyphsMatch(glyphProfile("abc"), [exact("a"), exact("b"), null, null])).toBe(true);
    expect(glyphsMatch(glyphProfile("abcde"), [exact("a"), exact("b"), null])).toBe(false);
  });

  it("parseToUnicode lee bfchar y bfrange (con lista y con incremento)", () => {
    const map = parseToUnicode(
      "1 beginbfchar <0003> <0020> <0004> <00660069> endbfchar 2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<0061> <0062>] endbfrange",
    );
    expect(map.get(3)).toBe(" ");
    expect(map.get(4)).toBe("fi");
    expect([map.get(0x10), map.get(0x11), map.get(0x12)]).toEqual(["A", "B", "C"]);
    expect([map.get(0x20), map.get(0x21)]).toEqual(["a", "b"]);
  });
});

describe("F2 · filtro de tamano de glifo", () => {
  it("un texto de tamano muy distinto dentro de la misma caja (nota minuscula, letra enorme) NO se borra", async () => {
    const source = await rawPdf(
      "BT /F1 20 Tf 40 100 Td (Original) Tj ET BT /F1 5 Tf 60 108 Td (nota) Tj ET BT /F1 40 Tf 120 100 Td (I) Tj ET",
    );
    expect(await strings(source)).toEqual(expect.arrayContaining(["Original", "nota", "I"]));
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(true);
    const names = await strings(result.bytes);
    expect(names).not.toContain("Original");
    expect(names).toContain("nota");
    expect(names).toContain("I");
    const content = await pageContent(result.bytes);
    expect(content).toContain("(nota)");
    expect(content).toContain("(I)");
  });
});

/* ------------------------------------------------------------------ *
 * Ronda 3: falsos «no se pudo quitar» y /Contents compartido
 * ------------------------------------------------------------------ */

/** Bloques que detecta el editor en la pagina (pdf.js + `analyzePageText`), como los ve la app. */
async function blocksOf(bytes: Uint8Array, pageNumber = 1): Promise<TextBlock[]> {
  const opened = await openWithPdfjs(bytes);
  try {
    const page = await opened.page(pageNumber);
    return (await analyzePageText(page, pageNumber - 1, { OPS: opened.OPS })).blocks;
  } finally {
    await opened.close();
  }
}

/** Edicion que hace la app al cambiar un bloque: caja, cobertura y perfil de glifos salen del bloque real. */
function blockEdit(block: TextBlock, text = "Nuevo", overrides: Partial<TextEdit> = {}): TextEdit {
  return { ...draftEditForBlock(block, { coverColor: "#ffffff" }), text, ...overrides };
}

const zoneOf = (e: TextEdit, margin = 1): Zone => {
  const box = e.coverBox ?? e.box;
  return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
};

/** Fuentes del PDF sin `ToUnicode`: lo que hace falta para ejercitar la rama aproximada. */
async function hasToUnicode(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.has(PDFName.of("ToUnicode"))) return true;
  }
  return false;
}

/** PDF 380x160 con texto dibujado por pdf-lib (fuente estandar WinAnsi, sin ToUnicode). */
async function drawnPdf(
  fontName: StandardFonts,
  lines: Array<{ text: string; x: number; y: number; size: number }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(fontName);
  const page = doc.addPage([380, 160]);
  for (const line of lines) page.drawText(line.text, { x: line.x, y: line.y, size: line.size, font });
  return doc.save();
}

/** Todos los glifos del texto caen en la caja: lo que halla el interprete ANTES de validar contra el perfil. */
async function foundGlyphs(bytes: Uint8Array, e: TextEdit): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const copy: TextEdit = { ...e };
  delete copy.originalGlyphs;
  return removeOriginalText(doc, doc.getPage(0), [copy])[0].glyphs;
}

/** Comprobaciones de un bloque cambiado de verdad: ni pdf.js ni pdftotext lo extraen, el nuevo si y 0 px fuera. */
async function expectBlockReplaced(
  source: Uint8Array,
  result: Uint8Array,
  e: TextEdit,
  expected: { gone: string[]; present: string[]; untouched?: string[]; compact?: boolean },
): Promise<void> {
  // Con Tc grande pdf.js y poppler separan las letras con espacios: se compara sin blancos.
  const norm = (value: string) => (expected.compact ? value.replace(/\s+/g, "") : value);
  const before = norm((await strings(source)).join(" "));
  const after = norm((await strings(result)).join(" "));
  for (const gone of expected.gone) {
    expect(before).toContain(norm(gone));
    expect(after).not.toContain(norm(gone));
  }
  for (const present of expected.present) expect(after).toContain(norm(present));
  for (const kept of expected.untouched ?? []) expect(after).toContain(norm(kept));
  const text = pdftotext(result);
  if (text !== null) {
    const flat = norm(text);
    for (const gone of expected.gone) expect(flat).not.toContain(norm(gone));
    for (const present of expected.present) expect(flat).toContain(norm(present));
  }
  const diff = diffPixels(await render(source), await render(result), zoneOf(e));
  expect(diff.outside).toBe(0);
  expect(diff.inside).toBeGreaterThan(0);
}

const SPECIAL: Array<{ text: string; marks: string[]; gone: string[] }> = [
  { text: "Oferta limitada… marca™ 1½ tazas", marks: ["…", "™", "½"], gone: ["Oferta", "limitada", "marca", "tazas"] },
  { text: "Receta: 1¼ y 3¾ ‰ de sal", marks: ["¼", "¾", "‰"], gone: ["Receta", "sal"] },
  { text: "Viñeta • item", marks: ["•"], gone: ["Viñeta", "item"] },
  { text: "“Comillas” ‘x’ — – € ƒ", marks: ["“", "”", "‘", "’", "—", "–", "€", "ƒ"], gone: ["Comillas"] },
  { text: "Daga † doble ‡ š œ ž Ÿ", marks: ["†", "‡", "š", "œ", "ž", "Ÿ"], gone: ["Daga", "doble"] },
];

describe.each([
  ["Helvetica", StandardFonts.Helvetica],
  ["Times-Roman", StandardFonts.TimesRoman],
  ["Helvetica-Bold", StandardFonts.HelveticaBold],
])("F2 ronda 3 · N1/N2 · %s de pdf-lib sin ToUnicode con simbolos de WinAnsi 0x80–0x9F y que NFKC expande", (_name, fontName) => {
  it.each(SPECIAL)("«$text»: se hallan TODOS los glifos, se marca eliminado y el original no se extrae", async ({ text, marks, gone }) => {
    const source = await drawnPdf(fontName, [
      { text, x: 20, y: 100, size: 14 },
      { text: "Pie intacto", x: 20, y: 30, size: 10 },
    ]);
    expect(await hasToUnicode(source)).toBe(false); // precondicion: es la rama aproximada
    const blocks = await blocksOf(source);
    const block = blocks.find((b) => b.text.includes(gone[0]));
    expect(block, "bloque detectado").toBeDefined();
    for (const mark of marks) expect(block!.text).toContain(mark);
    const e = blockEdit(block!, "Nuevo");
    // N2: ningun glifo se pierde por un ancho mal calculado (antes: 12 de 13 con la vineta).
    expect(await foundGlyphs(source, e)).toBe([...text].length);
    // N1: el perfil (NFKC) y la cuenta aproximada de glifos coinciden.
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    expect(remains(result.warningsByEdit[e.id])).toBeNull();
    await expectBlockReplaced(source, result.bytes, e, { gone, present: ["Nuevo"], untouched: ["Pie intacto"] });
  });
});

describe("F2 ronda 3 · N1/N2 · PDFs de jsPDF (la propia app los genera con fuentes base 14 sin ToUnicode)", () => {
  it.each(["helvetica", "times", "courier"])("%s: «Viñeta • item — “x” € 1½ ™» se elimina de verdad", async (family) => {
    const pdf = new jsPDF({ unit: "pt", format: [380, 160] });
    pdf.setFont(family);
    pdf.setFontSize(12);
    pdf.text("Viñeta • item — “x” € 1½ ™", 20, 60);
    pdf.text("Pie intacto", 20, 120);
    const source = new Uint8Array(pdf.output("arraybuffer"));
    expect(await hasToUnicode(source)).toBe(false);
    const block = (await blocksOf(source)).find((b) => b.text.includes("item"));
    expect(block, "bloque detectado").toBeDefined();
    const e = blockEdit(block!, "Nuevo");
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    await expectBlockReplaced(source, result.bytes, e, { gone: ["item"], present: ["Nuevo"], untouched: ["Pie intacto"], compact: true });
  });
});

describe("F2 ronda 3 · N2 · anchos AFM de 0x80–0x9F con el resto de la linea", () => {
  /** Linea parcial: el bloque editado es solo la ultima palabra; delante van simbolos de 0x80–0x9F. */
  async function lastWord(fontName: StandardFonts, prefix: string, word: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(fontName);
    const page = doc.addPage([380, 160]);
    page.drawText(prefix + word, { x: 20, y: 100, size: 14, font });
    const source = await doc.save();
    const x = 20 + font.widthOfTextAtSize(prefix, 14);
    const width = font.widthOfTextAtSize(word, 14);
    const box = { x: x - 0.3, y: 96, width: width + 0.6, height: 18 };
    const e = edit({ box, coverBox: box, text: "Nuevo", fontSize: 14, originalGlyphs: glyphProfile(word) });
    return { source, e };
  }

  it.each([
    ["Viñeta • ", "item"],
    ["Oferta… ", "ahora"],
    ["“Cita” — ", "autor"],
    ["Total € 5 ™ ", "final"],
  ])("«%s» + «%s»: cada glifo cae en su sitio y solo se quita la ultima palabra", async (prefix, word) => {
    const { source, e } = await lastWord(StandardFonts.Helvetica, prefix, word);
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit.e1).toContainEqual({ kind: "original-text-removed" });
    const after = (await strings(result.bytes)).join(" ");
    expect(after).not.toContain(word);
    expect(after).toContain("Nuevo");
    expect(after).toContain(prefix.trim().split(" ")[0]);
    const diff = diffPixels(await render(source), await render(result.bytes), { x: 19, y: 95, width: 340, height: 22 });
    expect(diff.outside).toBe(0);
  });
});

describe("F2 ronda 3 · N2 · codificaciones declaradas (MacRoman, /Differences, StandardEncoding)", () => {
  async function customFontPdf(font: Record<string, unknown>, content: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([380, 160]);
    const ref = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", ...font }));
    page.node.setFontDictionary(PDFName.of("F1"), ref);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(content)));
    return doc.save();
  }

  async function replaceMarked(source: Uint8Array, marker: string) {
    const block = (await blocksOf(source)).find((b) => b.text.includes(marker));
    expect(block, `bloque con ${marker}`).toBeDefined();
    const e = blockEdit(block!, "Nuevo");
    const result = await applyTextEdits(source, [e]);
    return { block: block!, e, result };
  }

  it("MacRomanEncoding sin /Widths ni ToUnicode: em dash, vinetas y acentos con su ancho de MacRoman", async () => {
    // Cafe — Nandu • • • … en MacRoman: é=0x8E, —=0xD1, Ñ=0x84, ú=0x9C, •=0xA5, …=0xC9
    const source = await customFontPdf(
      { Encoding: "MacRomanEncoding" },
      "BT /F1 14 Tf 20 100 Td (Caf\\216 \\321 \\321 \\321 \\204and\\234 \\245 \\245 \\245 \\311) Tj ET BT /F1 10 Tf 20 30 Td (Pie intacto) Tj ET",
    );
    expect(await hasToUnicode(source)).toBe(false);
    const { block, e, result } = await replaceMarked(source, "Caf");
    expect(block.text).toContain("—");
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    await expectBlockReplaced(source, result.bytes, e, { gone: ["Caf", "and"], present: ["Nuevo"], untouched: ["Pie intacto"] });
  });

  it("/Encoding con /Differences (ligaduras fi, fl y vineta) sin /Widths: los anchos salen del nombre del glifo", async () => {
    const source = await customFontPdf(
      { Encoding: { Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: [1, "fi", "fl", "bullet"] } },
      "BT /F1 14 Tf 20 100 Td (\\001re \\002oor \\003 \\003 \\003 x) Tj ET BT /F1 10 Tf 20 30 Td (Pie intacto) Tj ET",
    );
    const { e, result } = await replaceMarked(source, "re");
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    const after = (await strings(result.bytes)).join(" ");
    expect(after).toContain("Nuevo");
    expect(after).toContain("Pie intacto");
    expect(after).not.toMatch(/oor/);
  });

  it("sin /Encoding (StandardEncoding): ﬁ y ﬂ en 0xAE/0xAF y comilla recta en 0x27", async () => {
    const source = await customFontPdf(
      {},
      "BT /F1 14 Tf 20 100 Td (\\256\\256\\256 \\257\\257\\257 x) Tj ET BT /F1 10 Tf 20 30 Td (Pie intacto) Tj ET",
    );
    const { e, result } = await replaceMarked(source, "x");
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    const after = (await strings(result.bytes)).join(" ");
    expect(after).toContain("Nuevo");
    expect(after).toContain("Pie intacto");
  });

  it("fuente Symbol sin /Widths: sus anchos no se conocen, asi que no se casa ni se quita nada y se avisa widths", async () => {
    const source = await rawPdf("BT /F1 20 Tf 40 100 Td (Original) Tj ET", { font: StandardFonts.Symbol });
    const result = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "widths" });
    expect(await pageContent(result.bytes)).toContain("(Original) Tj");
  });
});

describe("F2 ronda 3 · N3 · espaciado de caracteres (Tc) y de palabras (Tw)", () => {
  const TC_CASES: Array<[string, string, string]> = [
    ["Tc 2", "2 Tc", "Espaciado de caracteres"],
    ["Tc 3", "3 Tc", "Hola"],
    ["Tc 6", "6 Tc", "Hola"],
    ["Tw 8", "8 Tw", "Hola mundo feliz"],
    ["Tc 4 con Tz 150", "4 Tc 150 Tz", "Hola mundo"],
    ["Tc -0,5", "-0.5 Tc", "Hola mundo"],
    ["Tc 1 y Tw 6", "1 Tc 6 Tw", "Hola mundo feliz"],
  ];

  it.each(TC_CASES)("%s: el ultimo glifo no se pierde por el margen de la caja", async (_name, ops, text) => {
    const source = await rawPdf(`q BT /F1 14 Tf ${ops} 20 100 Td (${text}) Tj ET Q BT /F1 8 Tf 20 30 Td (Pie intacto) Tj ET`);
    const block = (await blocksOf(source)).find((b) => b.text.includes("Hola") || b.text.includes("Espaciado"));
    expect(block, "bloque detectado").toBeDefined();
    const e = blockEdit(block!, "Nuevo");
    expect(await foundGlyphs(source, e)).toBe(text.length);
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    await expectBlockReplaced(source, result.bytes, e, {
      gone: [text.split(" ")[0]],
      present: ["Nuevo"],
      untouched: ["Pie intacto"],
      compact: true,
    });
    expect(await pageContent(result.bytes)).not.toContain(`(${text})`);
  });

  /** «Hola» con Tc 3 (37,8 pt de tinta); la caja manual es la de la tinta, como la del editor. */
  const holaBox = { x: 19.5, y: 96, width: 38.8, height: 18 };
  const holaEdit = () => edit({ box: holaBox, coverBox: holaBox, text: "Nuevo", fontSize: 14, originalGlyphs: glyphProfile("Hola") });

  it("adverso: un glifo ajeno justo FUERA de la caja (sin espaciado propio) no se toca aunque el Tc del bloque sea grande", async () => {
    const source = await rawPdf("BT /F1 14 Tf 3 Tc 20 100 Td (Hola) Tj ET BT /F1 14 Tf 0 Tc 60.5 100 Td (X) Tj ET");
    const result = await applyTextEdits(source, [holaEdit()]);
    expect(result.warningsByEdit.e1).toContainEqual({ kind: "original-text-removed" });
    const content = await pageContent(result.bytes);
    expect(content).toContain("(X) Tj");
    expect(content).not.toContain("(Hola)");
    expect(await strings(result.bytes)).toContain("X");
  });

  it("adverso: texto vecino del mismo cuerpo DENTRO de una caja ancha con Tc grande: no se borra NADA y se avisa ambiguous", async () => {
    const source = await rawPdf("BT /F1 14 Tf 3 Tc 20 100 Td (Hola) Tj ( mundo) Tj ET");
    const wide = { x: 19.5, y: 96, width: 110, height: 18 };
    const result = await applyTextEdits(source, [edit({ box: wide, coverBox: wide, text: "Nuevo", fontSize: 14, originalGlyphs: glyphProfile("Hola") })]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const content = await pageContent(result.bytes);
    expect(content).toContain("(Hola) Tj");
    expect(content).toContain("( mundo) Tj");
  });

  it("adverso: un glifo ajeno que EMPIEZA dentro de la caja y cuyo espaciado sobresale: no se borra (se bloquea el bloque)", async () => {
    // El punto de otro objeto de texto se dibuja encima de la «l» (Tc 3 propio): ahora su tinta cae dentro y el
    // perfil de «Hola» ya no cuadra, asi que no se quita nada del bloque; el punto sigue en el flujo.
    const source = await rawPdf("BT /F1 14 Tf 3 Tc 20 100 Td (Hola) Tj ET BT /F1 14 Tf 3 Tc 53.5 100 Td (.) Tj ET");
    const result = await applyTextEdits(source, [holaEdit()]);
    const content = await pageContent(result.bytes);
    expect(content).toContain("(.) Tj");
    if (removed(result.warningsByEdit.e1)) expect(content).not.toContain("(Hola)");
    else expect(content).toContain("(Hola) Tj");
  });
});

describe("F2 ronda 3 · N3b · texto dibujado varias veces para simular negrita", () => {
  const FONT = "BT /F1 14 Tf";
  const BOLD_CASES: Array<[string, string]> = [
    ["dos pasadas en dos BT", `${FONT} 20 100 Td (Hola mundo) Tj ET ${FONT} 20.4 100 Td (Hola mundo) Tj ET`],
    ["dos Tj en el mismo BT", `${FONT} 20 100 Td (Hola mundo) Tj 0.4 0 Td (Hola mundo) Tj ET`],
    ["tres pasadas", `${FONT} 20 100 Td (Hola mundo) Tj ET ${FONT} 20.4 100 Td (Hola mundo) Tj ET ${FONT} 20 100.4 Td (Hola mundo) Tj ET`],
    [
      "cuatro pasadas en diagonal",
      `${FONT} 20 100 Td (Hola mundo) Tj ET ${FONT} 20.3 100 Td (Hola mundo) Tj ET ${FONT} 20 100.3 Td (Hola mundo) Tj ET ${FONT} 20.3 100.3 Td (Hola mundo) Tj ET`,
    ],
    ["con TJ y kerning", `${FONT} 20 100 Td [(Ho) -20 (la mundo)] TJ ET ${FONT} 20.4 100 Td [(Ho) -20 (la mundo)] TJ ET`],
  ];

  it.each(BOLD_CASES)("%s: las pasadas caen en la caja, el perfil cuadra con una y se quitan todas", async (_name, content) => {
    const source = await rawPdf(`${content} BT /F1 8 Tf 20 30 Td (Pie intacto) Tj ET`);
    const block = (await blocksOf(source)).find((b) => b.text.includes("Hola"));
    expect(block, "bloque detectado").toBeDefined();
    const e = blockEdit(block!, "Nuevo");
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    expect(remains(result.warningsByEdit[e.id])).toBeNull();
    await expectBlockReplaced(source, result.bytes, e, { gone: ["Hola", "mundo"], present: ["Nuevo"], untouched: ["Pie intacto"] });
    const after = await pageContent(result.bytes);
    expect(after).not.toContain("(Hola mundo)");
    expect(after).not.toContain("(Ho)");
    expect(after).toContain("(Pie intacto)");
  });

  const box = { x: 19.5, y: 96, width: 78, height: 18 };
  const hand = (text: string) => edit({ box, coverBox: box, text: "Nuevo", fontSize: 14, originalGlyphs: glyphProfile(text) });

  it("adverso: la segunda pasada tiene OTRA letra del mismo ancho (Hola / Hole): no se confunde con una copia, no se borra nada", async () => {
    // «a» y «e» miden lo mismo en Helvetica: solo el codigo del glifo las distingue.
    const source = await rawPdf(`${FONT} 20 100 Td (Hola mundo) Tj ET ${FONT} 20.3 100 Td (Hole mundo) Tj ET`);
    const result = await applyTextEdits(source, [hand("Hola mundo")]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const content = await pageContent(result.bytes);
    expect(content).toContain("(Hola mundo) Tj");
    expect(content).toContain("(Hole mundo) Tj");
  });

  it("adverso: la segunda pasada es de otro tamano de fuente (15 frente a 14): no es una copia, no se borra nada", async () => {
    const source = await rawPdf(`${FONT} 20 100 Td (Hola mundo) Tj ET BT /F1 14.9 Tf 20.3 100 Td (Hola mundo) Tj ET`);
    const result = await applyTextEdits(source, [hand("Hola mundo")]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    expect(await pageContent(result.bytes)).toContain("(Hola mundo) Tj");
  });

  it("adverso: dos palabras cortas con la misma geometria pero 14 y 15 pt no se funden aunque las posiciones casi coincidan", async () => {
    // Texto de dos letras: la diferencia de ancho es menor que la tolerancia de posicion; solo el tamano distingue las pasadas.
    const source = await rawPdf(`${FONT} 20 100 Td (Hi) Tj ET BT /F1 15 Tf 20 100 Td (Hi) Tj ET`);
    const result = await applyTextEdits(source, [hand("Hi")]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    expect(await pageContent(result.bytes)).toContain("(Hi) Tj");
  });

  it("adverso: cinco pasadas del mismo texto no son una negrita simulada: no se borra nada", async () => {
    const passes = [0, 0.1, 0.2, 0.3, 0.4].map((dx) => `${FONT} ${20 + dx} 100 Td (Hola mundo) Tj ET`).join(" ");
    const source = await rawPdf(passes);
    const result = await applyTextEdits(source, [hand("Hola mundo")]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    expect(await pageContent(result.bytes)).toContain("(Hola mundo) Tj");
  });

  it("adverso: dos letras iguales seguidas («ll») NO se funden como copias y un glifo ajeno dentro de la caja no se cuela", async () => {
    // «Hallo» mas una «x» ajena dentro de la caja. Si las dos «l» contaran como una pasada doble, el perfil de 5 caracteres
    // cuadraria por casualidad (H a l o x) y se borraria la «x» de otro texto.
    const source = await rawPdf(`${FONT} 20 100 Td (Hallo) Tj ET ${FONT} 60 100 Td (x) Tj ET`);
    const wide = { x: 19.5, y: 96, width: 60, height: 18 };
    const result = await applyTextEdits(source, [
      edit({ box: wide, coverBox: wide, text: "Nuevo", fontSize: 14, originalGlyphs: glyphProfile("Hallo") }),
    ]);
    expect(removed(result.warningsByEdit.e1)).toBe(false);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const content = await pageContent(result.bytes);
    expect(content).toContain("(Hallo) Tj");
    expect(content).toContain("(x) Tj");
  });

  it("un bloque con dos pasadas solo a medias (la segunda cubre parte del texto) se quita entero", async () => {
    const source = await rawPdf(`${FONT} 20 100 Td (Hola mundo) Tj ET ${FONT} 20.3 100 Td (Hola) Tj ET`);
    const result = await applyTextEdits(source, [hand("Hola mundo")]);
    expect(result.warningsByEdit.e1).toContainEqual({ kind: "original-text-removed" });
    const content = await pageContent(result.bytes);
    expect(content).not.toContain("(Hola mundo)");
    expect(content).not.toContain("(Hola) Tj");
  });
});

/**
 * Wave 10 · C-A2 · negrita simulada con 3 o 4 pasadas FINAS (cuerpo 15).
 *
 * Causa: el agrupado de fragmentos (`textBlocksGroup.prepare`) descartaba una pasada como duplicado solo si caia a
 * <= 0,03 em (0,45 pt a 15) de una pasada CONSERVADA. En una negrita de 3-4 pasadas a 0,25-0,4 pt cada una la 3.ª
 * cae a 0,6 pt de la 1.ª pero a 0,3 de la 2.ª (descartada): sobrevivia como texto aparte y el bloque salia DUPLICADO
 * («Hola mundoHola mundo»: el editor lo mostraba doble y su perfil de glifos, 2 copias, no cuadraba con las 3-4
 * pasadas del flujo). `removeOriginalText` hacia lo correcto (no borrar ante la duda) y daba `ambiguous`.
 * Con 2 pasadas, con 3-4 a 0,15 y con 3-4 a >= 0,6 (todas conservadas, perfil con TODAS las copias) ya funcionaba.
 * Ahora cada pasada se encadena con la anterior, tambien con las descartadas. La validacion de `removeOriginalText`
 * (`collapseOverstrike`: misma fuente, mismo codigo, mismo cuerpo, <= 12 % del cuerpo y <= 35 % del ancho del glifo)
 * NO cambia, y sigue sin borrar nada ante la duda.
 */
describe("Wave 10 · C-A2 · negrita simulada con 3 o 4 pasadas finas", () => {
  const FONT15 = "BT /F1 15 Tf";
  const pass = (x: number, y: number, text = "Hola mundo", size = 15) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`;
  /** `n` pasadas acumuladas: la k-esima cae a k*d de la primera, en horizontal o en diagonal. */
  const passes = (n: number, d: number, kind: "horizontal" | "diagonal") =>
    Array.from({ length: n }, (_, k) => pass(20 + k * d, kind === "diagonal" ? 100 + k * d : 100)).join(" ");
  const withFooter = (content: string) => `${content} BT /F1 8 Tf 20 30 Td (Pie intacto) Tj ET`;

  const FINE: Array<[string, number, number, "horizontal" | "diagonal"]> = [
    ["3 pasadas horizontales a 0,25 pt", 3, 0.25, "horizontal"],
    ["3 pasadas horizontales a 0,3 pt", 3, 0.3, "horizontal"],
    ["3 pasadas horizontales a 0,33 pt", 3, 0.33, "horizontal"],
    ["3 pasadas horizontales a 0,35 pt", 3, 0.35, "horizontal"],
    ["3 pasadas horizontales a 0,4 pt", 3, 0.4, "horizontal"],
    ["4 pasadas horizontales a 0,25 pt", 4, 0.25, "horizontal"],
    ["4 pasadas horizontales a 0,3 pt", 4, 0.3, "horizontal"],
    ["4 pasadas horizontales a 0,33 pt", 4, 0.33, "horizontal"],
    ["4 pasadas horizontales a 0,35 pt", 4, 0.35, "horizontal"],
    ["3 pasadas en diagonal a 0,25 pt", 3, 0.25, "diagonal"],
    ["3 pasadas en diagonal a 0,3 pt", 3, 0.3, "diagonal"],
    ["3 pasadas en diagonal a 0,35 pt", 3, 0.35, "diagonal"],
    ["3 pasadas en diagonal a 0,4 pt", 3, 0.4, "diagonal"],
    ["4 pasadas en diagonal a 0,2 pt", 4, 0.2, "diagonal"],
  ];

  it.each(FINE)(
    "%s: el bloque sale UNA vez (no «Hola mundoHola mundo»), se quitan todas las pasadas y fuera de la zona hay 0 px de diferencia",
    async (_name, n, d, kind) => {
      const source = await rawPdf(withFooter(passes(n, d, kind)));
      const blocks = await blocksOf(source);
      const block = blocks.find((b) => b.text.includes("Hola"));
      expect(block, "bloque detectado").toBeDefined();
      // La causa: el bloque tenia que salir una vez, no una por cada pasada que no se encadenaba.
      expect(block!.text).toBe("Hola mundo");
      const e = blockEdit(block!, "Nuevo");
      const result = await applyTextEdits(source, [e]);
      expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
      expect(remains(result.warningsByEdit[e.id])).toBeNull();
      await expectBlockReplaced(source, result.bytes, e, { gone: ["Hola", "mundo"], present: ["Nuevo"], untouched: ["Pie intacto"] });
      const after = await pageContent(result.bytes);
      expect(after).not.toContain("(Hola mundo)");
      expect(after).toContain("(Pie intacto)");
    },
  );

  it("con TJ y kerning (3 pasadas a 0,3 pt) tambien se quitan, y `pdftotext -layout` ya no ve el original", async () => {
    const tj = (x: number) => `${FONT15} ${x} 100 Td [(Ho) -20 (la mundo)] TJ ET`;
    const source = await rawPdf(withFooter([tj(20), tj(20.3), tj(20.6)].join(" ")));
    const block = (await blocksOf(source)).find((b) => b.text.includes("Hola"));
    expect(block?.text).toBe("Hola mundo");
    const e = blockEdit(block!, "Nuevo");
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    await expectBlockReplaced(source, result.bytes, e, { gone: ["Hola", "mundo"], present: ["Nuevo"], untouched: ["Pie intacto"] });
    const text = pdftotext(result.bytes);
    if (text !== null) expect(text.replace(/\s+/g, " ")).not.toMatch(/Ho\s?la/);
  });

  it("TrueType embebida (Identity-H, ToUnicode exacto) dibujada 4 veces a 0,3 pt: se quitan las 4 pasadas", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const ttf = fs.readFileSync(path.join(FONTS_DIR, "LiberationSans-Regular.ttf"));
    const font = await doc.embedFont(ttf, { subset: true });
    const page = doc.addPage([300, 200]);
    for (let k = 0; k < 4; k += 1) page.drawText("Importe 1.250,00", { x: 40 + k * 0.3, y: 100, size: 15, font });
    page.drawText("Cliente ACME", { x: 40, y: 60, size: 15, font });
    const source = await doc.save();
    const block = (await blocksOf(source)).find((b) => b.text.includes("Importe"));
    expect(block?.text).toBe("Importe 1.250,00");
    const e = blockEdit(block!, "Importe 999,00");
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    await expectBlockReplaced(source, result.bytes, e, { gone: ["1.250,00"], present: ["999,00"], untouched: ["Cliente ACME"] });
  });

  /* ------------------------ adversas: ante la duda NO se borra ------------------------ */

  /** Edicion de mano (caja ancha y perfil de «Hola mundo»): no depende de lo que detecte el agrupado. */
  const wide = { x: 19.5, y: 96, width: 100, height: 20 };
  const hand = (text = "Hola mundo") =>
    edit({ box: wide, coverBox: wide, text: "Nuevo", fontSize: 15, originalGlyphs: glyphProfile(text) });

  async function expectNothingRemoved(source: Uint8Array, e: TextEdit, strings: string[]) {
    const result = await applyTextEdits(source, [e]);
    expect(removed(result.warningsByEdit[e.id])).toBe(false);
    expect(remains(result.warningsByEdit[e.id])).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const content = await pageContent(result.bytes);
    for (const text of strings) expect(content).toContain(text);
  }

  it("adverso: 3 pasadas finas y un glifo AJENO dentro de la caja: el perfil de una copia + el ajeno no cuadra, no se borra nada", async () => {
    const source = await rawPdf(`${passes(3, 0.3, "horizontal")} ${pass(95, 100, "x")}`);
    await expectNothingRemoved(source, hand(), ["(Hola mundo) Tj", "(x) Tj"]);
  });

  it("adverso: 3 pasadas finas y un glifo ajeno que cae EXACTAMENTE sobre una letra de la pasada (otro codigo): no se funde con ella", async () => {
    // Una «x» dibujada sobre la «H» (mismo punto): su codigo es otro, asi que es un glifo mas y el perfil no cuadra.
    const source = await rawPdf(`${passes(3, 0.3, "horizontal")} ${pass(20.1, 100, "x")}`);
    await expectNothingRemoved(source, hand(), ["(Hola mundo) Tj", "(x) Tj"]);
  });

  it("adverso: dos pasadas separadas 2,5 pt (17 % del cuerpo) no son copias aunque midan < 35 % del ancho de la «o»: no se borra nada", async () => {
    // El limite del cuerpo (12 %) es independiente del del glifo (35 %): en letras anchas el segundo seria 4-5 pt.
    const source = await rawPdf(`${pass(20, 100, "Wo")} ${pass(22.5, 100, "Wo")}`);
    await expectNothingRemoved(source, hand("Wo"), ["(Wo) Tj"]);
  });

  it("adverso: la tercera pasada es de OTRO cuerpo (14,2 frente a 15): no es una copia, no se borra nada", async () => {
    const source = await rawPdf(`${pass(20, 100)} ${pass(20.3, 100)} ${pass(20.6, 100, "Hola mundo", 14.2)}`);
    await expectNothingRemoved(source, hand(), ["(Hola mundo) Tj"]);
  });

  it("adverso: la tercera pasada lleva OTRA letra del mismo ancho (Hole): no se confunde con una copia, no se borra nada", async () => {
    const source = await rawPdf(`${pass(20, 100)} ${pass(20.3, 100)} ${pass(20.6, 100, "Hole mundo")}`);
    await expectNothingRemoved(source, hand(), ["(Hola mundo) Tj", "(Hole mundo) Tj"]);
  });

  it("adverso: 5 pasadas a 0,3 pt NO son una negrita simulada (maximo 4): el bloque se detecta una vez pero no se borra nada", async () => {
    const source = await rawPdf(withFooter(passes(5, 0.3, "horizontal")));
    const block = (await blocksOf(source)).find((b) => b.text.includes("Hola"));
    expect(block?.text).toBe("Hola mundo");
    const e = blockEdit(block!, "Nuevo");
    await expectNothingRemoved(source, e, ["(Hola mundo) Tj", "(Pie intacto) Tj"]);
  });

  it("adverso: 4 pasadas cuya dispersion total (1,2 pt) pasa del 35 % del ancho de la «l» (1,17 pt): no se borra nada", async () => {
    const source = await rawPdf(passes(4, 0.4, "horizontal"));
    const block = (await blocksOf(source)).find((b) => b.text.includes("Hola"));
    expect(block?.text).toBe("Hola mundo");
    await expectNothingRemoved(source, blockEdit(block!, "Nuevo"), ["(Hola mundo) Tj"]);
  });

  it("adverso: el mismo texto a otra altura (3 pasadas finas encima de otras 3 a 9 pt) no se funde: cada bloque se edita aparte", async () => {
    const source = await rawPdf(withFooter(`${passes(3, 0.3, "horizontal")} ${[0, 1, 2].map((k) => pass(20 + k * 0.3, 70)).join(" ")}`));
    const blocks = (await blocksOf(source)).filter((b) => b.text.includes("Hola"));
    expect(blocks.map((b) => b.text)).toEqual(["Hola mundo", "Hola mundo"]);
    const upper = blocks.find((b) => b.box.y > 90)!;
    const e = blockEdit(upper, "Nuevo");
    const result = await applyTextEdits(source, [e]);
    expect(result.warningsByEdit[e.id]).toContainEqual({ kind: "original-text-removed" });
    // Solo se quitan las 3 pasadas de arriba: las de abajo siguen en el flujo y en pdf.js.
    const content = await pageContent(result.bytes);
    expect(content.match(/\(Hola mundo\) Tj/g)?.length).toBe(3);
    expect((await strings(result.bytes)).join(" ")).toContain("Hola mundo");
  });
});

describe("F2 ronda 3 · N4 · /Contents como array indirecto compartido y edicion que NO consigue quitar el original", () => {
  const shared = "BT /F1 20 Tf 40 100 Td (Original) Tj ET BT /F1 12 Tf 40 30 Td (Pie comun) Tj ET";

  /** Dos paginas cuyo `/Contents` es el MISMO array indirecto (como deja un duplicado hecho a mano o por otra herramienta). */
  async function sharedArrayPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const stream = doc.context.register(doc.context.stream(shared));
    const array = doc.context.register(doc.context.obj([stream]));
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.setFontDictionary(PDFName.of("F1"), font.ref);
      page.node.set(PDFName.of("Contents"), array);
    }
    return doc.save();
  }

  const contentsOf = async (bytes: Uint8Array, index: number) => {
    const doc = await PDFDocument.load(bytes);
    const raw = doc.getPage(index).node.get(PDFName.of("Contents"));
    const array = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
    return { raw, size: array instanceof PDFArray ? array.size() : -1 };
  };

  it("precondicion: las dos paginas comparten el array", async () => {
    const source = await sharedArrayPdf();
    const a = await contentsOf(source, 0);
    const b = await contentsOf(source, 1);
    expect(String(a.raw)).toBe(String(b.raw));
    expect(a.raw).toBeInstanceOf(PDFRef);
  });

  it("edicion bloqueada (perfil que no cuadra): la pagina 2 no recibe ni el texto nuevo ni la cobertura (0 px de diferencia)", async () => {
    const source = await sharedArrayPdf();
    const result = await applyTextEdits(source, [edit({ text: "NUEVO P1", originalGlyphs: { chars: 99, ligatures: 0 } })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "ambiguous" });
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).toContain("NUEVO P1");
    expect(p2).toBe((await allText(source, 2))[1]);
    expect(p2).not.toContain("NUEVO");
    expect((await sameDiff(source, 2, result.bytes, 2)).outside).toBe(0);
    expect((await sameDiff(source, 2, result.bytes, 2)).inside).toBe(0);
    // El array de la otra pagina sigue con su unico flujo (nadie le anadio cobertura, texto ni q/Q).
    expect((await contentsOf(result.bytes, 1)).size).toBe(1);
    expect((await contentsOf(result.bytes, 0)).size).toBeGreaterThan(1);
  });

  it("texto NUEVO (sin blockId) en una pagina de array compartido: la otra pagina no lo recibe", async () => {
    const source = await sharedArrayPdf();
    const result = await applyTextEdits(source, [
      edit({ blockId: undefined, text: "Nota nueva", box: { x: 40, y: 140, width: 120, height: 24 }, coverBox: undefined, cover: { color: null, padding: 0 } }),
    ]);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).toContain("Nota nueva");
    expect(p2).not.toContain("Nota nueva");
    expect((await sameDiff(source, 2, result.bytes, 2)).outside).toBe(0);
    expect((await contentsOf(result.bytes, 1)).size).toBe(1);
  });

  it("las dos paginas se editan y ninguna logra quitar el original: cada una recibe solo lo suyo", async () => {
    const source = await sharedArrayPdf();
    const result = await applyTextEdits(source, [
      edit({ id: "e1", text: "UNO", originalGlyphs: { chars: 99, ligatures: 0 } }),
      edit({ id: "e2", pageIndex: 1, blockId: "p1-b0", text: "DOS", originalGlyphs: { chars: 99, ligatures: 0 } }),
    ]);
    const [p1, p2] = await allText(result.bytes, 2);
    expect(p1).toContain("UNO");
    expect(p1).not.toContain("DOS");
    expect(p2).toContain("DOS");
    expect(p2).not.toContain("UNO");
    expect(p1).toContain("Pie comun");
    expect(p2).toContain("Pie comun");
  });

  it("removeOriginalText llamado SIN pasar por applyTextEdits sobre un array compartido: no reescribe el flujo en su sitio (defensa en profundidad)", async () => {
    const doc = await PDFDocument.load(await sharedArrayPdf());
    const outcome = removeOriginalText(doc, doc.getPage(0), [edit({ text: "Nuevo" })])[0];
    expect(outcome.removed).toBe(true);
    const [p1, p2] = await allText(await doc.save(), 2);
    expect(p1).not.toContain("Original");
    expect(p2).toContain("Original");
    expect(p2).toContain("Pie comun");
  });

  it("isolateSharedContents: aisla el array compartido y no toca los que ya son de la pagina", async () => {
    const source = await sharedArrayPdf();
    const doc = await PDFDocument.load(source);
    expect(isolateSharedContents(doc, doc.getPage(0))).toBe(true);
    const own = doc.getPage(0).node.get(PDFName.of("Contents"));
    expect(own).toBeInstanceOf(PDFArray); // directo, propio de la pagina
    expect(doc.getPage(1).node.get(PDFName.of("Contents"))).toBeInstanceOf(PDFRef);
    // Ya aislado: no hay nada mas que hacer. La pagina 2 conserva el array indirecto, ahora de su sola propiedad.
    expect(isolateSharedContents(doc, doc.getPage(0))).toBe(false);
    expect(isolateSharedContents(doc, doc.getPage(1))).toBe(false);
    // Flujo unico indirecto, o array directo: tampoco.
    const single = await PDFDocument.load(await rawPdf(shared));
    expect(isolateSharedContents(single, single.getPage(0))).toBe(false);
  });
});

describe("F2 ronda 3 · M15 · un bloque bloqueado por otra razon conserva SU razon", () => {
  it("Tr 3 (invisible) con perfil de glifos: sigue siendo invisible, no pasa a ambiguous", async () => {
    const source = await rawPdf("BT /F1 20 Tf 3 Tr 40 100 Td (Oculto) Tj ET");
    const result = await applyTextEdits(source, [edit({ text: "Nuevo", originalGlyphs: glyphProfile("Oculto") })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "invisible" });
  });

  it("XObject compartido con perfil de glifos: sigue siendo shared-xobject", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.context.register(
      doc.context.flateStream("BT /F1 20 Tf 40 100 Td (Original) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 300, 200],
        Resources: { Font: { F1: font.ref } },
      }),
    );
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([300, 200]);
      page.node.setFontDictionary(PDFName.of("F1"), font.ref);
      page.node.setXObject(PDFName.of("Fm1"), form);
      page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("/Fm1 Do")));
    }
    const result = await applyTextEdits(await doc.save(), [edit({ text: "Nuevo", originalGlyphs: glyphProfile("Original") })]);
    expect(remains(result.warningsByEdit.e1)).toEqual({ kind: "original-text-remains", reason: "shared-xobject" });
  });
});
