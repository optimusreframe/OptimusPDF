import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRO_DESKTOP_QUERY, useIsDesktop } from "@/app/pdf-pro/shell/useIsDesktop";

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
