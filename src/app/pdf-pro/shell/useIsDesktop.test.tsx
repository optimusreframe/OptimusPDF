import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRO_COARSE_QUERY,
  PRO_COMPACT_HEIGHT_QUERY,
  PRO_DESKTOP_QUERY,
  PRO_SHORT_QUERY,
  useCoarsePointer,
  useIsCompactHeight,
  useIsDesktop,
  useIsShortViewport,
  useIsWideViewport,
} from "@/app/pdf-pro/shell/useIsDesktop";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return query === PRO_DESKTOP_QUERY ? matches : false;
      },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })),
  );
  return {
    set(value: boolean) {
      matches = value;
      act(() => listeners.forEach((listener) => listener()));
    },
    listenerCount: () => listeners.size,
  };
}

describe("useIsDesktop", () => {
  it("el punto de corte es md (768 px)", () => {
    expect(PRO_DESKTOP_QUERY).toBe("(min-width: 768px)");
  });

  it("sin matchMedia asume escritorio", () => {
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
  });

  it("lee la consulta al montar", () => {
    stubMatchMedia(false);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(false);
    cleanup();
    stubMatchMedia(true);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(true);
  });

  it("reacciona a girar el telefono o redimensionar sin recargar", () => {
    const media = stubMatchMedia(true);
    const { result } = renderHook(() => useIsDesktop());
    media.set(false);
    expect(result.current).toBe(false);
    media.set(true);
    expect(result.current).toBe(true);
  });

  it("deja de escuchar al desmontar", () => {
    const media = stubMatchMedia(true);
    const { unmount } = renderHook(() => useIsDesktop());
    expect(media.listenerCount()).toBe(1);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});

/** `matchMedia` con una lista de consultas que coinciden (el resto, no). */
function stubQueries(matching: readonly string[]) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

describe("reparto por alto y puntero (M2)", () => {
  it("un movil horizontal (ancho de escritorio pero poco alto) NO es escritorio", () => {
    stubQueries([PRO_DESKTOP_QUERY, PRO_SHORT_QUERY]);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(false);
    expect(renderHook(() => useIsShortViewport()).result.current).toBe(true);
  });

  it("una tableta con ancho y alto de escritorio SI lo es", () => {
    stubQueries([PRO_DESKTOP_QUERY]);
    expect(renderHook(() => useIsDesktop()).result.current).toBe(true);
    expect(renderHook(() => useIsShortViewport()).result.current).toBe(false);
  });

  it("el alto pequeño y el puntero grueso se leen de sus consultas", () => {
    stubQueries([PRO_COMPACT_HEIGHT_QUERY, PRO_COARSE_QUERY]);
    expect(renderHook(() => useIsCompactHeight()).result.current).toBe(true);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(true);
    cleanup();
    stubQueries([]);
    expect(renderHook(() => useIsCompactHeight()).result.current).toBe(false);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
  });

  it("sin matchMedia: ni corto, ni compacto, ni puntero grueso", () => {
    expect(renderHook(() => useIsShortViewport()).result.current).toBe(false);
    expect(renderHook(() => useIsCompactHeight()).result.current).toBe(false);
    expect(renderHook(() => useCoarsePointer()).result.current).toBe(false);
  });
});

describe("useIsWideViewport (M6)", () => {
  it("sin matchMedia (cliente) no es ancho y con ella sigue a (min-width: 768px) aunque el alto sea de movil horizontal", () => {
    expect(renderHook(() => useIsWideViewport()).result.current).toBe(false);
    cleanup();
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsWideViewport());
    expect(result.current).toBe(false);
    media.set(true);
    expect(result.current).toBe(true);
  });
});
