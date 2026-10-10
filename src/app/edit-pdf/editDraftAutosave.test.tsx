import "fake-indexeddb/auto";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_DRAFT_SAVE_DEBOUNCE_MS,
  createEditDraftAutosaver,
  useEditDraftAutosave,
  type EditDraftSnapshot,
} from "@/app/edit-pdf/editDraftAutosave";
import {
  __closeWarmEditDraftsConnectionForTests,
  __hasWarmEditDraftsConnectionForTests,
  __resetEditDraftsMemoryForTests,
  clearAllEditDrafts,
  deleteEditDraft,
  listEditDrafts,
  saveEditDraft,
  warmEditDraftsConnection,
} from "@/app/edit-pdf/editDrafts";
import {
  applyOp,
  createEditSession,
  newTextEdit,
  textItem,
  type EditSession,
} from "@/app/edit-pdf/editSession";

/**
 * Autoguardado del borrador: debounce de 350 ms, volcado al irse de la pagina
 * (beforeunload sobrevive a una recarga, pagehide/visibilitychange no) y
 * disciplina de generaciones. Los unitarios usan `save`/`remove` inyectados; la
 * prueba de «recarga a los 100 ms» usa IndexedDB de verdad (fake-indexeddb).
 */

const ID = "ab".repeat(32);
const PDF = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);

function sessionWith(text: string): EditSession {
  return applyOp(
    createEditSession(),
    {
      type: "add",
      item: textItem(
        newTextEdit({
          id: "t1",
          pageIndex: 0,
          box: { x: 10, y: 10, width: 100, height: 20 },
          fontKey: "helvetica",
          text,
        }),
      ),
    },
    0,
  );
}

function snapshot(text = "Hola", overrides: Partial<EditDraftSnapshot> = {}): EditDraftSnapshot {
  return { id: ID, fileName: "doc.pdf", fileBytes: PDF, session: sessionWith(text), ...overrides };
}

const OK = { ok: true } as const;

function mocks() {
  const save = vi.fn(async () => OK);
  const remove = vi.fn(async () => ({ ok: true }) as const);
  return { save, remove };
}

describe("createEditDraftAutosave — debounce y volcado", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("el debounce por defecto es de 350 ms", () => {
    expect(EDIT_DRAFT_SAVE_DEBOUNCE_MS).toBe(350);
  });

  it("varios cambios seguidos se guardan UNA vez, 350 ms despues del ultimo, con el ultimo estado", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule(snapshot("a"));
    await vi.advanceTimersByTimeAsync(200);
    autosaver.schedule(snapshot("ab"));
    await vi.advanceTimersByTimeAsync(200);
    autosaver.schedule(snapshot("abc"));
    await vi.advanceTimersByTimeAsync(349);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = (save.mock.calls[0] as unknown as [{ session: EditSession }])[0];
    expect(saved.session.items[0]).toMatchObject({ edit: { text: "abc" } });
    autosaver.dispose();
  });

  it("beforeunload a los 100 ms vuelca YA, una sola vez, y el temporizador no repite", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule(snapshot());
    await vi.advanceTimersByTimeAsync(100);
    expect(save).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("beforeunload"));
    expect(save).toHaveBeenCalledTimes(1); // sincrono, dentro del propio evento
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    autosaver.dispose();
  });

  it("pagehide y visibilitychange->hidden tambien vuelcan (movil / cambio de pestana)", async () => {
    for (const trigger of [
      () => window.dispatchEvent(new Event("pagehide")),
      () => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ]) {
      const { save, remove } = mocks();
      const autosaver = createEditDraftAutosaver({ save, remove });
      autosaver.schedule(snapshot());
      trigger();
      expect(save).toHaveBeenCalledTimes(1);
      autosaver.dispose();
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("sin nada pendiente no queda ningun oyente de beforeunload (bfcache)", async () => {
    const { save, remove } = mocks();
    const add = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule(snapshot());
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    await vi.advanceTimersByTimeAsync(EDIT_DRAFT_SAVE_DEBOUNCE_MS);
    expect(removeListener.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    // Un beforeunload posterior ya no guarda otra vez.
    window.dispatchEvent(new Event("beforeunload"));
    expect(save).toHaveBeenCalledTimes(1);
    autosaver.dispose();
    add.mockRestore();
    removeListener.mockRestore();
  });

  it("sin cambios pendientes no guarda; si ya guardo ese documento, retira el borrador", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule({ ...snapshot(), session: createEditSession() });
    await vi.advanceTimersByTimeAsync(400);
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    autosaver.schedule(snapshot("algo"));
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(1);
    // El usuario lo deshizo todo: el borrador ya no tiene sentido.
    autosaver.schedule({ ...snapshot(), session: createEditSession() });
    await vi.advanceTimersByTimeAsync(400);
    expect(remove).toHaveBeenCalledWith(ID);
    autosaver.dispose();
  });

  it("un texto nuevo vacio no cuenta como cambio: no se guarda", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule(snapshot("   "));
    await vi.advanceTimersByTimeAsync(400);
    expect(save).not.toHaveBeenCalled();
    autosaver.dispose();
  });

  it("un guardado superado por uno mas nuevo recibe isCurrent=false (no resucita lo viejo)", async () => {
    let release: (value: typeof OK) => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<typeof OK>((resolve) => {
          release = resolve;
        }),
    );
    const autosaver = createEditDraftAutosaver({ save, remove: vi.fn(async () => ({ ok: true }) as const) });
    autosaver.schedule(snapshot("uno"));
    await vi.advanceTimersByTimeAsync(400);
    const first = (save.mock.calls[0] as unknown as [{ isCurrent: () => boolean }])[0];
    expect(first.isCurrent()).toBe(true);
    autosaver.schedule(snapshot("dos"));
    expect(first.isCurrent()).toBe(false);
    release(OK);
    autosaver.dispose();
  });

  it("discard borra el borrador y lo pendiente NO lo resucita", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    autosaver.schedule(snapshot());
    await autosaver.discard(ID);
    expect(remove).toHaveBeenCalledWith(ID);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("beforeunload"));
    expect(save).not.toHaveBeenCalled();
    autosaver.dispose();
  });

  it("un guardado en vuelo cuando se hace discard queda superado", async () => {
    let capture: { isCurrent: () => boolean } | null = null;
    const save = vi.fn(async (p: { isCurrent?: () => boolean }) => {
      capture = { isCurrent: p.isCurrent! };
      return OK;
    });
    const autosaver = createEditDraftAutosaver({ save: save as never, remove: vi.fn(async () => ({ ok: true }) as const) });
    autosaver.schedule(snapshot());
    await vi.advanceTimersByTimeAsync(400);
    await autosaver.discard(ID);
    expect(capture!.isCurrent()).toBe(false);
    autosaver.dispose();
  });

  it("dispose vuelca lo pendiente; dispose({flush:false}) lo descarta; despues ya no programa", async () => {
    const a = mocks();
    const flushing = createEditDraftAutosaver(a);
    flushing.schedule(snapshot());
    flushing.dispose();
    expect(a.save).toHaveBeenCalledTimes(1);
    flushing.schedule(snapshot("otra"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.save).toHaveBeenCalledTimes(1);

    const b = mocks();
    const dropping = createEditDraftAutosaver(b);
    dropping.schedule(snapshot());
    dropping.dispose({ flush: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.save).not.toHaveBeenCalled();
  });

  it("flush manual guarda ya y devuelve el resultado; sin nada pendiente devuelve null", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove });
    await expect(autosaver.flush()).resolves.toBeNull();
    autosaver.schedule(snapshot());
    await expect(autosaver.flush()).resolves.toEqual(OK);
    expect(save).toHaveBeenCalledTimes(1);
    autosaver.dispose();
  });

  it("onResult recibe el resultado de cada guardado (error incluido)", async () => {
    const onResult = vi.fn();
    const save = vi.fn(async () => ({ ok: false, reason: "quota" }) as const);
    const autosaver = createEditDraftAutosaver({ save, remove: vi.fn(async () => ({ ok: true }) as const), onResult });
    autosaver.schedule(snapshot());
    await vi.advanceTimersByTimeAsync(400);
    expect(onResult).toHaveBeenCalledWith({ ok: false, reason: "quota" });
    autosaver.dispose();
  });

  it("debounceMs personalizable", async () => {
    const { save, remove } = mocks();
    const autosaver = createEditDraftAutosaver({ save, remove, debounceMs: 50 });
    autosaver.schedule(snapshot());
    await vi.advanceTimersByTimeAsync(50);
    expect(save).toHaveBeenCalledTimes(1);
    autosaver.dispose();
  });

  it("con cambios pendientes abre la conexion de vida larga para el volcado", async () => {
    vi.useRealTimers();
    __closeWarmEditDraftsConnectionForTests();
    const autosaver = createEditDraftAutosaver(mocks());
    autosaver.schedule(snapshot());
    await warmEditDraftsConnection();
    expect(__hasWarmEditDraftsConnectionForTests()).toBe(true);
    autosaver.dispose({ flush: false });
  });
});

describe("recarga a los 100 ms con beforeunload (IndexedDB real)", () => {
  beforeEach(async () => {
    __closeWarmEditDraftsConnectionForTests();
    __resetEditDraftsMemoryForTests();
    await clearAllEditDrafts();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("una edicion hecha 100 ms antes de recargar SOBREVIVE: la transaccion nace dentro del evento", async () => {
    const autosaver = createEditDraftAutosaver();
    autosaver.schedule(snapshot("lo ultimo que escribi"));
    // El primer cambio abrio la conexion de vida larga; a los 100 ms ya esta lista.
    await warmEditDraftsConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await listEditDrafts()).toHaveLength(0); // el debounce (350 ms) aun no ha disparado

    const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
    window.dispatchEvent(new Event("beforeunload")); // «la pagina se descarga»
    // Lo que sobrevive a una recarga es una transaccion ya lanzada: se creo SIN esperar nada.
    expect(spy.mock.calls.filter(([, mode]) => mode === "readwrite").length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();

    // La pagina «nueva»: modulos recargados, sin memoria de la anterior.
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.resetModules();
    const fresh = await import("@/app/edit-pdf/editDrafts");
    const loaded = await fresh.loadEditDraft(ID);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.draft.session.items[0]).toMatchObject({ edit: { text: "lo ultimo que escribi" } });
    expect(Array.from(loaded.draft.bytes)).toEqual(Array.from(PDF));
    autosaver.dispose({ flush: false });
  });

  it("el debounce posterior no vuelve a guardar lo ya volcado", async () => {
    const save = vi.fn(saveEditDraft);
    const autosaver = createEditDraftAutosaver({ save });
    autosaver.schedule(snapshot("x"));
    await warmEditDraftsConnection();
    window.dispatchEvent(new Event("beforeunload"));
    await new Promise((resolve) => setTimeout(resolve, EDIT_DRAFT_SAVE_DEBOUNCE_MS + 100));
    expect(save).toHaveBeenCalledTimes(1);
    autosaver.dispose({ flush: false });
  });

  it("guardado normal por debounce: aparece en la lista y se puede retomar", async () => {
    const autosaver = createEditDraftAutosaver({ debounceMs: 30 });
    autosaver.schedule(snapshot("por debounce", { pageCount: 2, currentPage: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list = await listEditDrafts();
    expect(list.map((d) => d.id)).toEqual([ID]);
    expect(list[0]).toMatchObject({ pageCount: 2, currentPage: 1, pendingCount: 1 });
    autosaver.dispose();
    await deleteEditDraft(ID);
  });

  it("al retirar el ultimo cambio, el borrador guardado por esta pestana desaparece", async () => {
    const autosaver = createEditDraftAutosaver({ debounceMs: 20 });
    autosaver.schedule(snapshot("algo"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await listEditDrafts()).toHaveLength(1);
    autosaver.schedule({ ...snapshot(), session: createEditSession() });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await listEditDrafts()).toHaveLength(0);
    autosaver.dispose();
  });
});

describe("useEditDraftAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("programa el guardado al cambiar la sesion y vuelca al desmontar", async () => {
    const { save, remove } = mocks();
    const { rerender, unmount } = renderHook(
      ({ snap }: { snap: EditDraftSnapshot | null }) => useEditDraftAutosave(snap, { save, remove }),
      { initialProps: { snap: snapshot("a") as EditDraftSnapshot | null } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledTimes(1);
    rerender({ snap: snapshot("b") });
    unmount();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("re-renderizar con la misma sesion no reprograma", async () => {
    const { save, remove } = mocks();
    const snap = snapshot("a");
    const { rerender } = renderHook(() => useEditDraftAutosave({ ...snap }, { save, remove }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    rerender();
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("snapshot null o enabled:false no guardan nada", async () => {
    const { save, remove } = mocks();
    renderHook(() => useEditDraftAutosave(null, { save, remove }));
    renderHook(() => useEditDraftAutosave(snapshot(), { save, remove, enabled: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("expone flush y discard", async () => {
    const { save, remove } = mocks();
    const { result } = renderHook(() => useEditDraftAutosave(snapshot(), { save, remove }));
    await act(async () => {
      await result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.discard(ID);
    });
    expect(remove).toHaveBeenCalledWith(ID);
  });
});
