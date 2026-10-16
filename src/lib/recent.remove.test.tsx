import { beforeEach, describe, expect, it } from "vitest";
import { addRecentEntry, clearRecentEntries, getRecentEntries, MAX_RECENT_ENTRIES, RECENT_STORAGE_KEY, removeRecentEntry } from "@/lib/recent";

describe("removeRecentEntry", () => {
  beforeEach(() => clearRecentEntries());

  it("quita solo la entrada pedida, en memoria y en el almacenamiento", () => {
    addRecentEntry("merge-pdf", "a.pdf");
    addRecentEntry("rotate-pdf", "b.pdf");
    addRecentEntry("split-pdf", "c.pdf");
    const [newest, middle, oldest] = getRecentEntries();
    removeRecentEntry(middle.id);
    expect(getRecentEntries().map((e) => e.fileName)).toEqual([newest.fileName, oldest.fileName]);
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY)!).map((e: { id: string }) => e.id)).toEqual([newest.id, oldest.id]);
  });

  it("al quitar la última, el almacenamiento queda sin clave", () => {
    addRecentEntry("merge-pdf", "a.pdf");
    removeRecentEntry(getRecentEntries()[0].id);
    expect(getRecentEntries()).toEqual([]);
    expect(window.localStorage.getItem(RECENT_STORAGE_KEY)).toBeNull();
  });

  it("un id desconocido no cambia nada ni avisa", () => {
    addRecentEntry("merge-pdf", "a.pdf");
    const before = getRecentEntries();
    removeRecentEntry("no-existe");
    expect(getRecentEntries()).toBe(before);
  });

  it("avisa a los suscriptores", async () => {
    const { subscribeToRecentEntries } = await import("@/lib/recent");
    addRecentEntry("merge-pdf", "a.pdf");
    let calls = 0;
    const off = subscribeToRecentEntries(() => {
      calls += 1;
    });
    removeRecentEntry(getRecentEntries()[0].id);
    off();
    expect(calls).toBe(1);
  });

  it("la retención es de 20 entradas", () => {
    expect(MAX_RECENT_ENTRIES).toBe(20);
    for (let i = 0; i < 30; i += 1) addRecentEntry("merge-pdf", `f${i}.pdf`);
    expect(getRecentEntries()).toHaveLength(20);
    expect(getRecentEntries()[0].fileName).toBe("f29.pdf");
  });
});
