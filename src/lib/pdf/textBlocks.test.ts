import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
} from "@cantoo/pdf-lib";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import PDFKit from "pdfkit";
import {
  getPageGeometry,
  userBoxToNormalizedRect,
  viewPointToUser,
} from "@/lib/pdf/core";
import type { TextBlock } from "@/lib/pdf/editTypes";
import {
  STANDARD_FONT_DIR,
  checkBlock,
  drawLine,
  findBlock,
  hexToRgb,
  newDoc,
  openWithPdfjs,
  setRawContent,
  type DrawSpec,
  type Expected,
} from "@/lib/pdf/textBlocksFixtures";
import {
  analyzeDocPageText,
  analyzePageText,
  blockAtPoint,
  collectTextRuns,
  extractTextBlocks,
  extractTextBlocksFromDoc,
  findRun,
  type TextOps,
} from "@/lib/pdf/textBlocks";
import { sourceFontInfoFrom } from "@/lib/pdf/fontInfo";
import fs from "node:fs";
import path from "node:path";
import {
  groupTextItems,
  looksLikeShiftedGlyphIds,
  type RuleLine,
} from "@/lib/pdf/textBlocksGroup";

const H = StandardFonts.Helvetica;
const HB = StandardFonts.HelveticaBold;
const T = StandardFonts.TimesRoman;
const TB = StandardFonts.TimesRomanBold;
const C = StandardFonts.Courier;

/** Abre, analiza la pagina `n` (1-based) y cierra. */
async function analyzeBytes(
  bytes: Uint8Array,
  pageNumber = 1,
  includeInvisible = false,
) {
  const opened = await openWithPdfjs(bytes);
  try {
    const page = await opened.page(pageNumber);
    return await analyzePageText(page, pageNumber - 1, {
      OPS: opened.OPS,
      includeInvisible,
    });
  } finally {
    await opened.close();
  }
}

/* ------------------------------------------------------------------ *
 * BATERIA: PDFs sinteticos con respuesta conocida
 * ------------------------------------------------------------------ */

type BatteryCase = { category: string; expected: Expected };

function union(items: Expected[], text: string): Expected {
  const x = Math.min(...items.map((i) => i.box.x));
  const y = Math.min(...items.map((i) => i.box.y));
  const r = Math.max(...items.map((i) => i.box.x + i.box.width));
  const t = Math.max(...items.map((i) => i.box.y + i.box.height));
  return {
    text,
    box: { x, y, width: r - x, height: t - y },
    size: items[0].size,
    color: items[0].color,
    rotation: items[0].rotation,
  };
}

async function buildBattery() {
  const { doc, font } = await newDoc();
  const cases: Array<BatteryCase & { page: number }> = [];
  const add = (page: number, category: string, expected: Expected) =>
    cases.push({ page, category, expected });

  /* Pagina 1: lineas sueltas de distinto tamano, color y fuente. */
  const p1 = doc.addPage([612, 792]);
  const singles: DrawSpec[] = [
    { text: "Titulo principal", x: 72, y: 700, size: 24, color: "#1a237e", font: HB },
    { text: "Subtitulo en gris", x: 72, y: 670, size: 14, color: "#808080" },
    { text: "Texto de cuerpo a diez puntos", x: 72, y: 640, size: 10, font: T },
    { text: "Nota diminuta 8 pt", x: 72, y: 615, size: 8, color: "#cc0000", font: C },
    { text: "Grande", x: 72, y: 560, size: 36, color: "#00aa00" },
    { text: "Magenta once", x: 320, y: 640, size: 11, color: "#ff00ff" },
    { text: "Cafe senor nandu", x: 320, y: 615, size: 12, font: TB, color: "#0000ff" },
    { text: "Total: 1,234.56 EUR", x: 320, y: 590, size: 13, color: "#333333" },
    { text: "UNA FRASE EN MAYUSCULAS", x: 72, y: 500, size: 16, font: HB },
    { text: "x", x: 72, y: 450, size: 12 },
    { text: "Texto naranja en courier", x: 200, y: 450, size: 9.5, font: C, color: "#ff8800" },
    { text: "Ultima linea de la pagina uno", x: 72, y: 60, size: 12, font: T, color: "#555555" },
  ];
  for (const spec of singles) add(1, "linea suelta", await drawLine(p1, font, spec));

  /* Pagina 2: rotaciones. */
  const p2 = doc.addPage([612, 792]);
  const rotated: DrawSpec[] = [
    { text: "Texto a noventa", x: 100, y: 200, size: 14, rotate: 90 },
    { text: "Texto a ciento ochenta", x: 500, y: 700, size: 12, rotate: 180, color: "#ff0000" },
    { text: "Texto a doscientos setenta", x: 550, y: 600, size: 12, rotate: 270, font: T },
    { text: "Texto a treinta grados", x: 200, y: 300, size: 14, rotate: 30, color: "#0000ff" },
    { text: "Texto a cuarenta y cinco", x: 150, y: 450, size: 11, rotate: 45, font: HB },
    { text: "Texto a menos veinte", x: 300, y: 150, size: 12, rotate: -20, color: "#008800" },
  ];
  for (const spec of rotated) add(2, "rotado", await drawLine(p2, font, spec));

  /* Pagina 3: parrafos. */
  const p3 = doc.addPage([612, 792]);
  const paragraph = async (
    lines: string[],
    x0: number,
    top: number,
    size: number,
    align: "left" | "center" | "right",
    color = "#000000",
    face: StandardFonts = H,
  ): Promise<Expected> => {
    const f = await font(face);
    const out: Expected[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const width = f.widthOfTextAtSize(lines[i], size);
      const x = align === "left" ? x0 : align === "center" ? x0 - width / 2 : x0 - width;
      out.push(
        await drawLine(p3, font, {
          text: lines[i],
          x,
          y: top - i * 1.2 * size,
          size,
          color,
          font: face,
        }),
      );
    }
    return union(out, lines.join(" "));
  };
  add(3, "parrafo", await paragraph(
    ["Este es un parrafo de cuatro lineas que", "se ha escrito para probar el agrupado", "geometrico de bloques de texto en una", "pagina de prueba."],
    72, 700, 12, "left",
  ));
  add(3, "parrafo", await paragraph(
    ["Parrafo centrado de tres lineas", "con anchos distintos entre ellas", "y un cierre corto"],
    306, 600, 12, "center", "#222222",
  ));
  add(3, "parrafo", await paragraph(
    ["Parrafo alineado a la derecha", "con tres lineas de ancho", "distinto"],
    540, 500, 11, "right", "#aa0000", T,
  ));
  add(3, "parrafo", await paragraph(
    ["Primer parrafo de dos lineas aqui", "y termina en esta linea del primero"],
    72, 400, 12, "left",
  ));
  add(3, "parrafo", await paragraph(
    ["Segundo parrafo separado por un", "hueco mayor que el interlineado"],
    72, 400 - 2 * 14.4 - 12, 12, "left",
  ));

  /* Pagina 4: columnas y tabla. */
  const p4 = doc.addPage([612, 792]);
  const column = async (x: number, label: string) => {
    const lines = [1, 2, 3, 4, 5].map((n) => `${label} linea numero ${n} con texto largo`);
    const out: Expected[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      out.push(
        await drawLine(p4, font, { text: lines[i], x, y: 700 - i * 14.4, size: 12 }),
      );
    }
    return union(out, lines.join(" "));
  };
  add(4, "columna", await column(50, "Izquierda"));
  add(4, "columna", await column(330, "Derecha"));
  const cells = [
    ["Nombre", "Cantidad", "Precio"],
    ["Manzana", "3", "1.20"],
    ["Pera", "12", "0.80"],
  ];
  for (let r = 0; r < cells.length; r += 1) {
    for (let c = 0; c < cells[r].length; c += 1) {
      add(4, "tabla", await drawLine(p4, font, {
        text: cells[r][c],
        x: 50 + c * 150,
        y: 500 - r * 14.4,
        size: 12,
        font: r === 0 ? HB : H,
      }));
    }
  }

  /* Pagina 5: superindices. */
  const p5 = doc.addPage([612, 792]);
  const hf = await font(H);
  add(5, "superindice", await drawLine(p5, font, { text: "E = mc", x: 72, y: 700, size: 12 }));
  add(5, "superindice", await drawLine(p5, font, {
    text: "2", x: 72 + hf.widthOfTextAtSize("E = mc", 12) + 0.3, y: 705, size: 8,
  }));
  add(5, "superindice", await drawLine(p5, font, { text: "Nota al pie", x: 72, y: 650, size: 12 }));
  add(5, "superindice", await drawLine(p5, font, {
    text: "1", x: 72 + hf.widthOfTextAtSize("Nota al pie", 12) + 0.3, y: 655, size: 7.5,
  }));

  /* Pagina 6: /Rotate 90 y CropBox desplazado. */
  const p6 = doc.addPage([612, 792]);
  p6.setRotation(degrees(90));
  p6.setCropBox(40, 60, 400, 500);
  add(6, "pagina girada", await drawLine(p6, font, { text: "Texto en pagina girada", x: 100, y: 300, size: 14, color: "#aa00aa" }));
  add(6, "pagina girada", await drawLine(p6, font, { text: "Segunda linea con cropbox", x: 100, y: 200, size: 11, font: T }));

  return { bytes: await doc.save(), cases };
}

describe("bateria sintetica (criterios medibles)", () => {
  it("detecta >= 90 % de los bloques con caja, tamano, color y rotacion correctos", async () => {
    const { bytes, cases } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const byPage = new Map<number, TextBlock[]>();
    for (const n of new Set(cases.map((c) => c.page))) {
      byPage.set(n, await extractTextBlocks(await opened.page(n), n - 1, { OPS: opened.OPS }));
    }
    await opened.close();

    const tally: Record<string, { total: number; ok: number }> = {};
    const failures: string[] = [];
    let ok = 0;
    for (const { page, category, expected } of cases) {
      const entry = (tally[category] ??= { total: 0, ok: 0 });
      entry.total += 1;
      const block = findBlock(byPage.get(page) ?? [], expected.text);
      const check = block ? checkBlock(block, expected) : null;
      const pass = !!check && check.covers && check.tight && check.size && check.color && check.rotation;
      if (pass) {
        entry.ok += 1;
        ok += 1;
      } else {
        failures.push(
          `${category} "${expected.text}" ${block ? JSON.stringify({ check, box: block.box, expected: expected.box, size: block.fontSize, color: block.color, rot: block.rotation }) : "NO DETECTADO"}`,
        );
      }
    }
    // Resumen visible en caso de fallo.
    expect(failures, JSON.stringify(tally)).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(ok / cases.length).toBeGreaterThanOrEqual(0.9);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers de PDFs a medida
 * ------------------------------------------------------------------ */

/** PDF de una pagina con flujo de contenido en bruto y Helvetica como /F1. */
async function rawPdf(
  content: string,
  options: {
    size?: [number, number];
    extGState?: Record<string, Record<string, number>>;
    fontName?: StandardFonts;
  } = {},
): Promise<Uint8Array> {
  const { doc, font } = await newDoc();
  const f = await font(options.fontName ?? H);
  const page = doc.addPage(options.size ?? [400, 400]);
  setRawContent(doc, page, content, { F1: f });
  if (options.extGState) {
    const entries: Record<string, PDFDict> = {};
    for (const [name, dict] of Object.entries(options.extGState)) {
      entries[name] = doc.context.obj(dict);
    }
    page.node.Resources()?.set(PDFName.of("ExtGState"), doc.context.obj(entries));
  }
  return doc.save();
}

function textsOf(blocks: readonly TextBlock[]): string[] {
  return blocks.map((b) => b.text);
}

/* ------------------------------------------------------------------ *
 * Pagina por pagina de la bateria
 * ------------------------------------------------------------------ */

describe("extraccion sobre la bateria", () => {
  let blocksByPage: Map<number, TextBlock[]>;

  const load = async () => {
    if (blocksByPage) return blocksByPage;
    const { bytes } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    blocksByPage = new Map();
    for (let n = 1; n <= 6; n += 1) {
      blocksByPage.set(
        n,
        await extractTextBlocks(await opened.page(n), n - 1, { OPS: opened.OPS }),
      );
    }
    await opened.close();
    return blocksByPage;
  };

  it("lineas sueltas: izquierda y ancho a lo largo de la linea base dentro de 1 pt", async () => {
    const { bytes, cases } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const blocks = await extractTextBlocks(await opened.page(1), 0, { OPS: opened.OPS });
    await opened.close();
    for (const { expected } of cases.filter((c) => c.page === 1)) {
      const block = findBlock(blocks, expected.text)!;
      expect(block, expected.text).toBeDefined();
      expect(Math.abs(block.box.x - expected.box.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(block.box.width - expected.box.width)).toBeLessThanOrEqual(1);
      // La linea base declarada es la dibujada.
      expect(block.lines).toHaveLength(1);
      expect(block.lines[0].origin!.x).toBeCloseTo(expected.box.x, 0);
    }
  });

  it("lineas sueltas: familia, negrita y subconjunto de la fuente", async () => {
    const blocks = (await load()).get(1)!;
    const title = findBlock(blocks, "Titulo principal")!;
    expect(title.font.bold).toBe(true);
    expect(title.font.family).toBe("sans");
    const body = findBlock(blocks, "Texto de cuerpo a diez puntos")!;
    expect(body.font.family).toBe("serif");
    expect(body.font.bold).toBe(false);
    const note = findBlock(blocks, "Nota diminuta 8 pt")!;
    expect(note.font.family).toBe("mono");
    expect(findBlock(blocks, "Cafe senor nandu")!.font.bold).toBe(true);
    expect(title.font.subset).toBe(false);
    expect(title.font.embedded).toBe(false);
  });

  it("todos los bloques tienen id estable p<pagina>-b<indice> y huella", async () => {
    const pages = await load();
    for (const [n, blocks] of pages) {
      blocks.forEach((block, i) => {
        expect(block.id).toBe(`p${n - 1}-b${i}`);
        expect(block.pageIndex).toBe(n - 1);
        expect(block.origHash).toMatch(/^[0-9a-f]{8}$/);
        expect(block.editable).toBe(true);
      });
      expect(new Set(blocks.map((b) => b.origHash)).size).toBe(blocks.length);
    }
  });

  it("rotados: rotacion exacta y rectangulo orientado coherente", async () => {
    const blocks = (await load()).get(2)!;
    const rotations = Object.fromEntries(
      blocks.map((b) => [b.text, b.rotation]),
    );
    expect(rotations["Texto a noventa"]).toBe(90);
    expect(rotations["Texto a ciento ochenta"]).toBe(180);
    expect(rotations["Texto a doscientos setenta"]).toBe(270);
    expect(rotations["Texto a treinta grados"]).toBeCloseTo(30, 1);
    expect(rotations["Texto a cuarenta y cinco"]).toBeCloseTo(45, 1);
    expect(rotations["Texto a menos veinte"]).toBeCloseTo(340, 1);
    const thirty = findBlock(blocks, "Texto a treinta grados")!;
    const o = thirty.orientedBox!;
    // La caja envolvente contiene las cuatro esquinas del rectangulo orientado.
    const a = (thirty.rotation * Math.PI) / 180;
    for (const [u, v] of [[0, 0], [o.width, 0], [0, o.height], [o.width, o.height]]) {
      const x = o.origin.x + u * Math.cos(a) - v * Math.sin(a);
      const y = o.origin.y + u * Math.sin(a) + v * Math.cos(a);
      expect(x).toBeGreaterThanOrEqual(thirty.box.x - 0.01);
      expect(x).toBeLessThanOrEqual(thirty.box.x + thirty.box.width + 0.01);
      expect(y).toBeGreaterThanOrEqual(thirty.box.y - 0.01);
      expect(y).toBeLessThanOrEqual(thirty.box.y + thirty.box.height + 0.01);
    }
  });

  it("parrafos: numero de lineas, alineacion e interlineado", async () => {
    const blocks = (await load()).get(3)!;
    expect(blocks).toHaveLength(5);
    const left = blocks.find((b) => b.text.startsWith("Este es un parrafo"))!;
    expect(left.lines).toHaveLength(4);
    expect(left.align).toBe("left");
    expect(left.lineHeight).toBeCloseTo(1.2, 2);
    const center = blocks.find((b) => b.text.startsWith("Parrafo centrado"))!;
    expect(center.lines).toHaveLength(3);
    expect(center.align).toBe("center");
    const right = blocks.find((b) => b.text.startsWith("Parrafo alineado"))!;
    expect(right.align).toBe("right");
    expect(right.font.family).toBe("serif");
    const first = blocks.find((b) => b.text.startsWith("Primer parrafo"))!;
    const second = blocks.find((b) => b.text.startsWith("Segundo parrafo"))!;
    expect(first.lines).toHaveLength(2);
    expect(second.lines).toHaveLength(2);
  });

  it("columnas: un bloque por columna, sin mezclar", async () => {
    const blocks = (await load()).get(4)!.filter((b) => b.lines.length === 5);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text.startsWith("Izquierda")).toBe(true);
    expect(blocks[0].text).not.toContain("Derecha");
    expect(blocks[1].text.startsWith("Derecha")).toBe(true);
    // Izquierda antes que derecha en lectura (misma banda superior).
    expect(blocks[0].box.x).toBeLessThan(blocks[1].box.x);
  });

  it("tabla: nueve celdas independientes aunque las filas esten a 1.2 de interlineado", async () => {
    const cells = (await load()).get(4)!.filter((b) => b.lines.length === 1);
    expect(cells).toHaveLength(9);
    expect(textsOf(cells)).toEqual(
      expect.arrayContaining(["Nombre", "Cantidad", "Precio", "Manzana", "3", "1.20", "Pera", "12", "0.80"]),
    );
  });

  it("orden de lectura de la tabla: filas de arriba abajo, celdas de izquierda a derecha", async () => {
    const cells = (await load()).get(4)!.filter((b) => b.lines.length === 1);
    expect(textsOf(cells)).toEqual([
      "Nombre", "Cantidad", "Precio",
      "Manzana", "3", "1.20",
      "Pera", "12", "0.80",
    ]);
  });

  it("superindices: bloque aparte, marcado y sin pisar la linea", async () => {
    const blocks = (await load()).get(5)!;
    expect(blocks).toHaveLength(4);
    const two = findBlock(blocks, "2")!;
    expect(two.script).toBe("superscript");
    expect(two.fontSize).toBeCloseTo(8, 1);
    const base = findBlock(blocks, "E = mc")!;
    expect(base.script).toBeUndefined();
    // La caja de la base no se solapa con la del indice.
    expect(base.box.x + base.box.width).toBeLessThanOrEqual(two.box.x + 0.5);
    expect(findBlock(blocks, "1")!.script).toBe("superscript");
  });
});

/* ------------------------------------------------------------------ *
 * Geometria contra core.ts (/Rotate y CropBox con origen no cero)
 * ------------------------------------------------------------------ */

describe("geometria de pagina (core.ts)", () => {
  it("las coordenadas son espacio de usuario aunque haya /Rotate 90 y CropBox desplazado", async () => {
    const { bytes, cases } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const page = await opened.page(6);
    const blocks = await extractTextBlocks(page, 5, { OPS: opened.OPS });
    const pdfLib = await PDFDocument.load(bytes);
    const geometry = getPageGeometry(pdfLib.getPage(5));
    expect(geometry.rotation).toBe(90);
    expect(geometry.box).toMatchObject({ x: 40, y: 60, width: 400, height: 500 });

    const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(geometry.viewWidth, 3);
    expect(viewport.height).toBeCloseTo(geometry.viewHeight, 3);

    for (const { expected } of cases.filter((c) => c.page === 6)) {
      const block = findBlock(blocks, expected.text)!;
      // 1) core.ts: caja de usuario -> rectangulo normalizado de la vista.
      const normalized = userBoxToNormalizedRect(geometry, block.box);
      // 2) pdf.js: la misma caja pasada por su viewport (rotado).
      const [x1, y1] = viewport.convertToViewportPoint(block.box.x, block.box.y);
      const [x2, y2] = viewport.convertToViewportPoint(
        block.box.x + block.box.width,
        block.box.y + block.box.height,
      );
      expect(normalized.x).toBeCloseTo(Math.min(x1, x2) / viewport.width, 3);
      expect(normalized.y).toBeCloseTo(Math.min(y1, y2) / viewport.height, 3);
      expect(normalized.width).toBeCloseTo(Math.abs(x2 - x1) / viewport.width, 3);
      expect(normalized.height).toBeCloseTo(Math.abs(y2 - y1) / viewport.height, 3);
      // El texto queda dentro de la pagina visible.
      expect(normalized.x).toBeGreaterThanOrEqual(0);
      expect(normalized.x + normalized.width).toBeLessThanOrEqual(1.0001);
    }
    await opened.close();
  });

  it("viewPointToUser devuelve un punto dentro del bloque desde su centro en la vista", async () => {
    const { bytes } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const page = await opened.page(6);
    const [block] = await extractTextBlocks(page, 5, { OPS: opened.OPS });
    const pdfLib = await PDFDocument.load(bytes);
    const geometry = getPageGeometry(pdfLib.getPage(5));
    const viewport = page.getViewport({ scale: 1 });
    // Centro del bloque segun pdf.js (espacio de vista de pdf.js: origen arriba).
    const cx = block.box.x + block.box.width / 2;
    const cy = block.box.y + block.box.height / 2;
    const [vx, vyTop] = viewport.convertToViewportPoint(cx, cy);
    // core.ts usa origen ABAJO-izquierda en la vista.
    const user = viewPointToUser(geometry, vx, viewport.height - vyTop);
    expect(user.x).toBeCloseTo(cx, 3);
    expect(user.y).toBeCloseTo(cy, 3);
    expect(blockAtPoint([block], user)).toBe(block);
    await opened.close();
  });

  it("texto en pagina sin giro con CropBox desplazado conserva coordenadas absolutas", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([600, 800]);
    page.setCropBox(100, 200, 300, 300);
    const expected = await drawLine(page, font, { text: "Dentro del recorte", x: 150, y: 300, size: 12 });
    const result = await analyzeBytes(await doc.save());
    const block = findBlock(result.blocks, "Dentro del recorte")!;
    expect(block.box.x).toBeCloseTo(expected.box.x, 0);
    expect(block.lines[0].baseline).toBeCloseTo(300, 1);
  });

  it("el texto fuera del CropBox no se devuelve (pdf.js lo descarta)", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([600, 800]);
    page.setCropBox(100, 200, 300, 300);
    await drawLine(page, font, { text: "Visible", x: 150, y: 300, size: 12 });
    await drawLine(page, font, { text: "Fuera", x: 10, y: 10, size: 12 });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Visible"]);
  });
});

/* ------------------------------------------------------------------ *
 * Operadores: color, modo de render, matrices
 * ------------------------------------------------------------------ */

describe("color y estado grafico", () => {
  it("escala horizontal (Tz) NO falsea el tamano de fuente", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 10 Tf 50 Tz 60 350 Td (Narrow) Tj ET"),
    );
    const [block] = result.blocks;
    expect(block.text).toBe("Narrow");
    expect(block.fontSize).toBeCloseTo(10, 3);
    expect(block.box.width).toBeCloseTo(16.1, 0);
  });

  it("espaciado entre caracteres (Tc): pdf.js lo parte en letras y se recompone", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 10 Tf 3 Tc 60 330 Td (Spaced) Tj ET"),
    );
    expect(result.blocks[0].text).toBe("Spaced");
  });

  it("la matriz cm escala el tamano y la posicion", async () => {
    const result = await analyzeBytes(
      await rawPdf("q 0.5 0 0 0.5 100 100 cm 1 0 0 rg BT /F1 24 Tf 0 0 Td (Scaled) Tj ET Q"),
    );
    const [block] = result.blocks;
    expect(block.fontSize).toBeCloseTo(12, 3);
    expect(block.box.x).toBeCloseTo(100, 3);
    expect(block.color).toBe("#ff0000");
  });

  it("una matriz cm girada 90 grados da texto girado", async () => {
    const result = await analyzeBytes(
      await rawPdf("q 0 1 -1 0 200 100 cm 0 0 1 rg BT /F1 12 Tf 0 0 Td (Girado por cm) Tj ET Q"),
    );
    const [block] = result.blocks;
    expect(block.rotation).toBe(90);
    expect(block.color).toBe("#0000ff");
    expect(block.fontSize).toBeCloseTo(12, 3);
  });

  it("el color persiste entre BT/ET y se restaura con q/Q", async () => {
    const result = await analyzeBytes(
      await rawPdf(`
1 0 0 rg
q 0 0 1 rg BT /F1 12 Tf 50 300 Td (azul dentro) Tj ET Q
BT /F1 12 Tf 50 250 Td (rojo fuera) Tj ET
BT /F1 12 Tf 50 200 Td 0 1 0 rg (verde despues) Tj ET
BT /F1 12 Tf 50 150 Td (sigue verde) Tj ET`),
    );
    const byText = Object.fromEntries(result.blocks.map((b) => [b.text, b.color]));
    expect(byText["azul dentro"]).toBe("#0000ff");
    expect(byText["rojo fuera"]).toBe("#ff0000");
    expect(byText["verde despues"]).toBe("#00ff00");
    expect(byText["sigue verde"]).toBe("#00ff00");
  });

  it("sin operador de color el texto es negro", async () => {
    const result = await analyzeBytes(await rawPdf("BT /F1 12 Tf 50 300 Td (negro) Tj ET"));
    expect(result.blocks[0].color).toBe("#000000");
  });

  it("gris (g) y CMYK (k) se normalizan a #rrggbb", async () => {
    const result = await analyzeBytes(
      await rawPdf(`
BT /F1 10 Tf 0.5 g 60 280 Td (gris) Tj ET
BT /F1 10 Tf 0 1 1 0 k 60 240 Td (cmyk) Tj ET
BT /F1 10 Tf 0 0 0 1 k 60 200 Td (negro k) Tj ET`),
    );
    const byText = Object.fromEntries(result.blocks.map((b) => [b.text, b.color]));
    expect(byText["gris"]).toBe("#808080");
    expect(byText["cmyk"]).toMatch(/^#[0-9a-f]{6}$/);
    const red = parseInt(byText["cmyk"].slice(1, 3), 16);
    const green = parseInt(byText["cmyk"].slice(3, 5), 16);
    expect(red).toBeGreaterThan(200);
    expect(green).toBeLessThan(80);
    // pdf.js convierte K=1 con su aproximacion polinomica (casi negro).
    for (const i of [1, 3, 5]) {
      expect(parseInt(byText["negro k"].slice(i, i + 2), 16)).toBeLessThan(80);
    }
  });

  it("elevacion (Ts) mueve la linea base", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 10 Tf 60 240 Td 5 Ts (rise) Tj ET"),
    );
    expect(result.blocks[0].lines[0].baseline).toBeCloseTo(245, 1);
  });

  it("modo de render 1 (solo trazo) usa el color del trazo", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 12 Tf 1 Tr 0 0 1 RG 1 0 0 rg 60 220 Td (trazo) Tj ET"),
    );
    expect(result.blocks[0].color).toBe("#0000ff");
  });

  it("Td, TD, T*, ' y TL colocan cada linea", async () => {
    const result = await analyzeBytes(
      await rawPdf(
        "BT /F1 12 Tf 14 TL 50 300 Td (uno) Tj T* (dos) Tj (tres) ' 0 -30 TD (cuatro) Tj ET",
      ),
    );
    const baselines = Object.fromEntries(
      result.blocks.flatMap((b) => b.lines.map((l) => [l.text, l.baseline])),
    );
    // Misma columna y sangria 0: se agrupan, pero las lineas conservan su y.
    expect(Object.keys(baselines).join(" ")).toContain("uno");
    const lines = result.blocks.flatMap((b) => b.lines);
    const ys = lines.map((l) => Math.round(l.baseline));
    expect(ys).toEqual(expect.arrayContaining([300, 286, 272]));
  });

  it("un XObject de formulario escalado conserva el color y escala el tamano", async () => {
    const { doc, font } = await newDoc();
    const inner = await PDFDocument.create();
    const f = await inner.embedFont(H);
    const innerPage = inner.addPage([200, 100]);
    innerPage.drawText("En formulario", { x: 10, y: 50, size: 20, font: f, color: hexToRgb("#cc3300") });
    const [embedded] = await doc.embedPdf(await inner.save());
    const page = doc.addPage([400, 400]);
    page.drawPage(embedded, { x: 100, y: 200, xScale: 0.5, yScale: 0.5 });
    void font;
    const result = await analyzeBytes(await doc.save());
    const [block] = result.blocks;
    expect(block.text).toBe("En formulario");
    expect(block.fontSize).toBeCloseTo(10, 2);
    expect(block.color).toBe("#cc3300");
    expect(block.box.x).toBeCloseTo(105, 1);
  });

  it("un trozo TJ con ajustes numericos se lee como una sola linea", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 12 Tf 60 300 Td [(Hel) -20 (lo) 120 ( W) -10 (orld)] TJ ET"),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].text.replace(/\s+/g, "")).toBe("HelloWorld");
  });
});


/* ------------------------------------------------------------------ *
 * Texto invisible (OCR) y paginas escaneadas
 * ------------------------------------------------------------------ */

describe("capa invisible y paginas sin texto", () => {
  const ocrContent = `
BT /F1 12 Tf 3 Tr 60 300 Td (Texto OCR uno) Tj ET
BT /F1 12 Tf 3 Tr 60 285.6 Td (Texto OCR dos) Tj ET`;

  it("3 Tr: se excluye de los bloques y se cuenta en hiddenCount", async () => {
    const result = await analyzeBytes(
      await rawPdf(`BT /F1 12 Tf 60 350 Td (Visible) Tj ET ${ocrContent}`),
    );
    expect(textsOf(result.blocks)).toEqual(["Visible"]);
    expect(result.hiddenCount).toBe(1); // las dos lineas OCR forman un parrafo
    expect(result.hasTextLayer).toBe(true);
    expect(result.failed).toBe(false);
  });

  it("includeInvisible los devuelve al final como solo lectura 'invisible'", async () => {
    const result = await analyzeBytes(
      await rawPdf(`BT /F1 12 Tf 60 350 Td (Visible) Tj ET ${ocrContent}`),
      1,
      true,
    );
    expect(result.blocks).toHaveLength(2);
    const hidden = result.blocks[1];
    expect(hidden.editable).toBe(false);
    expect(hidden.readOnlyReason).toBe("invisible");
    expect(hidden.id).toBe("p0-b1");
    expect(result.blocks[0].editable).toBe(true);
  });

  it("pagina escaneada con OCR oculto: hasTextLayer false y hiddenCount > 0", async () => {
    const result = await analyzeBytes(await rawPdf(ocrContent));
    expect(result.blocks).toEqual([]);
    expect(result.hasTextLayer).toBe(false);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });

  it("alfa de relleno 0 (ca 0) tambien cuenta como oculto", async () => {
    const result = await analyzeBytes(
      await rawPdf("q /GS1 gs BT /F1 12 Tf 60 200 Td (transparente) Tj ET Q BT /F1 12 Tf 60 150 Td (opaco) Tj ET", {
        extGState: { GS1: { ca: 0 } },
      }),
    );
    expect(textsOf(result.blocks)).toEqual(["opaco"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("modo 7 (recorte) no es texto visible", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 12 Tf 7 Tr 60 200 Td (recorte) Tj ET"),
    );
    expect(result.blocks).toEqual([]);
    expect(result.hiddenCount).toBe(1);
  });

  it("pagina vacia: sin bloques, sin capa de texto, sin fallo", async () => {
    const { doc } = await newDoc();
    doc.addPage([300, 300]);
    const result = await analyzeBytes(await doc.save());
    expect(result).toEqual({ blocks: [], hiddenCount: 0, hasTextLayer: false, failed: false });
  });

  it("pagina solo con grafismos (sin texto) tampoco tiene capa de texto", async () => {
    const { doc } = await newDoc();
    const page = doc.addPage([300, 300]);
    page.drawRectangle({ x: 20, y: 20, width: 100, height: 100, color: hexToRgb("#cccccc") });
    const result = await analyzeBytes(await doc.save());
    expect(result.hasTextLayer).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it("espacios en blanco no cuentan como capa de texto", async () => {
    const result = await analyzeBytes(await rawPdf("BT /F1 12 Tf 60 200 Td (    ) Tj ET"));
    expect(result.hasTextLayer).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Fuentes
 * ------------------------------------------------------------------ */

describe("sourceFontInfoFrom", () => {
  const info = (name: string, extra: Record<string, unknown> = {}) =>
    sourceFontInfoFrom({ name, ...extra });

  it("subconjunto: prefijo de seis mayusculas y +", () => {
    expect(info("ABCDEF+LiberationSans").subset).toBe(true);
    expect(info("Helvetica").subset).toBe(false);
    expect(info("abcdef+Foo").subset).toBe(false);
    expect(info("ABCDE+Foo").subset).toBe(false);
  });

  it("negrita y cursiva salen del nombre", () => {
    expect(info("ABCDEF+LiberationSans-Bold").bold).toBe(true);
    expect(info("TimesNewRomanPS-BoldItalicMT")).toMatchObject({ bold: true, italic: true });
    expect(info("Arial-ItalicMT")).toMatchObject({ bold: false, italic: true });
    expect(info("Verdana-Oblique").italic).toBe(true);
    expect(info("Arial-Black").bold).toBe(true);
    expect(info("Calibri-Light").bold).toBe(false);
    expect(info("Helvetica").bold).toBe(false);
  });

  it("negrita y cursiva tambien salen de las banderas de pdf.js y de los flags", () => {
    expect(info("Foo", { bold: true }).bold).toBe(true);
    expect(info("Foo", { black: true }).bold).toBe(true);
    expect(info("Foo", { italic: true }).italic).toBe(true);
    expect(info("Foo", { flags: 1 << 18 }).bold).toBe(true);
    expect(info("Foo", { flags: 1 << 6 }).italic).toBe(true);
  });

  it("familia: sans / serif / mono por nombre", () => {
    const family = (name: string) => info(name).family;
    expect(family("ArialMT")).toBe("sans");
    expect(family("Calibri")).toBe("sans");
    expect(family("Verdana-Bold")).toBe("sans");
    expect(family("TimesNewRomanPSMT")).toBe("serif");
    expect(family("Cambria")).toBe("serif");
    expect(family("Georgia-Italic")).toBe("serif");
    expect(family("CourierNewPSMT")).toBe("mono");
    expect(family("Consolas")).toBe("mono");
    expect(family("ABCDEF+LiberationMono")).toBe("mono");
    expect(family("LiberationSerif")).toBe("serif");
    expect(family("NotoSans-Regular")).toBe("sans");
  });

  it("familia: sin pista en el nombre usa fallbackName y despues los flags", () => {
    expect(sourceFontInfoFrom({ name: "Xyzzy", fallbackName: "serif" }).family).toBe("serif");
    expect(sourceFontInfoFrom({ name: "Xyzzy", fallbackName: "monospace" }).family).toBe("mono");
    expect(sourceFontInfoFrom({ name: "Xyzzy", fallbackName: "sans-serif" }).family).toBe("sans");
    expect(sourceFontInfoFrom({ name: "Xyzzy", flags: 1 }).family).toBe("mono");
    expect(sourceFontInfoFrom({ name: "Xyzzy", flags: 2 }).family).toBe("serif");
    expect(sourceFontInfoFrom({ name: "Xyzzy" }).family).toBe("sans");
  });

  it("simbolicas por nombre (Symbol, Dingbats, Wingdings, fuentes matematicas TeX)", () => {
    for (const name of ["Symbol", "ZapfDingbats", "ABCDEF+Wingdings-Regular", "Webdings", "CMSY10", "ABCDEF+CMMI12", "SymbolMT"]) {
      expect(info(name).symbolic, name).toBe(true);
    }
    for (const name of ["Arial", "Helvetica", "ABCDEF+Calibri", "SymbolicSans-Regular".replace("Symbolic", "Sym")]) {
      expect(info(name).symbolic, name).toBe(false);
    }
  });

  it("embedded: missingFile true => no; estandar sin prefijo => no; subconjunto => si", () => {
    expect(sourceFontInfoFrom({ name: "Foo", missingFile: true }).embedded).toBe(false);
    expect(sourceFontInfoFrom({ name: "Helvetica", missingFile: false }).embedded).toBe(false);
    expect(sourceFontInfoFrom({ name: "Times-Roman", missingFile: false }).embedded).toBe(false);
    expect(sourceFontInfoFrom({ name: "ABCDEF+Helvetica", missingFile: false }).embedded).toBe(true);
    expect(sourceFontInfoFrom({ name: "Garamond", missingFile: false }).embedded).toBe(true);
  });

  it("Type3 y fuente no resuelta", () => {
    expect(sourceFontInfoFrom({ name: "T3", isType3Font: true })).toMatchObject({
      type3: true,
      embedded: true,
    });
    const none = sourceFontInfoFrom(null, "g_d0_f7");
    expect(none).toMatchObject({
      pdfName: "g_d0_f7",
      family: "sans",
      bold: false,
      italic: false,
      subset: false,
      type3: false,
    });
    expect(sourceFontInfoFrom(undefined).pdfName).toBe("");
  });
});

describe("fuentes en PDFs reales", () => {
  async function kitPdf(
    draw: (kit: InstanceType<typeof PDFKit>) => void,
    size: [number, number] = [400, 300],
  ) {
    const kit = new PDFKit({ size, margin: 0 });
    const chunks: Buffer[] = [];
    kit.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => kit.on("end", () => resolve()));
    draw(kit);
    kit.end();
    await done;
    return new Uint8Array(Buffer.concat(chunks));
  }

  const drawKit = (kit: InstanceType<typeof PDFKit>) => {
    kit
      .font(`${STANDARD_FONT_DIR}LiberationSans-Regular.ttf`)
      .fontSize(14)
      .fillColor("#336699")
      .text("Subset cafe", 50, 50, { lineBreak: false });
    kit
      .font(`${STANDARD_FONT_DIR}LiberationSans-Bold.ttf`)
      .fontSize(20)
      .fillColor("#000000")
      .text("Bold Title", 50, 100, { lineBreak: false });
  };

  it("TTF subconjunto de pdfkit: prefijo, embebida, negrita por nombre, color y tamano", async () => {
    const result = await analyzeBytes(await kitPdf(drawKit));
    expect(result.failed).toBe(false);
    const regular = findBlock(result.blocks, "Subset cafe")!;
    expect(regular.font).toMatchObject({ subset: true, embedded: true, bold: false, family: "sans", type3: false });
    expect(regular.font.pdfName).toMatch(/^[A-Z]{6}\+LiberationSans$/);
    expect(regular.color).toBe("#336699");
    expect(regular.fontSize).toBeCloseTo(14, 2);
    expect(regular.editable).toBe(true);
    const bold = findBlock(result.blocks, "Bold Title")!;
    expect(bold.font.bold).toBe(true);
    expect(bold.fontSize).toBeCloseTo(20, 2);
    // pdfkit mide y desde arriba: el texto de 14 pt a y=50 queda cerca de 300-50.
    expect(regular.box.y + regular.box.height).toBeLessThan(260);
    expect(regular.box.y + regular.box.height).toBeGreaterThan(235);
    expect(regular.box.x).toBeCloseTo(50, 0);
  });

  it("parrafos de pdfkit (justificado, centrado, derecha con lineGap, sangria) salen como un bloque de 4 lineas", async () => {
    const lorem =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
    const bytes = await kitPdf((kit) => {
      kit.font(`${STANDARD_FONT_DIR}LiberationSans-Regular.ttf`).fontSize(11);
      kit.text(lorem, 50, 50, { width: 300, align: "justify" });
      kit.text(lorem, 50, 200, { width: 300, align: "center" });
      kit.text(lorem, 50, 350, { width: 300, align: "right", lineGap: 3 });
      kit.text(lorem, 50, 500, { width: 300, align: "left", indent: 20 });
    }, [500, 700]);
    const result = await analyzeBytes(bytes);
    expect(result.blocks).toHaveLength(4);
    for (const block of result.blocks) {
      expect(block.lines).toHaveLength(4);
      expect(block.text.startsWith("Lorem ipsum dolor sit amet")).toBe(true);
      expect(block.text.endsWith("commodo consequat.")).toBe(true);
    }
    // pdfkit dibuja de arriba abajo: justificado, centrado, derecha, sangria.
    expect(result.blocks.map((b) => b.align)).toEqual(["left", "center", "right", "left"]);
    expect(result.blocks[2].lineHeight!).toBeGreaterThan(result.blocks[0].lineHeight!);
  });

  it("sin ToUnicode el texto sale como caracteres de control: solo lectura 'no-unicode'", async () => {
    const bytes = await kitPdf(drawKit);
    const doc = await PDFDocument.load(bytes);
    let removed = 0;
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (
        object instanceof PDFDict &&
        object.get(PDFName.of("Subtype"))?.toString() === "/Type0"
      ) {
        object.delete(PDFName.of("ToUnicode"));
        removed += 1;
      }
    }
    expect(removed).toBeGreaterThan(0);
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks.length).toBeGreaterThan(0);
    for (const block of result.blocks) {
      expect(block.editable).toBe(false);
      expect(block.readOnlyReason).toBe("no-unicode");
    }
  });

  it("ZapfDingbats y Symbol: solo lectura 'symbolic'", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([400, 400]);
    page.drawText("✁✂✃", { x: 50, y: 300, size: 14, font: await font(StandardFonts.ZapfDingbats) });
    page.drawText("αβγ", { x: 50, y: 250, size: 14, font: await font(StandardFonts.Symbol) });
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(2);
    for (const block of result.blocks) {
      expect(block.font.symbolic).toBe(true);
      expect(block.editable).toBe(false);
      expect(block.readOnlyReason).toBe("symbolic");
    }
  });

  it("fuente Type3: solo lectura 'type3'", async () => {
    const { doc } = await newDoc();
    const proc = doc.context.register(
      doc.context.stream("600 0 0 0 500 700 d1 0 0 500 700 re f"),
    );
    const type3 = doc.context.register(
      doc.context.obj({
        Type: "Font",
        Subtype: "Type3",
        FontBBox: [0, 0, 500, 700],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { a: proc },
        Encoding: { Type: "Encoding", Differences: [97, "a"] },
        FirstChar: 97,
        LastChar: 97,
        Widths: [600],
      }),
    );
    const page = doc.addPage([300, 300]);
    const stream = doc.context.flateStream("BT /T3 20 Tf 50 200 Td (aaa) Tj ET");
    page.node.set(PDFName.of("Contents"), doc.context.register(stream));
    page.node.Resources()?.set(PDFName.of("Font"), doc.context.obj({ T3: type3 }));
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].font.type3).toBe(true);
    expect(result.blocks[0].editable).toBe(false);
    expect(result.blocks[0].readOnlyReason).toBe("type3");
  });
});

/* ------------------------------------------------------------------ *
 * Robustez: REGLA DURA, nunca lanzar a la interfaz
 * ------------------------------------------------------------------ */

type FakeItem = Record<string, unknown> | null | undefined | number | string;

function fakePage(overrides: {
  items?: FakeItem[];
  styles?: Record<string, unknown>;
  getOperatorList?: () => Promise<unknown>;
  getTextContent?: () => Promise<unknown>;
  commonObjs?: unknown;
  view?: unknown;
} = {}): PDFPageProxy {
  return {
    view: overrides.view ?? [0, 0, 612, 792],
    getOperatorList:
      overrides.getOperatorList ?? (async () => ({ fnArray: [], argsArray: [] })),
    getTextContent:
      overrides.getTextContent ??
      (async () => ({ items: overrides.items ?? [], styles: overrides.styles ?? {} })),
    commonObjs: overrides.commonObjs ?? {
      has: () => false,
      get: () => {
        throw new Error("Requesting object that isn't resolved yet");
      },
    },
    cleanup: () => {},
  } as unknown as PDFPageProxy;
}

const fakeItem = (extra: Record<string, unknown> = {}) => ({
  str: "Hola",
  dir: "ltr",
  width: 24,
  height: 12,
  transform: [12, 0, 0, 12, 50, 100],
  fontName: "g_d0_f1",
  hasEOL: false,
  ...extra,
});

const NO_OPS: TextOps = {};

describe("robustez", () => {
  it("fuente no resuelta en commonObjs: sigue y usa valores neutros", async () => {
    const result = await analyzePageText(fakePage({ items: [fakeItem()] }), 0, { OPS: NO_OPS });
    expect(result.failed).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].font).toMatchObject({ family: "sans", bold: false, type3: false });
  });

  it("sin ascenso/descenso usa 0.8 / -0.2 documentados", async () => {
    const [block] = await extractTextBlocks(fakePage({ items: [fakeItem()] }), 0, { OPS: NO_OPS });
    expect(block.box.y).toBeCloseTo(100 - 0.2 * 12, 3);
    expect(block.box.height).toBeCloseTo(12, 3);
    expect(block.lines[0].baseline).toBe(100);
  });

  it("usa el ascenso/descenso del estilo cuando existe", async () => {
    const [block] = await extractTextBlocks(
      fakePage({ items: [fakeItem()], styles: { g_d0_f1: { ascent: 0.9, descent: -0.3 } } }),
      0,
      { OPS: NO_OPS },
    );
    expect(block.box.y).toBeCloseTo(100 - 0.3 * 12, 3);
    expect(block.box.height).toBeCloseTo(12 * 1.2, 3);
  });

  it("ascenso absurdo se acota", async () => {
    const [block] = await extractTextBlocks(
      fakePage({ items: [fakeItem()], styles: { g_d0_f1: { ascent: 40, descent: 9 } } }),
      0,
      { OPS: NO_OPS },
    );
    expect(block.box.height).toBeLessThan(12 * 2);
    expect(block.box.height).toBeGreaterThan(0);
  });

  it("estilo vertical => solo lectura 'vertical'", async () => {
    const [block] = await extractTextBlocks(
      fakePage({ items: [fakeItem()], styles: { g_d0_f1: { vertical: true } } }),
      0,
      { OPS: NO_OPS },
    );
    expect(block.editable).toBe(false);
    expect(block.readOnlyReason).toBe("vertical");
  });

  it("getTextContent que rechaza => resultado vacio con failed", async () => {
    const result = await analyzePageText(
      fakePage({ getTextContent: async () => { throw new Error("boom"); } }),
      0,
      { OPS: NO_OPS },
    );
    expect(result).toEqual({ blocks: [], hiddenCount: 0, hasTextLayer: false, failed: true });
  });

  it("getOperatorList que lanza => vacio con failed, sin excepcion", async () => {
    await expect(
      analyzePageText(
        fakePage({ getOperatorList: async () => { throw new Error("boom"); } }),
        0,
        { OPS: NO_OPS },
      ),
    ).resolves.toMatchObject({ failed: true, blocks: [] });
  });

  it("fragmentos basura (null, numeros, sin transform, NaN) se saltan", async () => {
    const result = await analyzePageText(
      fakePage({
        items: [
          null,
          undefined,
          5,
          "texto",
          {},
          { str: 7 },
          fakeItem({ transform: undefined }),
          fakeItem({ transform: [1, 2, 3] }),
          fakeItem({ transform: [Number.NaN, 0, 0, 12, 0, 0] }),
          fakeItem({ str: "" }),
          fakeItem({ str: "Bueno" }),
        ],
      }),
      0,
      { OPS: NO_OPS },
    );
    expect(result.failed).toBe(false);
    expect(textsOf(result.blocks)).toEqual(["Bueno"]);
  });

  it("textContent o items ausentes no revientan", async () => {
    for (const getTextContent of [async () => ({}), async () => ({ items: null }), async () => null]) {
      const result = await analyzePageText(fakePage({ getTextContent }), 0, { OPS: NO_OPS });
      expect(result.blocks).toEqual([]);
    }
  });

  it("lista de operadores malformada no impide extraer el texto", async () => {
    const result = await analyzePageText(
      fakePage({
        items: [fakeItem()],
        getOperatorList: async () => ({
          fnArray: [1, 2, 3],
          argsArray: [null, undefined, "raro"],
        }),
      }),
      0,
      { OPS: { save: 1, setTextMatrix: 2, showText: 3 } },
    );
    expect(result.failed).toBe(false);
    expect(result.blocks).toHaveLength(1);
  });

  it("extractTextBlocksFromDoc con pagina inexistente devuelve []", async () => {
    const doc = { getPage: async () => { throw new Error("Invalid page request"); } } as unknown as PDFDocumentProxy;
    await expect(extractTextBlocksFromDoc(doc, 99, { OPS: NO_OPS })).resolves.toEqual([]);
    await expect(analyzeDocPageText(doc, 99, { OPS: NO_OPS })).resolves.toMatchObject({ failed: true });
  });

  it("extractTextBlocksFromDoc: indice real y fuera de rango sobre un PDF de verdad", async () => {
    const { bytes } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const real = await extractTextBlocksFromDoc(opened.doc, 0, { OPS: opened.OPS });
    expect(real.length).toBeGreaterThanOrEqual(12);
    expect(await extractTextBlocksFromDoc(opened.doc, 500, { OPS: opened.OPS })).toEqual([]);
    expect(await extractTextBlocksFromDoc(opened.doc, -1, { OPS: opened.OPS })).toEqual([]);
    await opened.close();
  });

  it("page.cleanup que lanza se ignora", async () => {
    const page = fakePage({ items: [fakeItem()] });
    (page as unknown as { cleanup: () => void }).cleanup = () => { throw new Error("x"); };
    const doc = { getPage: async () => page } as unknown as PDFDocumentProxy;
    expect((await extractTextBlocksFromDoc(doc, 0, { OPS: NO_OPS })).length).toBe(1);
  });

  const nasty: Record<string, string> = {
    "cadena sin cerrar": "BT /F1 12 Tf 50 50 Td (sin cerrar Tj",
    "operadores sin operandos": "BT Tj Td Tf TJ ET Tj",
    "fuente inexistente": "BT /F9 12 Tf 10 10 Td (Hola) Tj ET",
    "tamano de fuente cero": "BT /F1 0 Tf 10 10 Td (Cero) Tj ET",
    "tamano negativo": "BT /F1 -12 Tf 10 100 Td (Negativo) Tj ET",
    "matriz degenerada": "BT /F1 12 Tf 0 0 0 0 10 10 Tm (Plano) Tj ET",
    "numeros enormes": "q 1e30 0 0 1e30 0 0 cm BT /F1 12 Tf 1 1 Td (Enorme) Tj ET Q",
    "q sin Q y Q de mas": "Q Q q q BT /F1 12 Tf 50 50 Td (Pila) Tj ET",
    "ET sin BT": "ET ET BT /F1 12 Tf 50 50 Td (ET) Tj",
    "binario": "BT /F1 12 Tf 50 50 Td (\u0000\u0001\u0002ÿþ) Tj ET \u0000\u0000\u0001",
    "vacio": "",
  };
  for (const [name, content] of Object.entries(nasty)) {
    it(`contenido raro (${name}) no lanza`, async () => {
      const bytes = await rawPdf(content);
      const result = await analyzeBytes(bytes);
      expect(Array.isArray(result.blocks)).toBe(true);
      expect(typeof result.hiddenCount).toBe("number");
      for (const block of result.blocks) {
        expect(Number.isFinite(block.box.x)).toBe(true);
        expect(Number.isFinite(block.box.y)).toBe(true);
        expect(Number.isFinite(block.box.width)).toBe(true);
        expect(Number.isFinite(block.box.height)).toBe(true);
      }
    });
  }

  it("PDF truncado: si pdf.js lo abre, la extraccion no lanza", async () => {
    const { bytes } = await buildBattery();
    const truncated = bytes.slice(0, Math.floor(bytes.length * 0.6));
    let opened: Awaited<ReturnType<typeof openWithPdfjs>> | null = null;
    try {
      opened = await openWithPdfjs(truncated);
    } catch {
      // pdf.js rechaza el archivo: es un error de CARGA, ajeno a la extraccion.
      return;
    }
    for (let n = 1; n <= opened.doc.numPages; n += 1) {
      await expect(
        extractTextBlocksFromDoc(opened.doc, n - 1, { OPS: opened.OPS }),
      ).resolves.toBeInstanceOf(Array);
    }
    await opened.close();
  });
});

/* ------------------------------------------------------------------ *
 * Recorrido de operadores y asignacion de tiradas (puro)
 * ------------------------------------------------------------------ */

describe("collectTextRuns / findRun", () => {
  const OPS = {
    save: 1, restore: 2, transform: 3, beginText: 4, setTextMatrix: 5, moveText: 6,
    setLeadingMoveText: 7, nextLine: 8, setLeading: 9, setFont: 10, setCharSpacing: 11,
    setWordSpacing: 12, setHScale: 13, setTextRise: 14, setTextRenderingMode: 15,
    setFillRGBColor: 16, setStrokeRGBColor: 17, setGState: 18, showText: 19,
    paintFormXObjectBegin: 20, paintFormXObjectEnd: 21, setFillGray: 22, setFillCMYKColor: 23,
    setStrokeGray: 24, setStrokeCMYKColor: 25,
  } as TextOps;
  const glyphs = (n: number, width = 500) =>
    [Array.from({ length: n }, () => ({ width, isSpace: false }))];

  const build = (ops: Array<[number, unknown]>) => ({
    fnArray: ops.map(([fn]) => fn),
    argsArray: ops.map(([, args]) => args),
  });

  it("una tirada por showText con color, origen y avance", () => {
    const runs = collectTextRuns(
      build([
        [OPS.beginText, null],
        [OPS.setFillRGBColor, ["#ff0000"]],
        [OPS.setFont, ["f1", 10]],
        [OPS.moveText, [50, 100]],
        [OPS.showText, glyphs(4)],
        [OPS.showText, glyphs(2)],
      ]),
      OPS,
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ x: 50, y: 100, color: "#ff0000", invisible: false, fontId: "f1" });
    expect(runs[0].length).toBeCloseTo(20, 6); // 4 * 500/1000 * 10
    // La segunda empieza donde acabo la primera.
    expect(runs[1].x).toBeCloseTo(70, 6);
  });

  it("q/Q restauran color y matriz; cm se acumula", () => {
    const runs = collectTextRuns(
      build([
        [OPS.save, null],
        [OPS.transform, [2, 0, 0, 2, 10, 20]],
        [OPS.setFillRGBColor, ["#00ff00"]],
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 5]],
        [OPS.moveText, [1, 1]],
        [OPS.showText, glyphs(1, 1000)],
        [OPS.restore, null],
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 5]],
        [OPS.moveText, [1, 1]],
        [OPS.showText, glyphs(1)],
      ]),
      OPS,
    );
    expect(runs[0]).toMatchObject({ x: 12, y: 22, color: "#00ff00" });
    expect(runs[0].length).toBeCloseTo(10, 6); // 5 pt * escala 2
    expect(runs[1]).toMatchObject({ x: 1, y: 1, color: "#000000" });
  });

  it("numeros dentro de TJ, Tc, Tw y Tz afectan al avance", () => {
    const runs = collectTextRuns(
      build([
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 10]],
        [OPS.setCharSpacing, [1]],
        [OPS.setWordSpacing, [2]],
        [OPS.setHScale, [50]],
        [
          OPS.showText,
          [[{ width: 500, isSpace: false }, -200, { width: 250, isSpace: true }]],
        ],
      ]),
      OPS,
    );
    // glifo 1: 5 + Tc 1 = 6; ajuste -200 => +2; glifo 2 (espacio): 2.5 + 1 + Tw 2 = 5.5;
    // total 13.5 y la escala horizontal del 50 % lo deja en 6.75.
    expect(runs[0].length).toBeCloseTo(6.75, 6);
  });

  it("render mode 3 / 7 y alfa 0 marcan invisible; modo 1 usa el trazo", () => {
    const base: Array<[number, unknown]> = [
      [OPS.beginText, null],
      [OPS.setFont, ["f1", 10]],
      [OPS.setFillRGBColor, ["#112233"]],
      [OPS.setStrokeRGBColor, ["#445566"]],
    ];
    const run = (extra: Array<[number, unknown]>) =>
      collectTextRuns(build([...base, ...extra, [OPS.showText, glyphs(1)]]), OPS)[0];
    expect(run([[OPS.setTextRenderingMode, [3]]]).invisible).toBe(true);
    expect(run([[OPS.setTextRenderingMode, [7]]]).invisible).toBe(true);
    expect(run([[OPS.setGState, [[["ca", 0]]]]]).invisible).toBe(true);
    expect(run([[OPS.setGState, [[["ca", 0.5]]]]]).invisible).toBe(false);
    expect(run([[OPS.setTextRenderingMode, [0]]]).invisible).toBe(false);
    expect(run([[OPS.setTextRenderingMode, [1]]]).color).toBe("#445566");
    expect(run([]).color).toBe("#112233");
  });

  it("formularios: la matriz de paintFormXObjectBegin se aplica y se deshace", () => {
    const runs = collectTextRuns(
      build([
        [OPS.paintFormXObjectBegin, [[0.5, 0, 0, 0.5, 100, 100], [0, 0, 10, 10]]],
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 20]],
        [OPS.showText, glyphs(1)],
        [OPS.paintFormXObjectEnd, null],
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 20]],
        [OPS.showText, glyphs(1)],
      ]),
      OPS,
    );
    expect(runs[0]).toMatchObject({ x: 100, y: 100 });
    expect(runs[1]).toMatchObject({ x: 0, y: 0 });
  });

  it("gris y CMYK numericos se normalizan", () => {
    const runs = collectTextRuns(
      build([
        [OPS.beginText, null],
        [OPS.setFont, ["f1", 10]],
        [OPS.setFillGray, [0.5]],
        [OPS.showText, glyphs(1)],
        [OPS.setFillCMYKColor, [0, 0, 0, 0]],
        [OPS.showText, glyphs(1)],
      ]),
      OPS,
    );
    expect(runs[0].color).toBe("#808080");
    expect(runs[1].color).toBe("#ffffff");
  });

  it("lista vacia o args raros => sin tiradas y sin excepcion", () => {
    expect(collectTextRuns({ fnArray: [], argsArray: [] }, OPS)).toEqual([]);
    expect(() =>
      collectTextRuns(
        build([
          [OPS.setTextMatrix, "raro"],
          [OPS.transform, null],
          [OPS.showText, undefined],
          [OPS.setFont, 7],
        ]),
        OPS,
      ),
    ).not.toThrow();
  });

  it("findRun elige la tirada que empieza justo antes, en la misma linea base", () => {
    const run = (x: number, y: number, color: string) => ({
      x, y, dx: 1, dy: 0, length: 10, color, invisible: false, fontId: "f", index: 0, glyphs: 1,
    });
    const runs = [run(50, 100, "#aa0000"), run(80, 100, "#00aa00"), run(50, 80, "#0000aa")];
    expect(findRun(runs, 50, 100, 0, 12)?.color).toBe("#aa0000");
    expect(findRun(runs, 82, 100, 0, 12)?.color).toBe("#00aa00");
    expect(findRun(runs, 70, 100, 0, 12)?.color).toBe("#aa0000");
    expect(findRun(runs, 60, 80, 0, 12)?.color).toBe("#0000aa");
    // Direccion distinta: ninguna tirada vale.
    expect(findRun(runs, 50, 100, Math.PI / 2, 12)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Utilidades: blockAtPoint, muestreo de fondo
 * ------------------------------------------------------------------ */

function makeBlock(partial: Partial<TextBlock> & { box: TextBlock["box"] }): TextBlock {
  return {
    id: "p0-b0",
    pageIndex: 0,
    text: "x",
    lines: [],
    fontSize: 12,
    color: "#000000",
    rotation: 0,
    align: "left",
    font: sourceFontInfoFrom({ name: "Helvetica" }),
    editable: true,
    origHash: "00000000",
    ...partial,
  };
}

describe("blockAtPoint", () => {
  const a = makeBlock({ id: "a", box: { x: 10, y: 10, width: 100, height: 50 } });
  const b = makeBlock({ id: "b", box: { x: 20, y: 20, width: 20, height: 10 } });

  it("devuelve el bloque que contiene el punto", () => {
    expect(blockAtPoint([a], { x: 50, y: 30 })?.id).toBe("a");
    expect(blockAtPoint([a], { x: 10, y: 10 })?.id).toBe("a"); // borde inclusivo
    expect(blockAtPoint([a], { x: 110, y: 60 })?.id).toBe("a");
  });

  it("devuelve null fuera de cualquier bloque", () => {
    expect(blockAtPoint([a, b], { x: 5, y: 5 })).toBeNull();
    expect(blockAtPoint([], { x: 5, y: 5 })).toBeNull();
  });

  it("con cajas solapadas gana la de menor area", () => {
    expect(blockAtPoint([a, b], { x: 25, y: 25 })?.id).toBe("b");
    expect(blockAtPoint([b, a], { x: 25, y: 25 })?.id).toBe("b");
    expect(blockAtPoint([a, b], { x: 80, y: 40 })?.id).toBe("a");
  });

  it("slop amplia la zona de clic", () => {
    expect(blockAtPoint([a], { x: 8, y: 30 })).toBeNull();
    expect(blockAtPoint([a], { x: 8, y: 30 }, 3)?.id).toBe("a");
  });

  it("texto girado: usa el rectangulo orientado, no la caja envolvente", () => {
    // Rectangulo 100 x 10 girado 45 grados desde (100, 100).
    const angle = Math.PI / 4;
    const w = 100;
    const h = 10;
    const bbox = {
      x: 100 - h * Math.sin(angle),
      y: 100,
      width: w * Math.cos(angle) + h * Math.sin(angle),
      height: w * Math.sin(angle) + h * Math.cos(angle),
    };
    const rotated = makeBlock({
      id: "r",
      rotation: 45,
      box: bbox,
      orientedBox: { origin: { x: 100, y: 100 }, width: w, height: h },
    });
    // Un punto sobre el texto.
    const onText = { x: 100 + 50 * Math.cos(angle), y: 100 + 50 * Math.sin(angle) + 1 };
    expect(blockAtPoint([rotated], onText)?.id).toBe("r");
    // Esquina vacia de la caja envolvente (arriba-izquierda): esta dentro de la
    // caja pero fuera del texto.
    const emptyCorner = { x: bbox.x + 2, y: bbox.y + bbox.height - 2 };
    expect(blockAtPoint([rotated], emptyCorner)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Rendimiento y determinismo
 * ------------------------------------------------------------------ */

describe("rendimiento y estabilidad", () => {
  /*
   * Los dos tests de abajo son guardas de rendimiento ("no cuadratico"), no
   * medidas finas: medido en una maquina libre tardan ~0,3 s y ~0,15 s
   * aislados y hasta ~1,2 s dentro de la suite completa (17 workers), y con
   * la CPU muy repartida se estiran 4-8 veces. Un presupuesto de 2 s / 3 s
   * rozaba ese limite y daba fallos intermitentes sin ningun defecto.
   * Los techos de 8 s / 10 s siguen siendo ordenes de magnitud por debajo
   * de lo que costaria una regresion real a un recorrido cuadratico.
   */
  it("100 paginas con ~30 lineas cada una se extraen en tiempo razonable (< 8 s)", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    for (let p = 0; p < 100; p += 1) {
      const page = doc.addPage([612, 792]);
      for (let i = 0; i < 30; i += 1) {
        page.drawText(`Pagina ${p + 1} linea ${i + 1} con algo de texto de relleno`, {
          x: 72,
          y: 740 - i * 14.4,
          size: 12,
          font: f,
        });
      }
    }
    const bytes = await doc.save();
    const started = performance.now();
    const opened = await openWithPdfjs(bytes);
    let total = 0;
    for (let n = 1; n <= 100; n += 1) {
      const blocks = await extractTextBlocksFromDoc(opened.doc, n - 1, { OPS: opened.OPS });
      total += blocks.length;
    }
    const elapsed = performance.now() - started;
    await opened.close();
    expect(total).toBeGreaterThanOrEqual(100); // un parrafo por pagina como minimo
    expect(elapsed).toBeLessThan(8000);
  });

  it("extraer dos veces la misma pagina da exactamente lo mismo", async () => {
    const { bytes } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    const page = await opened.page(3);
    const first = await extractTextBlocks(page, 2, { OPS: opened.OPS });
    const second = await extractTextBlocks(page, 2, { OPS: opened.OPS });
    expect(second).toEqual(first);
    await opened.close();
  });

  it("una pagina con miles de fragmentos agrupa sin ser cuadratica", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([2000, 2000]);
    for (let row = 0; row < 120; row += 1) {
      for (let col = 0; col < 25; col += 1) {
        page.drawText(`c${row}-${col}`, { x: 20 + col * 75, y: 1950 - row * 16, size: 8, font: f });
      }
    }
    const bytes = await doc.save();
    const started = performance.now();
    const result = await analyzeBytes(bytes);
    const elapsed = performance.now() - started;
    expect(result.blocks).toHaveLength(3000);
    expect(elapsed).toBeLessThan(10_000);
  });
});

/* ------------------------------------------------------------------ *
 * Regresiones de la verificacion independiente de W5
 * ------------------------------------------------------------------ */

async function kitBytes(
  draw: (kit: InstanceType<typeof PDFKit>) => void,
  size: [number, number] = [500, 700],
): Promise<Uint8Array> {
  const kit = new PDFKit({ size, margin: 0 });
  const chunks: Buffer[] = [];
  kit.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => kit.on("end", () => resolve()));
  kit.font(`${STANDARD_FONT_DIR}LiberationSans-Regular.ttf`).fontSize(11);
  draw(kit);
  kit.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

describe("D2 interlineado ancho", () => {
  it("pdfkit lineGap 8 (1.9x): un parrafo, no una linea por bloque", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.text(LOREM, 50, 50, { width: 300, align: "left", lineGap: 8 });
      }),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toHaveLength(4);
    expect(result.blocks[0].lineHeight!).toBeGreaterThan(1.75);
  });

  it("doble espacio (2x) escrito con pdf-lib: un solo parrafo", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([500, 600]);
    const f = await font(H);
    const words = LOREM.split(" ");
    // Envolver a mano en ~300 pt.
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, 12) > 300) {
        lines.push(current);
        current = word;
      } else current = candidate;
    }
    lines.push(current);
    lines.forEach((text, i) => page.drawText(text, { x: 50, y: 550 - i * 24, size: 12, font: f }));
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toHaveLength(lines.length);
  });

  it("dos parrafos a doble espacio separados por un hueco mayor siguen siendo dos", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([500, 600]);
    const f = await font(H);
    const wrap = (text: string) => {
      const out: string[] = [];
      let current = "";
      for (const word of text.split(" ")) {
        const candidate = current ? `${current} ${word}` : word;
        if (f.widthOfTextAtSize(candidate, 12) > 300) {
          out.push(current);
          current = word;
        } else current = candidate;
      }
      out.push(current);
      return out;
    };
    const first = wrap(LOREM);
    const second = wrap(LOREM);
    let y = 560;
    for (const line of first) { page.drawText(line, { x: 50, y, size: 12, font: f }); y -= 24; }
    y -= 24; // hueco extra de parrafo
    for (const line of second) { page.drawText(line, { x: 50, y, size: 12, font: f }); y -= 24; }
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((b) => b.lines.length)).toEqual([first.length, second.length]);
  });

  it("dos lineas sueltas separadas 2.3x NO se funden (etiquetas de formulario)", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([500, 400]);
    const f = await font(H);
    // Hay texto corrido mas ancho en la pagina: se sabe donde acaba la columna.
    page.drawText("Una linea de introduccion bastante mas ancha que las etiquetas de abajo", {
      x: 50, y: 360, size: 12, font: f,
    });
    page.drawText("Nombre del solicitante", { x: 50, y: 300, size: 12, font: f });
    page.drawText("Direccion", { x: 50, y: 300 - 27.6, size: 12, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(3);
  });

  it("dos columnas a doble espacio: un bloque por columna", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([600, 600]);
    const f = await font(H);
    for (const x of [50, 330]) {
      for (let i = 0; i < 4; i += 1) {
        page.drawText(`Linea ${i} de la columna con bastante texto largo aqui`, {
          x, y: 500 - i * 24, size: 11, font: f,
        });
      }
    }
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.every((b) => b.lines.length === 4)).toBe(true);
  });
});

describe("D3 listas", () => {
  it("pdfkit list(): cada elemento es un bloque y la continuacion se queda con el suyo", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.fontSize(12);
        kit.list(
          [
            "Primer punto de lista",
            "Segundo punto de lista",
            "Tercer punto que es mas largo y ocupa dos lineas completas en la pagina de ejemplo porque es largo",
          ],
          { bulletRadius: 2, width: 250 },
        );
      }),
    );
    expect(result.blocks.map((b) => b.lines.length).slice(0, 2)).toEqual([1, 1]);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[2].lines.length).toBeGreaterThan(1);
    expect(result.blocks[0].text).toBe("Primer punto de lista");
  });

  it("vinetas circulares dibujadas con pdf-lib: un bloque por elemento", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([400, 400]);
    const f = await font(H);
    ["Uno", "Dos", "Tres", "Cuatro"].forEach((text, i) => {
      const y = 300 - i * 14.4;
      page.drawCircle({ x: 56, y: y + 3.5, size: 2, color: hexToRgb("#000000") });
      page.drawText(text, { x: 70, y, size: 12, font: f });
    });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Uno", "Dos", "Tres", "Cuatro"]);
    // La vineta queda fuera de la caja del bloque: editar no la cubre.
    for (const block of result.blocks) expect(block.box.x).toBeGreaterThanOrEqual(69);
  });

  it("la linea de continuacion de un elemento con vineta vectorial se une a su elemento", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([400, 400]);
    const f = await font(H);
    page.drawCircle({ x: 56, y: 303.5, size: 2, color: hexToRgb("#000000") });
    page.drawText("Elemento largo que continua en", { x: 70, y: 300, size: 12, font: f });
    page.drawText("la linea siguiente del mismo", { x: 70, y: 285.6, size: 12, font: f });
    page.drawCircle({ x: 56, y: 274.7, size: 2, color: hexToRgb("#000000") });
    page.drawText("Otro elemento", { x: 70, y: 271.2, size: 12, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks.map((b) => b.lines.length)).toEqual([2, 1]);
  });

  it("marca de lista suelta + tabulador + texto (estilo Word): la marca no es un bloque", async () => {
    const BULLET = String.fromCharCode(0x95); // vineta en WinAnsi
    const result = await analyzeBytes(
      await rawPdf(`
BT /F1 12 Tf 50 300 Td (${BULLET}) Tj ET
BT /F1 12 Tf 80 300 Td (Primer elemento) Tj ET
BT /F1 12 Tf 50 285.6 Td (-) Tj ET
BT /F1 12 Tf 80 285.6 Td (Segundo elemento) Tj ET`),
    );
    expect(textsOf(result.blocks)).toEqual(["Primer elemento", "Segundo elemento"]);
  });

  it("un parrafo normal con sangria de primera linea NO se parte", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.text(LOREM, 50, 50, { width: 300, align: "left", indent: 20 });
      }),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toHaveLength(4);
  });
});

describe("D5 estilos mezclados", () => {
  it("color y negrita distintos en una linea => mixedStyle", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit
          .fillColor("#000000").text("Normal ", 50, 50, { continued: true })
          .fillColor("#cc0000").text("rojo ", { continued: true })
          .font(`${STANDARD_FONT_DIR}LiberationSans-Bold.ttf`)
          .fillColor("#0000cc").text("azul negrita ", { continued: true })
          .font(`${STANDARD_FONT_DIR}LiberationSans-Regular.ttf`)
          .fillColor("#000000").text("de nuevo normal.");
      }),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].mixedStyle).toBe(true);
  });

  it("estilo uniforme => no aparece el campo", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.text(LOREM, 50, 50, { width: 300 });
      }),
    );
    expect(result.blocks[0]).not.toHaveProperty("mixedStyle");
  });

  it("dos tiradas de color distinto fundidas por pdf.js en un fragmento => mixedStyle", async () => {
    const result = await analyzeBytes(
      await rawPdf("BT /F1 12 Tf 60 300 Td 1 0 0 rg (Red) Tj 0 0 1 rg ( Blue) Tj ET"),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].mixedStyle).toBe(true);
  });

  it("la bateria sintetica no marca mezcla en ningun bloque", async () => {
    const { bytes } = await buildBattery();
    const opened = await openWithPdfjs(bytes);
    for (let n = 1; n <= 6; n += 1) {
      const blocks = await extractTextBlocks(await opened.page(n), n - 1, { OPS: opened.OPS });
      for (const block of blocks) expect(block.mixedStyle, block.text).toBeUndefined();
    }
    await opened.close();
  });
});

describe("D6/D9 espaciado y ultima linea", () => {
  it("espaciado entre caracteres y entre palabras (pdfkit): una linea = un bloque", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.fontSize(12).text("Character spaced heading", 50, 50, { characterSpacing: 4 });
        kit.text("Word spaced text here", 50, 100, { wordSpacing: 15 });
      }),
    );
    expect(textsOf(result.blocks)).toEqual(["Character spaced heading", "Word spaced text here"]);
  });

  it("estilo Chrome: cada letra con su Td (tracking 3 pt) y huecos de palabra: una linea", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([500, 400]);
    // Cada letra en su propia instruccion, separada 3 pt (tracking) y 9 pt entre palabras.
    let content = "";
    let x = 50;
    for (const word of ["ESPACIADO", "AMPLIO", "TITULO"]) {
      for (const ch of word) {
        content += `BT /F1 12 Tf ${x.toFixed(2)} 300 Td (${ch}) Tj ET\n`;
        x += f.widthOfTextAtSize(ch, 12) + 3;
      }
      x += 3.3 + 3 - 3 + 3;
    }
    setRawContent(doc, page, content, { F1: f });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["ESPACIADO AMPLIO TITULO"]);
  });

  it("word-spacing regular entre fragmentos sueltos: una linea; columnas reales siguen partidas", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([500, 400]);
    let content = "";
    let x = 50;
    for (const word of ["Palabras", "muy", "separadas", "entre", "si"]) {
      content += `BT /F1 12 Tf ${x.toFixed(2)} 300 Td (${word}) Tj ET\n`;
      x += f.widthOfTextAtSize(word, 12) + 24; // word-spacing constante de 24 pt
    }
    // Tres columnas con huecos DISTINTOS (tabla): no se funden.
    content +=
      "BT /F1 12 Tf 50 200 Td (Producto) Tj ET\nBT /F1 12 Tf 160 200 Td (Cantidad) Tj ET\nBT /F1 12 Tf 330 200 Td (Precio) Tj ET\n";
    setRawContent(doc, page, content, { F1: f });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual([
      "Palabras muy separadas entre si",
      "Producto",
      "Cantidad",
      "Precio",
    ]);
  });

  it("pdfkit en dos columnas: la ultima linea corta no se separa", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.fontSize(10).text(LOREM.repeat(6), 50, 50, { columns: 2, columnGap: 20, height: 300, width: 450 });
      }),
    );
    expect(result.blocks).toHaveLength(2);
  });

  it("columna con una ultima linea de una sola palabra se queda en su parrafo", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([500, 300]);
    const f = await font(H);
    for (const x of [50, 280]) {
      ["varias lineas de texto que", "se ajustan al ancho de la", "columna"].forEach((text, i) =>
        page.drawText(text, { x, y: 250 - i * 13.5, size: 12, font: f }),
      );
    }
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks.map((b) => b.lines.length)).toEqual([3, 3]);
  });
});

describe("D7 negrita falsa", () => {
  it("el mismo texto con desfase de 0.3 pt (14 pt) se deduplica", async () => {
    const result = await analyzeBytes(
      await rawPdf(
        "BT /F1 14 Tf 40 300 Td (Duplicate bold) Tj ET BT /F1 14 Tf 40.3 300 Td (Duplicate bold) Tj ET",
      ),
    );
    expect(textsOf(result.blocks)).toEqual(["Duplicate bold"]);
  });

  it("3 y 4 pasadas finas (cuerpo 15, 0,3 pt) se deduplican en UN bloque (Wave 10 · C-A2: antes salia «…bold» doble)", async () => {
    const pass = (x: number) => `BT /F1 15 Tf ${x} 300 Td (Duplicate bold) Tj ET`;
    const three = await analyzeBytes(await rawPdf([40, 40.3, 40.6].map(pass).join(" ")));
    expect(textsOf(three.blocks)).toEqual(["Duplicate bold"]);
    const four = await analyzeBytes(await rawPdf([40, 40.3, 40.6, 40.9].map(pass).join(" ")));
    expect(textsOf(four.blocks)).toEqual(["Duplicate bold"]);
  });

  it("texto repetido a otra altura NO se deduplica", async () => {
    const result = await analyzeBytes(
      await rawPdf(
        "BT /F1 14 Tf 40 300 Td (Igual) Tj ET BT /F1 14 Tf 40 250 Td (Igual) Tj ET",
      ),
    );
    expect(result.blocks).toHaveLength(2);
  });
});

describe("D8 CID sin ToUnicode con espacios como caracteres de control", () => {
  it("letras desplazadas y espacio U+0003 => solo lectura 'no-unicode'", async () => {
    const { visible } = groupTextItems(
      [
        {
          str: "/RUHP\u0003LSVXP\u0003GRORU\u0003VLW\u0003DPHW",
          x: 72, y: 700, rotation: 0, width: 150, fontSize: 12, ascent: 0.8, descent: -0.2,
          color: "#000000", font: sourceFontInfoFrom({ name: "AAAAAA+Georgia" }),
          invisible: false, vertical: false,
        },
      ],
      { pageIndex: 0 },
    );
    expect(visible[0].editable).toBe(false);
    expect(visible[0].readOnlyReason).toBe("no-unicode");
  });

  it("un unico caracter de control suelto en un texto largo NO lo bloquea", () => {
    const { visible } = groupTextItems(
      [
        {
          str: `${"Una frase de texto normal, bastante larga para no confundirse ".repeat(2)}\u0001`,
          x: 72, y: 700, rotation: 0, width: 300, fontSize: 12, ascent: 0.8, descent: -0.2,
          color: "#000000", font: sourceFontInfoFrom({ name: "Helvetica" }),
          invisible: false, vertical: false,
        },
      ],
      { pageIndex: 0 },
    );
    expect(visible[0].editable).toBe(true);
  });
});

describe("B4 alineacion a la derecha de una linea sola", () => {
  it("pdfkit: 'Derecha' pegado al margen derecho => right; el parrafo sigue en left", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.text(LOREM, 50, 50, { width: 400, align: "left" });
        kit.text("Derecha", 50, 200, { width: 400, align: "right" });
        kit.text(LOREM, 50, 260, { width: 400, align: "left" });
      }),
    );
    const single = findBlock(result.blocks, "Derecha")!;
    expect(single.align).toBe("right");
    expect(result.blocks.filter((b) => b.align === "right")).toHaveLength(1);
    expect(result.blocks.filter((b) => b.lines.length > 1).every((b) => b.align === "left")).toBe(true);
  });

  it("una linea corta a la izquierda NO se marca como derecha", async () => {
    const result = await analyzeBytes(
      await kitBytes((kit) => {
        kit.text(LOREM, 50, 50, { width: 400, align: "left" });
        kit.text("Izquierda", 50, 200);
        kit.text(LOREM, 50, 260, { width: 400, align: "left" });
      }),
    );
    expect(findBlock(result.blocks, "Izquierda")!.align).toBe("left");
  });

  it("pdf-lib: titulo centrado entre margenes asimetricos => center", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([600, 500]);
    const f = await font(H);
    // Margenes: izquierdo 50, derecho 550 (cuerpo en x=50).
    for (const y of [400, 300]) {
      page.drawText("Linea de cuerpo larga a la izquierda uno", { x: 50, y, size: 12, font: f });
      page.drawText("Otra linea de cuerpo larga siguiente", { x: 50, y: y - 40, size: 12, font: f });
    }
    const w = f.widthOfTextAtSize("Titulo", 16);
    page.drawText("Titulo", { x: 300 - w / 2, y: 450, size: 16, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(findBlock(result.blocks, "Titulo")!.align).toBe("center");
  });

  it("columna de numeros alineados a la derecha (mismo borde derecho, distinto izquierdo) => right", async () => {
    const { doc, font } = await newDoc();
    const page = doc.addPage([600, 500]);
    const f = await font(H);
    ["1.5", "22.75", "333.1", "4"].forEach((text, i) => {
      const w = f.widthOfTextAtSize(text, 12);
      page.drawText(text, { x: 300 - w, y: 400 - i * 30, size: 12, font: f });
    });
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(4);
    expect(result.blocks.every((b) => b.align === "right")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Ronda 3 de verificacion: N1 (parrafos de una linea), N2 (listas con
 * sangria colgante), N3 (tablas con poco relleno), N5 (rendimiento) y
 * N6 (ids de glifo desplazados). Los PDFs de `__fixtures__/chromium` los
 * genero Chromium con `page.pdf()` (headless); los demas, pdf-lib.
 * ------------------------------------------------------------------ */

function chromiumFixture(name: string): Uint8Array {
  return new Uint8Array(
    fs.readFileSync(path.join(process.cwd(), "src/lib/pdf/__fixtures__/chromium", name)),
  );
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function analyzeFixture(name: string) {
  return analyzeBytes(chromiumFixture(name));
}

describe("N1 parrafos de una linea con margen (Chromium)", () => {
  it("v3-singles: Nombre / Direccion / Telefono / Correo son cuatro bloques", async () => {
    const result = await analyzeFixture("v3-singles.pdf");
    expect(textsOf(result.blocks)).toEqual([
      "Nombre: Juan Perez",
      "Direccion: Calle Falsa 123",
      "Telefono: 555-1234",
      "Correo: juan@example.com",
    ]);
  });

  it("chrome-unicode: cada parrafo de una linea sigue siendo suyo (4 bloques)", async () => {
    const result = await analyzeFixture("chrome-unicode.pdf");
    expect(result.blocks).toHaveLength(4);
    expect(result.blocks.every((b) => b.lines.length === 1)).toBe(true);
  });

  it("n-forms: etiquetas de una linea + dos parrafos justificados, todo exacto", async () => {
    const L =
      "El rapido zorro marron salta sobre el perro perezoso mientras la luna ilumina el campo abierto de forma muy brillante y nadie dice nada de lo ocurrido en la montana.";
    const result = await analyzeFixture("n-forms.pdf");
    expect(result.blocks.map((b) => norm(b.text))).toEqual([
      "Nombre: Juan Perez",
      "Direccion: Calle Falsa 123, Springfield",
      "Telefono: 555-1234",
      "Correo: juan@example.com",
      `${L} ${L}`,
      `${L} ${L}`,
    ]);
  });

  it("c2-double: UN parrafo de varias lineas a doble espacio sigue unido", async () => {
    const result = await analyzeFixture("c2-double.pdf");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].lines).toHaveLength(9);
  });

  /** Generador determinista de parrafos de una linea con pitch dado (en em). */
  async function singlesPdf(seed: number, pitchEm: number, count: number) {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([595, 842]);
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const words = "rapido zorro marron salta sobre perro perezoso luna ilumina campo abierto brillante nadie casa mesa libro pluma ciudad rio montana viento noche cielo".split(" ");
    const paras: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const n = 2 + Math.floor(rnd() * 8);
      const text = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      paras.push(text);
      page.drawText(text, { x: 57, y: 790 - i * pitchEm * 12, size: 12, font: f });
    }
    return { bytes: await doc.save(), paras };
  }

  for (const pitch of [2.15, 1.81, 1.98, 1.65]) {
    it(`parrafos de una linea con paso de ${pitch} em: >= 97 % exactos (4 documentos de 12 parrafos)`, async () => {
      let exact = 0;
      let total = 0;
      for (let k = 0; k < 4; k += 1) {
        const { bytes, paras } = await singlesPdf(100 + k * 31, pitch, 12);
        const result = await analyzeBytes(bytes);
        const set = new Set(result.blocks.map((b) => norm(b.text)));
        for (const p of paras) {
          total += 1;
          if (set.has(norm(p))) exact += 1;
        }
      }
      expect(exact / total).toBeGreaterThanOrEqual(0.97);
    });
  }

  it("dos lineas sueltas largas y a 2.15 em NO se funden aunque lleguen al borde", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([595, 842]);
    page.drawText("Una linea completa que llega hasta el final de la caja de texto actual", { x: 57, y: 700, size: 12, font: f });
    page.drawText("Otra linea completa que llega hasta el final de la caja del texto ya", { x: 57, y: 700 - 25.8, size: 12, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks).toHaveLength(2);
  });

  it("tres lineas a doble espacio que llenan la columna SI se unen; con cuatro, tambien", async () => {
    const make = async (n: number) => {
      const { doc, font } = await newDoc();
      const f = await font(H);
      const page = doc.addPage([595, 842]);
      for (let i = 0; i < n; i += 1) {
        page.drawText(
          i === n - 1 ? "ultima linea corta" : `Linea ${i} de texto continuo que alcanza el borde derecho ${"x".repeat(i % 3)}`,
          { x: 57, y: 700 - i * 24, size: 12, font: f },
        );
      }
      return analyzeBytes(await doc.save());
    };
    expect((await make(3)).blocks).toHaveLength(1);
    expect((await make(4)).blocks).toHaveLength(1);
    expect((await make(2)).blocks).toHaveLength(2);
  });
});

describe("N2 listas con sangria colgante", () => {
  it("v6-ol2: cada elemento (marcador + continuacion) es un bloque", async () => {
    const result = await analyzeFixture("v6-ol2.pdf");
    expect(result.blocks.map((b) => b.lines.length)).toEqual([2, 2, 1, 2]);
    expect(result.blocks.map((b) => b.text.slice(0, 3))).toEqual(["1. ", "2. ", "3. ", "a. "]);
    expect(result.blocks.every((b) => b.align === "left")).toBe(true);
  });

  it("v2-ol: elementos de varias lineas en 3 bloques y ninguno 'center'", async () => {
    const result = await analyzeFixture("v2-ol.pdf");
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks.every((b) => b.align === "left")).toBe(true);
  });

  it("n-lists: numeradas, con letras y con vinetas, cada elemento exacto", async () => {
    const L =
      "El rapido zorro marron salta sobre el perro perezoso mientras la luna ilumina el campo abierto de forma muy brillante y nadie dice nada de lo ocurrido en la montana.";
    const M = "Una frase de longitud media que ocupa una linea completa en el documento de prueba actual.";
    const result = await analyzeFixture("n-lists.pdf");
    expect(result.blocks.map((b) => norm(b.text))).toEqual([
      "Pasos a seguir:",
      `1. ${L}`,
      `2. ${M}`,
      `3. ${L} ${L}`,
      "4. Corto",
      "Y tambien:",
      `a. ${L}`,
      `b. ${M}`,
      L,
      "Otro punto breve",
    ]);
  });

  it("sintetico: marcador de texto 'N.' + sangria colgante en dos lineas por elemento", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([500, 500]);
    const items = [
      ["1. Primer elemento que es largo y", "continua en la segunda linea"],
      ["2. Segundo elemento igual de largo", "y tambien continua abajo"],
    ];
    let y = 400;
    for (const [first, second] of items) {
      page.drawText(first, { x: 50, y, size: 12, font: f });
      page.drawText(second, { x: 66, y: y - 14.4, size: 12, font: f });
      y -= 14.4 * 2 + 6;
    }
    const result = await analyzeBytes(await doc.save());
    expect(result.blocks.map((b) => b.lines.length)).toEqual([2, 2]);
    expect(result.blocks.every((b) => b.align === "left")).toBe(true);
  });

  it("una linea de ancho completo con otra sangrada y centros casi iguales NO es 'center'", () => {
    const { visible } = groupTextItems(
      [
        { str: "1. Linea de ancho completo del elemento", x: 50, y: 700, rotation: 0, width: 230, fontSize: 12, ascent: 0.8, descent: -0.2, color: "#000000", font: sourceFontInfoFrom({ name: "Helvetica" }), invisible: false, vertical: false },
        { str: "continuacion colgante algo mas corta", x: 66, y: 685.6, rotation: 0, width: 200, fontSize: 12, ascent: 0.8, descent: -0.2, color: "#000000", font: sourceFontInfoFrom({ name: "Helvetica" }), invisible: false, vertical: false },
      ],
      { pageIndex: 0 },
    );
    expect(visible).toHaveLength(1);
    expect(visible[0].align).toBe("left");
  });
});

describe("N3 tablas con poco relleno", () => {
  it("v6-tablepad2: la linea de una celda no se funde con la celda vecina", async () => {
    const result = await analyzeFixture("v6-tablepad2.pdf");
    expect(result.blocks).toHaveLength(9);
    for (const block of result.blocks) {
      expect(block.box.width, block.text).toBeLessThan(360);
      const mixes = /Servicio|Importe|\d,\d\d/.test(block.text) && /El rapido/.test(block.text);
      expect(mixes, block.text).toBe(false);
    }
  });

  it("n-notes: cabecera de tabla, celdas con texto envuelto y parrafos, todo exacto", async () => {
    const result = await analyzeFixture("n-notes.pdf");
    const texts = result.blocks.map((b) => norm(b.text));
    for (const expected of ["Concepto", "Descripcion detallada", "Importe", "Servicio A", "100,00", "Servicio B", "250,00", "Pie de pagina final", "Tema tratado ayer", "Fecha: 12 de marzo"]) {
      expect(texts, expected).toContain(expected);
    }
  });

  it("sintetico: celdas a 8 pt de la celda de texto envuelto (calle estrecha) no se funden", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([600, 400]);
    // Columna A: etiquetas; columna B: parrafo envuelto que arranca SIEMPRE en x=129.
    const labelWidth = f.widthOfTextAtSize("Servicio A", 12);
    for (const [row, top] of [["A", 350], ["B", 290]] as const) {
      page.drawText(`Servicio ${row}`, { x: 66, y: top - 14.4, size: 12, font: f });
      ["el rapido zorro marron salta sobre el perro", "luna ilumina el campo abierto de forma muy", "nada de lo ocurrido"].forEach((line, i) =>
        page.drawText(line, { x: 66 + labelWidth + 8, y: top - i * 14.4, size: 12, font: f }),
      );
    }
    const result = await analyzeBytes(await doc.save());
    for (const block of result.blocks) {
      expect(/Servicio/.test(block.text) && /rapido|luna|nada/.test(block.text), block.text).toBe(false);
    }
  });

  it("prosa justificada palabra a palabra NO se parte por el criterio de calles", () => {
    // 12 lineas de 8 palabras sueltas con huecos 4-8 pt (< 0.7 em) que nunca
    // se repiten en x y en ancho a la vez.
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const items = [] as Parameters<typeof groupTextItems>[0][number][];
    for (let line = 0; line < 12; line += 1) {
      let x = 72;
      for (let w = 0; w < 8; w += 1) {
        const width = (3 + Math.floor(rnd() * 6)) * 6;
        items.push({ str: "p".repeat(width / 6), x, y: 700 - line * 14.4, rotation: 0, width, fontSize: 12, ascent: 0.8, descent: -0.2, color: "#000000", font: sourceFontInfoFrom({ name: "Helvetica" }), invisible: false, vertical: false });
        x += width + 4 + rnd() * 5; // 0.33 - 0.75 em
      }
    }
    const { visible } = groupTextItems(items, { pageIndex: 0 });
    // Una linea jamas se parte en mas de 2 bloques por casualidad (el umbral 0.7 em
    // puede partir algun hueco de 8.9 pt), y desde luego no hay un bloque por palabra.
    expect(visible.length).toBeLessThan(items.length / 4);
  });
});

describe("N5 rendimiento", () => {
  it("16 000 palabras sueltas (400 filas x 40) se agrupan sin explosion de coste (< 12 s)", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([2000, 3200]);
    let n = 0;
    for (let row = 0; row < 400; row += 1) {
      for (let col = 0; col < 40; col += 1) {
        page.drawText(`w${n++ % 100}`, { x: 10 + col * 48, y: 3180 - row * 7, size: 6, font: f });
      }
    }
    const bytes = await doc.save();
    const started = performance.now();
    const result = await analyzeBytes(bytes);
    const elapsed = performance.now() - started;
    expect(result.blocks).toHaveLength(16000);
    // Solo mide ~0,5 s; dentro de la suite completa (17 workers de vitest a la
    // vez) se estira a >3 s sin que el codigo empeore, asi que el techo es
    // holgado: esta prueba solo protege contra una explosion de coste (el
    // recorrido cuadratico anterior tardaba 16 s con 40 000 fragmentos).
    expect(elapsed).toBeLessThan(12000);
  }, 60000);

  it("un parrafo denso de 60 lineas tarda decenas de ms", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([600, 800]);
    for (let i = 0; i < 60; i += 1) {
      page.drawText(Array.from({ length: 14 }, (_, j) => `palabra${(i * 7 + j) % 50}`).join(" "), { x: 40, y: 780 - i * 12, size: 9, font: f });
    }
    const bytes = await doc.save();
    const started = performance.now();
    const result = await analyzeBytes(bytes);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result.blocks).toHaveLength(1);
  });
});

describe("N6 ids de glifo desplazados sin ToUnicode", () => {
  const shift = (text: string, by: number) =>
    [...text].map((c) => (c === " " ? "\u0003" : String.fromCharCode(c.charCodeAt(0) - by))).join("");

  it("detecta frases desplazadas 29 y 31 y deja pasar texto legitimo (incl. mayusculas y siglas)", () => {
    for (const phrase of ["Subtitulo", "Lorem ipsum dolor sit amet", "Resumen ejecutivo del proyecto", "The quick brown fox jumps over the lazy dog", "Direccion", "Total a pagar por el cliente"]) {
      expect(looksLikeShiftedGlyphIds(shift(phrase, 29)), phrase).toBe(true);
      expect(looksLikeShiftedGlyphIds(shift(phrase, 31)), phrase).toBe(true);
    }
    for (const legit of [
      "INFORME ANUAL", "HTML CSS XML", "FACTURA N 4521", "NASA ESA CERN", "PO-4521-X", "RFC XYZ123456ABC",
      "TCP UDP HTTP", "SRL CPA NTSC", "Hello World", "Subtitulo", "ISO 9001:2015", "DNI 12345678Z",
      "TOTAL: 1.234,56 EUR", "CONTRATO DE ARRENDAMIENTO", "3M 4K 5G", "Title Case Words Here",
    ]) {
      expect(looksLikeShiftedGlyphIds(legit), legit).toBe(false);
    }
  });

  it("solo se aplica a fuentes en subconjunto: Helvetica estandar con ese texto sigue editable", () => {
    const text = shift("Resumen ejecutivo del proyecto", 29).replace(/\u0003/g, " ");
    const raw = (name: string) => ({
      str: text, x: 72, y: 700, rotation: 0, width: 200, fontSize: 12, ascent: 0.8, descent: -0.2,
      color: "#000000", font: sourceFontInfoFrom({ name }), invisible: false, vertical: false,
      identityEncoding: true,
    });
    expect(groupTextItems([raw("ABCDEF+Georgia")], { pageIndex: 0 }).visible[0].readOnlyReason).toBe("no-unicode");
    expect(groupTextItems([raw("Helvetica")], { pageIndex: 0 }).visible[0].editable).toBe(true);
  });

  async function withoutToUnicode(name: string): Promise<Uint8Array> {
    const doc = await PDFDocument.load(chromiumFixture(name));
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && object.has(PDFName.of("ToUnicode"))) {
        object.delete(PDFName.of("ToUnicode"));
      }
    }
    return new Uint8Array(await doc.save());
  }

  it("chrome-paragraphs sin ToUnicode: ningun bloque queda editable; con ToUnicode, todos", async () => {
    const broken = await analyzeBytes(await withoutToUnicode("chrome-paragraphs.pdf"));
    expect(broken.blocks.length).toBe(5);
    for (const block of broken.blocks) {
      expect(block.editable, block.text).toBe(false);
      expect(block.readOnlyReason).toBe("no-unicode");
    }
    const fine = await analyzeFixture("chrome-paragraphs.pdf");
    expect(fine.blocks.every((b) => b.editable)).toBe(true);
  });

  it("n-lists sin ToUnicode: ninguno editable; el original, todos", async () => {
    const broken = await analyzeBytes(await withoutToUnicode("n-lists.pdf"));
    expect(broken.blocks.every((b) => !b.editable)).toBe(true);
    const fine = await analyzeFixture("n-lists.pdf");
    expect(fine.blocks.every((b) => b.editable)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Ronda final: falsos positivos de la heuristica de ids desplazados
 * ------------------------------------------------------------------ */

describe("N6 sin falsos positivos en texto legitimo en mayusculas", () => {
  // Textos legitimos de la verificacion A3 (tallas, unidades, romanos, acentos...)
  const A3_LEGIT = [
    "S M L XL XXL", "XL L M S XS", "XS S M L XL", "MB GB TB KB", "XVI XVII XVIII", "MMXXVI", "A B C D E F", "SI NO",
    "PVP IVA TTC", "MR MRS MS DR", "TCP UDP IP DNS", "BMW VW MB AUDI", "SMS MMS RCS", "UK US EU UN", "MX CO AR CL PE",
    "CDMX NL JAL", "NY LA SF DC", "TV FM AM", "VIP VAT FAQ", "CEO CFO CTO COO", "PM AM EST PST", "KG LB OZ ML",
    "SRL SPA SAS SA SL", "RUC DNI CUIT", "HR IT QA UX", "DD MM AAAA", "N S E O NE NO SE SO", "ID NIF", "PDF DOC XLS PPT",
    "GPS LTE 5G", "PST CST MST", "B2B B2C", "ROI KPI OKR SLA", "ONG ONU OMS OTAN", "PP PSOE VOX", "LGBT IVF DNA RNA",
    "CPU GPU RAM SSD", "USB HDMI VGA", "PSN XBOX", "NBA NFL MLB NHL", "UEFA FIFA", "SW NW SE NE", "TRS STR",
    "BRL CLP COP MXN", "MXN ARS PEN UYU", "CH ST TH", "LTDA SRL", "MCMXC", "CDLXXIX", "LVIII LIX LX",
    "TÉCNICO: PEDRO R", "TÉCNICO: ISAAC R", "TÉCNICO: ANDRES", "MÉTODO: PAGO UNICO", "DÉBITO: SÍ", "TÉRMINO: 30 DIAS",
    "SÍNTESIS: CRM ERP", "TÉCNICO: JUAN P", "ÉPOCA: SIGLO XX", "TÉCNICO: ORLANDO", "TÉCNICO: VICTOR M",
    "INFORME ANUAL", "HTML CSS", "PO-4521-X", "NASA ESA JAXA", "ISBN 978-3-16-148410-0", "IVA 21%", "CIF B12345678",
    "NIF 12345678Z", "FACTURA No 2026-0042", "TOTAL A PAGAR", "DESCRIPCION CANTIDAD PRECIO IMPORTE",
    "CONDICIONES GENERALES DE CONTRATACION", "MADRID BARCELONA VALENCIA SEVILLA", "JOHN SMITH", "MARIA GARCIA LOPEZ",
    "RFC XAXX010101000", "SKU-AB12-9", "USD EUR GBP JPY CHF", "PRESIDENCIA DEL GOBIERNO", "BANCO SANTANDER S.A.",
    "ACUERDO DE CONFIDENCIALIDAD", "TERMS AND CONDITIONS", "TABLE OF CONTENTS", "CHAPTER 1 INTRODUCTION",
    "PDF XML JSON YAML", "ISO 9001 ISO 14001", "SECCION A SECCION B", "UNIVERSIDAD COMPLUTENSE DE MADRID",
    "NOMBRE APELLIDOS DNI", "FECHA HORA LUGAR", "DEPARTAMENTO DE RECURSOS HUMANOS", "RESUMEN EJECUTIVO", "ANEXO I",
    "SQL NOSQL ORM API REST", "WWW.EJEMPLO.COM", "TEL 91 555 12 34", "BRAZIL ARGENTINA CHILE PERU",
    "STRENGTH WEAKNESS OPPORTUNITIES THREATS", "CRM ERP SCM BI", "LLC INC LTD GMBH", "AEAT TGSS INSS SEPE",
    "ESTADO DE RESULTADOS", "BALANCE GENERAL", "ACTIVO PASIVO PATRIMONIO", "NORTH SOUTH EAST WEST", "RENFE AVE ALVIA",
    "A4 A3 A5 B5", "Q1 Q2 Q3 Q4", "ENERO FEBRERO MARZO ABRIL", "LUNES MARTES MIERCOLES", "GDPR LOPD RGPD LSSI",
    "CONFIDENCIAL", "BORRADOR", "SIN VALOR", "PAGADO", "PRIVATE AND CONFIDENTIAL", "ALL RIGHTS RESERVED",
    "Hola mundo esto es un texto normal", "The quick brown fox jumps over the lazy dog", "Dirección: Calle Mayor 12, Madrid",
    "Gracias por su compra", "El presente contrato se celebra entre las partes", "Nombre y apellidos del solicitante",
    "Total sin IVA", "Subtotal", "Page 3 of 12",
  ];
  // Muestra nueva: encabezados de tabla, siglas, codigos, nombres propios, direcciones (es/en).
  const NEW_LEGIT = [
    "TECNICO: NOMBRE X", "DEBITO: SI", "ESTADO: ACTIVO", "CLIENTE: JUAN P", "REF: AB-1234", "PEDIDO N 00123",
    "CODIGO POSTAL 28001", "TELEFONO 600 123 456", "EMAIL: INFO@EJEMPLO.ES", "WEB: WWW.SITIO.COM", "SUBTOTAL IVA TOTAL",
    "BASE IMPONIBLE", "CUOTA IVA 21%", "RETENCION IRPF 15%", "FORMA DE PAGO: TRANSFERENCIA", "IBAN ES00 0000 0000 0000",
    "SWIFT BSCHESMM", "VENCIMIENTO: 30 DIAS", "OBSERVACIONES", "FIRMA Y SELLO", "ORDER CONFIRMATION", "SHIPPING ADDRESS",
    "BILLING INFORMATION", "UNIT PRICE QTY AMOUNT", "TOTAL DUE", "PAYMENT TERMS NET 30", "PURCHASE ORDER NO",
    "SIGNATURE DATE", "PAGE 1 OF 3", "PLEASE RETAIN THIS COPY", "JOSE LUIS RODRIGUEZ ZAPATERO", "ANA MARIA FERNANDEZ",
    "JOHN F KENNEDY", "ELIZABETH WARREN", "PEDRO ALMODOVAR", "GABRIEL GARCIA MARQUEZ", "WILLIAM SHAKESPEARE",
    "MIGUEL DE CERVANTES", "ISABEL II", "CARLOS III", "AVDA DE AMERICA 12", "CALLE MAYOR 3 4B", "PASEO DE LA CASTELLANA",
    "PLAZA DEL SOL", "RUA AUGUSTA 100", "5TH AVENUE NEW YORK", "BAKER STREET 221B", "VIA ROMA 15", "MADRID ESPANA",
    "BUENOS AIRES ARGENTINA", "A.B.C.", "S.A. DE C.V.", "I.V.A. INCLUIDO", "N.I.F.", "Q.E.P.D.", "P.D.: GRACIAS",
    "UU.EE.", "EE.UU.", "C/ SOL 5", "AV. LUZ 7", "NIVEL 1 NIVEL 2 NIVEL 3", "FASE A FASE B", "OPCION 1 OPCION 2",
    "ITEM 001 ITEM 002", "LOTE 45B", "SERIE X9", "MODELO ZX-81", "PLANTA BAJA", "SOTANO -1", "ESCALERA IZQ", "ZZZ",
    "XXXXXX", "QWERTY ASDF", "LOREM IPSUM", "MNOPQR STUVWX", "YZ ABC DEF", "ABCDEFGH", "KLMNOPQR", "FGHIJKLM", "TUVWXYZ",
    "HTML CSS XML", "FACTURA N 4521", "NASA ESA CERN", "TOTAL EUR", "CONTRATO DE ARRENDAMIENTO", "RFC XYZ123456ABC",
    "TCP UDP HTTP", "SRL CPA NTSC", "GDPR PCI DSS", "IVA IRPF", "NIF CIF DNI", "FIGURE 3 RESULTS", "ISO 9001:2015",
    "DNI 12345678Z", "3M 4K 5G", "MR SMITH PLC", "BRNO PRG", "SQL JSON YAML",
  ];

  it(`ninguno de los ${A3_LEGIT.length + NEW_LEGIT.length} textos legitimos se marca (con la funcion sola)`, () => {
    const all = [...new Set([...A3_LEGIT, ...NEW_LEGIT])];
    expect(all.length).toBeGreaterThanOrEqual(200);
    expect(all.filter((t) => looksLikeShiftedGlyphIds(t))).toEqual([]);
  });

  const PROSE = [
    "Subtitulo del documento", "Informacion general del cliente", "El presente contrato se celebra entre las partes",
    "Descripcion del servicio prestado", "Condiciones generales de contratacion", "Resumen ejecutivo del proyecto",
    "The quick brown fox jumps over the lazy dog", "Terms and conditions of sale", "Chapter one introduction to the subject",
    "Invoice number and payment details", "Direccion de entrega del pedido", "Nombre y apellidos del solicitante",
  ];

  it("sigue detectando 48/48 frases desplazadas (29, 31, 28, 30) con espacio real o U+0003", () => {
    let hits = 0;
    for (const by of [29, 31, 28, 30]) {
      for (const phrase of PROSE) {
        const keepSpace = [...phrase]
          .map((ch) => (ch === " " ? ch : String.fromCharCode(ch.charCodeAt(0) - by)))
          .join("");
        const controlSpace = [...phrase]
          .map((ch) => (ch === " " ? "\u0003" : String.fromCharCode(ch.charCodeAt(0) - by)))
          .join("");
        if (looksLikeShiftedGlyphIds(keepSpace)) hits += 1;
        expect(looksLikeShiftedGlyphIds(controlSpace), phrase).toBe(true);
      }
    }
    expect(hits).toBe(48);
  });

  it("un texto de una palabra desplazado ('6XEWLWXOR') sigue detectandose; las siglas cortas no", () => {
    expect(looksLikeShiftedGlyphIds("6XEWLWXOR")).toBe(true);
    expect(looksLikeShiftedGlyphIds("S M L XL XXL")).toBe(false);
    expect(looksLikeShiftedGlyphIds("MMXXVI")).toBe(false);
  });

  it("cualquier caracter fuera de ASCII (acentos, enie) es texto legitimo", () => {
    expect(looksLikeShiftedGlyphIds("6XEWLWXOR\u00c9")).toBe(false);
    expect(looksLikeShiftedGlyphIds("T\u00c9CNICO: NOMBRE X")).toBe(false);
  });

  it("s9-caps.pdf (Chrome, CON ToUnicode): todo el texto en mayusculas sigue editable", async () => {
    const result = await analyzeFixture("s9-caps.pdf");
    expect(result.blocks.length).toBeGreaterThanOrEqual(8);
    for (const block of result.blocks) expect(block.editable, block.text).toBe(true);
    const texts = result.blocks.map((b) => b.text);
    for (const expected of ["S M L XL XXL", "MB GB TB KB", "XVI XVII XVIII", "MMXXVI"]) {
      expect(texts).toContain(expected);
    }
  });

  it("la heuristica solo corre con evidencia de que la fuente NO traduce a Unicode", () => {
    const shifted = [...PROSE[5]].map((ch) => (ch === " " ? " " : String.fromCharCode(ch.charCodeAt(0) - 29))).join("");
    const make = (identityEncoding: boolean | undefined) => ({
      str: shifted, x: 72, y: 700, rotation: 0, width: 200, fontSize: 12, ascent: 0.8, descent: -0.2,
      color: "#000000", font: sourceFontInfoFrom({ name: "ABCDEF+Georgia" }),
      invisible: false, vertical: false, identityEncoding,
    });
    const reason = (value: boolean | undefined) =>
      groupTextItems([make(value)], { pageIndex: 0 }).visible[0];
    expect(reason(true).readOnlyReason).toBe("no-unicode");
    // La fuente tiene mapa (algun glifo se traduce) o no hay datos: no se toca.
    expect(reason(false).editable).toBe(true);
    expect(reason(undefined).editable).toBe(true);
  });

  it("collectTextRuns anota si los glifos se traducen (mapa) o son su propio codigo (identidad)", () => {
    const OPS = { beginText: 1, setFont: 2, showText: 3 } as TextOps;
    const list = (glyphs: Array<{ originalCharCode: number; unicode: string; width: number }>) => ({
      fnArray: [OPS.beginText, OPS.setFont, OPS.showText],
      argsArray: [null, ["f1", 10], [glyphs]],
    });
    const identity = new Map();
    collectTextRuns(list([{ originalCharCode: 54, unicode: "6", width: 500 }, { originalCharCode: 88, unicode: "X", width: 500 }]), OPS, undefined, undefined, identity);
    expect(identity.get("f1")).toEqual({ identity: 2, mapped: 0 });
    const mapped = new Map();
    collectTextRuns(list([{ originalCharCode: 44, unicode: "I", width: 500 }, { originalCharCode: 88, unicode: "X", width: 500 }]), OPS, undefined, undefined, mapped);
    expect(mapped.get("f1")).toEqual({ identity: 1, mapped: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * Ronda 5: reglas vectoriales como separadores (D3) y huella corta (D5)
 * ------------------------------------------------------------------ */

const TABLE_CELLS = ["Concepto", "Unidades", "Importe", "Servicio uno", "2", "250,00", "Gestion Ágil", "10", "1.075,50", "TOTAL", "1.325,50"];

/** Cuenta los bloques que una regla vertical cruza POR DENTRO (borrarlos borraria el borde). */
async function blocksCrossedByVerticalRule(name: string): Promise<{ blocks: TextBlock[]; crossed: string[] }> {
  const opened = await openWithPdfjs(chromiumFixture(name));
  try {
    const page = await opened.page(1);
    const result = await analyzePageText(page, 0, { OPS: opened.OPS });
    const rules: RuleLine[] = [];
    collectTextRuns(await page.getOperatorList(), opened.OPS, undefined, [], new Map(), rules);
    const verticals = rules.filter((r) => Math.abs(r.x0 - r.x1) < 0.6 && Math.abs(r.y1 - r.y0) > 4);
    const crossed = result.blocks
      .filter((b) =>
        verticals.some(
          (r) =>
            r.x0 > b.box.x + 0.3 &&
            r.x0 < b.box.x + b.box.width - 0.3 &&
            Math.min(r.y0, r.y1) < b.box.y + b.box.height &&
            Math.max(r.y0, r.y1) > b.box.y,
        ),
      )
      .map((b) => b.text);
    return { blocks: result.blocks, crossed };
  } finally {
    await opened.close();
  }
}

describe("D3 reglas vectoriales: ninguna celda se funde a traves de un borde", () => {
  for (const [name, label] of [
    ["tbl-0.pdf", "padding 0, borde 0.5 px, Helvetica (texto de celdas contiguas fundido por pdf.js)"],
    ["tbl-1.pdf", "padding 0, borde 0.5 px, Times"],
    ["tbl-4.pdf", "padding 0, borde 2 px"],
    ["tbl-6.pdf", "padding 1 px"],
  ] as const) {
    it(`Chromium ${label}: 11 celdas exactas y ninguna cruzada por un borde`, async () => {
      const { blocks, crossed } = await blocksCrossedByVerticalRule(name);
      expect(blocks.map((b) => b.text.trim()).sort()).toEqual([...TABLE_CELLS].sort());
      expect(crossed).toEqual([]);
    });
  }

  it("pdf-lib: bordes con drawLine entre celdas de texto pegado se respetan", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([400, 300]);
    // "Unidades" acaba en x=100.3 y "Importe" empieza en 101.3: pdf.js los fundiria.
    const w = f.widthOfTextAtSize("Unidades", 12);
    page.drawText("Unidades", { x: 100.3 - w, y: 200, size: 12, font: f });
    page.drawText("Importe", { x: 101.3, y: 200, size: 12, font: f });
    page.drawLine({ start: { x: 100.8, y: 192 }, end: { x: 100.8, y: 214 }, thickness: 1 });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Unidades", "Importe"]);
    const [left, right] = result.blocks;
    expect(left.box.x + left.box.width).toBeLessThanOrEqual(100.3);
    expect(right.box.x).toBeGreaterThanOrEqual(101.3 - 0.01);
  });

  it("pdf-lib: celdas con drawRectangle (borde trazado) en un texto fundido por una sola instruccion", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 50, y: 190, width: 80, height: 24, borderWidth: 1, borderColor: hexToRgb("#000000") });
    page.drawRectangle({ x: 130, y: 190, width: 80, height: 24, borderWidth: 1, borderColor: hexToRgb("#000000") });
    // Una sola instruccion con todo el texto: el corte solo puede salir de la regla + el espacio.
    const first = f.widthOfTextAtSize("Servicio uno ", 12);
    const x = 130 - first - 0.5;
    page.drawText("Servicio uno 2", { x, y: 198, size: 12, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Servicio uno", "2"]);
    const [a, b] = result.blocks;
    expect(a.box.x + a.box.width).toBeLessThan(130 - 0.5);
    expect(b.box.x).toBeGreaterThan(130 + 0.5);
  });

  it("pdfkit: moveTo/lineTo/stroke entre celdas separa los bloques", async () => {
    const bytes = await kitBytes((kit) => {
      kit.fontSize(12);
      kit.text("Unidades", 40, 50, { lineBreak: false });
      kit.text("Importe", 102, 50, { lineBreak: false });
      kit.lineWidth(1).moveTo(101, 44).lineTo(101, 68).stroke();
    }, [300, 200]);
    const result = await analyzeBytes(bytes);
    expect(textsOf(result.blocks)).toEqual(["Unidades", "Importe"]);
  });

  it("una regla que atraviesa UNA palabra sin espacios (texto sobre una linea) no se usa para partirla", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([300, 200]);
    page.drawText("Unidades", { x: 50, y: 100, size: 12, font: f });
    page.drawLine({ start: { x: 75, y: 90 }, end: { x: 75, y: 115 }, thickness: 1 });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Unidades"]);
  });

  it("un subrayado (regla horizontal bajo el texto) no parte ni separa nada", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([400, 200]);
    page.drawText("Texto subrayado con varias palabras", { x: 50, y: 100, size: 12, font: f });
    page.drawLine({ start: { x: 50, y: 98 }, end: { x: 250, y: 98 }, thickness: 0.8 });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Texto subrayado con varias palabras"]);
  });

  it("una regla horizontal entre dos lineas separadas 1.4 em corta el parrafo; sin regla se unen", async () => {
    const build = async (withRule: boolean) => {
      const { doc, font } = await newDoc();
      const f = await font(H);
      const page = doc.addPage([400, 200]);
      page.drawText("Primera linea de un parrafo de ejemplo", { x: 50, y: 150, size: 12, font: f });
      page.drawText("Segunda linea del mismo parrafo ejemplo", { x: 50, y: 150 - 16.8, size: 12, font: f });
      if (withRule) page.drawLine({ start: { x: 40, y: 145.8 }, end: { x: 300, y: 145.8 }, thickness: 0.8 });
      return analyzeBytes(await doc.save());
    };
    expect((await build(false)).blocks).toHaveLength(1);
    expect((await build(true)).blocks).toHaveLength(2);
  });

  it("sin reglas (celdas sin bordes) el resultado es el de siempre", async () => {
    const { doc, font } = await newDoc();
    const f = await font(H);
    const page = doc.addPage([400, 200]);
    page.drawText("Uno", { x: 50, y: 100, size: 12, font: f });
    page.drawText("Dos", { x: 200, y: 100, size: 12, font: f });
    const result = await analyzeBytes(await doc.save());
    expect(textsOf(result.blocks)).toEqual(["Uno", "Dos"]);
  });

  it("groupTextItems con reglas: parte un fragmento fundido por el espacio mas cercano y respeta el borde", () => {
    const item = (str: string, x: number, width: number) => ({
      str, x, y: 700, rotation: 0, width, fontSize: 12, ascent: 0.8, descent: -0.2,
      color: "#000000", font: sourceFontInfoFrom({ name: "Helvetica" }), invisible: false, vertical: false,
    });
    const rules = [{ x0: 130, y0: 690, x1: 130, y1: 712, thickness: 0.75 }];
    const { visible } = groupTextItems([item("Servicio uno 2", 60, 75)], { pageIndex: 0, rules });
    expect(visible.map((b) => b.text)).toEqual(["Servicio uno", "2"]);
    expect(visible[0].box.x + visible[0].box.width).toBeLessThan(130 - 0.3);
    expect(visible[1].box.x).toBeGreaterThan(130 + 0.3);
    // Misma entrada sin reglas: un solo bloque.
    expect(groupTextItems([item("Servicio uno 2", 60, 75)], { pageIndex: 0 }).visible).toHaveLength(1);
  });
});

describe("D5 huella corta del detector de texto desplazado", () => {
  const TOKENS = ["5GHZ", "1TB", "2TB", "8GB", "16GB", "4K", "5G", "3D", "2FA", "100KM", "3M", "MP3", "MP4", "H264", "B2B", "B2C", "IPV6", "USB3", "HDMI2", "G20", "T800", "U2", "H2O", "SDK", "XML", "SQL", "LTR", "CPU", "GPU", "KB", "MB", "GB", "TB", "MHZ", "KHZ", "HTML", "CSS", "USB", "HDMI", "PRSNT", "STRNG", "KRKN", "WRKS", "ANEXO", "2DO", "3ER", "1RA", "7UP", "A4", "F1", "X86", "ARM64", "RTX4090", "5NM", "12V", "220V", "50HZ", "60FPS", "4K60", "1080P", "720P", "UHD", "OLED", "IP67", "IP68", "RJ45", "M2", "SSD", "NVME", "DDR5", "LPDDR5", "WIFI6", "BT5", "LTE", "5GNR", "TOTAL", "FECHA", "NOMBRE"];

  it("0 falsos positivos en 20 000 combinaciones de unidades, modelos, siglas y tokens con digito", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const flagged: string[] = [];
    for (let i = 0; i < 20000; i += 1) {
      const n = 1 + Math.floor(rnd() * 4);
      const text = Array.from({ length: n }, () => TOKENS[Math.floor(rnd() * TOKENS.length)]).join(" ");
      if (looksLikeShiftedGlyphIds(text)) flagged.push(text);
    }
    expect(flagged).toEqual([]);
  });

  it("los textos SDK 5GHZ / 1TB MP4 / XML 5GHZ / G20 5GHZ LTR SQL son editables en una fuente sin mapa (CID legible)", () => {
    const font = sourceFontInfoFrom({ name: "ABCDEF+LiberationSans" });
    for (const text of ["SDK 5GHZ", "1TB MP4", "XML 5GHZ", "G20 5GHZ LTR SQL", "USB3 PRSNT KB CPU", "8GB T800 CPU", "1TB IPV6", "5GHZ 2DO"]) {
      const { visible } = groupTextItems(
        [{ str: text, x: 72, y: 700, rotation: 0, width: 100, fontSize: 12, ascent: 0.8, descent: -0.2, color: "#000000", font, invisible: false, vertical: false, identityEncoding: true }],
        { pageIndex: 0 },
      );
      expect(visible[0].editable, text).toBe(true);
    }
  });

  it("recall 100 %: 24 frases x 6 desplazamientos y 6 titulos en mayusculas x 6 desplazamientos", () => {
    const prose = [
      "Subtitulo del documento", "Informacion general del cliente", "El presente contrato se celebra entre las partes", "Descripcion del servicio prestado",
      "Condiciones generales de contratacion", "Resumen ejecutivo del proyecto", "The quick brown fox jumps over the lazy dog", "Terms and conditions of sale",
      "Chapter one introduction to the subject", "Invoice number and payment details", "Direccion de entrega del pedido", "Nombre y apellidos del solicitante",
      "Total a pagar por el cliente", "Fecha de emision de la factura", "Gracias por confiar en nosotros", "Politica de privacidad y cookies",
      "Please read the following carefully", "Payment is due within thirty days", "Estimado cliente le informamos de que", "Este documento es confidencial",
      "Report of the annual general meeting", "Warranty and return policy", "Capitulo tres resultados obtenidos", "Plan de trabajo para el proximo trimestre",
    ];
    const upper = ["INFORME ANUAL DE ACTIVIDADES", "CONDICIONES GENERALES DE CONTRATACION", "TERMS AND CONDITIONS OF SALE", "DESCRIPCION DEL SERVICIO", "RESUMEN EJECUTIVO DEL PROYECTO", "POLITICA DE PRIVACIDAD Y COOKIES"];
    const font = sourceFontInfoFrom({ name: "ABCDEF+LiberationSans" });
    let total = 0;
    let hits = 0;
    for (const shift of [27, 28, 29, 30, 31, 32]) {
      for (const phrase of [...prose, ...upper]) {
        // Mismo desplazamiento que el generador de la verificacion: ids = ASCII - shift, espacio = 32 - shift.
        const text = [...phrase].map((ch) => String.fromCharCode(ch.charCodeAt(0) - shift)).join("");
        const { visible } = groupTextItems(
          [{ str: text, x: 72, y: 700, rotation: 0, width: 200, fontSize: 12, ascent: 0.8, descent: -0.2, color: "#000000", font, invisible: false, vertical: false, identityEncoding: true }],
          { pageIndex: 0 },
        );
        total += 1;
        if (!visible[0].editable && visible[0].readOnlyReason === "no-unicode") hits += 1;
      }
    }
    expect(total).toBe(180);
    expect(hits).toBe(180);
  });
});
