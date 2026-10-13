import { describe, expect, it } from "vitest";
import {
  PDFArray,
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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyTextEdits } from "@/lib/pdf/editTextExport";
import { glyphsMatch, parseToUnicode, removeOriginalText, standardFontNameFor } from "@/lib/pdf/editTextRemove";
import { glyphProfile } from "@/lib/pdf/editTextProfile";
import { applyPageAssembly } from "@/lib/pdf/pageAssembly";
import type { TextEdit } from "@/lib/pdf/editTypes";

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
