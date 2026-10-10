import { describe, expect, it } from "vitest";
import {
  COVER_ACCENT_TOP_EM,
  COVER_DESCENT_EM,
  blockCoverExtent,
  blockCoverQuad,
  boxPolygon,
  polygonsOverlap,
  coverCorners,
  coverExtent,
  coverForBlock,
  coverShape,
  isRightAngle,
} from "@/lib/pdf/editCover";
import { parseTextEdit } from "@/app/edit-pdf/editSession";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";

function block(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    id: "p0-b0",
    pageIndex: 0,
    box: { x: 20, y: 95.2, width: 200, height: 24 },
    text: "Hola",
    lines: [
      {
        text: "Hola",
        box: { x: 20, y: 95.2, width: 200, height: 24 },
        baseline: 100,
        origin: { x: 20, y: 100 },
        length: 200,
      },
    ],
    fontSize: 24,
    color: "#000000",
    rotation: 0,
    align: "left",
    font: {
      pdfName: "Times-Roman",
      family: "serif",
      bold: false,
      italic: false,
      subset: false,
      embedded: false,
      symbolic: false,
      type3: false,
    },
    editable: true,
    origHash: "x",
    orientedBox: { origin: { x: 20, y: 95.2 }, width: 200, height: 24 },
    ...overrides,
  };
}

describe("coverForBlock — src/lib/pdf/editCover.ts", () => {
  it("amplia arriba hasta ~0,95 em sobre la linea base y abajo hasta 0,25 em (nunca reduce)", () => {
    const { box, oriented } = coverForBlock(block());
    expect(oriented).toBeUndefined();
    // Linea base 100, tamano 24: arriba 100 + 0,95*24 = 122,8; abajo 100 - 0,25*24 = 94.
    expect(box.y + box.height).toBeCloseTo(100 + COVER_ACCENT_TOP_EM * 24, 2);
    expect(box.y).toBeCloseTo(100 - COVER_DESCENT_EM * 24, 2);
    expect(box.x).toBe(20);
    expect(box.width).toBe(200);
  });

  it("no reduce una caja que ya era mas grande", () => {
    const tall = block({ orientedBox: { origin: { x: 20, y: 80 }, width: 200, height: 60 } });
    const { box } = coverForBlock(tall);
    expect(box.y).toBe(80);
    expect(box.y + box.height).toBe(140);
  });

  it("con interlineado ajustado no sube hasta la linea de arriba", () => {
    const tight = coverForBlock(block({ lineHeight: 1.0 }));
    const normal = coverForBlock(block());
    expect(tight.box.y + tight.box.height).toBeLessThan(normal.box.y + normal.box.height);
    // No crece mas alla de la caja original (119,2): la cola de la linea de arriba queda libre.
    expect(tight.box.y + tight.box.height).toBeCloseTo(119.2, 2);
  });

  it("varias lineas: abajo se cuenta desde la ULTIMA linea base", () => {
    const two = block({
      box: { x: 20, y: 66.4, width: 200, height: 52.8 },
      orientedBox: { origin: { x: 20, y: 66.4 }, width: 200, height: 52.8 },
      lineHeight: 1.2,
      lines: [
        { text: "a", box: { x: 20, y: 95, width: 200, height: 24 }, baseline: 100, origin: { x: 20, y: 100 }, length: 200 },
        { text: "b", box: { x: 20, y: 66, width: 200, height: 24 }, baseline: 71.2, origin: { x: 20, y: 71.2 }, length: 200 },
      ],
    });
    const { box } = coverForBlock(two);
    expect(box.y).toBeCloseTo(71.2 - 0.25 * 24, 2);
  });

  it("superindices y bloques sin rectangulo orientado se devuelven tal cual", () => {
    expect(coverForBlock(block({ script: "superscript" })).box).toEqual(block().box);
    expect(coverForBlock(block({ orientedBox: undefined })).box).toEqual(block().box);
  });

  it("texto a 40 grados: guarda el rectangulo orientado y su caja envolvente", () => {
    const angle = (40 * Math.PI) / 180;
    const rotated = block({
      rotation: 40,
      box: { x: 50, y: 57, width: 176, height: 152 },
      orientedBox: { origin: { x: 60, y: 60 }, width: 150, height: 18 },
      lines: [
        {
          text: "x",
          box: { x: 50, y: 57, width: 176, height: 152 },
          baseline: 60,
          origin: { x: 60 - 0, y: 60 + 4 },
          length: 150,
        },
      ],
      fontSize: 16,
    });
    const { box, oriented } = coverForBlock(rotated);
    expect(oriented?.rotation).toBe(40);
    expect(oriented!.width).toBe(150);
    expect(oriented!.height).toBeGreaterThanOrEqual(18);
    // La caja envolvente contiene las 4 esquinas.
    const corners = coverCorners({
      kind: "oriented",
      origin: oriented!.origin,
      width: oriented!.width,
      height: oriented!.height,
      rotation: 40,
      holes: [],
    });
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(c.x).toBeLessThanOrEqual(box.x + box.width + 0.01);
      expect(c.y).toBeGreaterThanOrEqual(box.y - 0.01);
      expect(c.y).toBeLessThanOrEqual(box.y + box.height + 0.01);
    }
    expect(Math.cos(angle)).toBeGreaterThan(0);
  });

  it("giro multiplo de 90: caja del eje exacta, sin cobertura orientada", () => {
    const vertical = block({
      rotation: 90,
      box: { x: 80, y: 20, width: 24, height: 200 },
      orientedBox: { origin: { x: 104, y: 20 }, width: 200, height: 24 },
      lines: [
        { text: "v", box: { x: 80, y: 20, width: 24, height: 200 }, baseline: 100, origin: { x: 100, y: 20 }, length: 200 },
      ],
    });
    const { box, oriented } = coverForBlock(vertical);
    expect(oriented).toBeUndefined();
    expect(box.height).toBeCloseTo(200, 2);
    expect(box.width).toBeGreaterThanOrEqual(24);
  });
});

describe("coverShape / coverExtent", () => {
  const base = {
    box: { x: 0, y: 0, width: 10, height: 10 },
    cover: { color: "#fff", padding: 2 },
  };

  it("sin color no hay cobertura", () => {
    expect(coverShape({ ...base, cover: { color: null, padding: 2 } })).toBeNull();
  });

  it("rectangulo: coverBox (o box) mas el padding por los cuatro lados", () => {
    const shape = coverShape({ ...base, coverBox: { x: 10, y: 20, width: 30, height: 8 } });
    expect(shape).toEqual({ kind: "rect", box: { x: 8, y: 18, width: 34, height: 12 } });
    expect(coverShape(base)).toEqual({ kind: "rect", box: { x: -2, y: -2, width: 14, height: 14 } });
  });

  it("orientado: crece el padding en ambos ejes del rectangulo girado", () => {
    const shape = coverShape({
      ...base,
      coverOriented: { origin: { x: 50, y: 50 }, width: 40, height: 10, rotation: 30 },
    });
    expect(shape?.kind).toBe("oriented");
    expect(coverCorners(shape!)).toHaveLength(4);
    const extent = coverExtent(shape!);
    const radians = (30 * Math.PI) / 180;
    const w = 44;
    const h = 14;
    expect(extent.width).toBeCloseTo(w * Math.cos(radians) + h * Math.sin(radians), 6);
    expect(extent.height).toBeCloseTo(w * Math.sin(radians) + h * Math.cos(radians), 6);
  });

  it("un giro multiplo de 90 en coverOriented se ignora (manda coverBox)", () => {
    const shape = coverShape({
      ...base,
      coverBox: { x: 1, y: 1, width: 5, height: 5 },
      coverOriented: { origin: { x: 50, y: 50 }, width: 40, height: 10, rotation: 180 },
    });
    expect(shape?.kind).toBe("rect");
  });

  it("blockCoverExtent incluye la ampliacion y el padding (el anillo de muestreo va fuera)", () => {
    const extent = blockCoverExtent(block(), 1);
    expect(extent.y).toBeCloseTo(94 - 1, 2);
    expect(extent.y + extent.height).toBeCloseTo(122.8 + 1, 2);
  });

  it("isRightAngle", () => {
    for (const angle of [0, 90, 180, 270, -90, 360]) expect(isRightAngle(angle)).toBe(true);
    for (const angle of [1, 40, 89, 135]) expect(isRightAngle(angle)).toBe(false);
  });
});

describe("parseTextEdit conserva coverOriented y obstacles (borradores)", () => {
  const edit: TextEdit = {
    id: "t1",
    blockId: "p0-b0",
    pageIndex: 0,
    box: { x: 1, y: 2, width: 30, height: 10 },
    coverBox: { x: 1, y: 2, width: 30, height: 10 },
    coverOriented: { origin: { x: 3, y: 4 }, width: 20, height: 8, rotation: 33 },
    obstacles: [{ id: "p0-b2", box: { x: 50, y: 2, width: 20, height: 10 } }],
    text: "x",
    fontSize: 12,
    color: "#000000",
    align: "left",
    fontKey: "helvetica",
    bold: false,
    italic: false,
    rotation: 0,
    cover: { color: "#ffffff", padding: 1 },
  };

  it("ida y vuelta por JSON", () => {
    const back = parseTextEdit(JSON.parse(JSON.stringify(edit)));
    expect(back?.coverOriented).toEqual(edit.coverOriented);
    expect(back?.obstacles).toEqual(edit.obstacles);
  });

  it("rechaza valores invalidos", () => {
    expect(parseTextEdit({ ...edit, coverOriented: { origin: { x: 1, y: 1 }, width: -1, height: 2, rotation: 3 } })).toBeNull();
    expect(parseTextEdit({ ...edit, obstacles: [{ id: 3, box: edit.box }] })).toBeNull();
    expect(parseTextEdit({ ...edit, obstacles: "no" })).toBeNull();
  });
});

describe("blockCoverQuad (W5-U5)", () => {
  it("texto sin giro o girado 90 grados: no hay cuadrilatero (se cubre con una caja del eje)", () => {
    expect(blockCoverQuad(block())).toBeNull();
    expect(blockCoverQuad(block({ rotation: 90 }))).toBeNull();
  });

  it("texto girado un angulo libre: cuatro esquinas del rectangulo orientado, con el margen", () => {
    const rotated = block({
      rotation: 30,
      orientedBox: { origin: { x: 100, y: 100 }, width: 80, height: 14 },
      lines: [{ text: "x", box: { x: 100, y: 100, width: 90, height: 60 }, baseline: 100, origin: { x: 100, y: 100 }, length: 80 }],
    });
    const quad = blockCoverQuad(rotated, 1)!;
    expect(quad).toHaveLength(4);
    const side = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
    expect(side).toBeGreaterThanOrEqual(80 + 2 - 1e-6);
    // Lados perpendiculares: es un rectangulo girado, no la caja envolvente.
    const dot = (quad[1].x - quad[0].x) * (quad[3].x - quad[0].x) + (quad[1].y - quad[0].y) * (quad[3].y - quad[0].y);
    expect(Math.abs(dot)).toBeLessThan(1e-6);
    expect(quad[1].y).not.toBeCloseTo(quad[0].y, 3);
  });
});

describe("coverShape — huecos de vecinos en la cobertura orientada (N3)", () => {
  const base = {
    box: { x: 0, y: 0, width: 10, height: 10 },
    cover: { color: "#fff", padding: 0 },
    coverOriented: { origin: { x: 20, y: 20 }, width: 100, height: 10, rotation: 30 },
  };

  it("un vecino que cruza el rectangulo girado deja un hueco que es su interseccion", () => {
    const shape = coverShape({ ...base, obstacles: [{ id: "n", box: { x: 50, y: 30, width: 20, height: 10 } }] });
    expect(shape?.kind).toBe("oriented");
    if (shape?.kind !== "oriented") return;
    expect(shape.holes).toHaveLength(1);
    expect(shape.holes[0].id).toBe("n");
    // El hueco queda dentro de la caja del vecino (+0,5 pt) y del rectangulo girado.
    for (const p of shape.holes[0].polygon) {
      expect(p.x).toBeGreaterThanOrEqual(49.5 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(70.5 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(29.5 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(40.5 + 1e-6);
    }
  });

  it("vecinos que no tocan el rectangulo no dejan hueco; un roce minimo tampoco", () => {
    const far = coverShape({ ...base, obstacles: [{ id: "far", box: { x: 200, y: 200, width: 10, height: 10 } }] });
    expect(far?.kind === "oriented" && far.holes).toEqual([]);
    // La caja envolvente del texto girado contiene este vecino, pero el rectangulo girado no lo cruza.
    const aside = coverShape({ ...base, obstacles: [{ id: "aside", box: { x: 20, y: 60, width: 20, height: 10 } }] });
    expect(aside?.kind === "oriented" && aside.holes).toEqual([]);
  });

  it("sin giro libre (rectangulo del eje) no hay huecos: ahi manda clipToObstacles", () => {
    const shape = coverShape({
      box: { x: 0, y: 0, width: 10, height: 10 },
      cover: { color: "#fff", padding: 0 },
      obstacles: [{ id: "n", box: { x: 5, y: 5, width: 10, height: 10 } }],
    });
    expect(shape?.kind).toBe("rect");
  });
});

describe("polygonsOverlap — los ejes de AMBOS poligonos cuentan (A4 D2)", () => {
  // Rombo (cuadrado a 45 grados) con la punta derecha en (12, 5).
  const diamond = [
    { x: 5, y: -2 },
    { x: 12, y: 5 },
    { x: 5, y: 12 },
    { x: -2, y: 5 },
  ];

  it("una caja alta a 1 pt tras la punta del rombo NO solapa (separa un eje de la CAJA, no del rombo)", () => {
    const box = boxPolygon({ x: 13, y: -10, width: 7, height: 30 });
    // Con solo los ejes del primer poligono (el rombo) se veria solape: ninguna de sus normales separa.
    expect(polygonsOverlap(diamond, box, 0)).toBe(false);
    expect(polygonsOverlap(box, diamond, 0)).toBe(false);
  });

  it("una caja pegada a la arista diagonal, dentro de la envolvente del rombo: SOLO el eje del rombo separa", () => {
    // Esquina (9, 9): fuera del rombo (x + y = 18 > 17), pero dentro de su caja envolvente en x y en y.
    const box = boxPolygon({ x: 9, y: 9, width: 3, height: 3 });
    // Aqui el primer poligono es la caja: sus ejes (x, y) NO separan; el segundo (el rombo) si.
    expect(polygonsOverlap(box, diamond, 0)).toBe(false);
    expect(polygonsOverlap(diamond, box, 0)).toBe(false);
    // Y un solape real sigue dando verdadero en ambos ordenes.
    const inside = boxPolygon({ x: 4, y: 4, width: 3, height: 3 });
    expect(polygonsOverlap(box, boxPolygon({ x: 10, y: 10, width: 3, height: 3 }), 0)).toBe(true);
    expect(polygonsOverlap(diamond, inside, 0)).toBe(true);
    expect(polygonsOverlap(inside, diamond, 0)).toBe(true);
  });
});
