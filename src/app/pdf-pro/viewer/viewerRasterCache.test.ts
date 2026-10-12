import { describe, expect, it, vi } from "vitest";
import { ViewerRasterCache, type ViewerRasterEntry } from "@/app/pdf-pro/viewer/viewerRasterCache";

function entry(id: string, bytes = 100): ViewerRasterEntry {
  return { url: `blob:${id}`, bytes, width: 10, height: 10 };
}

function makeCache(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const revoke = vi.fn();
  return { cache: new ViewerRasterCache({ ...options, revoke }), revoke };
}

describe("ViewerRasterCache (LRU global del visor)", () => {
  it("guarda y devuelve una entrada", () => {
    const { cache } = makeCache();
    cache.set("a", entry("a"));
    expect(cache.get("a")?.url).toBe("blob:a");
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(100);
  });

  it("al pasar del limite de entradas expulsa las mas antiguas y revoca su URL", () => {
    const { cache, revoke } = makeCache({ maxEntries: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) cache.set(id, entry(id));
    expect(cache.keys()).toEqual(["c", "d", "e"]);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:b");
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("leer una entrada la marca como la mas reciente (LRU, no FIFO)", () => {
    const { cache } = makeCache({ maxEntries: 3 });
    for (const id of ["a", "b", "c"]) cache.set(id, entry(id));
    cache.get("a");
    cache.set("d", entry("d"));
    expect(cache.keys()).toEqual(["c", "a", "d"]);
    expect(cache.has("b")).toBe(false);
  });

  it("peek no cambia el orden de uso", () => {
    const { cache } = makeCache({ maxEntries: 2 });
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.peek("a");
    cache.set("c", entry("c"));
    expect(cache.keys()).toEqual(["b", "c"]);
  });

  it("limita tambien por bytes", () => {
    const { cache, revoke } = makeCache({ maxEntries: 100, maxBytes: 250 });
    cache.set("a", entry("a", 100));
    cache.set("b", entry("b", 100));
    cache.set("c", entry("c", 100));
    expect(cache.keys()).toEqual(["b", "c"]);
    expect(cache.bytes).toBe(200);
    expect(revoke).toHaveBeenCalledWith("blob:a");
  });

  it("una entrada mayor que el limite se queda (la ultima insertada nunca se expulsa)", () => {
    const { cache } = makeCache({ maxBytes: 50 });
    cache.set("big", entry("big", 500));
    expect(cache.has("big")).toBe(true);
  });

  it("las URL ancladas (mostradas en el DOM) no se expulsan ni se revocan", () => {
    const { cache, revoke } = makeCache({ maxEntries: 2 });
    cache.set("a", entry("a"));
    cache.setPinned(["blob:a"]);
    cache.set("b", entry("b"));
    cache.set("c", entry("c"));
    expect(cache.has("a")).toBe(true);
    expect(revoke).not.toHaveBeenCalledWith("blob:a");
    expect(cache.keys()).toEqual(["a", "c"]);
  });

  it("al soltar una URL anclada, la cache vuelve a su limite", () => {
    const { cache, revoke } = makeCache({ maxEntries: 2 });
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.setPinned(["blob:a", "blob:b"]);
    cache.set("c", entry("c"));
    expect(cache.size).toBe(3);
    cache.setPinned([]);
    expect(cache.size).toBe(2);
    expect(revoke).toHaveBeenCalledWith("blob:a");
  });

  it("sustituir una clave anclada no revoca la URL vieja hasta que se suelta", () => {
    const { cache, revoke } = makeCache();
    cache.set("k", entry("old"));
    cache.setPinned(["blob:old"]);
    cache.set("k", entry("new"));
    expect(revoke).not.toHaveBeenCalled();
    expect(cache.get("k")?.url).toBe("blob:new");
    cache.setPinned([]);
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });

  it("sustituir una clave sin anclar revoca la URL vieja y no duplica los bytes", () => {
    const { cache, revoke } = makeCache();
    cache.set("k", entry("old", 100));
    cache.set("k", entry("new", 40));
    expect(revoke).toHaveBeenCalledWith("blob:old");
    expect(cache.bytes).toBe(40);
    expect(cache.size).toBe(1);
  });

  it("delete quita y revoca", () => {
    const { cache, revoke } = makeCache();
    cache.set("a", entry("a"));
    cache.delete("a");
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes).toBe(0);
    expect(revoke).toHaveBeenCalledWith("blob:a");
    cache.delete("nope");
  });

  it("clear revoca TODAS las URL, tambien las ancladas y las huerfanas", () => {
    const { cache, revoke } = makeCache();
    cache.set("a", entry("a"));
    cache.set("b", entry("b"));
    cache.setPinned(["blob:a"]);
    cache.set("a", entry("a2"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    for (const url of ["blob:a", "blob:a2", "blob:b"]) expect(revoke).toHaveBeenCalledWith(url);
  });

  it("con 500 paginas pedidas la memoria queda acotada por el limite", () => {
    const { cache } = makeCache({ maxEntries: 48, maxBytes: 20_000 });
    for (let i = 0; i < 500; i += 1) cache.set(`p${i}`, entry(`p${i}`, 300));
    expect(cache.size).toBeLessThanOrEqual(48);
    expect(cache.bytes).toBeLessThanOrEqual(20_000);
    expect(cache.has("p499")).toBe(true);
    expect(cache.has("p0")).toBe(false);
  });
});
