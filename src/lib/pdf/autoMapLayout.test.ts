import { describe, expect, it } from "vitest";
import {
  INITIAL_MIN_W_EM,
  PAGE_MARGIN_FRACTION,
  coverage,
  layoutInitials,
  layoutLine,
  layoutSignature,
  pageEm,
  rectWidth,
  toNormalized,
  type LayoutEnv,
} from "@/lib/pdf/autoMapLayout";

const env: LayoutEnv = { em: 11, pageWidth: 612, pageHeight: 792 };
const minW = INITIAL_MIN_W_EM * env.em;

describe("layoutInitials", () => {
  it("un firmante: una casilla centrada sobre la raya, nunca menor que una inicial", () => {
    const wide = layoutInitials({ x0: 400, x1: 520, y: 100 }, 1, env);
    expect(wide.rects).toHaveLength(1);
    expect(wide.mode).toBe("single");
    const r = wide.rects[0];
    expect(rectWidth(r)).toBeGreaterThanOrEqual(minW - 1e-9);
    expect(r.x0).toBeGreaterThanOrEqual(400);
    expect(r.x1).toBeLessThanOrEqual(520);
    expect(r.y0).toBeGreaterThan(100);

    const tiny = layoutInitials({ x0: 400, x1: 420, y: 100 }, 1, env);
    expect(rectWidth(tiny.rects[0])).toBeCloseTo(minW, 6);
    expect(tiny.tight).toBe(true);
  });

  it("dos firmantes sobre una raya larga: dos mitades, el firmante 1 a la izquierda", () => {
    const layout = layoutInitials({ x0: 400, x1: 560, y: 100 }, 2, env);
    expect(layout.mode).toBe("halves");
    const [a, b] = layout.rects;
    expect(a.x1).toBeLessThanOrEqual(b.x0);
    expect(a.x0).toBeGreaterThanOrEqual(400);
    expect(b.x1).toBeLessThanOrEqual(560);
    // Mitades iguales
    expect(rectWidth(a)).toBeCloseTo(rectWidth(b), 6);
    // Cada una dentro de su mitad
    expect((a.x0 + a.x1) / 2).toBeLessThan(480);
    expect((b.x0 + b.x1) / 2).toBeGreaterThan(480);
  });

  it("el limite entre «mitades» y «contiguas» es el doble de una inicial", () => {
    const justShort = layoutInitials({ x0: 300, x1: 300 + 2 * minW - 1, y: 100 }, 2, env);
    expect(justShort.mode).toBe("contiguous");
    const justLong = layoutInitials({ x0: 300, x1: 300 + 2 * minW + 0.3 * env.em + 1, y: 100 }, 2, env);
    expect(justLong.mode).toBe("halves");
  });

  it("raya corta: dos casillas contiguas desde el inicio de la raya y dentro del margen", () => {
    const layout = layoutInitials({ x0: 505, x1: 551, y: 100, labelRight: 500 }, 2, env);
    expect(layout.mode).toBe("contiguous");
    const [a, b] = layout.rects;
    expect(a.x1).toBeLessThanOrEqual(b.x0);
    expect(b.x1).toBeLessThanOrEqual(612 - PAGE_MARGIN_FRACTION * 612 + 1e-6);
    expect(a.x0).toBeGreaterThanOrEqual(500);
    expect(layout.tight).toBe(true);
  });

  it("raya corta cerca del borde: se desplaza a la izquierda, no mas alla de la etiqueta", () => {
    const layout = layoutInitials({ x0: 520, x1: 566, y: 100, labelRight: 505 }, 2, env);
    expect(layout.tight).toBe(true);
    expect(layout.rects[1].x1).toBeLessThanOrEqual(612 * (1 - PAGE_MARGIN_FRACTION) + 1e-6);
    expect(layout.rects[0].x0).toBeGreaterThanOrEqual(505);
  });

  it("raya corta en mitad de pagina: arranca justo en la raya sin desplazarse", () => {
    const layout = layoutInitials({ x0: 200, x1: 246, y: 100 }, 2, env);
    expect(layout.rects[0].x0).toBe(200);
    expect(layout.tight).toBe(false);
  });

  it("marcas «(__/__)» del propio documento: una por firmante en su orden", () => {
    const layout = layoutInitials({ x0: 100, x1: 210, y: 100, slots: [{ x0: 100, x1: 150 }, { x0: 160, x1: 210 }], fromText: true }, 2, env);
    expect(layout.mode).toBe("slots");
    expect(layout.rects).toHaveLength(2);
    expect((layout.rects[0].x0 + layout.rects[0].x1) / 2).toBeCloseTo(125, 5);
    expect((layout.rects[1].x0 + layout.rects[1].x1) / 2).toBeCloseTo(185, 5);
    const single = layoutInitials({ x0: 100, x1: 210, y: 100, slots: [{ x0: 100, x1: 150 }, { x0: 160, x1: 210 }], fromText: true }, 1, env);
    expect(single.rects).toHaveLength(1);
    expect((single.rects[0].x0 + single.rects[0].x1) / 2).toBeCloseTo(125, 5);
  });

  it("marcas muy juntas: las casillas no se solapan", () => {
    const layout = layoutInitials({ x0: 100, x1: 160, y: 100, slots: [{ x0: 100, x1: 128 }, { x0: 132, x1: 160 }], fromText: true }, 2, env);
    expect(layout.rects[0].x1).toBeLessThanOrEqual(layout.rects[1].x0);
    expect(layout.tight).toBe(true);
  });

  it("casilla vacia: la propia casilla, y dos mitades con dos firmantes", () => {
    const box = { x0: 450, y0: 40, x1: 550, y1: 70 };
    const one = layoutInitials({ x0: 450, x1: 550, y: 40, box }, 1, env);
    expect(one.rects[0]).toEqual({ x0: 450, y0: 40, x1: 550, y1: 70 });
    const two = layoutInitials({ x0: 450, x1: 550, y: 40, box }, 2, env);
    expect(two.rects[0].x1).toBeLessThanOrEqual(two.rects[1].x0);
    expect(two.rects[0].y0).toBe(40);
    expect(two.rects[1].x1).toBe(550);
  });

  it("la raya de un texto de subrayados se centra sobre su fila de texto", () => {
    const fromText = layoutInitials({ x0: 100, x1: 200, y: 100, fromText: true }, 1, env);
    const vector = layoutInitials({ x0: 100, x1: 200, y: 100 }, 1, env);
    expect(fromText.rects[0].y0).toBeLessThan(vector.rects[0].y0);
  });
});

describe("layoutSignature", () => {
  it("ocupa el ancho de la raya y ~3,6 em hacia arriba", () => {
    const { rect, blocked } = layoutSignature({ x0: 100, x1: 300, y: 200 }, env, []);
    expect(blocked).toBe(false);
    expect(rect.x0).toBe(100);
    expect(rect.x1).toBe(300);
    expect(rect.y1 - rect.y0).toBeCloseTo(3.6 * env.em, 6);
    expect(rect.y0).toBeGreaterThan(200);
  });

  it("acota el ancho a la mitad de la pagina", () => {
    const { rect } = layoutSignature({ x0: 50, x1: 560, y: 200 }, env, []);
    expect(rect.x1 - rect.x0).toBeCloseTo(0.5 * 612, 6);
  });

  it("ensancha una raya muy corta", () => {
    const { rect } = layoutSignature({ x0: 100, x1: 110, y: 200 }, env, []);
    expect(rect.x1 - rect.x0).toBeGreaterThanOrEqual(6 * env.em - 1e-6);
  });

  it("no cubre el texto de arriba: recorta la altura", () => {
    const text = { x0: 100, x1: 300, y0: 200 + 2.4 * env.em, y1: 200 + 3.4 * env.em };
    const { rect, blocked } = layoutSignature({ x0: 100, x1: 300, y: 200 }, env, [text]);
    expect(rect.y1).toBeLessThanOrEqual(text.y0);
    expect(blocked).toBe(false);
  });

  it("queda bloqueada si casi no hay sitio libre", () => {
    const text = { x0: 100, x1: 300, y0: 200 + 1.2 * env.em, y1: 200 + 2.2 * env.em };
    const { blocked } = layoutSignature({ x0: 100, x1: 300, y: 200 }, env, [text]);
    expect(blocked).toBe(true);
  });

  it("ignora el texto que esta a otro lado", () => {
    const text = { x0: 400, x1: 560, y0: 200 + 1.2 * env.em, y1: 200 + 2.2 * env.em };
    const { blocked, rect } = layoutSignature({ x0: 100, x1: 300, y: 200 }, env, [text]);
    expect(blocked).toBe(false);
    expect(rect.y1 - rect.y0).toBeCloseTo(3.6 * env.em, 6);
  });
});

describe("layoutLine, cobertura y normalizacion", () => {
  it("un hueco de texto ocupa el ancho de la raya", () => {
    const rect = layoutLine({ x0: 100, x1: 250, y: 300 }, 1.7, env);
    expect(rect.x0).toBe(100);
    expect(rect.x1).toBe(250);
    expect(rect.y1 - rect.y0).toBeCloseTo(1.7 * env.em, 6);
  });

  it("cobertura: fraccion del rectangulo ocupada por texto", () => {
    const rect = { x0: 0, y0: 0, x1: 100, y1: 10 };
    expect(coverage(rect, [])).toBe(0);
    expect(coverage(rect, [{ x0: 0, y0: 0, x1: 50, y1: 10 }])).toBeCloseTo(0.5, 6);
    expect(coverage(rect, [{ x0: 200, y0: 0, x1: 300, y1: 10 }])).toBe(0);
    expect(coverage(rect, [{ x0: -10, y0: -10, x1: 200, y1: 200 }])).toBe(1);
  });

  it("normaliza con origen arriba-izquierda y acota a la pagina", () => {
    const n = toNormalized({ x0: 61.2, y0: 79.2, x1: 183.6, y1: 118.8 }, 612, 792);
    expect(n.x).toBeCloseTo(0.1, 6);
    expect(n.width).toBeCloseTo(0.2, 6);
    expect(n.y).toBeCloseTo(1 - 118.8 / 792, 6);
    expect(n.height).toBeCloseTo(0.05, 6);
    const clipped = toNormalized({ x0: -20, y0: -5, x1: 700, y1: 900 }, 612, 792);
    expect(clipped).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("el «em» es una fraccion del ancho de la pagina", () => {
    expect(pageEm(612)).toBeCloseTo(11.016, 3);
    expect(pageEm(1224)).toBeCloseTo(2 * pageEm(612), 6);
  });
});
