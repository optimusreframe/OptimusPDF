import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetReducedMotionPrefCache,
  useReducedMotionPref,
} from "./useReducedMotionPref";

type Listener = (event: MediaQueryListEvent) => void;

/** matchMedia falso con control manual de `matches` y del evento change. */
function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: "change", cb: Listener) => listeners.add(cb),
    removeEventListener: (_: "change", cb: Listener) => listeners.delete(cb),
  };
  const matchMedia = vi.fn(() => mql as unknown as MediaQueryList);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    matchMedia,
    setMatches(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe("useReducedMotionPref", () => {
  beforeEach(() => resetReducedMotionPrefCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetReducedMotionPrefCache();
  });

  it("el PRIMER render ya devuelve true si el sistema pide reducir movimiento", () => {
    const media = installMatchMedia(true);
    const renders: boolean[] = [];
    renderHook(() => {
      const v = useReducedMotionPref();
      renders.push(v);
      return v;
    });
    expect(renders[0]).toBe(true);
    expect(media.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("devuelve false desde el primer render si no hay preferencia", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useReducedMotionPref());
    expect(result.current).toBe(false);
  });

  it("reacciona al evento change y se desuscribe al desmontar", () => {
    const media = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useReducedMotionPref());
    expect(result.current).toBe(false);
    expect(media.listenerCount()).toBe(1);

    act(() => media.setMatches(true));
    expect(result.current).toBe(true);

    act(() => media.setMatches(false));
    expect(result.current).toBe(false);

    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it("sin matchMedia (entorno sin soporte) devuelve false y no revienta", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useReducedMotionPref());
    expect(result.current).toBe(false);
  });
});
