import { afterEach, describe, expect, it, vi } from "vitest";
import { isIosWebKit, setIosWebkitOverride } from "@/lib/image/platform";

function withNavigator(value: Partial<Navigator>, run: () => void): void {
  vi.stubGlobal("navigator", value);
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => setIosWebkitOverride(null));

describe("isIosWebKit", () => {
  it("iPhone y iPad por agente de usuario", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", maxTouchPoints: 5 }, () => expect(isIosWebKit()).toBe(true));
    withNavigator({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15", maxTouchPoints: 5 }, () => expect(isIosWebKit()).toBe(true));
  });

  it("un iPad con «sitio de escritorio» se presenta como Mac pero tiene pantalla tactil", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", maxTouchPoints: 5 }, () => expect(isIosWebKit()).toBe(true));
  });

  it("un Mac real, Windows o Android no son iOS", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", maxTouchPoints: 0 }, () => expect(isIosWebKit()).toBe(false));
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36", maxTouchPoints: 0 }, () => expect(isIosWebKit()).toBe(false));
    withNavigator({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537.36", maxTouchPoints: 5 }, () => expect(isIosWebKit()).toBe(false));
  });

  it("sin navegador (servidor) no es iOS, y se puede forzar en pruebas", () => {
    expect(isIosWebKit()).toBe(false);
    setIosWebkitOverride(true);
    expect(isIosWebKit()).toBe(true);
  });
});
