import { describe, expect, it, vi } from "vitest";
import { createProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { PagesStore, MAX_PAGES_HISTORY, MAX_PAGES_PDF_SOURCES, getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { deletePages, duplicatePages, movePages, rotatePages } from "@/lib/pdf/pageAssemblyPlan";
import type { PageEntry } from "@/lib/pdf/pageAssembly";

let counter = 0;
const makeStore = () => new PagesStore(() => `t${(counter += 1)}`);
const ready = (store: PagesStore, pages = 5, snapshot = "s1") => {
  store.syncBase(snapshot, pages);
  return store;
};
const ids = (store: PagesStore) => store.getState().plan.map((entry) => entry.id as string);
const order = (plan: readonly PageEntry[]) => plan.map((entry) => (entry.kind === "existing" ? entry.sourceIndex : -1));

describe("PagesStore: base", () => {
  it("empieza sin documento y sin cambios", () => {
    const state = makeStore().getState();
    expect(state.baseSnapshotId).toBeNull();
    expect(state.plan).toEqual([]);
    expect(state.dirty).toBe(false);
    expect(state.changeCount).toBe(0);
  });

  it("syncBase crea el plan identidad con un id por pagina", () => {
    const store = ready(makeStore(), 4);
    const { plan, basePageCount } = store.getState();
    expect(basePageCount).toBe(4);
    expect(order(plan)).toEqual([0, 1, 2, 3]);
    expect(new Set(ids(store)).size).toBe(4);
  });

  it("syncBase con el mismo snapshot no cambia nada (misma referencia de estado)", () => {
    const store = ready(makeStore());
    const before = store.getState();
    expect(store.syncBase("s1", 5)).toBe("unchanged");
    expect(store.getState()).toBe(before);
  });

  it("un snapshot nuevo reinicia el plan; sin cambios pendientes es `reset`", () => {
    const store = ready(makeStore());
    expect(store.syncBase("s2", 5)).toBe("reset");
  });

  it("un snapshot nuevo con cambios pendientes los descarta y devuelve `discarded`", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "girar");
    expect(store.getState().dirty).toBe(true);
    expect(store.syncBase("s2", 5)).toBe("discarded");
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().past).toEqual([]);
  });

  it("tras `beginApply`, el cambio de snapshot siguiente NO cuenta como descarte", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "girar");
    store.beginApply();
    expect(store.syncBase("s2", 5)).toBe("reset");
    // La marca se consume: otro cambio con pendientes ya es un descarte.
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "girar");
    expect(store.syncBase("s3", 5)).toBe("discarded");
  });

  it("`cancelApply` devuelve a descartar de verdad", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "girar");
    store.beginApply();
    store.cancelApply();
    expect(store.syncBase("s2", 5)).toBe("discarded");
  });

  it("cambia tambien si el recuento de paginas cambia con el mismo id", () => {
    const store = ready(makeStore(), 3);
    expect(store.syncBase("s1", 4)).toBe("reset");
    expect(store.getState().plan.length).toBe(4);
  });
});

describe("PagesStore: edicion e historial propio", () => {
  it("commit sustituye el plan, apila un paso y marca los cambios", () => {
    const store = ready(makeStore());
    const next = rotatePages(store.getState().plan, [ids(store)[1]], 90);
    expect(store.commit(next, "girar")).toBe(true);
    const state = store.getState();
    expect(state.dirty).toBe(true);
    expect(state.changeCount).toBe(1);
    expect(state.past).toHaveLength(1);
    expect(state.past[0].label).toBe("girar");
  });

  it("commit del MISMO plan no hace nada ni crea paso", () => {
    const store = ready(makeStore());
    const before = store.getState();
    expect(store.commit(before.plan, "nada")).toBe(false);
    expect(store.getState()).toBe(before);
  });

  it("el contador de cambios crece con cada paso", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "a");
    store.commit(rotatePages(store.getState().plan, [ids(store)[1]], 90), "b");
    store.commit(rotatePages(store.getState().plan, [ids(store)[2]], 90), "c");
    expect(store.getState().changeCount).toBe(3);
  });

  it("si los pasos se compensan (plan identidad) ya no hay cambios que aplicar", () => {
    const store = ready(makeStore());
    const first = ids(store)[0];
    store.commit(rotatePages(store.getState().plan, [first], 90), "a");
    store.commit(rotatePages(store.getState().plan, [first], 270), "b");
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().changeCount).toBe(0);
  });

  it("deshacer devuelve el plan anterior y la descripcion del paso", () => {
    const store = ready(makeStore());
    const original = store.getState().plan;
    store.commit(movePages(original, [ids(store)[4]], 0), "mover");
    expect(store.undo()).toBe("mover");
    expect(store.getState().plan).toBe(original);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
  });

  it("rehacer repite el paso deshecho", () => {
    const store = ready(makeStore());
    const original = store.getState().plan;
    const moved = movePages(original, [ids(store)[4]], 0);
    store.commit(moved, "mover");
    store.undo();
    expect(store.redo()).toBe("mover");
    expect(store.getState().plan).toBe(moved);
    expect(store.canRedo).toBe(false);
  });

  it("deshacer/rehacer sin pasos devuelven null y no cambian el estado", () => {
    const store = ready(makeStore());
    const before = store.getState();
    expect(store.undo()).toBeNull();
    expect(store.redo()).toBeNull();
    expect(store.getState()).toBe(before);
  });

  it("un cambio nuevo tras deshacer descarta la rama de rehacer", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "a");
    store.undo();
    expect(store.canRedo).toBe(true);
    store.commit(rotatePages(store.getState().plan, [ids(store)[1]], 90), "b");
    expect(store.canRedo).toBe(false);
  });

  it("varios deshacer seguidos recorren la pila en orden inverso", () => {
    const store = ready(makeStore());
    store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), "uno");
    store.commit(rotatePages(store.getState().plan, [ids(store)[1]], 90), "dos");
    store.commit(rotatePages(store.getState().plan, [ids(store)[2]], 90), "tres");
    expect([store.undo(), store.undo(), store.undo(), store.undo()]).toEqual(["tres", "dos", "uno", null]);
    expect(store.getState().dirty).toBe(false);
  });

  it("la pila tiene tope (MAX_PAGES_HISTORY) y descarta los pasos mas antiguos", () => {
    const store = ready(makeStore());
    for (let i = 0; i < MAX_PAGES_HISTORY + 20; i += 1) {
      store.commit(rotatePages(store.getState().plan, [ids(store)[0]], 90), `p${i}`);
    }
    expect(store.getState().past).toHaveLength(MAX_PAGES_HISTORY);
  });

  it("discard vuelve a la identidad, vacia el historial y devuelve true si habia algo", () => {
    const store = ready(makeStore());
    store.commit(deletePages(store.getState().plan, [ids(store)[0]]), "borrar");
    expect(store.discard()).toBe(true);
    const state = store.getState();
    expect(state.plan).toHaveLength(5);
    expect(state.dirty).toBe(false);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(store.discard()).toBe(false);
  });

  it("discard sin documento no hace nada", () => {
    expect(makeStore().discard()).toBe(false);
  });
});

describe("PagesStore: seleccion", () => {
  it("setSelection solo guarda ids que existen", () => {
    const store = ready(makeStore());
    store.setSelection([ids(store)[0], "no-existe"], ids(store)[0], ids(store)[0]);
    expect([...store.getState().selection]).toEqual([ids(store)[0]]);
    expect(store.getState().anchorId).toBe(ids(store)[0]);
  });

  it("commit con `keep` conserva la seleccion que sigue existiendo", () => {
    const store = ready(makeStore());
    const [a, b] = ids(store);
    store.setSelection([a, b]);
    store.commit(deletePages(store.getState().plan, [b]), "borrar", "keep");
    expect([...store.getState().selection]).toEqual([a]);
  });

  it("commit con `clear` la vacia y con una lista selecciona esas paginas", () => {
    const store = ready(makeStore());
    const [a, b, c] = ids(store);
    store.setSelection([a]);
    store.commit(rotatePages(store.getState().plan, [a], 90), "girar", "clear");
    expect(store.getState().selection.size).toBe(0);
    store.commit(rotatePages(store.getState().plan, [b], 90), "girar", [c]);
    expect([...store.getState().selection]).toEqual([c]);
  });

  it("la seleccion y el foco de una pagina eliminada se limpian", () => {
    const store = ready(makeStore());
    const [a, b] = ids(store);
    store.setSelection([a, b], a, b);
    store.commit(deletePages(store.getState().plan, [b]), "borrar", "keep");
    expect(store.getState().focusId).toBeNull();
    expect(store.getState().anchorId).toBe(a);
  });

  it("deshacer recupera paginas y la seleccion se ajusta a las que existen", () => {
    const store = ready(makeStore());
    const [a, b] = ids(store);
    store.commit(deletePages(store.getState().plan, [b]), "borrar", "clear");
    store.setSelection([a]);
    store.undo();
    expect(store.getState().plan).toHaveLength(5);
    expect([...store.getState().selection]).toEqual([a]);
  });

  it("setFocus con el mismo id no notifica", () => {
    const store = ready(makeStore());
    const listener = vi.fn();
    store.setFocus(ids(store)[0]);
    store.subscribe(listener);
    store.setFocus(ids(store)[0]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("PagesStore: documentos sumados", () => {
  const pdf = (id: string, extra = {}) => ({
    id,
    kind: "pdf" as const,
    name: `${id}.pdf`,
    size: 10,
    status: "ready" as const,
    data: new Uint8Array([1, 2, 3]),
    pageCount: 2,
    ...extra,
  });

  it("addSource/patchSource actualizan las fuentes", () => {
    const store = ready(makeStore());
    store.addSource(pdf("a", { status: "reading", data: undefined }));
    expect(store.getState().sources.a.status).toBe("reading");
    store.patchSource("a", { status: "ready", pageCount: 7 });
    expect(store.getState().sources.a).toMatchObject({ status: "ready", pageCount: 7 });
  });

  it("patchSource de una fuente que no existe no hace nada", () => {
    const store = ready(makeStore());
    const before = store.getState();
    store.patchSource("x", { status: "error" });
    expect(store.getState()).toBe(before);
  });

  it("pdfSourceCount cuenta solo PDF (no imagenes)", () => {
    const store = ready(makeStore());
    store.addSource(pdf("a"));
    store.addSource({ id: "i", kind: "image", name: "i.png", size: 1, status: "ready" });
    expect(store.pdfSourceCount()).toBe(1);
  });

  it("el limite de PDF sumados es 10", () => {
    expect(MAX_PAGES_PDF_SOURCES).toBe(10);
  });

  it("removeSource quita una fuente que ningun paso usa", () => {
    const store = ready(makeStore());
    store.addSource(pdf("a"));
    store.removeSource("a");
    expect(store.getState().sources.a).toBeUndefined();
  });

  it("removeSource NO quita una fuente que usa el plan ni una que usa el historial", () => {
    const store = ready(makeStore());
    store.addSource(pdf("a"));
    const used: PageEntry[] = [
      ...store.getState().plan,
      { kind: "external", sourceId: "a", sourceIndex: 0, rotation: 0, id: "e1" },
    ];
    store.commit(used, "insertar");
    store.removeSource("a");
    expect(store.getState().sources.a).toBeDefined();
    store.commit(deletePages(store.getState().plan, ["e1"]), "borrar");
    // El plan ya no la usa, pero el historial (deshacer) si.
    store.removeSource("a");
    expect(store.getState().sources.a).toBeDefined();
  });

  it("externalsForPlan devuelve solo las fuentes listas que usa el plan", () => {
    const store = ready(makeStore());
    store.addSource(pdf("a"));
    store.addSource(pdf("b"));
    store.addSource({ id: "i", kind: "image", name: "i.png", size: 1, status: "ready", blob: new Blob(["x"]) });
    store.addSource({ id: "r", kind: "pdf", name: "r.pdf", size: 1, status: "reading" });
    store.commit(
      [
        ...store.getState().plan,
        { kind: "external", sourceId: "a", sourceIndex: 0, rotation: 0, id: "e1" },
        { kind: "image", sourceId: "i", rotation: 0, id: "e2" },
        { kind: "external", sourceId: "r", sourceIndex: 0, rotation: 0, id: "e3" },
      ],
      "insertar",
    );
    const externals = store.externalsForPlan();
    expect(Object.keys(externals).sort()).toEqual(["a", "i"]);
  });

  it("al cambiar de snapshot se sueltan las fuentes y se revocan sus URL", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = ready(makeStore());
    store.addSource({ id: "i", kind: "image", name: "i.png", size: 1, status: "ready", previewUrl: "blob:x" });
    store.syncBase("s2", 5);
    expect(store.getState().sources).toEqual({});
    expect(revoke).toHaveBeenCalledWith("blob:x");
    revoke.mockRestore();
  });

  it("dispose suelta las fuentes y los oyentes", () => {
    const store = ready(makeStore());
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    store.setFocus(ids(store)[0]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("PagesStore: duplicados y resumen", () => {
  it("el resumen del estado sigue al plan", () => {
    const store = ready(makeStore(), 4);
    store.commit(duplicatePages(store.getState().plan, [ids(store)[0]], () => `d${(counter += 1)}`), "duplicar");
    expect(store.getState().summary.duplicated).toBe(1);
    expect(store.getState().summary.identity).toBe(false);
  });
});

describe("getPagesStore", () => {
  it("devuelve el mismo organizador para el mismo documento de trabajo y otro para otro", () => {
    const docA = createProWorkingDoc();
    const docB = createProWorkingDoc();
    expect(getPagesStore(docA)).toBe(getPagesStore(docA));
    expect(getPagesStore(docA)).not.toBe(getPagesStore(docB));
  });
});
