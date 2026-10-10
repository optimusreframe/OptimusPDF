import { describe, expect, it } from "vitest";
import { usableViewportBottom } from "@/app/sign-pdf/FloatingFieldBar";

/** Con el teclado virtual abierto la barra flotante no debe quedar detras (W5-U4b). */
describe("usableViewportBottom", () => {
  it("sin visualViewport es la altura de la ventana", () => {
    expect(usableViewportBottom({ innerHeight: 812 })).toBe(812);
    expect(usableViewportBottom({ innerHeight: 812, visualViewport: null })).toBe(812);
  });

  it("con el teclado abierto es el borde inferior de la ventana visual", () => {
    expect(usableViewportBottom({ innerHeight: 812, visualViewport: { offsetTop: 0, height: 480 } })).toBe(480);
  });

  it("cuenta el desplazamiento de la ventana visual", () => {
    expect(usableViewportBottom({ innerHeight: 812, visualViewport: { offsetTop: 60, height: 480 } })).toBe(540);
  });

  it("nunca pasa de innerHeight", () => {
    expect(usableViewportBottom({ innerHeight: 600, visualViewport: { offsetTop: 100, height: 800 } })).toBe(600);
  });

  it("una ventana visual sin altura (valores raros) se ignora", () => {
    expect(usableViewportBottom({ innerHeight: 700, visualViewport: { offsetTop: 0, height: 0 } })).toBe(700);
    expect(usableViewportBottom({ innerHeight: 700, visualViewport: { offsetTop: 0, height: Number.NaN } })).toBe(700);
  });
});

import { barViewportBottom } from "@/app/sign-pdf/FloatingFieldBar";

describe("barViewportBottom — Firmar conserva innerHeight (W5)", () => {
  const keyboard = { innerHeight: 812, visualViewport: { offsetTop: 0, height: 480 } };

  it("sin viewportAware es SIEMPRE innerHeight, como antes de la Wave 5 (algoritmo original)", () => {
    const original = (win: { innerHeight: number }) => win.innerHeight;
    for (const win of [
      keyboard,
      { innerHeight: 600, visualViewport: { offsetTop: 100, height: 300 } },
      { innerHeight: 700 },
      { innerHeight: 700, visualViewport: null },
    ]) {
      expect(barViewportBottom(win, false)).toBe(original(win));
    }
  });

  it("con viewportAware (Editar) mide la ventana visual", () => {
    expect(barViewportBottom(keyboard, true)).toBe(480);
    expect(barViewportBottom({ innerHeight: 700 }, true)).toBe(700);
  });
});
