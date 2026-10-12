import { describe, expect, it } from "vitest";
import { resolvePageScope } from "@/app/pdf-pro/export/pageScope";

describe("resolvePageScope", () => {
  it("todas: sin lista de paginas (el motor exporta el documento entero)", () => {
    expect(resolvePageScope({ scope: "all", range: "" }, 12)).toEqual({ ok: true, pages: undefined, count: 12 });
  });

  it("rango: '1-3, 5' son las paginas 0,1,2,4 (base 0)", () => {
    expect(resolvePageScope({ scope: "range", range: "1-3, 5" }, 10)).toEqual({ ok: true, pages: [0, 1, 2, 4], count: 4 });
  });

  it("rango: orden y repetidos se normalizan", () => {
    expect(resolvePageScope({ scope: "range", range: "5, 2-3, 3" }, 10)).toEqual({ ok: true, pages: [1, 2, 4], count: 3 });
  });

  it("rango: acepta guiones largos y espacios", () => {
    expect(resolvePageScope({ scope: "range", range: "2 – 4" }, 10)).toEqual({ ok: true, pages: [1, 2, 3], count: 3 });
  });

  it("rango vacio: motivo rangeEmpty", () => {
    expect(resolvePageScope({ scope: "range", range: "  " }, 10)).toEqual({ ok: false, reason: "rangeEmpty" });
  });

  it("rango fuera del documento o mal escrito: rangeInvalid", () => {
    expect(resolvePageScope({ scope: "range", range: "7-9" }, 3)).toEqual({ ok: false, reason: "rangeInvalid" });
    expect(resolvePageScope({ scope: "range", range: "abc" }, 3)).toEqual({ ok: false, reason: "rangeInvalid" });
    expect(resolvePageScope({ scope: "range", range: "3-1" }, 5)).toEqual({ ok: false, reason: "rangeInvalid" });
    expect(resolvePageScope({ scope: "range", range: "0" }, 5)).toEqual({ ok: false, reason: "rangeInvalid" });
  });

  it("seleccion: usa las paginas elegidas, ordenadas y sin repetir", () => {
    expect(resolvePageScope({ scope: "selected", range: "" }, 10, [4, 1, 4, 2])).toEqual({ ok: true, pages: [1, 2, 4], count: 3 });
  });

  it("seleccion: descarta las que ya no existen (el documento cambio)", () => {
    expect(resolvePageScope({ scope: "selected", range: "" }, 3, [1, 7, -1, 2.5])).toEqual({ ok: true, pages: [1], count: 1 });
  });

  it("seleccion vacia: motivo selectionEmpty", () => {
    expect(resolvePageScope({ scope: "selected", range: "" }, 10, [])).toEqual({ ok: false, reason: "selectionEmpty" });
    expect(resolvePageScope({ scope: "selected", range: "" }, 2, [5])).toEqual({ ok: false, reason: "selectionEmpty" });
  });

  it("el texto del rango se ignora cuando el alcance es 'todas' o 'seleccionadas'", () => {
    expect(resolvePageScope({ scope: "all", range: "x" }, 4).ok).toBe(true);
    expect(resolvePageScope({ scope: "selected", range: "x" }, 4, [0]).ok).toBe(true);
  });
});
