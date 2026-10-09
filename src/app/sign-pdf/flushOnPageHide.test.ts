import { describe, expect, it, vi } from "vitest";
import { flushOnPageHide } from "@/app/sign-pdf/flushOnPageHide";

describe("flushOnPageHide", () => {
  it("sin window/document (servidor) no hace nada y devuelve un limpiador inocuo", () => {
    const flush = vi.fn();
    const stop = flushOnPageHide(flush);
    expect(typeof stop).toBe("function");
    stop();
  });

  it("pagehide llama al volcado y el limpiador quita el oyente", () => {
    // Entorno node: se simula window/document minimos.
    const listeners = new Map<string, () => void>();
    const fakeWindow = {
      addEventListener: (type: string, fn: () => void) => listeners.set(`w:${type}`, fn),
      removeEventListener: (type: string) => listeners.delete(`w:${type}`),
    };
    const fakeDocument = {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => listeners.set(`d:${type}`, fn),
      removeEventListener: (type: string) => listeners.delete(`d:${type}`),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    try {
      const flush = vi.fn();
      const stop = flushOnPageHide(flush);
      listeners.get("w:pagehide")!();
      expect(flush).toHaveBeenCalledTimes(1);
      listeners.get("w:beforeunload")!();
      expect(flush).toHaveBeenCalledTimes(2);
      listeners.get("d:visibilitychange")!();
      expect(flush).toHaveBeenCalledTimes(2);
      fakeDocument.visibilityState = "hidden";
      listeners.get("d:visibilitychange")!();
      expect(flush).toHaveBeenCalledTimes(3);
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("escucha beforeunload (la unica via que sobrevive a una recarga con IndexedDB) y lo quita al parar", () => {
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal("window", {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
    try {
      const stop = flushOnPageHide(() => {});
      expect(added.sort()).toEqual(["beforeunload", "pagehide"]);
      stop();
      expect(removed.sort()).toEqual(["beforeunload", "pagehide"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("un volcado que lanza no se propaga al navegador", () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
    try {
      flushOnPageHide(() => {
        throw new Error("boom");
      });
      expect(() => listeners.get("pagehide")!()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
