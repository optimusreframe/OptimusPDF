import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalSignData } from "@/app/sign-pdf/clearLocalSignData";
import {
  clearAllDrafts,
  listDrafts,
  saveDraft,
} from "@/app/sign-pdf/signDrafts";
import { clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { vaultInput } from "@/app/sign-pdf/vaultTestUtils";

/**
 * Borrado de lo guardado en IndexedDB (borradores + baul de firmas) con
 * resultado: la lista de lo que NO se pudo borrar decide si la interfaz puede
 * decir «Datos borrados».
 */

beforeEach(async () => {
  await clearAllDrafts();
  await clearVault();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seed() {
  await saveDraft({
    id: "doc-1",
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: "doc-1.pdf",
    manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
  expect((await saveVaultEntry(vaultInput("Ana Pérez"))).ok).toBe(true);
}

describe("clearAllDrafts devuelve resultado — src/app/sign-pdf/signDrafts.ts", () => {
  it("ok si borro, y sigue sin lanzar nunca", async () => {
    await seed();
    expect(await clearAllDrafts()).toEqual({ ok: true });
    expect(await listDrafts()).toHaveLength(0);
  });

  it("sin IndexedDB no hay nada guardado que borrar: ok", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await clearAllDrafts()).toEqual({ ok: true });
  });

  it("si la base existe pero falla al abrirse informa ok:false en vez de callar", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("bloqueada");
      },
    });
    expect(await clearAllDrafts()).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("clearLocalSignData — src/app/sign-pdf/clearLocalSignData.ts", () => {
  it("caso feliz: lista vacia y todo borrado", async () => {
    await seed();
    expect(await clearLocalSignData()).toEqual([]);
    expect(await listDrafts()).toHaveLength(0);
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("sin IndexedDB no es un fallo (no hay nada que borrar)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await clearLocalSignData()).toEqual([]);
  });

  it("con la base bloqueada informa de que el baul NO se borro", async () => {
    await seed();
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("bloqueada");
      },
    });
    expect(await clearLocalSignData()).toEqual(["drafts", "vault"]);
  });
});
