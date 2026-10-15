import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F0-fix · D1: sin `BroadcastChannel` (Safari anterior a 15.4) el aviso entre pestanas viaja por el evento `storage` de
 * `localStorage`. Cada prueba carga el modulo de nuevo (el canal se decide al primer uso) con `BroadcastChannel` ausente.
 */

const SIGNAL_KEY = "optimuspdf.sign-drafts.signal";

async function loadWithoutBroadcastChannel() {
  vi.resetModules();
  vi.stubGlobal("BroadcastChannel", undefined);
  return import("@/app/sign-pdf/signDrafts");
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function storageEvent(newValue: string | null, key: string = SIGNAL_KEY): StorageEvent {
  return new StorageEvent("storage", { key, newValue });
}

describe("aviso entre pestanas sin BroadcastChannel (evento `storage`)", () => {
  it("una escritura de OTRA pestana llega por `storage` a los suscriptores, con id, version y autor", async () => {
    const drafts = await loadWithoutBroadcastChannel();
    const seen: Array<{ id: string; rev: number; writerId: string }> = [];
    const unsubscribe = drafts.subscribeToRemoteDraftWrites((write) => seen.push(write));
    window.dispatchEvent(storageEvent(JSON.stringify({ m: { type: "write", id: "s-x", rev: 4, writerId: "t-otra" }, n: 0.5 })));
    expect(seen).toEqual([{ id: "s-x", rev: 4, writerId: "t-otra" }]);
    unsubscribe();
  });

  it("ignora otras claves, valores vacios, JSON roto y las escrituras propias", async () => {
    const drafts = await loadWithoutBroadcastChannel();
    const seen: unknown[] = [];
    drafts.subscribeToRemoteDraftWrites((write) => seen.push(write));
    window.dispatchEvent(storageEvent(JSON.stringify({ m: { type: "write", id: "s-x", rev: 1, writerId: "t-otra" } }), "otra-clave"));
    window.dispatchEvent(storageEvent(null));
    window.dispatchEvent(storageEvent("{no es json"));
    window.dispatchEvent(storageEvent(JSON.stringify({ m: { type: "write", id: "s-x", rev: 1, writerId: drafts.tabWriterId() } })));
    window.dispatchEvent(storageEvent(JSON.stringify({ m: "changed" })));
    expect(seen).toEqual([]);
  });

  it("al guardar, avisa por `localStorage` con el id, la version y el autor (el evento `storage` solo salta en las OTRAS pestanas)", async () => {
    const drafts = await loadWithoutBroadcastChannel();
    const bytes = new Uint8Array([1]);
    const result = await drafts.saveSessionDraft({
      id: "s-aviso-1",
      mode: "multi",
      signMode: "same",
      signers: [],
      blocks: [],
      documents: [
        {
          id: "d1",
          fileName: "a.pdf",
          size: 1,
          state: { fields: [], textFields: [], textValues: {}, pageIndex: 0, fieldPageIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 }, sealedKey: "", textFieldsDetectedFor: null } as never,
          getBytes: async () => bytes,
        },
      ],
      activeDocId: "d1",
      step: "signers" as never,
    });
    expect(result).toEqual({ ok: true });
    const raw = window.localStorage.getItem(SIGNAL_KEY);
    expect(raw).toBeTruthy();
    const posted = (JSON.parse(raw as string) as { m: { type: string; id: string; rev: number; writerId: string } }).m;
    expect(posted).toEqual({ type: "write", id: "s-aviso-1", rev: 1, writerId: drafts.tabWriterId() });
  });

  it("sin `localStorage` (modo muy estricto) guardar sigue funcionando: solo no hay aviso entre pestanas", async () => {
    const drafts = await loadWithoutBroadcastChannel();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    const result = await drafts.saveDraft({
      id: "a".repeat(64),
      fileBytes: new Uint8Array([1]),
      fileName: "a.pdf",
      manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
      step: "signers" as never,
      captures: {},
      textFieldsDetectedFor: null,
    });
    expect(result).toEqual({ ok: true });
  });
});
