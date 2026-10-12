import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAYOUT_PREFS,
  PRO_LAYOUT_STORAGE_KEY,
  THUMBS_WIDTH,
  loadLayoutPrefs,
  saveLayoutPrefs,
  useProLayout,
} from "@/app/pdf-pro/shell/proLayout";

beforeEach(() => window.localStorage.removeItem(PRO_LAYOUT_STORAGE_KEY));
afterEach(() => vi.restoreAllMocks());

describe("persistencia local de la distribucion", () => {
  it("guarda y lee lo mismo", () => {
    saveLayoutPrefs({ thumbsWidth: 210, contextWidth: 420, thumbsOpen: false, contextOpen: true });
    expect(loadLayoutPrefs()).toEqual({ thumbsWidth: 210, contextWidth: 420, thumbsOpen: false, contextOpen: true });
  });

  it("solo guarda numeros y booleanos (nada sensible)", () => {
    saveLayoutPrefs(DEFAULT_LAYOUT_PREFS);
    const stored = JSON.parse(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["contextOpen", "contextWidth", "thumbsOpen", "thumbsWidth"]);
    for (const value of Object.values(stored)) expect(["number", "boolean"]).toContain(typeof value);
  });

  it("un JSON roto o ajeno vuelve a los valores por defecto", () => {
    window.localStorage.setItem(PRO_LAYOUT_STORAGE_KEY, "{no es json");
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
    window.localStorage.setItem(PRO_LAYOUT_STORAGE_KEY, JSON.stringify({ thumbsWidth: "x", evil: 1 }));
    expect(loadLayoutPrefs().thumbsWidth).toBe(THUMBS_WIDTH.def);
  });

  it("si el almacenamiento lanza (modo privado) no rompe nada", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(() => saveLayoutPrefs(DEFAULT_LAYOUT_PREFS)).not.toThrow();
  });
});

describe("useProLayout", () => {
  it("arranca con lo guardado", () => {
    saveLayoutPrefs({ thumbsWidth: 250, contextWidth: 300, thumbsOpen: true, contextOpen: false });
    const { result } = renderHook(() => useProLayout());
    expect(result.current.prefs.thumbsWidth).toBe(250);
    expect(result.current.prefs.contextOpen).toBe(false);
  });

  it("update cambia y guarda; con persist=false solo cambia hasta commit (arrastre de un tirador)", () => {
    const { result } = renderHook(() => useProLayout());
    act(() => result.current.update({ thumbsWidth: 200 }, false));
    expect(result.current.prefs.thumbsWidth).toBe(200);
    expect(window.localStorage.getItem(PRO_LAYOUT_STORAGE_KEY)).toBeNull();
    act(() => result.current.commit());
    expect(loadLayoutPrefs().thumbsWidth).toBe(200);
    act(() => result.current.update({ contextOpen: false }));
    expect(loadLayoutPrefs().contextOpen).toBe(false);
  });

  it("update acota lo que se le da", () => {
    const { result } = renderHook(() => useProLayout());
    act(() => result.current.update({ thumbsWidth: 9999 }));
    expect(result.current.prefs.thumbsWidth).toBe(THUMBS_WIDTH.max);
  });

  it("reset vuelve a los valores por defecto y los guarda", () => {
    const { result } = renderHook(() => useProLayout());
    act(() => result.current.update({ thumbsWidth: 250, thumbsOpen: false }));
    act(() => result.current.reset());
    expect(result.current.prefs).toEqual(DEFAULT_LAYOUT_PREFS);
    expect(loadLayoutPrefs()).toEqual(DEFAULT_LAYOUT_PREFS);
  });
});
