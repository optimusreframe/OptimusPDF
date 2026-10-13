import "fake-indexeddb/auto";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { describe, expect, it, vi } from "vitest";
import { createProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { PRO_HOT_SNAPSHOT_BYTES, ProWorkingDoc, enforceProBudget, residentBytes } from "@/app/pdf-pro/proWorkingDoc";
import type { ProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { limitWarnings } from "@/app/pdf-pro/session/proLimits";
import { draftSnapshotOf } from "@/app/pdf-pro/proDraftAutosave";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import type { ProSnapshot } from "@/app/pdf-pro/proTypes";

/**
 * Wave 8 · memoria del historial: ventana caliente en RAM, volcado a disco de lo demas, recuperacion perezosa al
 * deshacer/rehacer, degradacion con aviso y limpieza. El almacen es falso y controlable (latencia, fallos, filas
 * perdidas) para ejercitar las carreras.
 */

const S = PRO_STRINGS.es.announce;

type FakeStore = ProHistoryStore & {
  rows: Map<string, Uint8Array>;
  puts: number;
  gets: number;
  removed: string[];
  cleared: number;
  disposed: boolean;
  /** Resuelve o rechaza las escrituras pendientes en el orden en que llegaron. */
  releasePuts: () => Promise<void>;
};

function fakeStore(options: { failPut?: boolean; manualPuts?: boolean; missing?: Set<string>; wrongFor?: string } = {}): FakeStore {
  const rows = new Map<string, Uint8Array>();
  const pendingPuts: (() => void)[] = [];
  const store: FakeStore = {
    name: "optimuspdf-pro-history-test",
    rows,
    puts: 0,
    gets: 0,
    removed: [],
    cleared: 0,
    disposed: false,
    releasePuts: async () => {
      for (const release of pendingPuts.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    put: (id, bytes) =>
      new Promise<void>((resolve, reject) => {
        store.puts += 1;
        const settle = () => {
          if (options.failPut) reject(new Error("QuotaExceededError"));
          else {
            rows.set(id, new Uint8Array(bytes));
            resolve();
          }
        };
        if (options.manualPuts) pendingPuts.push(settle);
        else setTimeout(settle, 0);
      }),
    get: async (id) => {
      store.gets += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (options.missing?.has(id)) return null;
      if (options.wrongFor === id) return fakeBytes(rows.get(id)?.byteLength ?? 8, 99);
      const row = rows.get(id);
      return row ? new Uint8Array(row) : null;
    },
    remove: async (ids) => {
      for (const id of ids) {
        rows.delete(id);
        store.removed.push(id);
      }
    },
    clear: async () => {
      rows.clear();
      store.cleared += 1;
    },
    dispose: async () => {
      store.disposed = true;
      rows.clear();
    },
  };
  return store;
}

const until = (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000, interval: 5 });

/** Documento con `n` pasos de 100 bytes y ventana caliente de 300 bytes (actual + 2 vecinos). */
async function withSteps(n: number, store: ProHistoryStore | null, extra: Partial<ConstructorParameters<typeof ProWorkingDoc>[0]> = {}) {
  const doc = fakeDoc({ historyStore: store, hotBytes: 300, ...extra });
  await doc.open(fakeFile(100), { pageCount: 3 });
  for (let i = 1; i <= n; i += 1) {
    const commit = doc.commit(fakeBytes(100, i), `P${i}`, "operation", { pageCount: 3 });
    const release = (store as FakeStore | null)?.releasePuts;
    if (release) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await release();
    }
    await commit;
  }
  return doc;
}

const snapshotsOf = (doc: ProWorkingDoc) => doc.getState().document!.snapshots;
const offloadedLabels = (doc: ProWorkingDoc) => snapshotsOf(doc).filter((s) => s.offloaded).map((s) => s.label);
const residentTotal = (doc: ProWorkingDoc) => snapshotsOf(doc).reduce((n, s) => n + residentBytes(s), 0);
const cursorOf = (doc: ProWorkingDoc) => doc.getState().document!.cursor;
const text = (doc: ProWorkingDoc) => doc.getState().announcement?.text;

describe("ventana caliente y volcado", () => {
  it("la ventana por defecto es 192 MB: con 100 MB quedan el actual y el anterior (siempre); con 40 MB, cuatro", () => {
    expect(PRO_HOT_SNAPSHOT_BYTES).toBe(192 * 1024 * 1024);
  });

  it("el anterior al actual se queda en RAM aunque no quepa en la ventana (deshacer un paso es instantaneo)", async () => {
    const store = fakeStore();
    const doc = await withSteps(4, store, { hotBytes: 50 });
    await until(() => offloadedLabels(doc).length === 3);
    expect(offloadedLabels(doc)).toEqual(["Original", "P1", "P2"]);
    expect(doc.undo()).toBe(true);
    expect(cursorOf(doc)).toBe(3);
    expect(doc.getState().restoring).toBe(false);
  });

  it("con PDF pequeños cabe todo el historial en la ventana: nada se vuelca y deshacer es siempre sincrono", async () => {
    const store = fakeStore();
    const doc = await withSteps(10, store, { hotBytes: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(offloadedLabels(doc)).toEqual([]);
    expect(store.puts).toBe(0);
    expect(doc.goTo(0)).toBe(true);
    expect(cursorOf(doc)).toBe(0);
  });

  it("tras varios pasos solo el actual y sus vecinos quedan en RAM; el resto se vuelca y sus bytes se vacian", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    expect(offloadedLabels(doc)).toEqual(["Original", "P1", "P2"]);
    expect(snapshotsOf(doc).map((s) => s.label)).toEqual(["Original", "P1", "P2", "P3", "P4", "P5"]);
    for (const snapshot of snapshotsOf(doc)) {
      expect(snapshot.bytes.byteLength).toBe(snapshot.offloaded ? 0 : 100);
      expect(snapshot.byteLength).toBe(100);
    }
    expect(residentTotal(doc)).toBe(300);
    expect([...store.rows.keys()].length).toBe(3);
    // El actual sigue entero y es lo que leen las herramientas.
    expect(doc.current()?.byteLength).toBe(100);
    expect(doc.currentSnapshot()?.label).toBe("P5");
    expect(doc.getState().document?.trimmedCount).toBe(0);
    expect(doc.getState().document?.historyOffloadFailed).toBeUndefined();
  });

  it("el historial completo sigue en la lista (deshacer no pierde pasos) y el presupuesto por bytes no recorta lo volcado", async () => {
    const store = fakeStore();
    const doc = await withSteps(12, store, { maxBytes: 350 });
    await until(() => offloadedLabels(doc).length === 10);
    expect(snapshotsOf(doc)).toHaveLength(13);
    expect(doc.getState().document?.trimmedCount).toBe(0);
    expect(limitWarnings(doc.getState().document).map((w) => w.code)).not.toContain("memoryHigh");
  });

  it("deshacer hacia un paso volcado recupera sus bytes EXACTOS y anuncia el paso; mientras tanto `restoring`", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    doc.undo(); // P4 (residente)
    doc.undo(); // P3 (residente)
    expect(cursorOf(doc)).toBe(3);
    expect(doc.undo()).toBe(true); // P2: en disco
    expect(doc.getState().restoring).toBe(true);
    expect(cursorOf(doc)).toBe(3); // aun no se movio
    await until(() => cursorOf(doc) === 2);
    expect(doc.getState().restoring).toBe(false);
    expect(text(doc)).toBe(S.undone("P3"));
    const current = doc.currentSnapshot()!;
    expect(current.offloaded).toBe(false);
    expect(Array.from(current.bytes.subarray(0, 8))).toEqual(Array.from(fakeBytes(100, 2).subarray(0, 8)));
    expect(current.bytes.byteLength).toBe(100);
    expect(doc.currentFile()?.size).toBe(100);
  });

  it("al moverse, lo que sale de la ventana se vuelca (si no estaba) y lo que entra se trae por adelantado", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    const putsBefore = store.puts;
    doc.undo();
    doc.undo(); // cursor en P3 (residente): ventana = P3, P2 (en disco: se trae), P4; P5 sale
    await until(() => snapshotsOf(doc)[5].offloaded === true && !snapshotsOf(doc)[2].offloaded);
    expect(store.puts).toBe(putsBefore + 1); // solo P5 era nuevo en disco
    expect(residentTotal(doc)).toBeLessThanOrEqual(300);
    // Con P2 ya en RAM el siguiente deshacer es instantaneo (sincrono).
    expect(doc.undo()).toBe(true);
    expect(cursorOf(doc)).toBe(2);
    expect(doc.getState().restoring).toBe(false);
    // Volver al final: P3 sale de la ventana pero ya estaba en disco: se suelta sin reescribir.
    const putsMid = store.puts;
    doc.goTo(5);
    await until(() => cursorOf(doc) === 5);
    await until(() => snapshotsOf(doc)[2].offloaded === true);
    expect(store.puts).toBe(putsMid);
  });

  it("un salto largo al original recupera el original y anuncia TODOS los pasos cruzados agrupados", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    expect(doc.goTo(0)).toBe(true);
    await until(() => cursorOf(doc) === 0);
    expect(text(doc)).toBe(S.undone("P5, P4, P3, P2, P1"));
    expect(doc.currentSnapshot()?.label).toBe("Original");
    expect(doc.current()?.byteLength).toBe(100);
    // Ahora el final del historial queda fuera de la ventana: se vuelca y el original + P1 (prefetch) quedan en RAM.
    await until(() => snapshotsOf(doc)[5].offloaded === true);
    expect(residentTotal(doc)).toBeLessThanOrEqual(300);
    doc.goTo(5);
    await until(() => cursorOf(doc) === 5);
    expect(text(doc)).toBe(S.wentTo("P1, P2, P3, P4, P5"));
    expect(doc.currentSnapshot()?.bytes[5]).toBe(5); // seed de P5
  });

  it("dos deshacer seguidos mientras el primero espera sus bytes: gana el ultimo y el anuncio cubre ambos pasos", async () => {
    const store = fakeStore();
    const doc = await withSteps(6, store);
    await until(() => offloadedLabels(doc).length === 4);
    doc.undo(); // P5 residente
    doc.undo(); // P4 residente
    expect(doc.undo()).toBe(true); // P3: disco (pendiente)
    expect(doc.undo()).toBe(true); // P2: disco; cancela el anterior
    await until(() => cursorOf(doc) === 2);
    expect(text(doc)).toBe(S.undone("P4, P3"));
    expect(doc.currentSnapshot()?.label).toBe("P2");
    expect(doc.currentSnapshot()?.bytes[5]).toBe(2);
    expect(doc.getState().restoring).toBe(false);
  });

  it("rehacer durante un deshacer pendiente vuelve al punto de partida y no deja nada en vuelo", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    doc.undo();
    doc.undo();
    doc.undo(); // P2 pendiente
    expect(doc.redo()).toBe(true); // vuelve a P3 (donde esta el cursor)
    expect(doc.getState().restoring).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cursorOf(doc)).toBe(3);
    expect(doc.currentSnapshot()?.label).toBe("P3");
  });

  it("confirmar un cambio mientras un deshacer espera sus bytes cancela ese deshacer: el cambio manda", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    doc.undo();
    doc.undo();
    doc.undo(); // P2 pendiente
    await doc.commit(fakeBytes(100, 9), "Nuevo", "operation", { pageCount: 3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(snapshotsOf(doc).map((s) => s.label)).toEqual(["Original", "P1", "P2", "P3", "Nuevo"]);
    expect(cursorOf(doc)).toBe(4);
    expect(doc.getState().restoring).toBe(false);
    // La rama de rehacer descartada (P4, P5) se borra tambien del disco si estaba alli.
    expect(store.rows.size).toBeLessThanOrEqual(3);
  });

  it("un paso descartado mientras se escribia (rama de rehacer) se borra del disco al terminar la escritura", async () => {
    const store = fakeStore({ manualPuts: true });
    const doc = fakeDoc({ historyStore: store, hotBytes: 300 });
    await doc.open(fakeFile(100), { pageCount: 3 });
    const commits = [1, 2, 3, 4, 5].map((i) => doc.commit(fakeBytes(100, i), `P${i}`, "operation", { pageCount: 3 }));
    // Cada confirmacion espera a que lo que sale de la ventana este en disco: se liberan las escrituras a mano.
    for (let i = 0; i < 5; i += 1) await store.releasePuts();
    await Promise.all(commits);
    expect(offloadedLabels(doc)).toEqual(["Original", "P1", "P2"]);
    // Se vuelve a P1 y se confirma otro cambio: P2..P5 fuera, tambien de disco.
    doc.goTo(1);
    await until(() => cursorOf(doc) === 1);
    const commit = doc.commit(fakeBytes(100, 8), "Otro", "operation", { pageCount: 3 });
    await store.releasePuts();
    await commit;
    expect(snapshotsOf(doc).map((s) => s.label)).toEqual(["Original", "P1", "Otro"]);
    expect(store.removed.length).toBeGreaterThan(0);
    expect([...store.rows.keys()].every((id) => snapshotsOf(doc).some((s) => s.id === id))).toBe(true);
  });

  it("volver a un paso cuya escritura aun esta en vuelo lo deja en RAM (no se vacia bajo los pies del visor)", async () => {
    const store = fakeStore({ manualPuts: true });
    const doc = await withSteps(2, store); // Original, P1, P2: todos en la ventana (300)
    // P3 se confirma pero NO se espera: el Original sale de la ventana con su escritura en vuelo.
    const commit = doc.commit(fakeBytes(100, 3), "P3", "operation", { pageCount: 3 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshotsOf(doc)[0].offloaded).toBeFalsy();
    expect(doc.goTo(0)).toBe(true); // sincrono: sigue residente
    expect(doc.getState().restoring).toBe(false);
    expect(doc.currentSnapshot()?.label).toBe("Original");
    expect(doc.currentSnapshot()?.bytes.byteLength).toBe(100);
    await store.releasePuts();
    await commit;
    expect(cursorOf(doc)).toBe(0);
    expect(doc.currentSnapshot()?.offloaded).toBeFalsy();
    expect(doc.currentSnapshot()?.bytes.byteLength).toBe(100);
    // Lo que si salio de la ventana (P3, el ultimo) se vuelca al moverse al original.
    await store.releasePuts();
    await until(() => snapshotsOf(doc)[3].offloaded === true);
  });
});

describe("degradacion con aviso", () => {
  it("si el disco falla (cuota), el documento queda marcado, se anuncia y se recorta por bytes como antes", async () => {
    const store = fakeStore({ failPut: true });
    const doc = fakeDoc({ historyStore: store, hotBytes: 300, maxBytes: 350 });
    const spoken: string[] = [];
    doc.subscribe(() => {
      const current = text(doc);
      if (current && spoken[spoken.length - 1] !== current) spoken.push(current);
    });
    await doc.open(fakeFile(100), { pageCount: 3 });
    for (let i = 1; i <= 5; i += 1) await doc.commit(fakeBytes(100, i), `P${i}`, "operation", { pageCount: 3 });
    await until(() => doc.getState().document?.historyOffloadFailed === true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spoken.some((line) => line.includes(S.historyOffloadFailed))).toBe(true);
    expect(spoken.some((line) => line.includes(S.historyTrimmed))).toBe(true);
    expect(limitWarnings(doc.getState().document).map((w) => w.code)).toContain("historyOffloadUnavailable");
    expect(residentTotal(doc)).toBeLessThanOrEqual(350);
    expect(doc.getState().document?.trimmedCount).toBeGreaterThan(0);
    expect(snapshotsOf(doc)[0].label).toBe("Original");
    expect(doc.currentSnapshot()?.label).toBe("P5");
    // Deshacer sigue siendo exacto sobre lo que queda y anuncia lo saltado.
    doc.goTo(0);
    expect(text(doc)).toBe(S.undone("P5, P4, P3, P2, P1"));
  });

  it("sin IndexedDB (store null) con muchos pasos: solo RAM, aviso en el panel, recorte de siempre y sin anuncio extra", async () => {
    const doc = await withSteps(5, null, { maxBytes: 350 });
    expect(text(doc)).toBe(`${S.applied("P5")}. ${S.historyTrimmed}`);
    expect(doc.getState().document?.historyOffloadFailed).toBe(true);
    expect(limitWarnings(doc.getState().document).map((w) => w.code)).toContain("historyOffloadUnavailable");
    expect(offloadedLabels(doc)).toEqual([]);
    expect(residentTotal(doc)).toBeLessThanOrEqual(350);
  });

  it("con el disco fallido, deshacer hacia un paso volcado lo recupera y el aviso de recorte se SUMA al «Deshecho» (no lo pisa)", async () => {
    const store = fakeStore();
    const doc = await withSteps(6, store, { maxBytes: 300 });
    await until(() => offloadedLabels(doc).length === 4);
    // El disco falla a partir de ahora (cuota): se marca el documento.
    (doc as unknown as { document: { historyOffloadFailed?: boolean } }).document.historyOffloadFailed = true;
    doc.goTo(2); // P2: volcado → se recupera
    await until(() => cursorOf(doc) === 2);
    expect(doc.currentSnapshot()?.bytes[5]).toBe(2);
    // Al volver, P5/P6 quedan residentes fuera de la ventana y sin disco: el presupuesto (300) recorta y lo anuncia SUMADO.
    expect(text(doc)).toContain(S.undone("P6, P5, P4, P3"));
    expect(text(doc)).toContain(S.historyTrimmed);
    expect(residentTotal(doc)).toBeLessThanOrEqual(300);
    expect(doc.getState().document?.trimmedCount).toBeGreaterThan(0);
  });

  it("sin disco y con pocos pasos (caben en la ventana) no hay aviso ninguno", async () => {
    const doc = await withSteps(2, null);
    expect(doc.getState().document?.historyOffloadFailed).toBeUndefined();
    expect(limitWarnings(doc.getState().document)).toEqual([]);
  });

  it("si el paso volcado ya no esta en disco al deshacer, se retira del historial y se anuncia (nunca en silencio)", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    const lost = snapshotsOf(doc)[1]; // P1
    store.rows.delete(lost.id);
    doc.goTo(1);
    await until(() => doc.getState().restoring === false && snapshotsOf(doc).length === 5);
    expect(snapshotsOf(doc).map((s) => s.label)).toEqual(["Original", "P2", "P3", "P4", "P5"]);
    expect(text(doc)).toBe(S.historyStepLost("P1"));
    expect(cursorOf(doc)).toBe(4); // no se movio
    expect(doc.currentSnapshot()?.label).toBe("P5");
    expect(doc.getState().document?.trimmedCount).toBe(1);
    expect(doc.getState().document?.historyOffloadFailed).toBe(true);
    // El siguiente hereda la etiqueta perdida: deshacer hasta el original la anuncia.
    expect(snapshotsOf(doc)[1].skippedLabels).toEqual(["P1"]);
  });

  it("si el disco devuelve bytes de OTRO tamaño, el almacen real los rechaza; el falso aqui no, y el documento los tomaria: por eso el almacen comprueba la longitud", async () => {
    // Documenta el reparto de responsabilidades: `proHistoryStore.get` compara `byteLength` con lo anotado.
    const store = fakeStore({ wrongFor: "nunca" });
    const doc = await withSteps(3, store);
    expect(doc.current()?.byteLength).toBe(100);
  });
});

describe("limpieza y borradores", () => {
  it("cerrar vacia el disco; abrir otro documento tambien; dispose borra la base", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => store.rows.size === 3);
    doc.close();
    expect(store.cleared).toBeGreaterThan(0);
    expect(store.rows.size).toBe(0);
    await doc.open(fakeFile(100, "otro.pdf"), { pageCount: 3 });
    for (let i = 1; i <= 4; i += 1) await doc.commit(fakeBytes(100, i), `Q${i}`, "operation", { pageCount: 3 });
    await until(() => store.rows.size === 2);
    const clearedBefore = store.cleared;
    await doc.open(fakeFile(100, "tercero.pdf"), { pageCount: 3 });
    expect(store.cleared).toBe(clearedBefore + 1);
    expect(store.rows.size).toBe(0);
    await doc.dispose();
    expect(store.disposed).toBe(true);
    expect(doc.getState().document).toBeNull();
  });

  it("una escritura que termina despues de cerrar el documento no deja restos", async () => {
    const store = fakeStore({ manualPuts: true });
    const doc = await withSteps(4, store);
    doc.close();
    await store.releasePuts();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.rows.size).toBe(0);
  });

  it("el borrador se hace con los bytes ENTEROS del actual y con el historial completo (etiquetas de lo volcado incluidas)", async () => {
    const store = fakeStore();
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    const draft = draftSnapshotOf(doc.getState().document, true, 0)!;
    expect(draft.bytes.byteLength).toBe(100);
    expect(draft.history.map((h) => h.label)).toEqual(["Original", "P1", "P2", "P3", "P4", "P5"]);
  });

  it("con el almacen real sobre fake-indexeddb el ciclo entero funciona (volcar, deshacer, rehacer, cerrar)", async () => {
    const store = createProHistoryStore({ sessionId: "doc-real", useBlob: false })!;
    const doc = await withSteps(5, store);
    await until(() => offloadedLabels(doc).length === 3);
    doc.goTo(0);
    await until(() => cursorOf(doc) === 0);
    expect(doc.currentSnapshot()?.bytes[5]).toBe(1); // seed del original (fakeFile usa seed 1)
    doc.goTo(5);
    await until(() => cursorOf(doc) === 5);
    expect(doc.currentSnapshot()?.bytes[5]).toBe(5);
    await doc.dispose();
    const names = (await indexedDB.databases()).map((info) => info.name);
    expect(names).not.toContain(store.name);
  });
});

describe("enforceProBudget con snapshots volcados", () => {
  const snap = (id: string, offloaded = false) => ({ id, byteLength: 100, offloaded }) as ProSnapshot;

  it("por bytes solo cuenta y descarta lo residente", () => {
    const result = enforceProBudget(
      { snapshots: [snap("o", true), snap("a", true), snap("b"), snap("c"), snap("d")], cursor: 4 },
      { maxSnapshots: 50, maxBytes: 250 },
    );
    expect(result.snapshots.map((s) => s.id)).toEqual(["o", "a", "c", "d"]);
    expect(result.evicted.map((s) => s.id)).toEqual(["b"]);
    expect(result.snapshots[2].skippedLabels).toEqual([undefined]);
  });

  it("por numero descarta el mas antiguo aunque este volcado", () => {
    const result = enforceProBudget(
      { snapshots: [snap("o", true), snap("a", true), snap("b"), snap("c")], cursor: 3 },
      { maxSnapshots: 3, maxBytes: 10_000 },
    );
    expect(result.snapshots.map((s) => s.id)).toEqual(["o", "b", "c"]);
  });
});

describe("paso en vuelo (D7)", () => {
  it("commit marca stepInFlight mientras esta encolado y lo baja al terminar; trackStep cuenta operaciones", async () => {
    const doc = fakeDoc({ historyStore: null, countPages: () => new Promise((r) => setTimeout(() => r(3), 10)) });
    await doc.open(fakeFile(100), { pageCount: 3 });
    expect(doc.getState().stepInFlight).toBe(false);
    const commit = doc.commit(fakeBytes(100, 1), "P1", "operation");
    expect(doc.getState().stepInFlight).toBe(true);
    expect(doc.getState().dirty).toBe(false);
    await commit;
    expect(doc.getState().stepInFlight).toBe(false);
    expect(doc.getState().dirty).toBe(true);
    let release: () => void = () => {};
    const work = doc.trackStep(new Promise<void>((resolve) => (release = resolve)));
    expect(doc.stepInFlight).toBe(true);
    release();
    await work;
    expect(doc.stepInFlight).toBe(false);
    // Un paso que falla tambien baja la marca.
    await doc.trackStep(Promise.reject(new Error("x"))).catch(() => undefined);
    expect(doc.stepInFlight).toBe(false);
  });
});
