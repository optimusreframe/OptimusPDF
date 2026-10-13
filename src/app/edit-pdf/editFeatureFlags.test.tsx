import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDIT_PDF_FEATURE_FLAGS,
  EDIT_PDF_FEATURE_FLAGS,
  EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetEditPdfFeatureFlagsCacheForTests,
  getEditPdfFeatureFlag,
  setEditPdfFeatureFlag,
  useEditPdfFeatureFlag,
  useEditPdfFeatureFlags,
} from "@/app/edit-pdf/editFeatureFlags";

/** Flags del editor: mismo patron que los de Firmar (localStorage + useSyncExternalStore). */

beforeEach(() => {
  window.localStorage.clear();
  __resetEditPdfFeatureFlagsCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editFeatureFlags — valores por defecto", () => {
  it("editExistingText ACTIVO y es el unico interruptor (la limpieza del original ya no lo es)", () => {
    expect(DEFAULT_EDIT_PDF_FEATURE_FLAGS).toEqual({ editExistingText: true });
    expect([...EDIT_PDF_FEATURE_FLAGS]).toEqual(["editExistingText"]);
    const { result } = renderHook(() => useEditPdfFeatureFlags());
    expect(result.current).toEqual(DEFAULT_EDIT_PDF_FEATURE_FLAGS);
  });

  it("la clave de almacenamiento es propia del editor", () => {
    expect(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY).toBe("optimuspdf.editPdf.featureFlags");
  });

  it("el snapshot de servidor son los defaults (la hidratacion no diverge)", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ editExistingText: false }),
    );
    let seen: unknown = null;
    function Probe() {
      seen = useEditPdfFeatureFlags();
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen).toEqual(DEFAULT_EDIT_PDF_FEATURE_FLAGS);
  });
});

describe("editFeatureFlags — persistencia", () => {
  it("setEditPdfFeatureFlag cambia el valor, lo persiste y avisa a los suscritos", () => {
    const { result } = renderHook(() => useEditPdfFeatureFlag("editExistingText"));
    expect(result.current).toBe(true);
    act(() => setEditPdfFeatureFlag("editExistingText", false));
    expect(result.current).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({
      editExistingText: false,
    });
    act(() => setEditPdfFeatureFlag("editExistingText", true));
    expect(result.current).toBe(true);
  });

  it("lee lo guardado al arrancar", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ editExistingText: false }),
    );
    const { result } = renderHook(() => useEditPdfFeatureFlags());
    expect(result.current.editExistingText).toBe(false);
  });

  it("repetir el mismo valor no notifica ni reescribe", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useEditPdfFeatureFlags());
    const before = result.current;
    act(() => setEditPdfFeatureFlag("editExistingText", true));
    expect(result.current).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("JSON corrupto, tipos erroneos y claves ajenas: se cae a los defaults sin lanzar", () => {
    for (const raw of ["{no json", "null", "[]", "7", '{"editExistingText":"no","otra":true}']) {
      window.localStorage.setItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY, raw);
      __resetEditPdfFeatureFlagsCacheForTests();
      const { result, unmount } = renderHook(() => useEditPdfFeatureFlags());
      expect(result.current).toEqual(DEFAULT_EDIT_PDF_FEATURE_FLAGS);
      unmount();
    }
  });

  it("si localStorage lanza al leer o al escribir, el flag sigue funcionando en memoria", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cuota", "QuotaExceededError");
    });
    const { result } = renderHook(() => useEditPdfFeatureFlag("editExistingText"));
    expect(result.current).toBe(true);
    expect(() => act(() => setEditPdfFeatureFlag("editExistingText", false))).not.toThrow();
    expect(result.current).toBe(false);
  });
});

describe("editFeatureFlags — un stripOriginalText guardado por una version anterior", () => {
  it("se ignora al leer: no aparece en el estado y no cambia editExistingText", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ stripOriginalText: true }),
    );
    const { result } = renderHook(() => useEditPdfFeatureFlags());
    expect(result.current).toEqual({ editExistingText: true });
    expect("stripOriginalText" in result.current).toBe(false);
    expect(getEditPdfFeatureFlag("editExistingText")).toBe(true);
  });

  it("se descarta en la siguiente escritura, sin tocar lo demas", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ stripOriginalText: true, editExistingText: true }),
    );
    renderHook(() => useEditPdfFeatureFlags());
    act(() => setEditPdfFeatureFlag("editExistingText", false));
    expect(JSON.parse(window.localStorage.getItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY)!)).toEqual({
      editExistingText: false,
    });
  });

  it("la referencia del snapshot es estable entre lecturas sin cambios (sin bucles de render)", () => {
    window.localStorage.setItem(
      EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ stripOriginalText: true }),
    );
    const { result, rerender } = renderHook(() => useEditPdfFeatureFlags());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("getEditPdfFeatureFlag lee puntualmente y refleja los cambios", () => {
    expect(getEditPdfFeatureFlag("editExistingText")).toBe(true);
    setEditPdfFeatureFlag("editExistingText", false);
    expect(getEditPdfFeatureFlag("editExistingText")).toBe(false);
  });
});
