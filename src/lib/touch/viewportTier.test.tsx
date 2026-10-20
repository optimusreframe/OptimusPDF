import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACT_CHROME_MAX_WIDTH,
  DESKTOP_MIN_WIDTH,
  TABLET_MIN_WIDTH,
  parseViewportSnapshot,
  useViewportTier,
  viewportTierOf,
} from "@/lib/touch/viewportTier";

describe("viewportTierOf · el contrato de anchos (M3)", () => {
  it("iPhone y iPad mini en vertical son `phone`", () => {
    for (const width of [320, 375, 393, 430, 744, TABLET_MIN_WIDTH - 1]) expect(viewportTierOf(width), `${width}`).toBe("phone");
  });

  it("iPad Pro 11 en VERTICAL (834) y las tabletas de 800 px son `tablet`, no escritorio (GE-02)", () => {
    for (const width of [TABLET_MIN_WIDTH, 800, 834, 1023]) expect(viewportTierOf(width), `${width}`).toBe("tablet");
  });

  it("desde 1024 px es `desktop` (paneles laterales)", () => {
    for (const width of [DESKTOP_MIN_WIDTH, 1194, 1440]) expect(viewportTierOf(width), `${width}`).toBe("desktop");
  });
});

describe("parseViewportSnapshot", () => {
  it("`compact` = dedo y menos de 1280 px (iPad horizontal): pliega la barra lateral global", () => {
    // [tablet, desktop, wide, coarse]
    expect(parseViewportSnapshot("1101")).toEqual({ tier: "desktop", coarse: true, compact: true });
    expect(parseViewportSnapshot("1111")).toEqual({ tier: "desktop", coarse: true, compact: false });
    expect(parseViewportSnapshot("1110")).toEqual({ tier: "desktop", coarse: false, compact: false });
    expect(parseViewportSnapshot("1001")).toEqual({ tier: "tablet", coarse: true, compact: true });
    expect(parseViewportSnapshot("0001")).toEqual({ tier: "phone", coarse: true, compact: true });
  });

  it("el umbral de `wide` es 1280 px", () => {
    expect(COMPACT_CHROME_MAX_WIDTH).toBe(1280);
  });
});

describe("useViewportTier", () => {
  const listeners = new Set<() => void>();
  let width = 834;
  let coarse = true;
  const original = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = ((query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return {
        get matches() {
          if (min) return width >= Number(min[1]);
          return query.includes("pointer: coarse") ? coarse : false;
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = original;
    listeners.clear();
  });

  function Probe() {
    const info = useViewportTier();
    return <p data-testid="tier">{`${info.tier}|${info.coarse}|${info.compact}`}</p>;
  }

  it("lee el ancho y el puntero, y reacciona a girar el aparato", () => {
    width = 834;
    coarse = true;
    render(<Probe />);
    expect(screen.getByTestId("tier").textContent).toBe("tablet|true|true");
    width = 1194;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(screen.getByTestId("tier").textContent).toBe("desktop|true|true");
    width = 1440;
    coarse = false;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(screen.getByTestId("tier").textContent).toBe("desktop|false|false");
  });
});
