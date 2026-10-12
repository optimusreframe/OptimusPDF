import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRO_FEATURE_FLAGS,
  PRO_FEATURE_FLAGS,
  PRO_FEATURE_FLAGS_STORAGE_KEY,
  __resetProFeatureFlagsCacheForTests,
  getProFeatureFlag,
  setProFeatureFlag,
  useProFeatureFlag,
  useProFeatureFlags,
} from "@/app/pdf-pro/proFeatureFlags";

beforeEach(() => {
  window.localStorage.clear();
  __resetProFeatureFlagsCacheForTests();
});

afterEach(() => vi.restoreAllMocks());

describe("proFeatureFlags — valores por defecto", () => {
  it("proAutosave va ACTIVO y el interruptor del visor continuo ya no existe", () => {
    expect(DEFAULT_PRO_FEATURE_FLAGS).toEqual({ proAutosave: true });
    expect([...PRO_FEATURE_FLAGS]).toEqual(["proAutosave"]);
    const { result } = renderHook(() => useProFeatureFlags());
    expect(result.current).toEqual(DEFAULT_PRO_FEATURE_FLAGS);
  });

  it("la clave de almacenamiento es propia de PDF Pro", () => {
    expect(PRO_FEATURE_FLAGS_STORAGE_KEY).toBe("optimuspdf.pro.featureFlags");
  });

  it("el snapshot de servidor son los defaults (la hidratacion no diverge)", () => {
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ proAutosave: false }));
    let seen: unknown = null;
    function Probe() {
      seen = useProFeatureFlags();
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen).toEqual(DEFAULT_PRO_FEATURE_FLAGS);
  });
});

describe("proFeatureFlags — persistencia y reactividad", () => {
  it("setProFeatureFlag cambia el valor, lo persiste y avisa a los suscritos", () => {
    const { result } = renderHook(() => useProFeatureFlag("proAutosave"));
    expect(result.current).toBe(true);
    act(() => setProFeatureFlag("proAutosave", false));
    expect(result.current).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(PRO_FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({ proAutosave: false });
    act(() => setProFeatureFlag("proAutosave", true));
    expect(result.current).toBe(true);
  });

  it("lee lo guardado al arrancar", () => {
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify({ proAutosave: false }));
    const { result } = renderHook(() => useProFeatureFlags());
    expect(result.current).toEqual({ proAutosave: false });
  });

  it("ignora claves desconocidas (incluido el antiguo proContinuousViewer) y valores que no son booleanos", () => {
    window.localStorage.setItem(
      PRO_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ proAutosave: "no", intruso: false, proContinuousViewer: false }),
    );
    const { result } = renderHook(() => useProFeatureFlags());
    expect(result.current).toEqual({ proAutosave: true });
  });

  it("JSON corrupto o con otra forma: cae a los defaults", () => {
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, "{no es json");
    expect(renderHook(() => useProFeatureFlags()).result.current).toEqual(DEFAULT_PRO_FEATURE_FLAGS);
    __resetProFeatureFlagsCacheForTests();
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify([true, false]));
    expect(renderHook(() => useProFeatureFlags()).result.current).toEqual(DEFAULT_PRO_FEATURE_FLAGS);
  });

  it("la referencia del estado es estable mientras nada cambia (useSyncExternalStore)", () => {
    const { result, rerender } = renderHook(() => useProFeatureFlags());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("poner el mismo valor no notifica ni reescribe", () => {
    const { result } = renderHook(() => useProFeatureFlags());
    const first = result.current;
    act(() => setProFeatureFlag("proAutosave", true));
    expect(result.current).toBe(first);
    expect(window.localStorage.getItem(PRO_FEATURE_FLAGS_STORAGE_KEY)).toBeNull();
  });

  it("getProFeatureFlag lee fuera de React", () => {
    expect(getProFeatureFlag("proAutosave")).toBe(true);
    setProFeatureFlag("proAutosave", false);
    expect(getProFeatureFlag("proAutosave")).toBe(false);
  });
});

describe("proFeatureFlags — el almacenamiento nunca lanza a la UI", () => {
  it("localStorage que lanza al leer: defaults", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const { result } = renderHook(() => useProFeatureFlags());
    expect(result.current).toEqual(DEFAULT_PRO_FEATURE_FLAGS);
  });

  it("localStorage que lanza al escribir: el flag sigue cambiado en memoria", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cuota");
    });
    const { result } = renderHook(() => useProFeatureFlag("proAutosave"));
    expect(() => act(() => setProFeatureFlag("proAutosave", false))).not.toThrow();
    expect(result.current).toBe(false);
  });
});
