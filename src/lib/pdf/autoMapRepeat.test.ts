import { describe, expect, it } from "vitest";
import { DEFAULT_REPEAT, clusterRepeats } from "@/lib/pdf/autoMapRepeat";
import type { LineInfo, PageAnalysis } from "@/lib/pdf/autoMapPage";

const W = 612;
const H = 792;

function page(pageIndex: number, lines: Array<{ x0: number; x1: number; y: number }>, hasText = true): PageAnalysis {
  return {
    pageIndex,
    width: W,
    height: H,
    hasText,
    candidates: [],
    unlabeledShortLines: lines.map((l) => ({ pageIndex, x0: l.x0, x1: l.x1, y: l.y, line: { ...l, thickness: 0.7, fromText: -1, dashed: false } as LineInfo })),
    textBoxes: [],
    signatureLines: 0,
    initialsHosts: 0,
    complex: false,
  };
}

const corner = { x0: 440, x1: 520, y: 60 };
const shifted = (dx: number, dy: number, dw = 0) => ({ x0: corner.x0 + dx, x1: corner.x1 + dx + dw, y: corner.y + dy });

describe("clusterRepeats", () => {
  it("agrupa una raya que se repite en casi la misma posicion", () => {
    const pages = [0, 1, 2, 3, 4].map((i) => page(i, [shifted(i, 0.5)]));
    const clusters = clusterRepeats(pages);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(5);
    expect(clusters[0].pageRatio).toBe(1);
  });

  it("la tolerancia horizontal es del 2,5 % de la pagina", () => {
    const inside = [0, 1, 2, 3].map((i) => page(i, [shifted(i === 0 ? 0 : 0.02 * W, 0)]));
    expect(clusterRepeats(inside)).toHaveLength(1);
    const outside = [0, 1, 2, 3].map((i) => page(i, [shifted(i === 0 ? 0 : 0.04 * W, 0)]));
    // La primera queda sola y las otras tres siguen formando un grupo
    const clusters = clusterRepeats(outside);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(3);
  });

  it("la tolerancia vertical es del 2 % de la pagina", () => {
    const inside = [0, 1, 2, 3].map((i) => page(i, [shifted(0, i === 0 ? 0 : 0.015 * H)]));
    expect(clusterRepeats(inside)[0].members).toHaveLength(4);
    const outside = [0, 1, 2, 3].map((i) => page(i, [shifted(0, i === 0 ? 0 : 0.035 * H)]));
    expect(clusterRepeats(outside)[0].members).toHaveLength(3);
  });

  it("rayas de largo muy distinto (con el mismo centro) no se agrupan", () => {
    const wide = (i: number) => (i % 2 === 0 ? corner : { x0: corner.x0 - 80, x1: corner.x1 + 80, y: corner.y });
    const pages = [0, 1, 2, 3].map((i) => page(i, [wide(i)]));
    const clusters = clusterRepeats(pages);
    expect(clusters.every((c) => c.members.length <= 2)).toBe(true);
  });

  it("hace falta que se repita en el 60 % de las paginas con texto (y en 2 como minimo)", () => {
    const some = (n: number, total: number) => Array.from({ length: total }, (_, i) => page(i, i < n ? [shifted(0, 0)] : []));
    expect(clusterRepeats(some(5, 10))).toHaveLength(0);
    expect(clusterRepeats(some(6, 10))).toHaveLength(1);
    expect(clusterRepeats(some(1, 2))).toHaveLength(0);
    expect(clusterRepeats(some(2, 2))).toHaveLength(1);
  });

  it("las paginas sin texto no cuentan para la fraccion", () => {
    const pages = [page(0, [shifted(0, 0)]), page(1, [shifted(0, 0)]), page(2, [], false), page(3, [], false), page(4, [], false)];
    expect(clusterRepeats(pages)).toHaveLength(1);
  });

  it("un grupo admite una sola raya por pagina", () => {
    const pages = [0, 1, 2].map((i) => page(i, [shifted(0, 0), shifted(1, 0.5)]));
    const clusters = clusterRepeats(pages);
    expect(clusters.every((c) => new Set(c.members.map((m) => m.page.pageIndex)).size === c.members.length)).toBe(true);
  });

  it("dos posiciones distintas dan dos grupos", () => {
    const pages = [0, 1, 2, 3].map((i) => page(i, [shifted(0, 0), { x0: 60, x1: 140, y: 60 }]));
    expect(clusterRepeats(pages)).toHaveLength(2);
  });

  it("sin dos paginas con texto no hay repeticion", () => {
    expect(clusterRepeats([page(0, [shifted(0, 0)])])).toHaveLength(0);
    expect(clusterRepeats([])).toHaveLength(0);
  });

  it("valores por defecto", () => {
    expect(DEFAULT_REPEAT).toMatchObject({ tolX: 0.025, tolY: 0.02, minPageRatio: 0.6, minPages: 2 });
  });
});
