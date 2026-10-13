import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import {
  applyTextEdits,
  flattenPages,
  unrotatedSize,
  type PageRasterizer,
} from "@/lib/pdf/editTextExport";
import { clearCatalogFontCache, loadCatalogFont, setCatalogFontReader } from "@/lib/pdf/editFonts";
import { PdfError } from "@/lib/pdf/core";
import type {
  SourceFontInfo,
  TextEdit,
} from "@/lib/pdf/editTypes";

/**
 * Estas pruebas NO simulan el resultado: generan PDFs reales con pdf-lib,
 * aplican las ediciones y comprueban el archivo de salida de dos maneras
 * independientes del codigo bajo prueba:
 *  - texto: se re-extrae con pdf.js ("legacy", funciona en Node sin DOM);
 *  - pixeles: se renderiza con pdf.js sobre `@napi-rs/canvas` (el mismo
 *    backend que usa `e2e/helpers/pdf-render-inspection.ts`) y se mide el
 *    color real del fondo cubierto.
 * Para las paginas con `/Rotate` y CropBox desplazado, las coordenadas de
 * pixel se obtienen del propio viewport de pdf.js (`convertToViewportPoint`),
 * no de la logica del motor.
 */

const STANDARD_FONTS_URL = path.join(process.cwd(), "public", "standard_fonts") + "/";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;
function getPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

type Rgb = [number, number, number];

type Rendered = {
  width: number;
  height: number;
  /** Punto de usuario del PDF -> pixel de la imagen. */
  toPx: (x: number, y: number) => { px: number; py: number };
  pixel: (px: number, py: number) => Rgb;
  /** Cuenta pixeles de una region (en px) que cumplen el predicado. */
  count: (
    predicate: (rgb: Rgb) => boolean,
    region?: { x0: number; y0: number; x1: number; y1: number },
  ) => number;
  /** Caja envolvente (en px) de los pixeles que cumplen el predicado. */
  bounds: (
    predicate: (rgb: Rgb) => boolean,
  ) => { x0: number; y0: number; x1: number; y1: number } | null;
};

async function render(bytes: Uint8Array, pageNumber = 1, scale = 2): Promise<Rendered> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS_URL,
  });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    await page.render({ canvasContext: context, viewport } as never).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixel = (px: number, py: number): Rgb => {
      const o = (py * canvas.width + px) * 4;
      return [image.data[o], image.data[o + 1], image.data[o + 2]];
    };
    const forEach = (
      region: { x0: number; y0: number; x1: number; y1: number },
      visit: (px: number, py: number, color: Rgb) => void,
    ) => {
      const x0 = Math.max(0, Math.floor(region.x0));
      const y0 = Math.max(0, Math.floor(region.y0));
      const x1 = Math.min(canvas.width, Math.ceil(region.x1));
      const y1 = Math.min(canvas.height, Math.ceil(region.y1));
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) visit(px, py, pixel(px, py));
      }
    };
    const whole = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
    return {
      width: canvas.width,
      height: canvas.height,
      toPx: (x, y) => {
        const [px, py] = viewport.convertToViewportPoint(x, y);
        return { px, py };
      },
      pixel,
      count: (predicate, region = whole) => {
        let total = 0;
        forEach(region, (_x, _y, color) => {
          if (predicate(color)) total += 1;
        });
        return total;
      },
      bounds: (predicate) => {
        let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
        forEach(whole, (px, py, color) => {
          if (!predicate(color)) return;
          box = box
            ? {
                x0: Math.min(box.x0, px),
                y0: Math.min(box.y0, py),
                x1: Math.max(box.x1, px + 1),
                y1: Math.max(box.y1, py + 1),
              }
            : { x0: px, y0: py, x1: px + 1, y1: py + 1 };
        });
        return box;
      },
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

type TextItem = { str: string; transform: number[]; width: number; height: number };

async function extract(bytes: Uint8Array, pageNumber = 1): Promise<TextItem[]> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS_URL,
  });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: TextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.length === 0) continue;
      items.push({
        str: item.str,
        transform: [...item.transform],
        width: item.width,
        height: item.height,
      });
    }
    return items;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const isRed = ([r, g, b]: Rgb) => r > 200 && g < 60 && b < 60;
const isDark = ([r, g, b]: Rgb) => r < 90 && g < 90 && b < 90;
const isBlue = ([r, g, b]: Rgb) => b > 150 && r < 90 && g < 120;

type PageSetup = {
  size?: [number, number];
  rotate?: 0 | 90 | 180 | 270;
  mediaBox?: [number, number, number, number];
  cropBox?: [number, number, number, number];
  background?: [number, number, number];
  texts?: Array<{
    text: string;
    x: number;
    y: number;
    size?: number;
    font?: StandardFonts;
    color?: [number, number, number];
    rotate?: number;
  }>;
};

async function buildPdf(pages: PageSetup[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (const setup of pages) {
    const page = document.addPage(setup.size ?? [300, 200]);
    if (setup.mediaBox) page.setMediaBox(...setup.mediaBox);
    if (setup.cropBox) page.setCropBox(...setup.cropBox);
    if (setup.rotate) page.setRotation(degrees(setup.rotate));
    if (setup.background) {
      const media = page.getMediaBox();
      page.drawRectangle({
        x: media.x,
        y: media.y,
        width: media.width,
        height: media.height,
        color: rgb(...setup.background),
      });
    }
    for (const item of setup.texts ?? []) {
      const font = await document.embedFont(item.font ?? StandardFonts.Helvetica);
      page.drawText(item.text, {
        x: item.x,
        y: item.y,
        size: item.size ?? 20,
        font,
        color: rgb(...(item.color ?? [0, 0, 0])),
        rotate: degrees(item.rotate ?? 0),
      });
    }
  }
  return document.save();
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

function sourceFont(pdfName: string, overrides: Partial<SourceFontInfo> = {}): SourceFontInfo {
  return {
    pdfName,
    family: "sans",
    bold: false,
    italic: false,
    subset: false,
    embedded: false,
    symbolic: false,
    type3: false,
    ...overrides,
  };
}

const ORIGINAL = { text: "Original", x: 40, y: 100, size: 20 };

afterEach(() => {
  setCatalogFontReader(null);
  clearCatalogFontCache();
});

describe("unrotatedSize — src/lib/pdf/editTextExport.ts", () => {
  it("sin rotar o a 180 grados es la propia caja", () => {
    expect(unrotatedSize({ width: 100, height: 20 }, 0)).toEqual({ width: 100, height: 20 });
    const half = unrotatedSize({ width: 100, height: 20 }, 180);
    expect(half.width).toBeCloseTo(100);
    expect(half.height).toBeCloseTo(20);
  });

  it("a 90 y 270 grados intercambia ancho y alto", () => {
    for (const angle of [90, 270]) {
      const size = unrotatedSize({ width: 20, height: 100 }, angle);
      expect(size.width).toBeCloseTo(100);
      expect(size.height).toBeCloseTo(20);
    }
  });

  it("invierte exactamente rotatedBounds en angulos libres", async () => {
    const { rotatedBounds } = await import("@/lib/pdf/core");
    for (const angle of [15, 30, 60, 75, 120]) {
      const bounds = rotatedBounds(120, 30, angle);
      const size = unrotatedSize(bounds, angle);
      expect(size.width).toBeCloseTo(120, 5);
      expect(size.height).toBeCloseTo(30, 5);
    }
  });

  it("cerca de 45 grados (sin solucion unica) asume un cuadrado finito y positivo", () => {
    const size = unrotatedSize({ width: 70, height: 70 }, 45);
    expect(size.width).toBeGreaterThan(0);
    expect(size.width).toBeCloseTo(size.height);
  });
});

describe("applyTextEdits — cubrir y redibujar", () => {
  it("la cobertura tapa el texto original: ni un pixel oscuro y el rectangulo mide bbox + padding (+-1 px)", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    expect((await render(source)).count(isDark)).toBeGreaterThan(50);

    const { bytes } = await applyTextEdits(source, [
      edit({ text: "", cover: { color: "#ff0000", padding: 2 } }),
    ]);
    const page = await render(bytes);
    expect(page.count(isDark)).toBe(0);

    // bbox (40,95,100,24) + padding 2 -> [38,142] x [93,121]; escala 2, alto 200.
    const red = page.bounds(isRed)!;
    expect(red).not.toBeNull();
    expect(Math.abs(red.x0 - 38 * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.x1 - 142 * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y0 - (200 - 121) * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y1 - (200 - 93) * 2)).toBeLessThanOrEqual(1);
  });

  it("con el color del fondo no queda borde visible: todo es fondo o texto nuevo", async () => {
    const bg: [number, number, number] = [1, 0.95, 0.7];
    const source = await buildPdf([{ background: bg, texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "Hi", cover: { color: "#fff2b3", padding: 1 } }),
    ]);
    const page = await render(bytes);
    const isBackground = ([r, g, b]: Rgb) =>
      Math.abs(r - 255) <= 2 && Math.abs(g - 242) <= 2 && Math.abs(b - 179) <= 2;
    // Zona original a la derecha del texto nuevo: sin restos del texto viejo.
    const restZone = { x0: 100 * 2, y0: (200 - 119) * 2, x1: 141 * 2, y1: (200 - 95) * 2 };
    expect(page.count((c) => !isBackground(c), restZone)).toBe(0);
    expect(page.count(isDark)).toBe(0);
    expect(page.count(isBlue)).toBeGreaterThan(10);
    // Anillo de 1-3 px fuera del bbox + padding: sigue siendo el fondo exacto.
    expect(page.count((c) => !isBackground(c), { x0: 34 * 2, y0: (200 - 124) * 2, x1: 38 * 2, y1: (200 - 90) * 2 })).toBe(0);
  });

  // Wave 8 · F2: antes (F1) este test comprobaba que "Original" SEGUIA extrayendose
  // con el aviso permanente `original-text-remains`; ahora el original se quita del flujo.
  it("el texto nuevo aparece al re-extraer y el original YA NO (F2), con aviso original-text-removed", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Cambiado" })]);
    const strings = (await extract(result.bytes)).map((item) => item.str);
    expect(strings).toContain("Cambiado");
    expect(strings).not.toContain("Original");
    expect(result.warnings).toContainEqual({ kind: "original-text-removed" });
    expect(result.warningsByEdit.e1).toContainEqual({ kind: "original-text-removed" });
    expect(result.warnings.some((w) => w.kind === "original-text-remains")).toBe(false);
  });

  it("original-text-removed tambien sale sin cobertura si reemplaza un bloque, y no en texto nuevo", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const noCover = await applyTextEdits(source, [edit({ cover: { color: null, padding: 0 } })]);
    expect(noCover.warnings).toContainEqual({ kind: "original-text-removed" });
    expect((await extract(noCover.bytes)).map((i) => i.str)).not.toContain("Original");

    const brandNew = await applyTextEdits(source, [
      edit({ blockId: undefined, coverBox: undefined, cover: { color: null, padding: 0 } }),
    ]);
    expect(brandNew.warnings).toEqual([]);
    expect(brandNew.warningsByEdit.e1).toBeUndefined();
  });

  it("las paginas sin ediciones no se tocan", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }, { texts: [{ text: "Pagina dos", x: 20, y: 100 }] }]);
    const { bytes } = await applyTextEdits(source, [edit({ pageIndex: 0 })]);
    const second = (await extract(bytes, 2)).map((item) => item.str);
    expect(second).toEqual(["Pagina dos"]);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(2);
  });

  it("borrar un bloque (texto vacio + cobertura) no dibuja texto", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [edit({ text: "   " })]);
    // F2: borrar el bloque tambien lo quita del flujo (antes quedaba "Original" bajo la cobertura).
    expect((await extract(bytes)).map((i) => i.str)).toEqual([]);
    expect((await render(bytes)).count(isDark)).toBe(0);
  });

  it("sin texto ni cobertura no cambia el aspecto", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const before = (await render(source)).count(isDark);
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "", blockId: undefined, cover: { color: null, padding: 0 } }),
    ]);
    expect((await render(bytes)).count(isDark)).toBe(before);
  });

  it("la cobertura de un vecino no tapa el texto de otra edicion de la misma pagina", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [
      edit({ id: "a", text: "AAAA" }),
      edit({
        id: "b",
        blockId: "p0-b1",
        text: "",
        box: { x: 30, y: 90, width: 140, height: 40 },
        coverBox: { x: 30, y: 90, width: 140, height: 40 },
        cover: { color: "#ffffff", padding: 0 },
      }),
    ]);
    expect((await render(bytes)).count(isBlue)).toBeGreaterThan(20);
  });

  it.each([
    ["sin rotar", 0],
    ["/Rotate 90", 90],
    ["/Rotate 180", 180],
    ["/Rotate 270", 270],
  ] as const)("cobertura y texto caen en el sitio en una pagina %s", async (_name, rotate) => {
    const source = await buildPdf([{ rotate, texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "", cover: { color: "#ff0000", padding: 2 } }),
    ]);
    const page = await render(bytes);
    expect(page.count(isDark)).toBe(0);

    const a = page.toPx(38, 93);
    const b = page.toPx(142, 121);
    const expected = {
      x0: Math.min(a.px, b.px),
      x1: Math.max(a.px, b.px),
      y0: Math.min(a.py, b.py),
      y1: Math.max(a.py, b.py),
    };
    const red = page.bounds(isRed)!;
    expect(Math.abs(red.x0 - expected.x0)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.x1 - expected.x1)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y0 - expected.y0)).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y1 - expected.y1)).toBeLessThanOrEqual(1);

    // El texto nuevo queda DENTRO de la caja cubierta, con la misma orientacion.
    // El original esta dibujado SIN girar en espacio de usuario: la edicion tambien (/Rotate lo gira igual).
    const withText = await applyTextEdits(source, [edit({ rotation: 0 })]);
    const rendered = await render(withText.bytes);
    const blue = rendered.bounds(isBlue)!;
    expect(blue).not.toBeNull();
    expect(blue.x0).toBeGreaterThanOrEqual(expected.x0 - 1);
    expect(blue.x1).toBeLessThanOrEqual(expected.x1 + 1);
    expect(blue.y0).toBeGreaterThanOrEqual(expected.y0 - 1);
    expect(blue.y1).toBeLessThanOrEqual(expected.y1 + 1);
  });

  it("CropBox con origen no cero: la cobertura sigue al texto original", async () => {
    const source = await buildPdf([
      {
        size: [400, 400],
        cropBox: [50, 60, 300, 200],
        texts: [{ text: "Original", x: 90, y: 140, size: 20 }],
      },
    ]);
    const box = { x: 90, y: 135, width: 100, height: 24 };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "", box, coverBox: box, cover: { color: "#ff0000", padding: 0 } }),
    ]);
    const page = await render(bytes);
    expect(page.count(isDark)).toBe(0);
    const a = page.toPx(90, 135);
    const b = page.toPx(190, 159);
    const red = page.bounds(isRed)!;
    expect(Math.abs(red.x0 - Math.min(a.px, b.px))).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y0 - Math.min(a.py, b.py))).toBeLessThanOrEqual(1);
    expect(Math.abs(red.x1 - Math.max(a.px, b.px))).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y1 - Math.max(a.py, b.py))).toBeLessThanOrEqual(1);
  });

  it("CropBox desplazado + /Rotate 90 a la vez", async () => {
    const source = await buildPdf([
      {
        size: [400, 400],
        rotate: 90,
        cropBox: [50, 60, 300, 200],
        texts: [{ text: "Original", x: 90, y: 140, size: 20 }],
      },
    ]);
    const box = { x: 90, y: 135, width: 100, height: 24 };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "", box, coverBox: box, cover: { color: "#ff0000", padding: 0 } }),
    ]);
    const page = await render(bytes);
    expect(page.count(isDark)).toBe(0);
    const a = page.toPx(90, 135);
    const b = page.toPx(190, 159);
    const red = page.bounds(isRed)!;
    expect(Math.abs(red.x0 - Math.min(a.px, b.px))).toBeLessThanOrEqual(1);
    expect(Math.abs(red.y1 - Math.max(a.py, b.py))).toBeLessThanOrEqual(1);
  });

  it("alinea a la izquierda, centro y derecha dentro de la caja", async () => {
    const source = await buildPdf([{}]);
    const box = { x: 40, y: 95, width: 200, height: 24 };
    for (const align of ["left", "center", "right"] as const) {
      const { bytes } = await applyTextEdits(source, [
        edit({ text: "Hola", box, coverBox: box, align, fontSize: 20, blockId: undefined, cover: { color: null, padding: 0 } }),
      ]);
      const item = (await extract(bytes)).find((i) => i.str === "Hola")!;
      const left = item.transform[4];
      if (align === "left") expect(left).toBeCloseTo(40, 1);
      if (align === "center") expect(left + item.width / 2).toBeCloseTo(140, 0);
      if (align === "right") expect(left + item.width).toBeCloseTo(240, 0);
    }
  });

  it("ajusta el texto al ancho de la caja con interlineado por defecto 1.2", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const box = { x: 40, y: 20, width: 80, height: 100 };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "uno dos tres cuatro cinco seis siete", box, coverBox: box, fontSize: 12 }),
    ]);
    const lines = (await extract(bytes)).filter((i) => i.str !== "Original");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(80.5);
    const ys = lines.map((l) => l.transform[5]).sort((a, b) => b - a);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i - 1] - ys[i]).toBeCloseTo(14.4, 2);
    // Primera linea base = arriba de la caja - half-leading - ascenso.
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const ascent = font.heightAtSize(12, { descender: false });
    const descent = font.heightAtSize(12) - ascent;
    expect(ys[0]).toBeCloseTo(120 - ((14.4 - (ascent + descent)) / 2 + ascent), 2);
  });

  it("respeta lineHeight propio y los saltos de linea explicitos", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const box = { x: 40, y: 20, width: 200, height: 100 };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "uno\ndos\n\ntres", box, coverBox: box, fontSize: 10, lineHeight: 1.5 }),
    ]);
    const lines = (await extract(bytes)).filter((i) => i.str !== "Original");
    expect(lines.map((l) => l.str)).toEqual(["uno", "dos", "tres"]);
    const ys = lines.map((l) => l.transform[5]);
    expect(ys[0] - ys[1]).toBeCloseTo(15, 2);
    // La linea en blanco ocupa su hueco: 3 interlineados entre uno y tres.
    expect(ys[0] - ys[2]).toBeCloseTo(45, 2);
  });

  it("rotacion de la edicion: el texto sale girado y dentro de su caja", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const box = { x: 100, y: 40, width: 24, height: 100 };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "Vertical", box, coverBox: box, rotation: 90 }),
    ]);
    const item = (await extract(bytes)).find((i) => i.str === "Vertical")!;
    // Rotado 90 grados antihorario: a ~ 0, b = +tamano.
    expect(item.transform[0]).toBeCloseTo(0, 5);
    expect(item.transform[1]).toBeCloseTo(20, 3);
    const page = await render(bytes);
    const blue = page.bounds(isBlue)!;
    const a = page.toPx(100, 40);
    const b = page.toPx(124, 140);
    expect(blue.x0).toBeGreaterThanOrEqual(Math.min(a.px, b.px) - 1);
    expect(blue.x1).toBeLessThanOrEqual(Math.max(a.px, b.px) + 1);
    expect(blue.y0).toBeGreaterThanOrEqual(Math.min(a.py, b.py) - 1);
    expect(blue.y1).toBeLessThanOrEqual(Math.max(a.py, b.py) + 1);
  });

  it("rotacion libre (30 grados) con caja envolvente: el ancho de ajuste sale de la caja sin rotar", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const { rotatedBounds } = await import("@/lib/pdf/core");
    const bounds = rotatedBounds(120, 30, 30);
    const box = { x: 80, y: 60, width: bounds.width, height: bounds.height };
    const { bytes } = await applyTextEdits(source, [
      edit({ text: "Inclinado", box, coverBox: box, rotation: 30, fontSize: 14 }),
    ]);
    const item = (await extract(bytes)).find((i) => i.str === "Inclinado")!;
    expect(item.transform[1]).toBeGreaterThan(0);
    expect(Math.atan2(item.transform[1], item.transform[0]) * (180 / Math.PI)).toBeCloseTo(30, 1);
  });

  it("negrita y cursiva usan las 4 variantes de la fuente base", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [
      edit({ id: "a", text: "Negrita", bold: true, fontKey: "times" }),
      edit({
        id: "b",
        blockId: undefined,
        text: "Cursiva",
        italic: true,
        fontKey: "courier",
        box: { x: 40, y: 20, width: 150, height: 24 },
        coverBox: undefined,
        cover: { color: null, padding: 0 },
      }),
    ]);
    const loaded = await PDFDocument.load(bytes);
    const baseFonts: string[] = [];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict) {
        const base = object.get(PDFName.of("BaseFont"));
        if (base instanceof PDFName) baseFonts.push(base.decodeText());
      }
    }
    expect(baseFonts).toContain("Times-Bold");
    expect(baseFonts).toContain("Courier-Oblique");
  });

  it("ignora ediciones con pagina inexistente o tamano de fuente invalido y las lista", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [
      edit({ id: "lejos", pageIndex: 5 }),
      edit({ id: "negativa", pageIndex: -1 }),
      edit({ id: "cero", fontSize: 0 }),
      edit({ id: "nan", fontSize: Number.NaN }),
      edit({ id: "ok" }),
    ]);
    expect(result.skipped).toEqual(["lejos", "negativa", "cero", "nan"]);
    expect(Object.keys(result.warningsByEdit).sort()).toEqual(["cero", "lejos", "nan", "negativa", "ok"]);
    expect(result.warningsByEdit.lejos).toEqual([{ kind: "edit-skipped", reason: "page" }]);
    expect(result.warningsByEdit.nan).toEqual([{ kind: "edit-skipped", reason: "font-size" }]);
  });

  it("acepta un PDFDocument ya cargado y lo modifica en su sitio", async () => {
    const document = await PDFDocument.load(await buildPdf([{ texts: [ORIGINAL] }]));
    const result = await applyTextEdits(document, [edit({ text: "En sitio" })]);
    expect((await extract(result.bytes)).map((i) => i.str)).toContain("En sitio");
    expect(document.getPage(0).node.Contents()).toBeDefined();
  });

  it("un archivo que no es PDF lanza PdfError", async () => {
    await expect(
      applyTextEdits(new Uint8Array([1, 2, 3, 4]), [edit()]),
    ).rejects.toBeInstanceOf(PdfError);
  });

  it("informa progreso creciente que termina en 1", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }, { texts: [ORIGINAL] }]);
    const seen: number[] = [];
    await applyTextEdits(source, [edit({ pageIndex: 0 }), edit({ id: "e2", pageIndex: 1 })], {
      onProgress: (value) => seen.push(value),
    });
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  it("signal abortado antes de empezar lanza cancelled", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      applyTextEdits(source, [edit()], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("signal abortado a mitad de camino (tras la carga) lanza cancelled y no devuelve bytes", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }, { texts: [ORIGINAL] }]);
    const controller = new AbortController();
    const promise = applyTextEdits(source, [edit({ pageIndex: 0 }), edit({ id: "e2", pageIndex: 1 })], {
      signal: controller.signal,
      onProgress: (value) => {
        if (value >= 0.1 && value < 0.5) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("applyTextEdits — fuentes del catalogo y avisos", () => {
  it("texto con cirilico y griego en Liberation Sans: sale tal cual al re-extraer, en subconjunto", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const text = "Привет, Ωmega ñandú";
    const result = await applyTextEdits(source, [
      edit({ text, fontKey: "liberation-sans", box: { x: 20, y: 95, width: 260, height: 24 } }),
    ]);
    const strings = (await extract(result.bytes)).map((i) => i.str).join(" ");
    expect(strings).toContain(text);
    expect(result.warnings.filter((w) => w.kind === "glyph-missing")).toEqual([]);
  });

  it("el PDF con una fuente del catalogo en subconjunto pesa una fraccion del TTF completo", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const regular = fs.statSync(path.join(process.cwd(), "public/fonts/LiberationSans-Regular.ttf")).size;
    const standard = await applyTextEdits(source, [edit({ text: "Hola mundo" })]);
    const embedded = await applyTextEdits(source, [edit({ text: "Hola mundo", fontKey: "liberation-sans" })]);
    const added = embedded.bytes.byteLength - standard.bytes.byteLength;
    console.info(
      `[medida] TTF completo ${regular} B; PDF con fuente base ${standard.bytes.byteLength} B; ` +
        `PDF con Liberation Sans subconjunto ${embedded.bytes.byteLength} B (+${added} B)`,
    );
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(regular / 5);
    expect(embedded.bytes.byteLength).toBeLessThan(regular / 5);
  });

  it("la fuente embebida es un subconjunto real: BaseFont propio y fichero de fuente pequeno", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const { bytes } = await applyTextEdits(source, [edit({ text: "abc", fontKey: "liberation-sans", bold: true })]);
    const loaded = await PDFDocument.load(bytes);
    const names: string[] = [];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict) {
        const base = object.get(PDFName.of("BaseFont"));
        if (base instanceof PDFName) names.push(base.decodeText());
      }
    }
    expect(names.some((n) => /^[A-Z]{6}\+LiberationSans-Bold$/.test(n))).toBe(true);
    const sizes = await embeddedFontFileSizes(bytes);
    expect(sizes.length).toBeGreaterThan(0);
    const bold = fs.statSync(path.join(process.cwd(), "public/fonts/LiberationSans-Bold.ttf")).size;
    expect(Math.max(...sizes)).toBeLessThan(bold / 5);
  });

  it("carga fontkit y los TTF de forma perezosa: nada para fuentes base, una vez para las embebidas", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const loadFontkit = vi.fn(async () => (await import("@pdf-lib/fontkit")) as never);
    const loadFontBytes = vi.fn(loadCatalogFont);

    await applyTextEdits(source, [edit({ text: "base" })], { loadFontkit, loadFontBytes });
    expect(loadFontkit).not.toHaveBeenCalled();
    expect(loadFontBytes).not.toHaveBeenCalled();

    await applyTextEdits(
      source,
      [
        edit({ id: "a", text: "uno", fontKey: "liberation-sans" }),
        edit({ id: "b", text: "dos", fontKey: "liberation-sans", box: { x: 40, y: 40, width: 100, height: 24 } }),
        edit({ id: "c", text: "tres", fontKey: "liberation-sans", bold: true, box: { x: 40, y: 10, width: 100, height: 24 } }),
      ],
      { loadFontkit, loadFontBytes },
    );
    expect(loadFontkit).toHaveBeenCalledTimes(1);
    expect(loadFontBytes).toHaveBeenCalledTimes(2); // regular + bold
  });

  it("glifos fuera de WinAnsi con fuente base: usa Liberation Sans y avisa glyph-missing con fallbackKey", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Привет", fontKey: "helvetica" })]);
    expect((await extract(result.bytes)).map((i) => i.str)).toContain("Привет");
    expect(result.warningsByEdit.e1).toContainEqual({
      kind: "glyph-missing",
      chars: ["П", "р", "и", "в", "е", "т"],
      fallbackKey: "liberation-sans",
    });
  });

  it("glifos que ninguna fuente tiene: salen como ? y se avisa, nunca en silencio", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Hola 日本", fontKey: "times" })]);
    expect((await extract(result.bytes)).map((i) => i.str)).toContain("Hola ??");
    expect(result.warningsByEdit.e1).toContainEqual({
      kind: "glyph-missing",
      chars: ["日", "本"],
    });
  });

  it("mezcla (cirilico + CJK): fuente de respaldo para lo posible y ? para lo imposible, dos avisos", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Да 日", fontKey: "helvetica" })]);
    expect((await extract(result.bytes)).map((i) => i.str)).toContain("Да ?");
    const kinds = result.warningsByEdit.e1.filter((w) => w.kind === "glyph-missing");
    expect(kinds).toHaveLength(2);
    expect(kinds).toContainEqual({ kind: "glyph-missing", chars: ["日"] });
  });

  it("sustitucion aproximada de la fuente original: aviso font-substituted con el nombre original", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [
      edit({ fontKey: "liberation-sans", sourceFont: sourceFont("ABCDEF+Calibri-Bold") }),
    ]);
    expect(result.warningsByEdit.e1).toContainEqual({
      kind: "font-substituted",
      from: "ABCDEF+Calibri-Bold",
      to: "liberation-sans",
    });
  });

  it("fuente original exacta (Arial -> Helvetica): sin aviso de sustitucion", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [
      edit({ fontKey: "helvetica", sourceFont: sourceFont("ArialMT") }),
    ]);
    expect(result.warnings.some((w) => w.kind === "font-substituted")).toBe(false);
  });

  it("si el usuario elige otra fuente distinta de la mapeada no hay aviso de sustitucion", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [
      edit({ fontKey: "times", sourceFont: sourceFont("Calibri") }),
    ]);
    expect(result.warnings.some((w) => w.kind === "font-substituted")).toBe(false);
  });

  it("liberation-serif/mono se embeben con su propio TTF: sin sustitucion y con cirilico/griego en la misma familia", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    for (const fontKey of ["liberation-serif", "liberation-mono"] as const) {
      const plain = await applyTextEdits(source, [edit({ fontKey, text: "Hola" })]);
      expect(plain.warnings.some((w) => w.kind === "font-substituted")).toBe(false);
      const sizes = await embeddedFontFileSizes(plain.bytes);
      expect(sizes).toHaveLength(1);
    }
    // Times/Courier con cirilico: caen a la Liberation de SU familia, no a Sans.
    const serif = await applyTextEdits(source, [edit({ fontKey: "times", text: "Привет" })]);
    expect(serif.warningsByEdit.e1).toContainEqual({
      kind: "glyph-missing",
      chars: ["П", "р", "и", "в", "е", "т"],
      fallbackKey: "liberation-serif",
    });
    const mono = await applyTextEdits(source, [edit({ fontKey: "courier", text: "Ωmega" })]);
    expect(mono.warningsByEdit.e1).toContainEqual({
      kind: "glyph-missing",
      chars: ["Ω"],
      fallbackKey: "liberation-mono",
    });
    expect((await extract(serif.bytes)).map((i) => i.str)).toContain("Привет");
  });

  it("si el TTF no se puede cargar, la exportacion NO falla: usa Helvetica y avisa", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Hola", fontKey: "liberation-sans" })], {
      loadFontBytes: async () => {
        throw new Error("sin red");
      },
    });
    expect((await extract(result.bytes)).map((i) => i.str)).toContain("Hola");
    expect(result.warnings).toContainEqual({
      kind: "font-substituted",
      from: "liberation-sans",
      to: "helvetica",
    });
  });

  it("un TTF corrupto tampoco aborta: mismo respaldo", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [edit({ text: "Hola", fontKey: "liberation-sans" })], {
      loadFontBytes: async () => new Uint8Array([0, 1, 2, 3, 4, 5]),
    });
    expect(result.warnings).toContainEqual({
      kind: "font-substituted",
      from: "liberation-sans",
      to: "helvetica",
    });
  });

  it("cancelar durante la carga de la fuente propaga cancelled", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const controller = new AbortController();
    await expect(
      applyTextEdits(source, [edit({ fontKey: "liberation-sans" })], {
        signal: controller.signal,
        loadFontBytes: async () => {
          controller.abort();
          throw new Error("abortado");
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("no repite avisos identicos en la lista global pero si los asocia a cada edicion", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const result = await applyTextEdits(source, [
      edit({ id: "a" }),
      edit({ id: "b", box: { x: 40, y: 40, width: 100, height: 24 }, coverBox: { x: 40, y: 40, width: 100, height: 24 } }),
    ]);
    // F2: la edicion "a" cubre el bloque (se quita); "b" apunta a una caja sin texto (no se encuentra).
    expect(result.warnings.filter((w) => w.kind === "original-text-removed")).toHaveLength(1);
    expect(result.warningsByEdit.a).toContainEqual({ kind: "original-text-removed" });
    expect(result.warningsByEdit.b).toContainEqual({ kind: "original-text-remains", reason: "not-found" });
  });
});

/* ------------------------------------------------------------------ *
 * Aplanar pagina
 * ------------------------------------------------------------------ */

async function createNodeRasterizer(bytes: Uint8Array): Promise<PageRasterizer> {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONTS_URL,
  }).promise;
  return {
    async rasterize(pageIndex, scale, quality) {
      const page = await pdf.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      await page.render({ canvasContext: context, viewport } as never).promise;
      return {
        bytes: new Uint8Array(canvas.toBuffer("image/jpeg", Math.round(quality * 100))),
        format: "jpeg",
        width: base.width,
        height: base.height,
      };
    },
    close: async () => {
      await pdf.loadingTask.destroy();
    },
  };
}

/**
 * Busca `needle` en los bytes del archivo Y en el contenido ya descomprimido
 * de todos sus streams (pdf-lib comprime las paginas, asi que buscar solo en
 * los bytes crudos daria un falso "no esta").
 */
async function contains(bytes: Uint8Array, needle: string): Promise<boolean> {
  const target = Buffer.from(needle, "latin1");
  // pdf-lib escribe el texto de las fuentes base como cadena hexadecimal.
  const hexTarget = Buffer.from(target.toString("hex").toUpperCase(), "latin1");
  const found = (haystack: Uint8Array) =>
    Buffer.from(haystack).includes(target) || Buffer.from(haystack).includes(hexTarget);
  if (found(bytes)) return true;
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      const decoded = decodePDFRawStream(object).decode();
      if (found(decoded)) return true;
    } catch {
      // Stream de imagen u otro filtro que no se decodifica: no es texto.
    }
  }
  return false;
}

/** Tamano de cada fichero de fuente (FontFile2/3) embebido en el PDF. */
async function embeddedFontFileSizes(bytes: Uint8Array): Promise<number[]> {
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  const sizes: number[] = [];
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const ref = object.get(PDFName.of("FontFile2")) ?? object.get(PDFName.of("FontFile3"));
    if (!ref) continue;
    const stream = loaded.context.lookup(ref);
    if (stream instanceof PDFRawStream) sizes.push(stream.getContentsSize());
  }
  return sizes;
}

describe("flattenPages — Aplanar pagina", () => {
  async function threePages() {
    return buildPdf([
      { texts: [{ text: "SECRETO uno", x: 20, y: 100 }] },
      { texts: [{ text: "SECRETO dos", x: 20, y: 100 }] },
      { texts: [{ text: "SECRETO tres", x: 20, y: 100 }] },
    ]);
  }

  it("la pagina aplanada ya no tiene texto extraible; las demas lo conservan", async () => {
    const source = await threePages();
    const flat = await flattenPages(source, [1], { createRasterizer: createNodeRasterizer });
    expect((await extract(flat, 1)).map((i) => i.str)).toEqual(["SECRETO uno"]);
    expect(await extract(flat, 2)).toEqual([]);
    expect((await extract(flat, 3)).map((i) => i.str)).toEqual(["SECRETO tres"]);
    expect((await PDFDocument.load(flat)).getPageCount()).toBe(3);
  });

  it("el texto original desaparece tambien de los bytes del archivo (control: antes estaba)", async () => {
    const source = await threePages();
    expect(await contains(source, "SECRETO dos")).toBe(true);
    const flat = await flattenPages(source, [1], { createRasterizer: createNodeRasterizer });
    expect(await contains(flat, "SECRETO dos")).toBe(false);
    expect(await contains(flat, "SECRETO uno")).toBe(true);
  });

  it("se ve igual: la pagina aplanada conserva tamano y trazos oscuros", async () => {
    const source = await threePages();
    const before = await render(source, 2);
    const flat = await flattenPages(source, [1], { createRasterizer: createNodeRasterizer });
    const after = await render(flat, 2);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    const darkBefore = before.count(isDark);
    expect(after.count(isDark)).toBeGreaterThan(darkBefore * 0.6);
    expect(after.count(isDark)).toBeLessThan(darkBefore * 1.4);
  });

  it("hornea las ediciones: tras aplicar y aplanar, ni el texto viejo ni el nuevo se extraen pero el nuevo se ve", async () => {
    const source = await buildPdf([{ texts: [ORIGINAL] }]);
    const edited = await applyTextEdits(source, [edit({ text: "Nuevo" })]);
    // F2 ya quito el original del flujo; el aplanado sigue quitando ademas el texto nuevo.
    expect((await extract(edited.bytes)).map((i) => i.str)).toEqual(["Nuevo"]);
    const flat = await flattenPages(edited.bytes, [0], { createRasterizer: createNodeRasterizer });
    expect(await extract(flat)).toEqual([]);
    expect(await contains(flat, "Original")).toBe(false);
    const page = await render(flat);
    expect(page.count(isBlue)).toBeGreaterThan(10);
    expect(page.count(isDark)).toBeLessThan(10);
  });

  it("una pagina con /Rotate 90 se aplana con las dimensiones que se ven", async () => {
    const source = await buildPdf([{ rotate: 90, texts: [ORIGINAL] }]);
    const flat = await flattenPages(source, [0], { createRasterizer: createNodeRasterizer });
    const loaded = await PDFDocument.load(flat);
    const size = loaded.getPage(0).getSize();
    expect(size.width).toBeCloseTo(200);
    expect(size.height).toBeCloseTo(300);
    expect(loaded.getPage(0).getRotation().angle).toBe(0);
  });

  it("conserva titulo y autor", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.setTitle("Contrato");
    document.setAuthor("Ana");
    const flat = await flattenPages(await document.save(), [0], { createRasterizer: createNodeRasterizer });
    const loaded = await PDFDocument.load(flat);
    expect(loaded.getTitle()).toBe("Contrato");
    expect(loaded.getAuthor()).toBe("Ana");
  });

  it("indices invalidos o repetidos: se ignoran; sin ninguno valido lanza nothingSelected", async () => {
    const source = await threePages();
    await expect(
      flattenPages(source, [7, -1, 1.5], { createRasterizer: createNodeRasterizer }),
    ).rejects.toMatchObject({ code: "nothingSelected" });
    const rasterize = vi.fn(async () => ({ bytes: new Uint8Array(), format: "jpeg" as const, width: 1, height: 1 }));
    await expect(
      flattenPages(source, [], { createRasterizer: async () => ({ rasterize, close: async () => {} }) }),
    ).rejects.toMatchObject({ code: "nothingSelected" });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("cierra el rasterizador aunque falle, y respeta la cancelacion", async () => {
    const source = await threePages();
    const close = vi.fn(async () => {});
    await expect(
      flattenPages(source, [0], {
        createRasterizer: async () => ({
          rasterize: async () => {
            throw new Error("canvas roto");
          },
          close,
        }),
      }),
    ).rejects.toBeInstanceOf(PdfError);
    expect(close).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      flattenPages(source, [0], { signal: controller.signal, createRasterizer: createNodeRasterizer }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("aplana varias paginas a la vez e informa progreso hasta 1", async () => {
    const source = await threePages();
    const seen: number[] = [];
    const flat = await flattenPages(source, [0, 2], {
      createRasterizer: createNodeRasterizer,
      onProgress: (value) => seen.push(value),
    });
    expect(await extract(flat, 1)).toEqual([]);
    expect((await extract(flat, 2)).map((i) => i.str)).toEqual(["SECRETO dos"]);
    expect(await extract(flat, 3)).toEqual([]);
    expect(seen.at(-1)).toBe(1);
  });
});
