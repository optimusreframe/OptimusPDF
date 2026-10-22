import { beforeAll, describe, expect, it } from "vitest";
import { getLegacyOps } from "./__fixtures__/annots/nodeEnv";
import { DRAW_OPS, GROUP_GAP_PT, MAX_CANDIDATES_PER_PAGE, MAX_PATHS, scanVectors, sitsOnLine, toPageVectors, type VectorOps } from "./vectors";

/** Trazos vectoriales (beta): lista de operadores fabricada a mano, sin pdf.js salvo la tabla `OPS`. */

let ops: VectorOps;
beforeAll(async () => {
  ops = await getLegacyOps();
});

type Cmd = ["M", number, number] | ["L", number, number] | ["C", number, number, number, number, number, number] | ["Z"];

function data(cmds: Cmd[]): number[] {
  const out: number[] = [];
  for (const c of cmds) {
    if (c[0] === "M") out.push(DRAW_OPS.moveTo, c[1], c[2]);
    else if (c[0] === "L") out.push(DRAW_OPS.lineTo, c[1], c[2]);
    else if (c[0] === "C") out.push(DRAW_OPS.curveTo, c[1], c[2], c[3], c[4], c[5], c[6]);
    else out.push(DRAW_OPS.closePath);
  }
  return out;
}

class List {
  fn: number[] = [];
  args: unknown[] = [];
  add(op: number, args: unknown = null): this {
    this.fn.push(op);
    this.args.push(args);
    return this;
  }
  path(paint: number, cmds: Cmd[]): this {
    return this.add(ops.constructPath, [paint, [new Float32Array(data(cmds))], [0, 0, 0, 0]]);
  }
}

const map = { toView: (x: number, y: number): [number, number] => [x, 792 - y] };
const scan = (list: List, options = {}) => scanVectors(list.fn, list.args, ops, map, 0, 612, 792, options);

/** Una escritura: `loops` rizos (curvas con vuelta atras) desde (x, y) en espacio de usuario (y hacia arriba). */
function scribble(x: number, y: number, loops = 5, width = 30): Cmd[] {
  const cmds: Cmd[] = [["M", x, y]];
  let cx = x;
  for (let i = 0; i < loops; i += 1) {
    cmds.push(["C", cx + width * 0.5, y + 22, cx - width * 0.2, y + 22, cx + width * 0.4, y], ["C", cx + width * 0.9, y - 18, cx + width * 0.2, y - 18, cx + width * 0.5, y + 2]);
    cx += width * 0.45;
  }
  return cmds;
}

describe("scanVectors · lo que SI es una candidata", () => {
  it("una escritura de curvas con bucles: rasgos y caja en puntos de vista", () => {
    const list = new List().add(ops.setStrokeRGBColor, ["#142980"]).add(ops.setLineWidth, [1.6]).path(ops.stroke, scribble(150, 150));
    const result = scan(list);
    expect(result.skipped).toBe(false);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    expect(c.pageIndex).toBe(0);
    expect(c.curves).toBe(10);
    expect(c.segments).toBe(10);
    expect(c.strokes).toBe(1);
    expect(c.xReversals).toBeGreaterThanOrEqual(2);
    expect(c.yReversals).toBeGreaterThanOrEqual(2);
    expect(c.axisAligned).toBe(0);
    expect(c.shapeShare).toBe(0);
    expect(c.color).toBe("#142980");
    expect(c.strokeWidth).toBeCloseTo(1.6, 5);
    expect(c.bbox.x).toBeCloseTo(144, 0); // las curvas llevan sus puntos de control: 6 pt a la izquierda de la salida
    expect(c.bbox.y).toBeGreaterThan(792 - 150 - 40); // y de vista = 792 - y de usuario
    expect(c.rect.width).toBeCloseTo(c.bbox.width / 612, 5);
    expect(c.rect.y).toBeCloseTo(c.bbox.y / 792, 5);
    expect(c.paths).toHaveLength(1);
    expect(c.paths[0].stroke).toBe(true);
    expect(c.paths[0].commands[0][0]).toBe("M");
  });

  it("los comandos guardados vuelven a dibujar la ruta (M, C y Z en puntos de vista)", () => {
    const list = new List().path(ops.stroke, [...scribble(100, 100), ["L", 140, 100], ["Z"]]);
    const c = scan(list).candidates[0];
    const letters = c.paths[0].commands.map((command) => command[0]);
    expect(letters[0]).toBe("M");
    expect(letters).toContain("C");
    expect(letters).toContain("L");
    expect(letters[letters.length - 1]).toBe("Z");
    expect(c.paths[0].commands[0][2]).toBeCloseTo(792 - 100, 3);
  });

  it("una poli-linea de tinta digital (muchos tramos diminutos) NO se toma por cuadro: sin segmentos rectos", () => {
    const cmds: Cmd[] = [["M", 100, 400]];
    for (let i = 1; i <= 300; i += 1) cmds.push(["L", 100 + i * 0.5 + Math.sin(i / 7) * 4, 400 + Math.cos(i / 5) * 12]);
    const result = scan(new List().path(ops.stroke, cmds));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].curves).toBe(0);
    expect(result.candidates[0].segments).toBe(300);
    expect(result.candidates[0].axisAligned).toBeLessThan(0.1);
  });

  it("una firma de contorno RELLENO (fill) tambien: relleno sin grosor de trazo", () => {
    const cmds: Cmd[] = [["M", 100, 300]];
    for (let i = 1; i <= 60; i += 1) cmds.push(["L", 100 + i * 2 + Math.sin(i / 3) * 5, 300 + Math.cos(i / 2) * 9]);
    cmds.push(["Z"]);
    const result = scan(new List().add(ops.setFillRGBColor, ["#0a0a14"]).path(ops.fill, cmds));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].paths[0].fill).toBe(true);
    expect(result.candidates[0].paths[0].stroke).toBe(false);
    expect(result.candidates[0].strokeWidth).toBe(0);
    expect(result.candidates[0].color).toBe("#0a0a14");
  });

  it("fillStroke y closeStroke tambien pintan: cuentan como trazo", () => {
    for (const paint of [ops.fillStroke, ops.closeStroke, ops.closeFillStroke, ops.eoFill, ops.eoFillStroke]) {
      expect(scan(new List().path(paint, scribble(150, 150))).candidates).toHaveLength(1);
    }
    expect(scan(new List().path(ops.endPath, scribble(150, 150))).candidates).toHaveLength(0);
    expect(scan(new List().path(ops.clip, scribble(150, 150))).candidates).toHaveLength(0);
  });

  it("la matriz (cm), save/restore y los formularios (paintFormXObjectBegin/End) desplazan y escalan la caja y el grosor", () => {
    const plain = scan(new List().add(ops.setLineWidth, [1]).path(ops.stroke, scribble(10, 10))).candidates[0];
    const list = new List()
      .add(ops.save)
      .add(ops.transform, [2, 0, 0, 2, 50, 60])
      .add(ops.setLineWidth, [1])
      .path(ops.stroke, scribble(10, 10))
      .add(ops.restore)
      .add(ops.paintFormXObjectBegin, [[1, 0, 0, 1, 300, 400], [0, 0, 100, 100]])
      .path(ops.stroke, scribble(0, 0))
      .add(ops.paintFormXObjectEnd)
      .path(ops.stroke, scribble(0, 700)); // fuera del formulario y de la matriz
    const byX = [...scan(list).candidates].sort((a, b) => a.bbox.x - b.bbox.x);
    expect(byX).toHaveLength(3);
    // Sin matriz (tras restore y tras el formulario): origen en 0.
    expect(byX[0].bbox.x).toBeCloseTo(plain.bbox.x - 10, 3);
    // Escala 2 y desplazamiento (50, 60): el ancho se duplica, el grosor pasa de 1 a 2 y la caja empieza en 50 + 2 x x0.
    const scaled = byX.find((c) => c.strokeWidth > 1.5);
    expect(scaled?.bbox.width).toBeCloseTo(plain.bbox.width * 2, 3);
    expect(scaled?.bbox.x).toBeCloseTo(50 + 2 * plain.bbox.x, 3);
    expect(scaled?.strokeWidth).toBeCloseTo(2, 5);
    // El formulario traslada 300 en x y NO escala.
    const form = byX.find((c) => c.bbox.x > 250);
    expect(form?.bbox.x).toBeCloseTo(300 + (plain.bbox.x - 10), 3);
    expect(form?.bbox.width).toBeCloseTo(plain.bbox.width, 3);
  });

  it("setGState con LW fija el grosor", () => {
    const list = new List().add(ops.setGState, [[["LW", 2.5]]]).path(ops.stroke, scribble(150, 150));
    expect(scan(list).candidates[0].strokeWidth).toBeCloseTo(2.5, 5);
  });

  it("varios trazos cercanos (hueco <= 14 pt) son UNA firma; lejanos (> 14 pt) son dos", () => {
    const first = scan(new List().path(ops.stroke, scribble(100, 100))).candidates[0].bbox;
    const second = (gap: number) => scribble(first.x + first.width + gap + 6, 100); // +6: los puntos de control salen 6 pt a la izquierda
    const merged = scan(new List().path(ops.stroke, scribble(100, 100)).path(ops.stroke, second(GROUP_GAP_PT - 2))).candidates;
    expect(merged).toHaveLength(1);
    expect(merged[0].strokes).toBe(2);
    expect(scan(new List().path(ops.stroke, scribble(100, 100)).path(ops.stroke, second(GROUP_GAP_PT + 4))).candidates).toHaveLength(2);
    expect(GROUP_GAP_PT).toBe(14);
  });

  it("el color dominante pesa por longitud y las candidatas se limitan a 12 por pagina, las mas complejas primero", () => {
    const list = new List();
    for (let i = 0; i < 15; i += 1) list.path(ops.stroke, scribble(10 + i * 38, 100 + (i % 2) * 300, 2 + (i % 5), 20));
    const result = scan(list);
    expect(result.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_PAGE);
    const sizes = result.candidates.map((c) => c.curves + c.segments);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });
});

describe("scanVectors · lo que NO", () => {
  it("rectangulos, cuadros y tablas (todo horizontal/vertical): ninguna candidata; las rayas largas se guardan como raya de firma", () => {
    const list = new List()
      .path(ops.stroke, [["M", 50, 100], ["L", 350, 100], ["L", 350, 120], ["L", 50, 120], ["Z"]])
      .path(ops.stroke, [["M", 50, 300], ["L", 250, 300]])
      .path(ops.stroke, [["M", 70, 200], ["L", 80, 200]]); // raya corta: no
    const result = scan(list);
    expect(result.candidates).toEqual([]);
    expect(result.lines.length).toBeGreaterThanOrEqual(3); // lados horizontales largos del rectangulo y la raya
    expect(result.lines.some((l) => Math.abs(l.y - (792 - 300)) < 0.01 && l.x0 === 50 && l.x1 === 250)).toBe(true);
    expect(result.lines.some((l) => l.x1 - l.x0 < 30)).toBe(false);
  });

  it("un rectangulo relleno fino (raya dibujada como relleno) cuenta como raya y no como trazo", () => {
    const result = scan(new List().path(ops.fill, [["M", 50, 300], ["L", 250, 300], ["L", 250, 300.5], ["L", 50, 300.5], ["Z"]]));
    expect(result.candidates).toEqual([]);
    expect(result.lines).toHaveLength(2);
  });

  it("una recta suelta (diagonal) no es un trazo de firma", () => {
    expect(scan(new List().path(ops.stroke, [["M", 50, 100], ["L", 150, 160]])).candidates).toEqual([]);
  });

  it("marcadores cerrados y chicos (circulos de un grafico de puntos): shapeShare 1", () => {
    const list = new List();
    for (let i = 0; i < 6; i += 1) {
      const x = 100 + i * 9;
      list.path(ops.stroke, [["M", x, 200], ["C", x, 203, x + 6, 203, x + 6, 200], ["C", x + 6, 197, x, 197, x, 200], ["Z"]]);
    }
    const result = scan(list);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].shapeShare).toBe(1);
    // Una escritura NO cerrada tiene 0.
    expect(scan(new List().path(ops.stroke, scribble(150, 150))).candidates[0].shapeShare).toBe(0);
  });

  it("trazos claros (luminancia > 235) y rutas gigantes (> 60 % del ancho o > 25 % del alto) se ignoran", () => {
    expect(scan(new List().add(ops.setStrokeRGBColor, ["#f4f4f4"]).path(ops.stroke, scribble(150, 150))).candidates).toEqual([]);
    expect(scan(new List().add(ops.setStrokeRGBColor, ["#eaeaea"]).path(ops.stroke, scribble(150, 150))).candidates).toHaveLength(1);
    expect(scan(new List().path(ops.stroke, scribble(10, 100, 60, 14))).candidates).toEqual([]); // ancho > 60 % de 612
    const tall: Cmd[] = [["M", 100, 100], ["C", 150, 400, 50, 400, 120, 120], ["C", 150, 380, 50, 380, 110, 100]];
    expect(scan(new List().path(ops.stroke, tall)).candidates).toEqual([]);
  });

  it("una pagina con mas de MAX_PATHS rutas (mapa, plano, grafico) se salta entera", () => {
    const list = new List();
    for (let i = 0; i < 12; i += 1) list.path(ops.stroke, scribble(20 + i * 40, 100));
    const result = scan(list, { maxPaths: 10 });
    expect(result.skipped).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.paths).toBe(11);
    expect(scan(list, { maxPaths: 12 }).skipped).toBe(false);
    expect(MAX_PATHS).toBe(6000);
  });

  it("lo que va entre beginAnnotation y endAnnotation no es contenido de la pagina", () => {
    const list = new List().add(ops.beginAnnotation).path(ops.stroke, scribble(150, 150)).add(ops.endAnnotation).path(ops.stroke, scribble(150, 450));
    const result = scan(list);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].bbox.y).toBeLessThan(792 - 400);
  });

  it("filtros de tamano y complejidad: curvas + tramos >= 8, caja de al menos 8 x 4 pt", () => {
    expect(scan(new List().path(ops.stroke, scribble(150, 150, 1))).candidates).toHaveLength(0); // 2 curvas
    expect(scan(new List().path(ops.stroke, scribble(150, 150, 2))).candidates).toHaveLength(1); // 4 curvas = 4 + 4
    const tiny: Cmd[] = [["M", 100, 100]];
    for (let i = 0; i < 20; i += 1) tiny.push(["L", 100 + (i % 2) * 2, 100 + (i % 3)]);
    expect(scan(new List().path(ops.stroke, tiny)).candidates).toEqual([]);
  });

  it("argumentos que no encajan se saltan sin lanzar", () => {
    const list = new List()
      .add(ops.transform, "no soy una matriz")
      .add(ops.constructPath, ["x"])
      .add(ops.constructPath, [ops.stroke, 5])
      .add(ops.constructPath, [ops.stroke, [new Float32Array([99, 1, 2])], null])
      .add(ops.setLineWidth, ["x"])
      .add(ops.setStrokeRGBColor, [5])
      .add(ops.paintFormXObjectBegin, null)
      .path(ops.stroke, scribble(150, 150));
    expect(() => scan(list)).not.toThrow();
    expect(scan(list).candidates).toHaveLength(1);
  });
});

describe("sitsOnLine y toPageVectors", () => {
  const box = { x: 100, y: 600, width: 100, height: 40 };
  const line = (over = {}) => ({ x0: 90, x1: 220, y: 650, ...over });
  it("raya justo debajo, o cruzando la parte baja, que cubre la firma", () => {
    expect(sitsOnLine(box, [line()])).toBe(true);
    expect(sitsOnLine(box, [line({ y: 640 })])).toBe(true);
    expect(sitsOnLine(box, [line({ y: 664 })])).toBe(true); // 24 pt por debajo
    expect(sitsOnLine(box, [line({ y: 665 })])).toBe(false);
    expect(sitsOnLine(box, [line({ y: 621 })])).toBe(false); // por encima del 55 % de la altura
    expect(sitsOnLine(box, [line({ y: 622 })])).toBe(true);
  });
  it("la raya ha de cubrir al menos la mitad del ancho y medir 60 % de la firma", () => {
    expect(sitsOnLine(box, [line({ x0: 160, x1: 260 })])).toBe(false); // solapa 40
    expect(sitsOnLine(box, [line({ x0: 150, x1: 260 })])).toBe(true); // solapa 50
    expect(sitsOnLine(box, [line({ x0: 100, x1: 150 })])).toBe(false); // mide 50 < 60
    expect(sitsOnLine(box, [])).toBe(false);
  });
  it("toPageVectors junta la pagina, sus candidatas y sus rayas", () => {
    const result = scan(new List().path(ops.stroke, scribble(150, 150)).path(ops.stroke, [["M", 100, 100], ["L", 300, 100]]));
    const page = toPageVectors(3, result);
    expect(page.pageIndex).toBe(3);
    expect(page.candidates).toBe(result.candidates);
    expect(page.lines).toBe(result.lines);
  });
});
