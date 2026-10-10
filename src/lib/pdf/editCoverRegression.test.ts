import { describe, expect, it } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  degrees,
  rgb,
} from "@cantoo/pdf-lib";
import {
  draftEditForBlock,
  geometryFromPdfJsPage,
  lineStripsToUserBoxes,
  makeMetrics,
  pageLayoutOf,
  sampleCanvasBackground,
  userBoxToPx,
} from "@/app/edit-pdf/editCanvasMath";
import { blockCoverExtent, coverShape } from "@/lib/pdf/editCover";
import { applyTextEdits, flattenPages, type PageRasterizer } from "@/lib/pdf/editTextExport";
import {
  contextOf,
  countPixels,
  extractBlocks,
  getPdfjsLegacy,
  isDarkPixel,
  regionOfBox,
  renderPages,
  STANDARD_FONTS_DIR,
  type Raster,
} from "@/lib/pdf/editRenderTestUtils";
import { sampleBackgroundColor, type RgbaImage } from "@/lib/pdf/editBackground";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";
import { createCanvas } from "@napi-rs/canvas";

/**
 * Regresiones de la verificacion independiente de la Wave 5. Cada caso mide
 * pixeles o texto del PDF de SALIDA (render real con pdf.js + @napi-rs/canvas),
 * y varios comparan con el comportamiento anterior para demostrar que la prueba
 * falla sin el arreglo (se anota la cifra «antes»).
 */

const SCALE = 3;

async function save(document: PDFDocument): Promise<Uint8Array> {
  return new Uint8Array(await document.save());
}

/** Edicion de BORRADO (texto vacio) de `block`, muestreando el fondo como lo hace la app. */
function deleteEdit(
  block: TextBlock,
  raster: Raster,
  layout?: ReturnType<typeof pageLayoutOf>,
): { edit: TextEdit; uniform: boolean | undefined } {
  const metrics = makeMetrics(
    geometryFromPdfJsPage(raster.page),
    raster.width / SCALE,
  );
  const extent = blockCoverExtent(block, 1);
  const rect = userBoxToPx(metrics, extent);
  const k = raster.width / metrics.cssWidth;
  const sample = sampleCanvasBackground(
    contextOf(raster),
    { width: raster.width, height: raster.height },
    { x: rect.left * k, y: rect.top * k, width: rect.width * k, height: rect.height * k },
  );
  const edit = draftEditForBlock(block, {
    coverColor: sample?.color ?? "#ffffff",
    coverUniform: sample?.uniform,
    layout,
    overrides: { text: "" },
  });
  return { edit, uniform: sample?.uniform };
}

describe("D1 — cobertura de texto girado un angulo libre", () => {
  async function diagonalPage() {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 300]);
    page.drawText("Diagonal text that is quite long", {
      x: 60,
      y: 60,
      size: 16,
      font,
      rotate: degrees(40),
    });
    page.drawText("NEIGHBOR ABOVE-LEFT", { x: 62, y: 200, size: 10, font });
    page.drawText("NEIGHBOR BELOW-RIGHT", { x: 250, y: 66, size: 10, font });
    return save(document);
  }

  const neighborRegions = (raster: Raster) => [
    regionOfBox(raster, { x: 62, y: 198, width: 120, height: 14 }),
    regionOfBox(raster, { x: 250, y: 64, width: 130, height: 14 }),
  ];

  it("borrar el texto a 40 grados NO borra el vecino que cae dentro de su caja envolvente", async () => {
    const bytes = await diagonalPage();
    const [before] = await renderPages(bytes, SCALE);
    const blocks = await extractBlocks(bytes);
    const diagonal = blocks.find((block) => Math.abs(block.rotation - 40) < 1);
    expect(diagonal).toBeDefined();

    const { edit } = deleteEdit(diagonal!, before);
    expect(edit.coverOriented).toBeDefined();
    const result = await applyTextEdits(bytes, [edit]);
    const [after] = await renderPages(result.bytes, SCALE);

    for (const region of neighborRegions(before)) {
      const inkBefore = countPixels(before, isDarkPixel, region);
      expect(inkBefore).toBeGreaterThan(500);
      // Antes del arreglo: 2007 -> 0 px de tinta en el vecino de arriba a la izquierda.
      expect(countPixels(after, isDarkPixel, region)).toBe(inkBefore);
    }
    // Y el texto girado ha desaparecido: toda la tinta restante es la de los vecinos.
    const neighbors = neighborRegions(before).reduce(
      (sum, region) => sum + countPixels(before, isDarkPixel, region),
      0,
    );
    expect(countPixels(after, isDarkPixel)).toBe(neighbors);
  });

  it("control: con la caja envolvente (comportamiento anterior) el vecino SI se borraba", async () => {
    const bytes = await diagonalPage();
    const [before] = await renderPages(bytes, SCALE);
    const blocks = await extractBlocks(bytes);
    const diagonal = blocks.find((block) => Math.abs(block.rotation - 40) < 1)!;
    const { edit } = deleteEdit(diagonal, before);
    const legacy: TextEdit = { ...edit, coverBox: { ...diagonal.box }, cover: { ...edit.cover, padding: 1 } };
    delete legacy.coverOriented;
    const result = await applyTextEdits(bytes, [legacy]);
    const [after] = await renderPages(result.bytes, SCALE);
    const [above] = neighborRegions(before);
    expect(countPixels(after, isDarkPixel, above)).toBeLessThan(countPixels(before, isDarkPixel, above));
  });

  it("el texto girado 90 grados sigue cubriendose con su caja (sin cobertura orientada)", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 300]);
    page.drawText("Vertical text here", { x: 100, y: 60, size: 16, font, rotate: degrees(90) });
    const bytes = await save(document);
    const [before] = await renderPages(bytes, SCALE);
    const block = (await extractBlocks(bytes)).find((b) => Math.abs(b.rotation - 90) < 1)!;
    const { edit } = deleteEdit(block, before);
    expect(edit.coverOriented).toBeUndefined();
    const result = await applyTextEdits(bytes, [edit]);
    const [after] = await renderPages(result.bytes, SCALE);
    expect(countPixels(after, isDarkPixel)).toBe(0);
  });
});

describe("D4 — acentos de mayusculas fuera de la caja de cobertura", () => {
  const TEXT = "ÁÉÍÓÚÑ ÀÂÄÅÃ Çg jpqy";

  async function accentPage(font: StandardFonts, size: number) {
    const document = await PDFDocument.create();
    const embedded = await document.embedFont(font);
    const page = document.addPage([500, 200]);
    page.drawText(TEXT, { x: 20, y: 100, size, font: embedded });
    return save(document);
  }

  it.each([
    ["Times", StandardFonts.TimesRoman, 12],
    ["Times", StandardFonts.TimesRoman, 24],
    ["Times", StandardFonts.TimesRoman, 48],
    ["Helvetica", StandardFonts.Helvetica, 24],
    ["Courier", StandardFonts.Courier, 24],
  ] as const)("%s a %i pt: borrar deja 0 px de residuo y el fondo se lee como liso", async (_name, font, size) => {
    const bytes = await accentPage(font, size);
    const [before] = await renderPages(bytes, SCALE);
    const block = (await extractBlocks(bytes))[0];
    const { edit, uniform } = deleteEdit(block, before);
    const result = await applyTextEdits(bytes, [edit]);
    const [after] = await renderPages(result.bytes, SCALE);
    // Antes del arreglo (Times): 20 px (12 pt), 86 px (24 pt), 201 px (48 pt) de residuo.
    expect(countPixels(after, isDarkPixel)).toBe(0);
    expect(uniform).toBe(true);
    expect(result.warnings.some((w) => w.kind === "background-not-uniform")).toBe(false);
  });

  it("control: con la caja anterior (sin ampliar), Times a 24 pt dejaba residuo", async () => {
    const bytes = await accentPage(StandardFonts.TimesRoman, 24);
    const [before] = await renderPages(bytes, SCALE);
    const block = (await extractBlocks(bytes))[0];
    const { edit } = deleteEdit(block, before);
    const result = await applyTextEdits(bytes, [{ ...edit, coverBox: { ...block.box } }]);
    const [after] = await renderPages(result.bytes, SCALE);
    expect(countPixels(after, isDarkPixel)).toBeGreaterThan(0);
  });

  it("la cobertura ampliada NO pisa la linea vecina (limite por interlineado)", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.TimesRoman);
    const page = document.addPage([500, 200]);
    // Dos lineas a interlineado 1,2: la de arriba tiene colas (g, j, p, y).
    page.drawText("gjpqy gjpqy gjpqy", { x: 20, y: 130, size: 24, font });
    page.drawText("ÁÉÍÓÚÑ ÀÂÄÅÃ", { x: 160, y: 130 - 28.8, size: 24, font });
    const bytes = await save(document);
    const [before] = await renderPages(bytes, SCALE);
    const blocks = await extractBlocks(bytes);
    const lower = blocks.find((block) => block.text.includes("ÁÉÍ"))!;
    const upper = blocks.find((block) => block.text.includes("gjpqy"));
    expect(upper).toBeDefined();
    const { edit } = deleteEdit(lower, before);
    const result = await applyTextEdits(bytes, [edit]);
    const [after] = await renderPages(result.bytes, SCALE);
    const upperRegion = regionOfBox(before, upper!.box);
    // Las colas de la linea de arriba quedan intactas...
    expect(countPixels(after, isDarkPixel, upperRegion)).toBe(countPixels(before, isDarkPixel, upperRegion));
    // ...y la linea de abajo desaparece sin residuo.
    const lowerRegion = regionOfBox(before, { ...lower.box, y: lower.box.y - 2, height: lower.box.height + 6 });
    expect(countPixels(after, isDarkPixel, lowerRegion)).toBe(0);
  });
});

describe("B-mayor 2 — bloque de una linea: la caja crece, no se parten palabras", () => {
  async function singleLinePage(text = "Servicios") {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 200]);
    page.drawText(text, { x: 40, y: 100, size: 20, font });
    page.drawText("NEXT", { x: 300, y: 100, size: 20, font });
    return save(document);
  }

  async function exportEdit(text: string, withLayout = true) {
    const bytes = await singleLinePage();
    const blocks = await extractBlocks(bytes);
    const block = blocks.find((b) => b.text === "Servicios")!;
    const metrics = makeMetrics(
      geometryFromPdfJsPage({ view: [0, 0, 400, 200], rotate: 0 }),
      400,
    );
    const edit = draftEditForBlock(block, {
      coverColor: "#ffffff",
      layout: withLayout ? pageLayoutOf(metrics, blocks) : undefined,
      overrides: { text },
    });
    const result = await applyTextEdits(bytes, [edit]);
    const pdfjs = await getPdfjsLegacy();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(result.bytes),
      standardFontDataUrl: STANDARD_FONTS_DIR,
      verbosity: 0,
    }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const lines = content.items
      .filter((item): item is typeof item & { str: string } => "str" in item && item.str.length > 0)
      .map((item) => item.str);
    await doc.loadingTask.destroy();
    return { edit, result, lines, block };
  }

  it("«Servicios» -> «Servicios y más» sale en una sola linea, sin partir la palabra", async () => {
    const { edit, lines, block } = await exportEdit("Servicios y más");
    // La caja crecio hasta el bloque vecino (menos el hueco), no hasta el borde de la pagina.
    expect(edit.box.x).toBeCloseTo(block.box.x, 3);
    expect(edit.box.x + edit.box.width).toBeLessThan(300);
    expect(edit.box.width).toBeGreaterThan(block.box.width * 2);
    // Antes: «Servicio» / «s y más» (envuelta al ancho original, partiendo la palabra).
    expect(lines.some((line) => line.includes("Servicios y más"))).toBe(true);
    expect(lines.some((line) => line === "s y más")).toBe(false);
  });

  it("sin la capa de maquetacion (borradores antiguos) la palabra tampoco se parte", async () => {
    const { lines } = await exportEdit("Servicios y más", false);
    expect(lines.join("|")).not.toMatch(/Servicio\|s/);
    expect(lines.join(" ")).toContain("Servicios");
  });

  it("un texto mas largo que el hueco baja de linea entre palabras, nunca dentro de una", async () => {
    const { lines } = await exportEdit("Servicios profesionales de consultoria integral");
    const joined = lines.join(" ");
    for (const word of ["Servicios", "profesionales", "consultoria", "integral"]) {
      expect(lines.some((line) => line.split(" ").includes(word))).toBe(true);
    }
    expect(joined).not.toMatch(/\b[a-z]\b \b[a-z]{2,}\b.*\b[a-z]\b$/);
  });

  it("una palabra mas ancha que el hueco invade al vecino y se AVISA overlap con su id", async () => {
    const { result, edit, block } = await exportEdit("Supercalifragilisticoespialidoso");
    expect(edit.obstacles?.some((o) => o.id !== block.id)).toBe(true);
    const warnings = result.warningsByEdit[edit.id] ?? [];
    const overlap = warnings.find((w) => w.kind === "overlap");
    expect(overlap).toBeDefined();
    expect(edit.obstacles?.map((o) => o.id)).toContain((overlap as { with?: string }).with);
  });

  it("sin invadir a nadie no hay aviso de solape", async () => {
    const { result, edit } = await exportEdit("Servicios y más");
    expect(result.warningsByEdit[edit.id]?.some((w) => w.kind === "overlap") ?? false).toBe(false);
  });

  it("dos ediciones cuyo texto nuevo se pisa entre si se avisan mutuamente", async () => {
    const bytes = await singleLinePage();
    const box = { x: 40, y: 95, width: 120, height: 24 };
    const base = {
      pageIndex: 0,
      box,
      fontSize: 20,
      color: "#000000",
      align: "left" as const,
      fontKey: "helvetica" as const,
      bold: false,
      italic: false,
      rotation: 0,
      cover: { color: null, padding: 0 },
    };
    const result = await applyTextEdits(bytes, [
      { ...base, id: "a", text: "Uno" },
      { ...base, id: "b", text: "Dos", box: { ...box, x: 50 } },
    ]);
    expect(result.warningsByEdit.a).toContainEqual({ kind: "overlap", with: "b" });
    expect(result.warningsByEdit.b).toContainEqual({ kind: "overlap", with: "a" });
  });

  it("la palabra mas ancha que la PAGINA si se parte (unico caso)", async () => {
    const bytes = await singleLinePage();
    const box = { x: 40, y: 20, width: 80, height: 24 };
    const result = await applyTextEdits(bytes, [
      {
        id: "w",
        pageIndex: 0,
        box,
        text: "W".repeat(60),
        fontSize: 20,
        color: "#000000",
        align: "left",
        fontKey: "helvetica",
        bold: false,
        italic: false,
        rotation: 0,
        cover: { color: null, padding: 0 },
      },
    ]);
    const pdfjs = await getPdfjsLegacy();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(result.bytes), verbosity: 0 }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items.flatMap((item) =>
      "str" in item && item.str.startsWith("W") ? [item] : [],
    );
    await doc.loadingTask.destroy();
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) expect(item.width).toBeLessThanOrEqual(400.5);
  });
});

describe("B-mayor 3 — fondo no uniforme sin aviso", () => {
  const W = 160;
  const H = 60;
  function fill(fn: (x: number, y: number) => [number, number, number]): RgbaImage {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const [r, g, b] = fn(x, y);
        const o = (y * W + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    return { data, width: W, height: H };
  }
  const box = { x: 40, y: 20, width: 80, height: 20 };

  it("degradado suave de (10,0,10) a lo ancho: NO uniforme (antes: uniforme)", () => {
    const image = fill((x) => [240 + Math.round((x / (W - 1)) * 10), 240, 240 + Math.round((x / (W - 1)) * 10)]);
    const sample = sampleBackgroundColor(image, box);
    expect(sample.uniform).toBe(false);
    expect(sample.sideDelta).toBeGreaterThan(5);
  });

  it("degradado vertical suave tambien", () => {
    const shade = (y: number) => 225 + Math.round((y / (H - 1)) * 20);
    const image = fill((_x, y) => [shade(y), shade(y), shade(y)]);
    expect(sampleBackgroundColor(image, box).uniform).toBe(false);
  });

  it("rayado diagonal #ddd/#fff: NO uniforme (antes: uniforme)", () => {
    const image = fill((x, y) => ((x + y) % 12 < 6 ? [221, 221, 221] : [255, 255, 255]));
    const sample = sampleBackgroundColor(image, box);
    expect(sample.uniform).toBe(false);
    expect(sample.outliers).toBeGreaterThan(0.2);
  });

  it("foto simulada (ruido + manchas): NO uniforme", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
    const image = fill((x, y) => {
      const base = 120 + 60 * Math.sin(x / 9) * Math.cos(y / 7);
      return [base + rnd() * 0.15, base + rnd() * 0.15, base + rnd() * 0.15];
    });
    expect(sampleBackgroundColor(image, box).uniform).toBe(false);
  });

  it("fondo plano (blanco, crema y oscuro) SI es uniforme", () => {
    for (const color of [[255, 255, 255], [250, 245, 225], [20, 24, 40]] as const) {
      const sample = sampleBackgroundColor(fill(() => [...color]), box);
      expect(sample.uniform, color.join(",")).toBe(true);
      expect(sample.sideDelta).toBe(0);
    }
  });

  it("falso positivo: unos trazos de texto vecino en el anillo NO marcan el fondo", () => {
    const image = fill(() => [255, 255, 255]);
    const data = image.data as Uint8ClampedArray;
    // Tres colas de letras (1 px de ancho, 3 de alto) rozando el borde superior.
    for (const x of [45, 70, 101]) {
      for (let y = 17; y < 20; y += 1) {
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
    const sample = sampleBackgroundColor(image, box);
    expect(sample.color).toBe("#ffffff");
    expect(sample.uniform).toBe(true);
  });

  it("PDF real: parrafo denso de 5 lineas sobre blanco -> el bloque se lee liso; con degradado, no", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.TimesRoman);
    const page = document.addPage([400, 300]);
    const lines = [
      "Primera linea del parrafo con texto normal y acentos",
      "Segunda linea del parrafo con texto normal y colas gjpqy",
      "Tercera linea del parrafo con texto normal y mas texto",
      "Cuarta linea del parrafo con texto normal gypsy",
      "Quinta linea corta.",
    ];
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 250 - i * 14.4, size: 12, font }));
    const plain = await save(document);
    const [flat] = await renderPages(plain, SCALE);
    for (const block of await extractBlocks(plain)) {
      expect(deleteEdit(block, flat).uniform, block.text.slice(0, 20)).toBe(true);
    }

    // Mismo texto sobre un degradado de (14,0,14) en 400 pt: el bloque (≈300 pt de ancho) lo ve.
    const gradient = await PDFDocument.create();
    const gfont = await gradient.embedFont(StandardFonts.TimesRoman);
    const gpage = gradient.addPage([400, 300]);
    for (let x = 0; x < 400; x += 4) {
      const t = x / 400;
      gpage.drawRectangle({ x, y: 0, width: 4, height: 300, color: rgb((240 + 14 * t) / 255, 240 / 255, (240 + 14 * t) / 255) });
    }
    lines.forEach((line, i) => gpage.drawText(line, { x: 40, y: 250 - i * 14.4, size: 12, font: gfont }));
    const withGradient = await save(gradient);
    const [raster] = await renderPages(withGradient, SCALE);
    const [block] = await extractBlocks(withGradient);
    expect(deleteEdit(block, raster).uniform).toBe(false);
  });
});

describe("D12/D13 — Liberation 2.x real: Serif y Mono ya no caen a Sans", () => {
  async function fontFileSizes(bytes: Uint8Array): Promise<number[]> {
    const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const sizes: number[] = [];
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const ref = object.get(PDFName.of("FontFile2")) ?? object.get(PDFName.of("FontFile3"));
      const stream = ref ? loaded.context.lookup(ref) : undefined;
      if (stream instanceof PDFRawStream) sizes.push(stream.getContentsSize());
    }
    return sizes;
  }

  it("cada familia embebe un subconjunto de pocos KB (frente a ~400 KB del TTF)", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 200]);
    const bytes = await save(document);
    for (const fontKey of ["liberation-sans", "liberation-serif", "liberation-mono"] as const) {
      const result = await applyTextEdits(bytes, [
        {
          id: "e",
          pageIndex: 0,
          box: { x: 20, y: 100, width: 250, height: 24 },
          text: "Hola mundo, Привет Ωmega",
          fontSize: 14,
          color: "#000000",
          align: "left",
          fontKey,
          bold: false,
          italic: false,
          rotation: 0,
          cover: { color: null, padding: 0 },
        },
      ]);
      const sizes = await fontFileSizes(result.bytes);
      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toBeLessThan(40_000);
      expect(result.warnings.some((w) => w.kind === "glyph-missing")).toBe(false);
      expect(result.warnings.some((w) => w.kind === "font-substituted")).toBe(false);
    }
  });
});

describe("D14 — aplanar descarta formularios y marcadores: se avisa", () => {
  const rasterizer = async (): Promise<PageRasterizer> => ({
    async rasterize() {
      const canvas = createCanvas(100, 100);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 100, 100);
      return {
        bytes: new Uint8Array(canvas.toBuffer("image/jpeg", 80)),
        format: "jpeg",
        width: 100,
        height: 100,
      };
    },
    close: async () => {},
  });

  it("PDF con campo de formulario: flatten-drops-forms {forms: true}", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    document.getForm().createTextField("nombre").addToPage(page, { x: 10, y: 10, width: 50, height: 20 });
    const seen: unknown[] = [];
    await flattenPages(await save(document), [0], {
      createRasterizer: rasterizer,
      onWarnings: (warnings) => seen.push(...warnings),
    });
    expect(seen).toEqual([{ kind: "flatten-drops-forms", forms: true, outlines: false }]);
  });

  it("PDF con marcadores: outlines: true", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([100, 100]);
    const context = document.context;
    const item = context.obj({ Title: "Capitulo", Dest: [page.ref, "Fit"] });
    const itemRef = context.register(item);
    const root = context.obj({ Type: "Outlines", First: itemRef, Last: itemRef, Count: 1 });
    item.set(PDFName.of("Parent"), context.register(root));
    document.catalog.set(PDFName.of("Outlines"), context.register(root));
    const seen: unknown[] = [];
    await flattenPages(await save(document), [0], {
      createRasterizer: rasterizer,
      onWarnings: (warnings) => seen.push(...warnings),
    });
    expect(seen).toEqual([{ kind: "flatten-drops-forms", forms: false, outlines: true }]);
  });

  it("PDF sencillo: ningun aviso", async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    let called = false;
    await flattenPages(await save(document), [0], {
      createRasterizer: rasterizer,
      onWarnings: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Ronda 2 (A2): N4 vecino pegado, N7 Liberation propia, N8 numeros no finitos
 * ------------------------------------------------------------------ */

describe("N4 — vecino pegado al anillo de cobertura", () => {
  async function stackedPage(gap: number, background: [number, number, number]) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 200]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 200, color: rgb(...background) });
    page.drawText("Linea central a editar", { x: 40, y: 100, size: 14, font });
    // Vecino 9 pt: su ascendente queda `gap` pt bajo la linea de descendentes de la central (y = 97,1).
    page.drawText("VECINO DEBAJO TOCANDO", { x: 40, y: 97.1 - gap - 0.72 * 9, size: 9, font });
    return save(document);
  }

  /** Lo que hace la app: extent con vecinos, anillo fuera de el, tinta de los vecinos ignorada. */
  function appSample(raster: Raster, block: TextBlock, others: TextBlock[]) {
    const metrics = makeMetrics(geometryFromPdfJsPage(raster.page), raster.width / SCALE);
    const neighbors = others.map((o) => ({ id: o.id, box: o.box }));
    const k = raster.width / metrics.cssWidth;
    const px = (box: TextBlock["box"]) => {
      const r = userBoxToPx(metrics, box);
      return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
    };
    return {
      neighbors,
      sample: sampleCanvasBackground(
        contextOf(raster),
        { width: raster.width, height: raster.height },
        px(blockCoverExtent(block, 1, neighbors)),
        undefined,
        neighbors.map((n) => px(n.box)),
      ),
      sampleLegacy: sampleCanvasBackground(
        contextOf(raster),
        { width: raster.width, height: raster.height },
        px(blockCoverExtent(block, 1)),
      ),
    };
  }

  it.each([0, 1, 2, 3, 5])(
    "vecino a %i pt: el fondo se lee liso, el vecino conserva toda su tinta y la linea central se borra",
    async (gap) => {
      for (const background of [[1, 1, 1], [0.953, 0.957, 0.965], [0.992, 0.902, 0.541]] as const) {
        const bytes = await stackedPage(gap, [...background]);
        const [before] = await renderPages(bytes, SCALE);
        const blocks = await extractBlocks(bytes);
        const main = blocks.find((b) => b.text === "Linea central a editar");
        const neighbor = blocks.find((b) => b.text.startsWith("VECINO"));
        expect(main && neighbor, `bloques separados a ${gap} pt`).toBeTruthy();
        const { neighbors, sample } = appSample(before, main!, [neighbor!]);
        expect(sample?.uniform, `uniform a ${gap} pt`).toBe(true);

        const edit = draftEditForBlock(main!, {
          coverColor: sample!.color,
          coverUniform: sample!.uniform,
          layout: pageLayoutOf(
            makeMetrics(geometryFromPdfJsPage(before.page), before.width / SCALE),
            blocks,
          ),
          overrides: { text: "" },
        });
        expect(neighbors).toHaveLength(1);
        const result = await applyTextEdits(bytes, [edit]);
        expect(result.warnings.some((w) => w.kind === "background-not-uniform")).toBe(false);
        const [after] = await renderPages(result.bytes, SCALE);

        // Tinta del vecino: pixeles que cambian dentro de su caja, por debajo de la caja de la linea central.
        const below = regionOfBox(before, {
          x: 0,
          y: 0,
          width: 400,
          height: main!.box.y - 0.05,
        });
        let changed = 0;
        for (let y = Math.floor(below.y0); y < Math.ceil(below.y1); y += 1) {
          for (let x = 0; x < before.width; x += 1) {
            const o = (y * before.width + x) * 4;
            if (Math.abs(before.data[o] - after.data[o]) > 8) changed += 1;
          }
        }
        // Antes del arreglo: 124 px del vecino borrados a 0 pt, y fondo «no liso» de 0 a 2 pt.
        expect(changed, `px del vecino alterados a ${gap} pt`).toBe(0);
        expect(countPixels(after, isDarkPixel, regionOfBox(before, main!.box))).toBe(0);
      }
    },
  );

  it("control: sin vecinos conocidos (comportamiento anterior) la cobertura se comia la tinta del vecino a 0 pt", async () => {
    const bytes = await stackedPage(0, [1, 1, 1]);
    const [before] = await renderPages(bytes, SCALE);
    const blocks = await extractBlocks(bytes);
    const main = blocks.find((b) => b.text === "Linea central a editar")!;
    const neighbor = blocks.find((b) => b.text.startsWith("VECINO"))!;
    const edit = draftEditForBlock(main, { coverColor: "#ffffff", overrides: { text: "" } });
    const [after] = await renderPages((await applyTextEdits(bytes, [edit])).bytes, SCALE);
    const region = regionOfBox(before, neighbor.box);
    // 2103 -> 1479 px de tinta del vecino sin la lista de vecinos.
    expect(countPixels(after, isDarkPixel, region)).toBeLessThan(countPixels(before, isDarkPixel, region));
  });

  it("la cobertura se recorta contra la caja del vecino: ni el margen ni la ampliacion lo pisan", async () => {
    const bytes = await stackedPage(0, [1, 1, 1]);
    const blocks = await extractBlocks(bytes);
    const main = blocks.find((b) => b.text === "Linea central a editar")!;
    const neighbor = blocks.find((b) => b.text.startsWith("VECINO"))!;
    const edit = draftEditForBlock(main, {
      coverColor: "#ffffff",
      layout: pageLayoutOf(makeMetrics(geometryFromPdfJsPage({ view: [0, 0, 400, 200], rotate: 0 }), 400), blocks),
    });
    const shape = coverShape(edit)!;
    expect(shape.kind).toBe("rect");
    const rect = (shape as { box: TextBlock["box"] }).box;
    // Sin vecino la cobertura llegaria a ~3,5 pt + 1 pt de margen por debajo de la linea base...
    const free = coverShape({ ...edit, obstacles: [] }) as { box: TextBlock["box"] };
    expect(free.box.y).toBeLessThan(rect.y);
    // ...con vecino se queda en la caja original del bloque (nunca mas abajo).
    expect(rect.y).toBeGreaterThanOrEqual(main.box.y - 1e-6);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(main.box.y + main.box.height - 1e-6);
    expect(neighbor.box.y).toBeLessThan(rect.y + 3);
  });

  it("el muestreo ignora la tinta de un bloque vecino conocido (y sin la lista, la ve como no liso)", () => {
    const W = 120;
    const H = 60;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    // «Vecino»: tinta oscura pegada a la caja por debajo (filas 41-47).
    for (let y = 41; y < 48; y += 1) {
      for (let x = 30; x < 90; x += 1) {
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 20;
      }
    }
    const ctx = { getImageData: (x: number, y: number, w: number, h: number) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy += 1) for (let xx = 0; xx < w; xx += 1) {
        const s = ((y + yy) * W + x + xx) * 4;
        out.set(data.subarray(s, s + 4), (yy * w + xx) * 4);
      }
      return { data: out, width: w, height: h };
    } };
    const box = { x: 30, y: 15, width: 60, height: 25 };
    expect(sampleCanvasBackground(ctx, { width: W, height: H }, box)?.uniform).toBe(false);
    const ignored = sampleCanvasBackground(ctx, { width: W, height: H }, box, undefined, [
      { x: 28, y: 41, width: 64, height: 10 },
    ]);
    expect(ignored?.uniform).toBe(true);
    expect(ignored?.color).toBe("#ffffff");
  });
});

describe("N7 — Liberation propia: sin font-substituted y nombre de subconjunto", () => {
  it.each([
    "LiberationSans-8450",
    "LiberationSans",
    "ABCDEF+LiberationSans-Bold-2000",
    "CZZZZZ+LiberationSans",
  ])("%s -> liberation-sans exacta", async (name) => {
    const { mapSourceFont } = await import("@/lib/pdf/editFonts");
    expect(mapSourceFont({ pdfName: name, family: "sans", bold: false, italic: false, subset: true, embedded: true, symbolic: false, type3: false })).toEqual({ key: "liberation-sans", exact: true });
  });

  it("LiberationSerif / LiberationMono con sufijo numerico tambien", async () => {
    const { mapSourceFont } = await import("@/lib/pdf/editFonts");
    const base = { bold: false, italic: false, subset: true, embedded: true, symbolic: false, type3: false };
    expect(mapSourceFont({ ...base, pdfName: "LiberationSerif-BoldItalic-1234", family: "serif" })).toEqual({ key: "liberation-serif", exact: true });
    expect(mapSourceFont({ ...base, pdfName: "LiberationMono-77", family: "mono" })).toEqual({ key: "liberation-mono", exact: true });
    // Una fuente parecida pero distinta sigue siendo aproximada.
    expect(mapSourceFont({ ...base, pdfName: "LiberationSansNarrow-1", family: "sans" }).exact).toBe(false);
  });

  it("de punta a punta: redibujar un bloque ya en Liberation Sans no emite font-substituted", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 120]);
    const first = await applyTextEdits(await save(document), [
      {
        id: "n",
        pageIndex: 0,
        box: { x: 20, y: 60, width: 250, height: 24 },
        text: "Texto en Liberation Sans",
        fontSize: 14,
        color: "#000000",
        align: "left",
        fontKey: "liberation-sans",
        bold: false,
        italic: false,
        rotation: 0,
        cover: { color: null, padding: 0 },
      },
    ]);
    const blocks = await extractBlocks(first.bytes);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].font.pdfName).toMatch(/^[A-Z]{6}\+LiberationSans$/);
    const edit = draftEditForBlock(blocks[0], { coverColor: "#ffffff", overrides: { text: "Otro texto" } });
    expect(edit.fontKey).toBe("liberation-sans");
    const second = await applyTextEdits(first.bytes, [edit]);
    expect(second.warnings.some((w) => w.kind === "font-substituted")).toBe(false);
  });

  it("subsetFontName: ABCDEF+NombrePostScript, determinista y distinto por estilo", async () => {
    const { subsetFontName } = await import("@/lib/pdf/editTextExport");
    const a = subsetFontName("liberation-sans", false, false);
    expect(a).toMatch(/^[A-Z]{6}\+LiberationSans$/);
    expect(subsetFontName("liberation-sans", false, false)).toBe(a);
    const bold = subsetFontName("liberation-sans", true, false);
    expect(bold).toMatch(/^[A-Z]{6}\+LiberationSans-Bold$/);
    expect(bold.slice(0, 6)).not.toBe(a.slice(0, 6));
    expect(subsetFontName("liberation-serif", true, true)).toMatch(/\+LiberationSerif-BoldItalic$/);
  });
});

describe("N8 — numeros no finitos: se omite la edicion, nunca se lanza", () => {
  const good: TextEdit = {
    id: "ok",
    pageIndex: 0,
    box: { x: 20, y: 20, width: 200, height: 24 },
    coverBox: { x: 20, y: 20, width: 200, height: 24 },
    text: "Bueno",
    fontSize: 14,
    color: "#0000ff",
    align: "left",
    fontKey: "helvetica",
    bold: false,
    italic: false,
    rotation: 0,
    cover: { color: "#ffffff", padding: 1 },
  };
  const BAD_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  async function blankPage() {
    const document = await PDFDocument.create();
    document.addPage([300, 120]);
    return save(document);
  }

  type Mutation = [string, (edit: TextEdit, value: number) => TextEdit, number[]];
  const mutations: Mutation[] = [
    ["box.x", (e, v) => ({ ...e, box: { ...e.box, x: v } }), BAD_NUMBERS],
    ["box.y", (e, v) => ({ ...e, box: { ...e.box, y: v } }), BAD_NUMBERS],
    ["box.width", (e, v) => ({ ...e, box: { ...e.box, width: v } }), [...BAD_NUMBERS, -5, 0]],
    ["box.height", (e, v) => ({ ...e, box: { ...e.box, height: v } }), [...BAD_NUMBERS, -5, 0]],
    ["coverBox.x", (e, v) => ({ ...e, coverBox: { ...e.coverBox!, x: v } }), BAD_NUMBERS],
    ["coverBox.width", (e, v) => ({ ...e, coverBox: { ...e.coverBox!, width: v } }), [...BAD_NUMBERS, -1, 0]],
    ["coverBox.height", (e, v) => ({ ...e, coverBox: { ...e.coverBox!, height: v } }), [...BAD_NUMBERS, -1, 0]],
    [
      "coverOriented.width",
      (e, v) => ({ ...e, coverOriented: { origin: { x: 1, y: 1 }, width: v, height: 5, rotation: 30 } }),
      [...BAD_NUMBERS, -1, 0],
    ],
    [
      "coverOriented.origin",
      (e, v) => ({ ...e, coverOriented: { origin: { x: v, y: 1 }, width: 5, height: 5, rotation: 30 } }),
      BAD_NUMBERS,
    ],
    [
      "coverOriented.rotation",
      (e, v) => ({ ...e, coverOriented: { origin: { x: 1, y: 1 }, width: 5, height: 5, rotation: v } }),
      BAD_NUMBERS,
    ],
    ["fontSize", (e, v) => ({ ...e, fontSize: v }), [...BAD_NUMBERS, -3, 0]],
    ["rotation", (e, v) => ({ ...e, rotation: v }), BAD_NUMBERS],
    ["lineHeight", (e, v) => ({ ...e, lineHeight: v }), BAD_NUMBERS],
    ["cover.padding", (e, v) => ({ ...e, cover: { ...e.cover, padding: v } }), BAD_NUMBERS],
    ["pageIndex", (e, v) => ({ ...e, pageIndex: v }), [...BAD_NUMBERS, -1, 0.5, 99]],
    [
      "obstacles.box",
      (e, v) => ({ ...e, obstacles: [{ id: "x", box: { x: v, y: 0, width: 5, height: 5 } }] }),
      BAD_NUMBERS,
    ],
  ];

  it.each(mutations)("%s no finito o invalido: la edicion se omite con aviso y el resto se dibuja", async (name, mutate, values) => {
    const bytes = await blankPage();
    for (const value of values) {
      const bad = { ...mutate(good, value), id: "bad" };
      if (name === "pageIndex" && value === 0.5) bad.pageIndex = 0.5;
      const result = await applyTextEdits(bytes, [bad, { ...good, id: "fine" }]);
      expect(result.skipped, `${name}=${value}`).toEqual(["bad"]);
      expect(result.warningsByEdit.bad?.[0]?.kind).toBe("edit-skipped");
      expect(result.warningsByEdit.fine?.some((w) => w.kind === "edit-skipped") ?? false).toBe(false);
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getPageCount()).toBe(1);
    }
  });

  it("texto que no es cadena tambien se omite (cast), y valores validos raros NO se omiten", async () => {
    const bytes = await blankPage();
    const result = await applyTextEdits(bytes, [
      { ...good, id: "t", text: undefined as unknown as string },
      { ...good, id: "neg-x", box: { ...good.box, x: -50 } },
      { ...good, id: "neg-rot", rotation: -45 },
      { ...good, id: "neg-pad", cover: { color: "#ffffff", padding: -2 } },
      { ...good, id: "neg-lh", lineHeight: -1 },
    ]);
    expect(result.skipped).toEqual(["t"]);
  });

  it("la sesion filtra antes: ni add, ni move/resize/restyle admiten numeros no finitos", async () => {
    const { applyOp, createEditSession, textItem, hasFiniteGeometry } = await import("@/app/edit-pdf/editSession");
    let session = createEditSession();
    for (const mutate of mutations) {
      for (const value of mutate[2].filter((v) => !Number.isInteger(v) || mutate[0] !== "pageIndex")) {
        const bad = mutate[1](good, value);
        if (mutate[0] === "pageIndex") continue;
        const next = applyOp(session, { type: "add", item: textItem({ ...bad, id: "bad" }) });
        if (!hasFiniteGeometry(bad)) expect(next.items, `${mutate[0]}=${value}`).toHaveLength(0);
      }
    }
    session = applyOp(session, { type: "add", item: textItem(good) });
    expect(session.items).toHaveLength(1);
    const before = session.items;
    session = applyOp(session, { type: "move", id: "ok", dx: Number.NaN, dy: 1 });
    session = applyOp(session, { type: "resize", id: "ok", box: { x: 1, y: Number.POSITIVE_INFINITY, width: 5, height: 5 } });
    session = applyOp(session, { type: "restyle", id: "ok", patch: { fontSize: Number.NaN, rotation: Number.POSITIVE_INFINITY, lineHeight: Number.NaN } });
    expect(session.items).toEqual(before);
  });
});

describe("N3 — cubrir texto girado no borra el vecino que lo cruza", () => {
  async function crossedPage() {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 220]);
    page.drawText("Texto girado", { x: 60, y: 60, size: 16, font, rotate: degrees(40) });
    page.drawText("Vecino medio libre", { x: 92, y: 104, size: 10, font });
    return save(document);
  }

  async function setup() {
    const bytes = await crossedPage();
    const [before] = await renderPages(bytes, SCALE);
    const blocks = await extractBlocks(bytes);
    const rotated = blocks.find((b) => Math.abs(b.rotation - 40) < 1)!;
    const neighbor = blocks.find((b) => b.text.startsWith("Vecino"))!;
    expect(rotated && neighbor).toBeTruthy();
    const metrics = makeMetrics(geometryFromPdfJsPage(before.page), before.width / SCALE);
    const edit = draftEditForBlock(rotated, {
      coverColor: "#ffffff",
      layout: pageLayoutOf(metrics, blocks),
      overrides: { text: "" },
    });
    return { bytes, before, rotated, neighbor, edit };
  }

  it("el vecino conserva toda su tinta, se avisa cover-overlaps-neighbor y el resto del texto girado desaparece", async () => {
    const { bytes, before, rotated, neighbor, edit } = await setup();
    expect(edit.coverOriented).toBeDefined();
    expect(edit.obstacles?.map((o) => o.id)).toContain(neighbor.id);

    const result = await applyTextEdits(bytes, [edit]);
    const [after] = await renderPages(result.bytes, SCALE);
    const region = regionOfBox(before, neighbor.box);
    const inkBefore = countPixels(before, isDarkPixel, region);
    expect(inkBefore).toBeGreaterThan(500);
    // Antes del arreglo la cobertura borraba parte de esa tinta (ver el control).
    expect(countPixels(after, isDarkPixel, region)).toBeGreaterThanOrEqual(inkBefore);
    // Aviso al usuario: bajo el hueco queda un resto del texto original.
    expect(result.warningsByEdit[edit.id]).toContainEqual({
      kind: "cover-overlaps-neighbor",
      with: neighbor.id,
    });
    // Fuera del hueco el texto girado se cubre: casi toda la tinta restante es la del vecino.
    const totalAfter = countPixels(after, isDarkPixel);
    const rotatedInkBefore = countPixels(before, isDarkPixel) - inkBefore;
    expect(totalAfter - inkBefore).toBeLessThan(rotatedInkBefore * 0.25);
    expect(rotated.id).not.toBe(neighbor.id);
  });

  it("control: sin recortar contra el vecino (comportamiento anterior) su tinta se perdia", async () => {
    const { bytes, before, neighbor, edit } = await setup();
    const legacy: TextEdit = { ...edit, obstacles: [] };
    const result = await applyTextEdits(bytes, [legacy]);
    const [after] = await renderPages(result.bytes, SCALE);
    const region = regionOfBox(before, neighbor.box);
    expect(countPixels(after, isDarkPixel, region)).toBeLessThan(countPixels(before, isDarkPixel, region) * 0.9);
    expect(result.warningsByEdit[edit.id]?.some((w) => w.kind === "cover-overlaps-neighbor") ?? false).toBe(false);
  });

  it("sin vecino que cruce no hay hueco ni aviso", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 220]);
    page.drawText("Texto girado", { x: 60, y: 60, size: 16, font, rotate: degrees(40) });
    page.drawText("Vecino lejano", { x: 200, y: 190, size: 10, font });
    const bytes = await save(document);
    const blocks = await extractBlocks(bytes);
    const rotated = blocks.find((b) => Math.abs(b.rotation - 40) < 1)!;
    const edit = draftEditForBlock(rotated, {
      coverColor: "#ffffff",
      layout: pageLayoutOf(
        makeMetrics(geometryFromPdfJsPage({ view: [0, 0, 300, 220], rotate: 0 }), 300),
        blocks,
      ),
      overrides: { text: "" },
    });
    const shape = coverShape(edit);
    expect(shape?.kind === "oriented" && shape.holes).toEqual([]);
    const result = await applyTextEdits(bytes, [edit]);
    expect(result.warnings.some((w) => w.kind === "cover-overlaps-neighbor")).toBe(false);
    const [after] = await renderPages(result.bytes, SCALE);
    expect(countPixels(after, isDarkPixel, regionOfBox(after, { x: 50, y: 50, width: 120, height: 100 }))).toBe(0);
  });
});

describe("A3 — solape de texto girado por su rectangulo orientado, no por la envolvente", () => {
  async function diagonal(neighborAt: { x: number; y: number }) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([500, 400]);
    page.drawText("Diagonal text that is quite long", { x: 80, y: 60, size: 16, font, rotate: degrees(40) });
    page.drawText("VECINO-LIBRE", { x: neighborAt.x, y: neighborAt.y, size: 9, font });
    const bytes = await save(document);
    const blocks = await extractBlocks(bytes);
    const rotated = blocks.find((b) => Math.abs(b.rotation - 40) < 1)!;
    const neighbor = blocks.find((b) => b.text.startsWith("VECINO"))!;
    expect(rotated && neighbor).toBeTruthy();
    const edit = draftEditForBlock(rotated, {
      coverColor: "#ffffff",
      layout: pageLayoutOf(
        makeMetrics(geometryFromPdfJsPage({ view: [0, 0, 500, 400], rotate: 0 }), 500),
        blocks,
      ),
      overrides: { text: "Reemplazo corto" },
    });
    return { bytes, edit, neighbor };
  }
  const intersects = (a: TextBlock["box"], b: TextBlock["box"]) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("un vecino dentro de la ENVOLVENTE pero lejos del texto girado no avisa overlap", async () => {
    const { bytes, edit, neighbor } = await diagonal({ x: 82, y: 142 });
    // Condicion que daba el falso positivo: la caja del texto girado contiene al vecino.
    expect(intersects(edit.box, neighbor.box)).toBe(true);
    expect(edit.obstacles?.map((o) => o.id)).toContain(neighbor.id);
    const result = await applyTextEdits(bytes, [edit]);
    expect(result.warningsByEdit[edit.id]?.some((w) => w.kind === "overlap") ?? false).toBe(false);
    expect(result.warnings.some((w) => w.kind === "cover-overlaps-neighbor")).toBe(false);
  });

  it("un vecino que el texto nuevo SI cruza sigue avisando overlap", async () => {
    const { bytes, edit, neighbor } = await diagonal({ x: 150, y: 124 });
    const result = await applyTextEdits(bytes, [edit]);
    expect(result.warningsByEdit[edit.id]).toContainEqual({ kind: "overlap", with: neighbor.id });
  });

  it("polygonsOverlap: dos rectangulos del eje se comportan como antes; uno girado compara su forma real", async () => {
    const { polygonsOverlap, boxPolygon } = await import("@/lib/pdf/editCover");
    const a = boxPolygon({ x: 0, y: 0, width: 10, height: 10 });
    expect(polygonsOverlap(a, boxPolygon({ x: 5, y: 5, width: 10, height: 10 }), 0.75)).toBe(true);
    expect(polygonsOverlap(a, boxPolygon({ x: 9.5, y: 0, width: 10, height: 10 }), 0.75)).toBe(false);
    // Rombo (cuadrado girado 45 grados) cuya envolvente contiene el punto (1,1), que el rombo no.
    const diamond = [
      { x: 5, y: -2 },
      { x: 12, y: 5 },
      { x: 5, y: 12 },
      { x: -2, y: 5 },
    ];
    const corner = boxPolygon({ x: -2, y: -2, width: 2, height: 2 });
    expect(polygonsOverlap(diamond, corner, 0)).toBe(false);
    expect(polygonsOverlap(diamond, boxPolygon({ x: 4, y: 4, width: 2, height: 2 }), 0)).toBe(true);
  });
});

describe("A3 — vecino ENCIMA a 0 pt: la cobertura propia tambien se recorta", () => {
  async function stackedAbove(gap: number) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([400, 200]);
    page.drawText("Linea central a editar", { x: 40, y: 100, size: 14, font });
    page.drawText("VECINO ENCIMA TOCANDO", { x: 40, y: 110.08 + gap + 0.21 * 9, size: 9, font });
    const bytes = await save(document);
    const blocks = await extractBlocks(bytes);
    return {
      bytes,
      blocks,
      main: blocks.find((b) => b.text === "Linea central a editar")!,
      neighbor: blocks.find((b) => b.text.startsWith("VECINO"))!,
    };
  }

  it.each([0, 1, 2])("hueco %i pt: el vecino conserva su tinta y la linea editada desaparece", async (gap) => {
    const { bytes, blocks, main, neighbor } = await stackedAbove(gap);
    const [before] = await renderPages(bytes, SCALE);
    const metrics = makeMetrics(geometryFromPdfJsPage(before.page), before.width / SCALE);
    const edit = draftEditForBlock(main, {
      coverColor: "#ffffff",
      layout: pageLayoutOf(metrics, blocks),
      overrides: { text: "" },
    });
    // La cobertura no entra en la caja del vecino mas alla de la tinta propia.
    expect(edit.coverBox!.y + edit.coverBox!.height).toBeLessThanOrEqual(
      Math.max(neighbor.box.y, 100 + 0.72 * 14) + 1e-6,
    );
    const [after] = await renderPages((await applyTextEdits(bytes, [edit])).bytes, SCALE);
    const region = regionOfBox(before, neighbor.box);
    const inkBefore = countPixels(before, isDarkPixel, region);
    // Antes: a 0 pt se perdian ~600 px (30 %) de las mayusculas del vecino; ahora unos pocos del suavizado.
    expect(inkBefore - countPixels(after, isDarkPixel, region)).toBeLessThanOrEqual(inkBefore * 0.01);
    expect(countPixels(after, isDarkPixel, regionOfBox(before, { ...main.box, y: main.box.y - 1, height: 11.5 }))).toBe(0);
  });

  it("control: con la caja nominal de pdf.js (comportamiento anterior) a 0 pt el vecino perdia tinta", async () => {
    const { bytes, main, neighbor } = await stackedAbove(0);
    const [before] = await renderPages(bytes, SCALE);
    const legacy = draftEditForBlock(main, { coverColor: "#ffffff", overrides: { text: "" } });
    const [after] = await renderPages(
      (await applyTextEdits(bytes, [{ ...legacy, coverBox: { ...main.box } }])).bytes,
      SCALE,
    );
    const region = regionOfBox(before, neighbor.box);
    expect(countPixels(after, isDarkPixel, region)).toBeLessThan(countPixels(before, isDarkPixel, region) * 0.9);
  });
});

/* ------------------------------------------------------------------ *
 * B3 N4: bordes de celda, invariancia por zoom y cobertura que no los borra
 * ------------------------------------------------------------------ */

describe("B3 N4 — borde de celda: misma decision a cualquier zoom y la cobertura NO lo borra", () => {
  const ZOOMS = [1, 1.5, 2, 3]; // px de canvas por punto PDF (100/150/200/300 %)
  const COLORS: Record<string, [number, number, number]> = {
    negro: [0, 0, 0],
    gris: [0.55, 0.55, 0.55],
    azul: [0.12, 0.31, 0.78],
  };

  async function cell(padding: number, width: number, color: [number, number, number]) {
    const plain = await PDFDocument.create();
    const font0 = await plain.embedFont(StandardFonts.Helvetica);
    plain.addPage([300, 160]).drawText("Celda de tabla", { x: 60, y: 80, size: 12, font: font0 });
    const probe = (await extractBlocks(await save(plain)))[0];
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 160]);
    page.drawText("Celda de tabla", { x: 60, y: 80, size: 12, font });
    const half = width / 2;
    const box = probe.box;
    page.drawRectangle({
      x: box.x - padding - half,
      y: box.y - padding - half,
      width: box.width + 2 * (padding + half),
      height: box.height + 2 * (padding + half),
      borderWidth: width,
      borderColor: rgb(...color),
    });
    const bytes = await save(document);
    const block = (await extractBlocks(bytes)).find((b) => b.text === "Celda de tabla")!;
    return { bytes, block, borderOuter: padding + width };
  }

  /** Muestreo como lo hace la app, a la escala de canvas `scale` (px/pt). */
  async function sampleAt(bytes: Uint8Array, block: TextBlock, scale: number) {
    const [raster] = await renderPages(bytes, scale);
    const metrics = makeMetrics(geometryFromPdfJsPage(raster.page), raster.width);
    const k = raster.width / metrics.cssWidth;
    const toCanvas = (b: TextBlock["box"]) => {
      const r = userBoxToPx(metrics, b);
      return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
    };
    const sample = sampleCanvasBackground(
      contextOf(raster),
      { width: raster.width, height: raster.height },
      toCanvas(blockCoverExtent(block, 1)),
      undefined,
      [],
      { pxPerPt: scale, inner: toCanvas(block.box) },
    )!;
    const clip = sample.lines ? lineStripsToUserBoxes(metrics, sample.lines, k, scale, 0.5) : [];
    return { raster, sample, clip };
  }

  /** Pixeles del borde que cambian al exportar (render a 3 px/pt). */
  async function borderDamage(bytes: Uint8Array, block: TextBlock, clip: TextBlock["box"][], outer: number) {
    const edit = draftEditForBlock(block, { coverColor: "#ffffff", coverClip: clip, overrides: { text: "" } });
    const [before] = await renderPages(bytes, 3);
    const [after] = await renderPages((await applyTextEdits(bytes, [edit])).bytes, 3);
    const band = regionOfBox(before, {
      x: block.box.x - outer - 1,
      y: block.box.y - outer - 1,
      width: block.box.width + 2 * (outer + 1),
      height: block.box.height + 2 * (outer + 1),
    });
    const hole = regionOfBox(before, {
      x: block.box.x - 0.3,
      y: block.box.y - 0.3,
      width: block.box.width + 0.6,
      height: block.box.height + 0.6,
    });
    let changed = 0;
    let ink = 0;
    for (let y = Math.floor(band.y0); y < Math.ceil(band.y1); y += 1) {
      for (let x = Math.floor(band.x0); x < Math.ceil(band.x1); x += 1) {
        if (x >= hole.x0 && x < hole.x1 && y >= hole.y0 && y < hole.y1) continue;
        const o = (y * before.width + x) * 4;
        if (before.data[o] < 200 || before.data[o + 1] < 200 || before.data[o + 2] < 200) ink += 1;
        if (Math.abs(before.data[o] - after.data[o]) > 8) changed += 1;
      }
    }
    return { changed, ink };
  }

  it.each(
    [1, 2].flatMap((w) =>
      Object.keys(COLORS).flatMap((c) => [1, 3, 5].map((p) => [w, c, p] as const)),
    ),
  )("borde de %i pt %s con relleno de %i pt: liso a 100/150/200/300 %, 0 px de borde borrados", async (width, colorName, padding) => {
    const { bytes, block, borderOuter } = await cell(padding, width, COLORS[colorName]);
    const decisions: string[] = [];
    let clip: TextBlock["box"][] = [];
    for (const zoom of ZOOMS) {
      const { sample, clip: found } = await sampleAt(bytes, block, zoom);
      decisions.push(`${sample.uniform}/${sample.color}`);
      if (zoom === 3) clip = found;
    }
    // Misma decision a cualquier zoom: borde de celda = fondo liso.
    expect(new Set(decisions).size, decisions.join(" ")).toBe(1);
    expect(decisions[0].startsWith("true/#ffffff")).toBe(true);
    const damage = await borderDamage(bytes, block, clip, borderOuter);
    expect(damage.ink).toBeGreaterThan(50);
    expect(damage.changed, `px de borde alterados (${width} pt ${colorName}, relleno ${padding})`).toBe(0);
  });

  it("control: sin las franjas de borde (comportamiento anterior) la cobertura borraba tramos del borde", async () => {
    let erased = 0;
    for (const [width, padding] of [[1, 1], [2, 1], [1, 3]] as const) {
      const { bytes, block, borderOuter } = await cell(padding, width, COLORS.negro);
      erased += (await borderDamage(bytes, block, [], borderOuter)).changed;
    }
    expect(erased).toBeGreaterThan(200);
  });

  it("lo real sigue avisando a cualquier zoom: banda gruesa, rayado y degradado fuerte", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const bands = document.addPage([300, 160]);
    for (let y = 0; y < 160; y += 8) {
      bands.drawRectangle({ x: 0, y, width: 300, height: 4, color: rgb(0.55, 0.55, 0.55) });
    }
    bands.drawText("Sobre rayas", { x: 60, y: 80, size: 12, font });
    const gradient = document.addPage([300, 160]);
    for (let x = 0; x < 300; x += 3) {
      gradient.drawRectangle({ x, y: 0, width: 3, height: 160, color: rgb(x / 300, 0.2, 1 - x / 300) });
    }
    gradient.drawText("Sobre degradado", { x: 60, y: 80, size: 12, font });
    const bytes = await save(document);
    for (const pageIndex of [0, 1]) {
      const block = (await extractBlocks(bytes, pageIndex))[0];
      for (const zoom of ZOOMS) {
        const [raster] = await renderPages(bytes, zoom).then((all) => [all[pageIndex]]);
        const metrics = makeMetrics(geometryFromPdfJsPage(raster.page), raster.width);
        const k = raster.width / metrics.cssWidth;
        const toCanvas = (b: TextBlock["box"]) => {
          const r = userBoxToPx(metrics, b);
          return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
        };
        const sample = sampleCanvasBackground(
          contextOf(raster),
          { width: raster.width, height: raster.height },
          toCanvas(blockCoverExtent(block, 1)),
          undefined,
          [],
          { pxPerPt: zoom, inner: toCanvas(block.box) },
        );
        expect(sample?.uniform, `pagina ${pageIndex} zoom ${zoom}`).toBe(false);
      }
    }
  });

  it("CoverInfo: sin canvas pintado el muestreo es provisional (null), nunca un «liso» silencioso", () => {
    expect(sampleCanvasBackground(null, { width: 10, height: 10 }, { x: 1, y: 1, width: 2, height: 2 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * A4 D4: borde pegado a la caja de texto (hueco 0): 0 % alterado a cualquier zoom
 * ------------------------------------------------------------------ */

describe("A4 D4 — borde pegado al texto: detectado y respetado a 100/150/200/300 %", () => {
  const ZOOMS = [1, 1.5, 2, 3];
  const COLOR: Record<string, [number, number, number]> = {
    negro: [0, 0, 0],
    gris: [0.5, 0.5, 0.5],
    azul: [0.1, 0.3, 0.8],
  };

  async function page(rule: { y: number; T: number; x0: number; x1: number } | null, color: [number, number, number], withText: boolean) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const p = document.addPage([300, 100]);
    if (rule) p.drawRectangle({ x: rule.x0, y: rule.y, width: rule.x1 - rule.x0, height: rule.T, color: rgb(...color) });
    if (withText) p.drawText("Total a pagar", { x: 100, y: 50, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
    return save(document);
  }
  const lum = (r: Raster, x: number, y: number) => {
    const o = (y * r.width + x) * 4;
    return 0.299 * r.data[o] + 0.587 * r.data[o + 1] + 0.114 * r.data[o + 2];
  };

  /** Lo que hace la app (EditSurface + EditWorkspace.sampleCover + blockDraft) a `zoom` px/pt. */
  async function exportAt(bytes: Uint8Array, zoom: number) {
    const [raster] = await renderPages(bytes, zoom);
    const block = (await extractBlocks(bytes))[0];
    const metrics = makeMetrics(geometryFromPdfJsPage(raster.page), raster.width);
    const k = raster.width / metrics.cssWidth;
    const toCanvas = (b: TextBlock["box"]) => {
      const r = userBoxToPx(metrics, b);
      return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
    };
    const sample = sampleCanvasBackground(
      contextOf(raster),
      { width: raster.width, height: raster.height },
      toCanvas(blockCoverExtent(block, 1)),
      undefined,
      [],
      { pxPerPt: zoom, inner: toCanvas(block.box) },
    )!;
    const clip = sample.lines ? lineStripsToUserBoxes(metrics, sample.lines, k, zoom, 0.5) : [];
    const edit = draftEditForBlock(block, {
      coverColor: sample.color,
      coverUniform: sample.uniform,
      coverClip: clip,
      overrides: { text: "" },
    });
    const out = (await renderPages((await applyTextEdits(bytes, [edit])).bytes, zoom))[0];
    return { sample, out, block };
  }

  it.each([0.25, 0.5, 0.75, 1, 2])(
    "regla de %f pt pegada al texto (hueco 0, 0,25, 0,5 y 1 pt), negro/gris/azul: 0 px alterados y fondo liso a todos los zooms",
    async (T) => {
      const probe = (await extractBlocks(await page(null, COLOR.negro, true)))[0].box;
      for (const [name, color] of Object.entries(COLOR)) {
        for (const gap of [0, 0.25, 0.5, 1]) {
          const rule = { y: probe.y - gap - T, T, x0: probe.x - 20, x1: probe.x + probe.width + 20 };
          const withText = await page(rule, color, true);
          const noText = await page(rule, color, false);
          for (const zoom of ZOOMS) {
            const ref = (await renderPages(noText, zoom))[0];
            const { sample, out } = await exportAt(withText, zoom);
            let lost = 0;
            let ink = 0;
            for (let y = 0; y < out.height; y += 1) {
              for (let x = 0; x < out.width; x += 1) {
                const reference = lum(ref, x, y);
                if (reference < 235) {
                  ink += 1;
                  // Se pierde si el pixel de la regla se aclara mas de un 30 % de lo que le falta para ser fondo.
                  if (lum(out, x, y) - reference > Math.max(12, 0.3 * (255 - reference))) lost += 1;
                }
              }
            }
            const label = `T=${T} ${name} hueco=${gap} zoom=${zoom}`;
            expect(ink, label).toBeGreaterThan(0);
            expect(lost, `px de regla alterados, ${label}`).toBe(0);
            expect(sample.uniform, `fondo liso, ${label}`).toBe(true);
          }
        }
      }
    },
  );

  it("control: sin las franjas de borde (comportamiento anterior) el hueco 0 borraba ~un tercio de la regla a 100 %", async () => {
    const probe = (await extractBlocks(await page(null, COLOR.negro, true)))[0].box;
    const rule = { y: probe.y - 1, T: 1, x0: probe.x - 20, x1: probe.x + probe.width + 20 };
    const withText = await page(rule, COLOR.negro, true);
    const ref = (await renderPages(await page(rule, COLOR.negro, false), 1))[0];
    const block = (await extractBlocks(withText))[0];
    const legacy = draftEditForBlock(block, { coverColor: "#ffffff", overrides: { text: "" } });
    const out = (await renderPages((await applyTextEdits(withText, [legacy])).bytes, 1))[0];
    let lost = 0;
    for (let y = 0; y < out.height; y += 1) {
      for (let x = 0; x < out.width; x += 1) {
        if (lum(ref, x, y) < 200 && lum(out, x, y) - lum(ref, x, y) > 40) lost += 1;
      }
    }
    expect(lost).toBeGreaterThan(30);
  });
});
