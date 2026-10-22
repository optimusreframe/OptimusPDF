import { describe, expect, it } from "vitest";
import { buildInkSvg, classifyInk, inkShapeOf, parseInkLists, renderInkRaster, MAX_INK_POINTS, type InkShape } from "./annotationsInk";
import { napiSurfaceFactory } from "./__fixtures__/annots/nodeEnv";

const identity = (x: number, y: number): [number, number] => [x, y];
const flipY = (x: number, y: number): [number, number] => [x, 100 - y];

describe("parseInkLists", () => {
  it("lee listas planas [x, y, x, y…] (Float32Array) y listas de {x, y}", () => {
    const flat = new Float32Array([1, 2, 3, 4, 5, 6]);
    const objects = [{ x: 7, y: 8 }, { x: 9, y: 10 }];
    expect(parseInkLists([flat, objects], identity)).toEqual([
      [[1, 2], [3, 4], [5, 6]],
      [[7, 8], [9, 10]],
    ]);
  });

  it("pasa cada punto por la conversion a vista (pagina girada o con y invertida)", () => {
    expect(parseInkLists([[10, 20, 30, 40]], flipY)).toEqual([[[10, 80], [30, 60]]]);
  });

  it("descarta trazos de un solo punto, coordenadas no finitas y entradas raras sin lanzar", () => {
    const lists = [[1, 2], [1, 2, Number.NaN, 4, 5, 6, 7, 8], [], null, "x", [{ x: 1 }]] as never;
    expect(parseInkLists(lists, identity)).toEqual([[[1, 2], [5, 6], [7, 8]]]);
    expect(parseInkLists(null, identity)).toEqual([]);
    expect(parseInkLists(undefined, identity)).toEqual([]);
  });

  it("limita el numero total de puntos (60 000)", () => {
    expect(MAX_INK_POINTS).toBe(60_000);
    const huge = new Float32Array(70_000 * 2).fill(1);
    const strokes = parseInkLists([huge], identity);
    expect(strokes[0].length).toBe(60_000);
    expect(parseInkLists([huge, huge], identity)).toHaveLength(1); // el presupuesto es de toda la anotacion
  });
});

describe("inkShapeOf", () => {
  const base = { inkLists: [new Float32Array([10, 10, 60, 40, 110, 10])] };

  it("toma color, grosor y opacidad de la anotacion, con medio grosor de margen en la caja", () => {
    const shape = inkShapeOf({ ...base, color: new Uint8ClampedArray([255, 0, 128]), borderStyle: { width: 4 }, opacity: 0.5 }, identity) as InkShape;
    expect(shape.color).toEqual([255, 0, 128]);
    expect(shape.width).toBe(4);
    expect(shape.opacity).toBe(0.5);
    expect(shape.bounds).toEqual({ x: 8, y: 8, width: 104, height: 34 });
  });

  it("sin color, grosor ni opacidad usa negro, 1 pt y opaco; grosores absurdos se acotan", () => {
    const plain = inkShapeOf({ ...base }, identity) as InkShape;
    expect([plain.color, plain.width, plain.opacity]).toEqual([[0, 0, 0], 1, 1]);
    expect((inkShapeOf({ ...base, borderStyle: { width: 9999 } }, identity) as InkShape).width).toBe(80);
    expect((inkShapeOf({ ...base, borderStyle: { width: -3 } }, identity) as InkShape).width).toBe(1);
    expect((inkShapeOf({ ...base, opacity: 0 }, identity) as InkShape).opacity).toBe(0.05);
  });

  it("devuelve null si no hay trazos utilizables", () => {
    expect(inkShapeOf({ inkLists: [] }, identity)).toBeNull();
    expect(inkShapeOf({}, identity)).toBeNull();
  });
});

describe("buildInkSvg", () => {
  const shape = inkShapeOf(
    { inkLists: [new Float32Array([10, 10, 60, 40, 110, 10]), new Float32Array([20, 50, 90, 50])], color: [13, 26, 178], borderStyle: { width: 2.5 }, opacity: 0.6 },
    identity,
  ) as InkShape;
  const svg = buildInkSvg(shape);

  it("lleva el color real, el grosor real, la opacidad y un trazado por trazo", () => {
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('stroke="#0d1ab2"');
    expect(svg).toContain('stroke-width="2.5"');
    expect(svg).toContain('stroke-opacity="0.6"');
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('stroke-linecap="round"');
  });

  it("el viewBox mide lo que la caja de los trazos y es XML bien formado", () => {
    const width = shape.bounds.width;
    expect(svg).toContain(`viewBox="0 0 ${Math.ceil(width * 100) / 100} `);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("NaN");
  });

  it("sin opacidad menor que 1 no escribe stroke-opacity", () => {
    const opaque = buildInkSvg({ ...shape, opacity: 1 });
    expect(opaque).not.toContain("stroke-opacity");
  });
});

describe("renderInkRaster", () => {
  it("dibuja los trazos con su color sobre fondo transparente", () => {
    const shape = inkShapeOf({ inkLists: [new Float32Array([10, 20, 110, 20])], color: [255, 0, 0], borderStyle: { width: 6 } }, identity) as InkShape;
    const image = renderInkRaster(shape, napiSurfaceFactory, 2);
    expect(image.width).toBe(Math.ceil(shape.bounds.width * 2));
    const middle = ((Math.floor(image.height / 2)) * image.width + Math.floor(image.width / 2)) * 4;
    expect([image.data[middle], image.data[middle + 1], image.data[middle + 2]]).toEqual([255, 0, 0]);
    expect(image.data[middle + 3]).toBe(255);
    expect(image.data[3]).toBe(0); // esquina: transparente
  });

  it("la opacidad de la anotacion baja el alfa del trazo", () => {
    const shape = inkShapeOf({ inkLists: [new Float32Array([10, 20, 110, 20])], color: [0, 0, 255], borderStyle: { width: 6 }, opacity: 0.5 }, identity) as InkShape;
    const image = renderInkRaster(shape, napiSurfaceFactory, 2);
    const middle = ((Math.floor(image.height / 2)) * image.width + Math.floor(image.width / 2)) * 4;
    expect(Math.abs(image.data[middle + 3] - 128)).toBeLessThanOrEqual(2);
  });
});

describe("classifyInk", () => {
  const make = (strokes: number, points: number, width: number, height: number): InkShape => ({
    strokes: Array.from({ length: strokes }, () => Array.from({ length: points }, (_, i) => [i, 0] as [number, number])),
    color: [0, 0, 0],
    width: 1,
    opacity: 1,
    bounds: { x: 0, y: 0, width, height },
  });

  it("pocos trazos, apaisado y de tamano de firma => firma", () => {
    expect(classifyInk(make(2, 20, 180, 60), 612, 792).kind).toBe("signature");
  });

  it("circulo o garabato grande (casi cuadrado, o de media pagina) => dibujo", () => {
    expect(classifyInk(make(1, 40, 300, 260), 612, 792).kind).toBe("drawing");
    expect(classifyInk(make(1, 40, 500, 100), 612, 792).kind).toBe("drawing"); // > 70 % del ancho
    expect(classifyInk(make(1, 40, 100, 300), 612, 792).kind).toBe("drawing"); // alto: no es firma
    expect(classifyInk(make(1, 40, 60, 120), 612, 792).kind).toBe("drawing"); // pequeno y vertical (aspecto 0,5): tampoco
  });

  it("demasiados trazos o muy pocos puntos => dibujo", () => {
    expect(classifyInk(make(30, 10, 200, 60), 612, 792).kind).toBe("drawing");
    expect(classifyInk(make(1, 3, 200, 60), 612, 792).kind).toBe("drawing");
  });

  it("explica el motivo y da confianza alta (es una anotacion Ink de verdad)", () => {
    const signature = classifyInk(make(2, 20, 180, 60), 612, 792);
    expect(signature.confidence).toBeGreaterThanOrEqual(0.8);
    expect(signature.reasons.join(" ")).toContain("Ink");
    expect(signature.reasons.join(" ")).toContain("2 trazos");
    expect(classifyInk(make(1, 20, 180, 60), 612, 792).reasons.join(" ")).toContain("1 trazo");
  });
});
