import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_BACKUP_KEY, daysSince, markLastBackup, readLastBackup } from "@/lib/backup/lastBackup";

/** «Último respaldo» en localStorage: clave fija, valor ISO, nunca lanza. */

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("lastBackup", () => {
  it("la clave es optimuspdf.lastBackup", () => {
    expect(LAST_BACKUP_KEY).toBe("optimuspdf.lastBackup");
  });
  it("escribe y lee la fecha ISO", () => {
    expect(readLastBackup()).toBeNull();
    expect(markLastBackup(new Date("2026-10-20T10:00:00.000Z"))).toBe(true);
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBe("2026-10-20T10:00:00.000Z");
    expect(readLastBackup()?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
  });
  it("un valor que no es una fecha ISO se lee como «nunca»", () => {
    for (const bad of ["", "ayer", "2026-13-45", "12345", "2026-10-20", "x".repeat(100)]) {
      window.localStorage.setItem(LAST_BACKUP_KEY, bad);
      expect(readLastBackup(), bad).toBeNull();
    }
  });
  it("con localStorage bloqueado no lanza", () => {
    const blocked = () => {
      throw new Error("bloqueado");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(readLastBackup()).toBeNull();
    expect(markLastBackup()).toBe(false);
  });
  it("daysSince", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    expect(daysSince(new Date("2026-10-20T00:00:00.000Z"), now)).toBe(0);
    expect(daysSince(new Date("2026-10-18T12:00:00.000Z"), now)).toBe(2);
    expect(daysSince(new Date("2026-10-25T12:00:00.000Z"), now)).toBe(0);
  });
});
