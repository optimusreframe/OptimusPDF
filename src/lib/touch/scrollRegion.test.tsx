import { afterEach, describe, expect, it } from "vitest";
import { findScrollParent, freeRegion, measureObstructions, scrollVerticallyBy } from "@/lib/touch/scrollRegion";

/** Caja de pruebas: jsdom no hace layout, asi que cada elemento declara su rectangulo. */
function bar(css: string, rect: { top: number; bottom: number; left?: number; right?: number }, attrs: Record<string, string> = {}) {
  const el = document.createElement("div");
  el.style.cssText = css;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  const left = rect.left ?? 0;
  const right = rect.right ?? 400;
  el.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.bottom, left, right, width: right - left, height: rect.bottom - rect.top, x: left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findScrollParent", () => {
  it("devuelve el ancestro con desplazamiento vertical", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 900, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 300, configurable: true });
    const child = document.createElement("div");
    scroller.append(child);
    document.body.append(scroller);
    expect(findScrollParent(child)).toBe(scroller);
  });

  it("sin ancestro desplazable cae al scroller del documento", () => {
    const child = document.createElement("div");
    document.body.append(child);
    expect(findScrollParent(child)).toBe(document.scrollingElement ?? document.documentElement);
  });

  it("ignora un `overflow: auto` que no desborda", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const child = document.createElement("div");
    scroller.append(child);
    document.body.append(scroller);
    expect(findScrollParent(child)).not.toBe(scroller);
  });
});

describe("measureObstructions · barras fijas y pegajosas", () => {
  const box = { left: 0, top: 0, right: 400, bottom: 700 };

  it("mide la cabecera pegajosa de arriba y las barras fijas de abajo", () => {
    bar("position: sticky", { top: 0, bottom: 56 }, { "data-fixed-chrome": "" });
    bar("position: sticky", { top: 64, bottom: 118 }, { "data-canvas-sticky": "" });
    bar("position: fixed", { top: 600, bottom: 654 }, { role: "toolbar" });
    bar("position: fixed", { top: 628, bottom: 700 }, { "data-chrome": "tabbar" });
    expect(measureObstructions(box)).toEqual({ top: 118, bottom: 100 });
  });

  it("ignora lo que no es barra: estrechos, estaticos u ocultos", () => {
    bar("position: static", { top: 0, bottom: 56 }, { "data-fixed-chrome": "" });
    bar("position: fixed", { top: 0, bottom: 56, left: 0, right: 100 }, { "data-fixed-chrome": "" });
    bar("position: fixed; visibility: hidden", { top: 640, bottom: 700 }, { "data-fixed-chrome": "" });
    expect(measureObstructions(box)).toEqual({ top: 0, bottom: 0 });
  });

  it("freeRegion descuenta las barras de la caja visible del scroller", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 700, configurable: true });
    scroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 700, left: 0, right: 400, width: 400, height: 700, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(scroller);
    bar("position: sticky", { top: 0, bottom: 60 }, { "data-fixed-chrome": "" });
    bar("position: fixed", { top: 640, bottom: 700 }, { "data-fixed-chrome": "" });
    expect(freeRegion(scroller)).toEqual({ left: 0, right: 400, top: 60, bottom: 640 });
  });
});

describe("scrollVerticallyBy", () => {
  it("desplaza y devuelve lo que se movio de verdad (el tope lo limita)", () => {
    const el = document.createElement("div");
    let top = 0;
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, 100));
      },
      configurable: true,
    });
    expect(scrollVerticallyBy(el, 70)).toBe(70);
    expect(scrollVerticallyBy(el, 70)).toBe(30);
    expect(scrollVerticallyBy(el, 10)).toBe(0);
    expect(scrollVerticallyBy(el, -400)).toBe(-100);
  });
});
