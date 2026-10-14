import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECENT_STORAGE_KEY } from "@/lib/recent";

/**
 * El historial puede llevar un PUNTERO a un borrador (`resume`: tipo + id, nunca contenido). Lo que viene de
 * localStorage no se da por bueno: un puntero manipulado se descarta y la entrada se conserva.
 */

const HEX = "ab".repeat(32);

async function freshRecent() {
  vi.resetModules();
  return import("@/lib/recent");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("addRecentEntry con puntero", () => {
  it("guarda tipo e id y nada mas", async () => {
    const recent = await freshRecent();
    recent.addRecentEntry("pdf-pro", "factura.pdf", { kind: "pro", id: HEX });
    const [entry] = recent.getRecentEntries();
    expect(entry.resume).toEqual({ kind: "pro", id: HEX });
    const stored = JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    expect(Object.keys(stored[0].resume).sort()).toEqual(["id", "kind"]);
    expect(Object.keys(stored[0]).sort()).toEqual(["date", "fileName", "id", "resume", "slug"]);
  });

  it("sin puntero la entrada es la de siempre (sin la clave `resume`)", async () => {
    const recent = await freshRecent();
    recent.addRecentEntry("merge-pdf", "a.pdf");
    expect("resume" in recent.getRecentEntries()[0]).toBe(false);
  });

  it("un puntero invalido no se guarda, pero la entrada si", async () => {
    const recent = await freshRecent();
    recent.addRecentEntry("pdf-pro", "a.pdf", { kind: "pro", id: "../../x" });
    recent.addRecentEntry("pdf-pro", "b.pdf", { kind: "nope" as never, id: HEX });
    const entries = recent.getRecentEntries();
    expect(entries.map((entry) => entry.fileName)).toEqual(["b.pdf", "a.pdf"]);
    expect(entries.every((entry) => entry.resume === undefined)).toBe(true);
  });
});

describe("lectura de localStorage", () => {
  const base = { id: "1", slug: "pdf-pro", fileName: "a.pdf", date: "2026-10-14T10:00:00.000Z" };

  it("conserva un puntero valido", async () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ ...base, resume: { kind: "edit", id: HEX } }]));
    const recent = await freshRecent();
    expect(recent.getRecentEntries()[0].resume).toEqual({ kind: "edit", id: HEX });
  });

  it.each([
    ["tipo desconocido", { kind: "delete", id: HEX }],
    ["prototipo", { kind: "__proto__", id: HEX }],
    ["constructor", { kind: "constructor", id: HEX }],
    ["id con ruta", { kind: "edit", id: "../../etc/passwd" }],
    ["id con etiqueta", { kind: "edit", id: "<script>" }],
    ["id numerico", { kind: "edit", id: 123 }],
    ["sesion con huella", { kind: "session", id: HEX }],
    ["sin id", { kind: "edit" }],
    ["texto suelto", "edit:" + HEX],
    ["lista", [HEX]],
    ["nulo", null],
  ])("descarta un puntero manipulado (%s) y conserva la entrada", async (_label, resume) => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([{ ...base, resume }]));
    const recent = await freshRecent();
    const [entry] = recent.getRecentEntries();
    expect(entry.fileName).toBe("a.pdf");
    expect(entry.resume).toBeUndefined();
  });

  it("no arrastra campos desconocidos de una entrada manipulada", async () => {
    window.localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([{ ...base, resume: { kind: "pro", id: HEX, extra: "<img onerror=x>" }, html: "<b>x</b>" }]),
    );
    const recent = await freshRecent();
    const [entry] = recent.getRecentEntries();
    expect(entry).toEqual({ ...base, resume: { kind: "pro", id: HEX } });
  });
});
