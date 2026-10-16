import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees, drawObject, popGraphicsState, pushGraphicsState, rgb } from "@cantoo/pdf-lib";
import { readPageGraphics, readPageTexts, userToView, viewGeometryOf, type ViewGeometry } from "@/lib/pdf/autoMapCollect";
import { openForAnalysis } from "@/lib/pdf/testing/autoMapHarness";

const context = { yieldEveryMs: 1e9, now: () => 0 };

async function graphics(build: (doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>) => Promise<void> | void, size: [number, number] = [612, 792], rotate = 0) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  await build(doc, page);
  if (rotate) page.setRotation(degrees(rotate));
  const opened = await openForAnalysis(await doc.save());
  try {
    const p = await opened.pdf.getPage(1);
    const g = viewGeometryOf(p);
    return { g, gr: await readPageGraphics(p, g, opened.ops, context), texts: await readPageTexts(p, g) };
  } finally {
    await opened.close();
  }
}

describe("autoMapCollect: geometria de la pagina", () => {
  it("una raya trazada: posicion, largo y grosor", async () => {
    const { gr } = await graphics((_, page) => page.drawLine({ start: { x: 100, y: 500 }, end: { x: 300, y: 500 }, thickness: 0.8 }));
    expect(gr.segments).toHaveLength(1);
    expect(gr.segments[0].x0).toBeCloseTo(100, 3);
    expect(gr.segments[0].x1).toBeCloseTo(300, 3);
    expect(gr.segments[0].y).toBeCloseTo(500, 3);
    expect(gr.segments[0].thickness).toBeCloseTo(0.8, 3);
  });

  it("dos rayas dentro de UNA sola ruta se separan (no una caja gigante)", async () => {
    const { gr } = await graphics((_, page) =>
      page.drawSvgPath("M 100 100 L 300 100 M 100 200 L 300 200", { x: 0, y: 792, borderColor: rgb(0, 0, 0), borderWidth: 0.7 }),
    );
    expect(gr.segments).toHaveLength(2);
    expect(gr.boxes).toHaveLength(0);
    expect(gr.segments.map((s) => Math.round(s.y)).sort((a, b) => a - b)).toEqual([592, 692]);
  });

  it("un rectangulo fino relleno cuenta como raya", async () => {
    const { gr } = await graphics((_, page) => page.drawRectangle({ x: 100, y: 400, width: 200, height: 0.6, color: rgb(0, 0, 0) }));
    expect(gr.segments).toHaveLength(1);
    expect(gr.segments[0].thickness).toBeLessThan(2);
  });

  it("un rectangulo vacio es una caja; una linea vertical, una vertical", async () => {
    const { gr } = await graphics((_, page) => {
      page.drawRectangle({ x: 100, y: 400, width: 90, height: 30, borderColor: rgb(0, 0, 0), borderWidth: 0.7 });
      page.drawLine({ start: { x: 400, y: 300 }, end: { x: 400, y: 380 }, thickness: 0.7 });
    });
    expect(gr.boxes).toHaveLength(1);
    expect(gr.boxes[0]).toMatchObject({ stroke: true });
    expect(gr.boxes[0].x1 - gr.boxes[0].x0).toBeCloseTo(90, 3);
    expect(gr.verticals).toHaveLength(1);
    expect(gr.verticals[0].x).toBeCloseTo(400, 3);
  });

  it("las rayas dentro de un XObject de formulario heredan su matriz", async () => {
    const doc = await PDFDocument.create();
    const source = doc.addPage([200, 100]);
    source.drawLine({ start: { x: 10, y: 20 }, end: { x: 110, y: 20 }, thickness: 0.8 });
    const [embedded] = await doc.embedPages([source]);
    const page = doc.addPage([612, 792]);
    page.drawPage(embedded, { x: 250, y: 400 });
    const opened = await openForAnalysis(await doc.save());
    try {
      const p = await opened.pdf.getPage(2);
      const gr = await readPageGraphics(p, viewGeometryOf(p), opened.ops, context);
      expect(gr.segments).toHaveLength(1);
      expect(gr.segments[0].x0).toBeCloseTo(260, 2);
      expect(gr.segments[0].x1).toBeCloseTo(360, 2);
      expect(gr.segments[0].y).toBeCloseTo(420, 2);
    } finally {
      await opened.close();
    }
  });

  it("una raya dentro de un XObject de formulario con /Matrix propia la hereda", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.context.stream("0.8 w 10 20 m 110 20 l S", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 400, 400],
      Matrix: [1, 0, 0, 1, 100, 50],
    });
    const key = page.node.newXObject("Fm0", doc.context.register(form));
    page.pushOperators(pushGraphicsState(), drawObject(key), popGraphicsState());
    const opened = await openForAnalysis(await doc.save());
    try {
      const p = await opened.pdf.getPage(1);
      const gr = await readPageGraphics(p, viewGeometryOf(p), opened.ops, context);
      expect(gr.segments).toHaveLength(1);
      expect(gr.segments[0].x0).toBeCloseTo(110, 2);
      expect(gr.segments[0].x1).toBeCloseTo(210, 2);
      expect(gr.segments[0].y).toBeCloseTo(70, 2);
    } finally {
      await opened.close();
    }
  });

  it("una ruta de cientos de miles de puntos no desborda la pila", async () => {
    const points = 150_000;
    const parts = ["0.1 w", "0 0 m"];
    for (let i = 1; i <= points; i += 1) parts.push(`${(i % 500) + 1} ${i % 700} l`);
    parts.push("S");
    const { gr } = await graphics((doc, page) => {
      page.node.addContentStream(doc.context.register(doc.context.stream(parts.join("\n"))));
    });
    expect(gr.truncated).toBe(false);
    expect(gr.boxes.length).toBe(0);
  });

  it("imagenes: su caja en el espacio de la vista", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const { gr } = await graphics(async (doc, page) => {
      page.drawImage(await doc.embedPng(png), { x: 100, y: 200, width: 150, height: 40 });
    });
    expect(gr.images).toHaveLength(1);
    expect(gr.images[0].x0).toBeCloseTo(100, 3);
    expect(gr.images[0].y1 - gr.images[0].y0).toBeCloseTo(40, 3);
  });

  it("el texto: caja de la pagina, linea base y altura", async () => {
    const { texts } = await graphics(async (doc, page) => {
      page.drawText("Signature:", { x: 72, y: 300, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("Signature:");
    expect(texts[0].left).toBeCloseTo(72, 3);
    expect(texts[0].baseline).toBeCloseTo(300, 3);
    expect(texts[0].height).toBeCloseTo(12, 1);
    expect(texts[0].right).toBeGreaterThan(texts[0].left + 30);
  });

  it("una pagina con la caja de recorte desplazada mide desde su esquina", async () => {
    const { gr, g } = await graphics((_, page) => {
      page.setCropBox(0, 8, 612, 784);
      page.drawLine({ start: { x: 100, y: 108 }, end: { x: 300, y: 108 }, thickness: 0.8 });
    });
    expect(g.viewHeight).toBe(784);
    expect(gr.segments[0].y).toBeCloseTo(100, 3);
  });

  it("ignora el texto girado en la vista (no sirve de etiqueta)", async () => {
    const { texts } = await graphics(async (doc, page) => {
      page.drawText("Vertical", { x: 100, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica), rotate: degrees(90) });
    });
    expect(texts).toHaveLength(0);
  });

  it("con /Rotate el texto girado en el contenido se ve derecho", async () => {
    const { texts, g } = await graphics(
      async (doc, page) => {
        page.drawText("Upright", { x: 100, y: 100, size: 12, font: await doc.embedFont(StandardFonts.Helvetica), rotate: degrees(90) });
      },
      [612, 792],
      90,
    );
    expect(g.viewWidth).toBe(792);
    expect(g.viewHeight).toBe(612);
    expect(texts).toHaveLength(1);
    expect(texts[0].right).toBeGreaterThan(texts[0].left);
  });
});

describe("userToView", () => {
  const base = { boxX: 0, boxY: 0, boxWidth: 600, boxHeight: 800 };
  const g = (rotation: ViewGeometry["rotation"]): ViewGeometry => ({ ...base, rotation, viewWidth: rotation === 90 || rotation === 270 ? 800 : 600, viewHeight: rotation === 90 || rotation === 270 ? 600 : 800 });
  it("0 grados: traslada por la caja", () => {
    expect(userToView({ ...g(0), boxX: 10, boxY: 20 }, 110, 220)).toEqual({ x: 100, y: 200 });
  });
  it("90: la esquina inferior izquierda pasa arriba a la izquierda", () => {
    expect(userToView(g(90), 0, 0)).toEqual({ x: 0, y: 600 });
    expect(userToView(g(90), 600, 800)).toEqual({ x: 800, y: 0 });
  });
  it("180: gira media vuelta", () => {
    expect(userToView(g(180), 0, 0)).toEqual({ x: 600, y: 800 });
  });
  it("270: la esquina inferior izquierda pasa abajo a la derecha", () => {
    expect(userToView(g(270), 0, 0)).toEqual({ x: 800, y: 0 });
    expect(userToView(g(270), 600, 800)).toEqual({ x: 0, y: 600 });
  });
});
