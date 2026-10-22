import { describe, expect, it } from "vitest";
import { judgeVector } from "./classifyVectors";
import { label, line, page, vectorCandidate } from "./classify.testUtils";
import type { LabelFact, PageVectors } from "./classifyTypes";

/** Firma vectorial (beta): rasgos de la escritura + una senal externa (etiqueta cerca o raya debajo); jamas «probable». */

const sigLabel = label("signature", { box: { x: 150, y: 650, width: 60, height: 10 } });
const noVectors: PageVectors = { pageIndex: 0, candidates: [], lines: [] };
const underLine: PageVectors = { pageIndex: 0, candidates: [], lines: [{ x0: 140, x1: 300, y: 650 }] };
const judge = (over = {}, labels: LabelFact[] = [sigLabel], vectors: PageVectors = noVectors, facts = page(0)) => judgeVector(vectorCandidate(over), facts, vectors, labels);

describe("judgeVector · aceptacion", () => {
  it("una escritura con bucles junto a «Firma»: firma beta, nunca probable (0,70 tope)", () => {
    const r = judge();
    expect(r?.kind).toBe("signature");
    expect(r?.confidence).toBe(0.7);
    expect(r?.reasons[0]).toBe("firma dibujada con trazos vectoriales (beta)");
    expect(r?.reasons[1]).toBe("40 curvas y 6 bucles");
    expect(r?.reasons).toContain("tinta azul");
    expect(r?.reasons).toContain("cerca de «Firma»");
  });
  it("sin etiqueta pero sobre una raya de firma: 0,5-0,6", () => {
    const r = judge({}, [], underLine);
    expect(r?.kind).toBe("signature");
    expect(r?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r?.confidence).toBeLessThan(0.7);
    expect(r?.reasons).toContain("sobre una raya de firma");
  });
  it("sin etiqueta ni raya NO se ofrece (un garabato decorativo no es una firma)", () => {
    expect(judge({}, [], noVectors)).toBeNull();
  });
  it("la etiqueta de iniciales la convierte en iniciales (si es pequena y casi cuadrada)", () => {
    const ini = label("initials", { box: { x: 150, y: 650, width: 40, height: 10 } });
    const r = judge({ bbox: { x: 150, y: 600, width: 50, height: 36 }, rect: { x: 0.24, y: 0.76, width: 0.08, height: 0.045 } }, [ini]);
    expect(r?.kind).toBe("initials");
  });
  it("las iniciales: proporcion >= 0,6 y area <= 4 % de la pagina; una firma con etiqueta de iniciales demasiado ancha no", () => {
    const ini = label("initials", { box: { x: 150, y: 650, width: 40, height: 10 } });
    expect(judge({ bbox: { x: 150, y: 600, width: 200, height: 40 } }, [ini])?.kind).toBe("initials"); // aspecto 5: limite
    expect(judge({ bbox: { x: 150, y: 600, width: 204, height: 40 } }, [ini])).toBeNull(); // aspecto 5,1
    expect(judge({ bbox: { x: 150, y: 600, width: 50, height: 90 }, rect: { x: 0.24, y: 0.76, width: 0.08, height: 0.11 } }, [ini])).toBeNull(); // aspecto 0,55
    expect(judge({ rect: { x: 0.24, y: 0.76, width: 0.3, height: 0.2 }, bbox: { x: 150, y: 600, width: 80, height: 70 } }, [ini])).toBeNull(); // area 6 %
  });
  it("tinta oscura tambien vale y se nombra", () => {
    const r = judge({ color: "#101010" });
    expect(r?.reasons).toContain("tinta oscura");
    expect(r?.reasons).not.toContain("tinta azul");
  });
  it("tinta azul clara (luminancia > 150 pero azul) vale", () => {
    expect(judge({ color: "#5a78ff" })?.kind).toBe("signature");
  });
  it("proporcion de firma suma; una firma casi cuadrada con etiqueta se ofrece con menos confianza", () => {
    const wide = judge();
    const square = judge({ bbox: { x: 150, y: 600, width: 50, height: 40 } });
    expect(square?.kind).toBe("signature");
    expect((square?.confidence ?? 1) <= (wide?.confidence ?? 0)).toBe(true);
    expect(judge({ bbox: { x: 150, y: 600, width: 50, height: 90 }, rect: { x: 0.24, y: 0.76, width: 0.08, height: 0.11 } })).toBeNull();
  });
});

describe("judgeVector · rechazo (cada rasgo con su limite)", () => {
  it("tamano: >= 20 x 6 pt, <= 60 % del ancho y 15 % del alto de la pagina", () => {
    const at = (width: number, height: number) => {
      const bbox = { x: 150, y: 600, width, height };
      const near = label("signature", { box: { x: 150, y: 600 + height + 3, width: 60, height: 10 } });
      return judge({ bbox, rect: { x: 150 / 612, y: 600 / 792, width: width / 612, height: height / 792 } }, [near]);
    };
    expect(at(20, 6)).not.toBeNull();
    expect(at(19, 6)).toBeNull();
    expect(at(60, 5)).toBeNull();
    expect(at(367, 40)).not.toBeNull();
    expect(at(368, 40)).toBeNull();
    expect(at(100, 118)).not.toBeNull();
    expect(at(100, 119)).toBeNull();
  });
  it("complejidad: >= 8 curvas o >= 40 segmentos", () => {
    expect(judge({ curves: 8, segments: 8 })).not.toBeNull();
    expect(judge({ curves: 7, segments: 39 })).toBeNull();
    expect(judge({ curves: 0, segments: 40 })).not.toBeNull();
  });
  it("rectas: como mucho 35 % de segmentos horizontales o verticales", () => {
    expect(judge({ axisAligned: 0.35 })).not.toBeNull();
    expect(judge({ axisAligned: 0.36 })).toBeNull();
  });
  it("marcadores cerrados (grafico de puntos): menos del 50 % de los trazos", () => {
    expect(judge({ shapeShare: 0.49 })).not.toBeNull();
    expect(judge({ shapeShare: 0.5 })).toBeNull();
  });
  it("bucles: al menos 2 cambios de sentido horizontal (una curva monotona de un grafico no es una firma)", () => {
    expect(judge({ xReversals: 2 })).not.toBeNull();
    expect(judge({ xReversals: 1 })).toBeNull();
  });
  it("tinta clara no azul (gris, trazo de cuadricula) no", () => {
    expect(judge({ color: "#969696" })).not.toBeNull(); // luminancia 150: limite
    expect(judge({ color: "#979797" })).toBeNull(); // 151
    expect(judge({ color: "#7a7a7a" })).not.toBeNull();
  });
  it("texto impreso dentro de la caja: no mas del 20 %", () => {
    const covered = page(0, [line("TEXTO", 150, 600, 140, 8)]); // 8 x 140 de 40 x 140 = 20 %
    expect(judge({}, [sigLabel], noVectors, covered)).not.toBeNull();
    const heavy = page(0, [line("TEXTO", 150, 600, 140, 9)]);
    expect(judge({}, [sigLabel], noVectors, heavy)).toBeNull();
  });
  it("sin hechos de pagina usa tamano de carta", () => {
    expect(judgeVector(vectorCandidate(), undefined, noVectors, [sigLabel])?.kind).toBe("signature");
  });
  it("etiqueta lejana (> 2 lineas) no cuenta; raya lejana (> 24 pt) tampoco", () => {
    const far = label("signature", { box: { x: 150, y: 700, width: 60, height: 10 } });
    expect(judge({}, [far])).toBeNull();
    expect(judge({}, [], { pageIndex: 0, candidates: [], lines: [{ x0: 140, x1: 300, y: 666 }] })).toBeNull();
  });
});
