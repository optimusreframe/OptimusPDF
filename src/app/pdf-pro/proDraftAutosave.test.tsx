import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  PRO_DRAFT_SAVE_DEBOUNCE_MS,
  createProDraftAutosaver,
  draftSnapshotOf,
  useProDraftAutosave,
  type ProDraftSnapshot,
} from "@/app/pdf-pro/proDraftAutosave";
import {
  __closeWarmProDraftsConnectionForTests,
  __resetProDraftsMemoryForTests,
  clearAllProDrafts,
  listProDrafts,
  loadProDraft,
} from "@/app/pdf-pro/proDrafts";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import { LanguageProvider } from "@/lib/i18n";
import { markDecryptedCopy } from "@/lib/pdf/inputGuard";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

const ID = "d".repeat(64);

function snap(patch: Partial<ProDraftSnapshot> = {}): ProDraftSnapshot {
  return {
    id: ID,
    fileName: "doc.pdf",
    bytes: fakeBytes(40),
    snapshotId: "s1",
    history: [{ label: "Original", createdAt: 1, source: "open" }],
    pageCount: 3,
    dirty: true,
    ...patch,
  };
}

beforeEach(async () => {
  __resetProDraftsMemoryForTests();
  __closeWarmProDraftsConnectionForTests();
  await clearAllProDrafts();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("createProDraftAutosaver", () => {
  it("el debounce por defecto es de 600 ms", () => {
    expect(PRO_DRAFT_SAVE_DEBOUNCE_MS).toBe(600);
  });

  it("guarda tras la calma, una sola vez aunque se programe varias", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(params: { snapshotId: string }) => Promise<{ ok: true }>>(async () => ({ ok: true }));
    const saver = createProDraftAutosaver({ save: save as never, debounceMs: 100 });
    saver.schedule(snap({ snapshotId: "a" }));
    saver.schedule(snap({ snapshotId: "b" }));
    saver.schedule(snap({ snapshotId: "c" }));
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ snapshotId: "c" });
    saver.dispose({ flush: false });
  });

  it("flush guarda YA lo pendiente y devuelve el resultado", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const saver = createProDraftAutosaver({ save, debounceMs: 10_000 });
    saver.schedule(snap());
    await expect(saver.flush()).resolves.toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    saver.dispose({ flush: false });
  });

  it("onPendingChange: true al programar cambios, sigue true mientras se guarda y baja al terminar", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const save = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const changes: boolean[] = [];
    const saver = createProDraftAutosaver({ save: save as never, debounceMs: 100, onPendingChange: (value) => changes.push(value) });
    expect(saver.isPending()).toBe(false);
    saver.schedule(snap());
    expect(saver.isPending()).toBe(true);
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(100);
    // El debounce ya vencio, pero la escritura sigue en vuelo: el borrador aun no cubre los cambios.
    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.isPending()).toBe(true);
    expect(changes).toEqual([true]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.isPending()).toBe(false);
    expect(changes).toEqual([true, false]);
    saver.dispose({ flush: false });
  });

  it("onPendingChange: un guardado que falla tambien baja la marca (el aviso del fallo toma el relevo)", async () => {
    const changes: boolean[] = [];
    const saver = createProDraftAutosaver({
      save: vi.fn(async () => ({ ok: false as const, reason: "storage" as const })) as never,
      debounceMs: 10_000,
      onPendingChange: (value) => changes.push(value),
    });
    saver.schedule(snap());
    await saver.flush();
    expect(saver.isPending()).toBe(false);
    expect(changes.at(-1)).toBe(false);
    saver.dispose({ flush: false });
  });

  it("un snapshot SIN cambios (deshecho hasta el guardado) no cuenta como escritura pendiente", () => {
    const changes: boolean[] = [];
    const saver = createProDraftAutosaver({ save: vi.fn() as never, debounceMs: 10_000, onPendingChange: (value) => changes.push(value) });
    saver.schedule(snap({ dirty: false }));
    expect(saver.isPending()).toBe(false);
    expect(changes).toEqual([]);
    saver.dispose({ flush: false });
  });

  it("descartar o desmontar con algo pendiente baja la marca", async () => {
    const changes: boolean[] = [];
    const saver = createProDraftAutosaver({ save: vi.fn() as never, remove: vi.fn(async () => ({ ok: true })) as never, debounceMs: 10_000, onPendingChange: (value) => changes.push(value) });
    saver.schedule(snap());
    await saver.discard(ID);
    expect(saver.isPending()).toBe(false);
    expect(changes).toEqual([true, false]);
    saver.dispose({ flush: false });
  });

  it("flush sin nada pendiente devuelve null", async () => {
    const saver = createProDraftAutosaver({ save: vi.fn(), debounceMs: 10 });
    await expect(saver.flush()).resolves.toBeNull();
  });

  it("sin cambios (dirty=false) NO guarda, y si no habia nada guardado tampoco borra", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const remove = vi.fn(async () => ({ ok: true as const }));
    const saver = createProDraftAutosaver({ save, remove, debounceMs: 10 });
    saver.schedule(snap({ dirty: false }));
    await saver.flush();
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("si esta pestana habia guardado ese documento, volver a limpio RETIRA el borrador", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const remove = vi.fn(async () => ({ ok: true as const }));
    const saver = createProDraftAutosaver({ save, remove, debounceMs: 10 });
    saver.schedule(snap());
    await saver.flush();
    saver.schedule(snap({ dirty: false }));
    await saver.flush();
    expect(remove).toHaveBeenCalledWith(ID);
  });

  it("discard borra el borrador y descarta lo pendiente: lo borrado no resucita", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const remove = vi.fn(async () => ({ ok: true as const }));
    const saver = createProDraftAutosaver({ save, remove, debounceMs: 20 });
    saver.schedule(snap());
    await saver.discard(ID);
    await new Promise((r) => setTimeout(r, 40));
    expect(save).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(ID);
  });

  it("un guardado lento ya superado por otro mas nuevo calla (isCurrent) y no avisa", async () => {
    const results: unknown[] = [];
    const currentChecks: boolean[] = [];
    const save = vi.fn(async (p: { isCurrent?: () => boolean }) => {
      await new Promise((r) => setTimeout(r, 15));
      currentChecks.push(p.isCurrent?.() ?? true);
      return { ok: false as const, reason: "superseded" as const };
    });
    const saver = createProDraftAutosaver({ save: save as never, debounceMs: 5, onResult: (r) => results.push(r) });
    saver.schedule(snap({ snapshotId: "a" }));
    const first = saver.flush();
    saver.schedule(snap({ snapshotId: "b" }));
    await first;
    expect(currentChecks).toEqual([false]);
    expect(results).toEqual([]);
    saver.dispose({ flush: false });
  });

  it("onResult recibe el resultado de cada guardado, tambien los fallos (cuota)", async () => {
    const results: unknown[] = [];
    const save = vi.fn(async () => ({ ok: false as const, reason: "quota" as const }));
    const saver = createProDraftAutosaver({ save, debounceMs: 5, onResult: (r) => results.push(r) });
    saver.schedule(snap());
    await saver.flush();
    expect(results).toEqual([{ ok: false, reason: "quota" }]);
    saver.dispose({ flush: false });
  });

  it("dispose con flush vuelca lo pendiente; sin flush lo descarta; despues ya no programa", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const withFlush = createProDraftAutosaver({ save, debounceMs: 10_000 });
    withFlush.schedule(snap());
    withFlush.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(save).toHaveBeenCalledTimes(1);
    withFlush.schedule(snap());
    await withFlush.flush();
    expect(save).toHaveBeenCalledTimes(1);

    save.mockClear();
    const without = createProDraftAutosaver({ save, debounceMs: 10_000 });
    without.schedule(snap());
    without.dispose({ flush: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(save).not.toHaveBeenCalled();
  });

  it("beforeunload vuelca lo pendiente al momento (no espera al debounce)", async () => {
    const save = vi.fn(async () => ({ ok: true as const }));
    const saver = createProDraftAutosaver({ save, debounceMs: 60_000 });
    saver.schedule(snap());
    expect(save).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("beforeunload"));
    await new Promise((r) => setTimeout(r, 5));
    expect(save).toHaveBeenCalledTimes(1);
    saver.dispose({ flush: false });
  });

  it("tras guardar, los oyentes de beforeunload se quitan (no queda nada puesto por el bfcache)", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const saver = createProDraftAutosaver({ save: vi.fn(async () => ({ ok: true as const })), debounceMs: 5 });
    saver.schedule(snap());
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    await saver.flush();
    expect(remove.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("draftSnapshotOf — que documento se guarda", () => {
  async function opened(options: { encrypted?: boolean; fingerprint?: string | null } = {}) {
    const doc = fakeDoc({ fingerprint: async () => (options.fingerprint === undefined ? "e".repeat(64) : options.fingerprint) });
    const file = fakeFile(50, "x.pdf");
    if (options.encrypted) markDecryptedCopy(file);
    await doc.open(file, { pageCount: 3 });
    await doc.commit(fakeBytes(60, 3), "Rotar", "operation", { pageCount: 3, opId: "rotate-all" });
    return doc;
  }

  it("guarda el snapshot ACTUAL con la huella del ORIGINAL como id y el historial ligero hasta el cursor", async () => {
    const doc = await opened();
    const state = doc.getState();
    const result = draftSnapshotOf(state.document, state.dirty, 2)!;
    expect(result.id).toBe("e".repeat(64));
    expect(result.bytes).toBe(doc.current());
    expect(result.history.map((n) => n.label)).toEqual(["Original", "Rotar"]);
    expect(result.history[1]).toMatchObject({ source: "operation", opId: "rotate-all" });
    expect(result.history[0]).not.toHaveProperty("bytes");
    expect(result.currentPage).toBe(2);
    expect(result.dirty).toBe(true);
    expect(result.fileName).toBe("x.pdf");
  });

  it("tras deshacer, el historial guardado llega solo hasta el cursor", async () => {
    const doc = await opened();
    doc.undo();
    const state = doc.getState();
    const result = draftSnapshotOf(state.document, state.dirty)!;
    expect(result.history.map((n) => n.label)).toEqual(["Original"]);
    expect(result.dirty).toBe(false);
  });

  it("un PDF CIFRADO nunca se guarda (devolveria su contenido sin el cifrado)", async () => {
    const doc = await opened({ encrypted: true });
    const state = doc.getState();
    expect(state.document?.wasEncrypted).toBe(true);
    expect(draftSnapshotOf(state.document, state.dirty)).toBeNull();
  });

  it("sin huella (sin crypto.subtle) no hay borrador", async () => {
    const doc = await opened({ fingerprint: null });
    const state = doc.getState();
    expect(draftSnapshotOf(state.document, state.dirty)).toBeNull();
  });

  it("sin documento no hay borrador", () => {
    expect(draftSnapshotOf(null, false)).toBeNull();
  });
});

function Harness({ enabled = true, debounceMs = 5 }: { doc: ProWorkingDoc; enabled?: boolean; debounceMs?: number }) {
  useProDraftAutosave({ enabled, debounceMs });
  return <p>listo</p>;
}

function mount(doc: ProWorkingDoc, props: { enabled?: boolean } = {}) {
  return render(
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc} shortcuts={false}>
        <Harness doc={doc} {...props} />
      </ProWorkingDocProvider>
    </LanguageProvider>,
  );
}

describe("useProDraftAutosave — de punta a punta con IndexedDB", () => {
  it("un cambio aplicado se guarda como borrador y se puede cargar", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc);
    await doc.open(fakeFile(50, "x.pdf"), { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(1));
    const loaded = await loadProDraft(ID);
    if (!loaded.ok) throw new Error("no cargo");
    expect(loaded.draft.bytes.byteLength).toBe(70);
    expect(loaded.draft.meta.steps).toBe(1);
  });

  it("abrir sin tocar NO crea borrador", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc);
    await doc.open(fakeFile(), { pageCount: 3 });
    await new Promise((r) => setTimeout(r, 60));
    expect(await listProDrafts()).toEqual([]);
  });

  it("deshacer hasta el estado guardado RETIRA el borrador", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc);
    await doc.open(fakeFile(), { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(1));
    act(() => {
      doc.undo();
    });
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(0));
  });

  it("descargar (markSaved) deja el documento limpio y retira el borrador", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc);
    await doc.open(fakeFile(), { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(1));
    act(() => doc.markSaved());
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(0));
  });

  it("enabled=false (flag proAutosave apagado) no guarda nada", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc, { enabled: false });
    await doc.open(fakeFile(), { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(await listProDrafts()).toEqual([]);
  });

  it("un PDF cifrado con cambios NO deja borrador", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    mount(doc);
    const file = fakeFile(50, "secreto.pdf");
    markDecryptedCopy(file);
    await doc.open(file, { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(await listProDrafts()).toEqual([]);
  });

  it("al desmontar vuelca lo pendiente (no se pierde el ultimo cambio)", async () => {
    const doc = fakeDoc({ fingerprint: async () => ID });
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc} shortcuts={false}>
          <Harness doc={doc} debounceMs={60_000} />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await doc.open(fakeFile(), { pageCount: 3 });
    await act(async () => {
      await doc.commit(fakeBytes(70, 5), "Rotar", "operation", { pageCount: 3 });
    });
    view.unmount();
    await waitFor(async () => expect(await listProDrafts()).toHaveLength(1));
  });
});
