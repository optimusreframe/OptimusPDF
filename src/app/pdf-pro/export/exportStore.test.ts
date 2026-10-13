import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfError } from "@/lib/pdf/core";
import { getExportStore, ExportStore, type ExportStoreState } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProExport, ProExportContext, ProExportResult } from "@/app/pdf-pro/ops/proExports";
import type { ProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Wave 9 · exportacion persistente: el estado y el motor de la exportacion viven en un almacen por documento de
 * trabajo (no en la tarjeta). Aqui se prueba SIN React, con un motor falso y controlable: inicio, progreso, cancelar,
 * terminar, copia FIJA del documento, cerrar/abrir otro, doble inicio, error y carreras entre cancelar y terminar.
 */

const downloads = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[], fail: false }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, name: string) => {
      if (downloads.fail) throw new Error("descarga bloqueada");
      downloads.items.push({ blob, name });
    },
  };
});

const ES = getExportStrings("es");
const EN = getExportStrings("en");

type Control = {
  entry: ProExport;
  calls: ProExportContext[];
  byteArgs: Uint8Array[];
  resolve: (result?: Partial<ProExportResult>) => void;
  reject: (error: unknown) => void;
  progress: (value: number) => void;
  signal: () => AbortSignal;
};

/** Un motor falso que NO termina hasta que la prueba lo decide (y que SI se entera de la cancelacion). */
function controllable(id = "word"): Control {
  const calls: ProExportContext[] = [];
  const byteArgs: Uint8Array[] = [];
  let resolve!: (result: ProExportResult) => void;
  let reject!: (error: unknown) => void;
  const entry: ProExport = {
    id,
    title: () => id,
    body: () => id,
    slug: "pdf-to-word",
    requiresNetwork: false,
    run(bytes, context) {
      calls.push(context);
      byteArgs.push(bytes);
      return new Promise<ProExportResult>((done, fail) => {
        resolve = done;
        reject = fail;
        context.signal.addEventListener("abort", () => fail(new PdfError("cancelled")));
      });
    },
  };
  return {
    entry,
    calls,
    byteArgs,
    resolve: (result) => resolve({ blob: new Blob(["x"]), filename: "salida.docx", ...result }),
    reject: (error) => reject(error),
    progress: (value) => calls[calls.length - 1].onProgress(value),
    signal: () => calls[calls.length - 1].signal,
  };
}

const request = (entry: ProExport, extra: Partial<Parameters<ExportStore["start"]>[0]> = {}) => ({
  entry,
  options: { stripRepeated: true },
  selectedPages: [] as readonly number[],
  language: "es" as const,
  ...extra,
});

async function openedDoc(extra: Parameters<typeof fakeDoc>[0] = {}) {
  const doc = fakeDoc(extra);
  await doc.open(fakeFile(120), { pageCount: 3 });
  return doc;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  downloads.items.length = 0;
  downloads.fail = false;
});
afterEach(() => vi.restoreAllMocks());

describe("exportStore · inicio y progreso", () => {
  it("empieza con el snapshot actual: estado `running`, version, documento y lo que recibe el motor", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    const snapshot = doc.currentSnapshot()!;
    const result = store.start(request(control.entry, { selectedPages: [0, 2] }));
    expect(result.ok).toBe(true);
    const job = store.getState().job!;
    expect(job).toMatchObject({
      formatId: "word",
      phase: "running",
      progress: 0,
      docId: doc.getState().document!.id,
      snapshotId: snapshot.id,
      versionLabel: "Original",
      filename: null,
      error: null,
    });
    expect(store.running).toBe(true);
    expect(store.runningJob).toBe(job);
    expect(control.calls).toHaveLength(1);
    expect(control.byteArgs[0]).toBe(snapshot.bytes);
    expect(control.calls[0]).toMatchObject({
      name: "doc.pdf",
      language: "es",
      options: { stripRepeated: true },
      selectedPages: [0, 2],
      pageCount: 3,
    });
    expect(control.calls[0].file).toBeInstanceOf(File);
    expect(control.calls[0].file?.size).toBe(snapshot.byteLength);
    expect(control.calls[0].signal.aborted).toBe(false);
  });

  it("start sin documento, o con una exportacion sin motor, no arranca nada", async () => {
    const empty = fakeDoc();
    expect(getExportStore(empty).start(request(controllable().entry))).toEqual({ ok: false, reason: "noDocument" });
    const doc = await openedDoc();
    const placeholder: ProExport = { id: "images", title: () => "x", body: () => "x", slug: "pdf-to-jpg", requiresNetwork: false };
    expect(getExportStore(doc).start(request(placeholder))).toEqual({ ok: false, reason: "unsupported" });
    expect(getExportStore(doc).getState().job).toBeNull();
  });

  it("el progreso se redondea al 1 % y solo avisa cuando cambia el porcentaje", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState().job!.progress));
    control.progress(0.001);
    control.progress(0.004);
    control.progress(0.42);
    control.progress(0.424);
    control.progress(2); // se acota a 1
    control.progress(-1); // se acota a 0
    control.progress(Number.NaN); // no es un numero: cuenta como 0 (sin cambio)
    expect(seen).toEqual([0.42, 1, 0]);
    expect(store.getState().job!.progress).toBe(0);
  });

  it("un progreso tardio de una exportacion cancelada no cambia nada", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    store.cancel();
    const listener = vi.fn();
    store.subscribe(listener);
    control.progress(0.9);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().job!.phase).toBe("cancelled");
  });
});

describe("exportStore · terminar", () => {
  it("descarga UNA vez con el nombre del motor, anuncia y SUELTA los bytes retenidos", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    expect(store.heldBytesForTests()).toBe(doc.currentSnapshot()!.bytes);
    control.resolve({ filename: "informe-word.docx" });
    await tick();
    expect(downloads.items.map((item) => item.name)).toEqual(["informe-word.docx"]);
    expect(store.getState().job).toMatchObject({ phase: "done", progress: 1, filename: "informe-word.docx", error: null });
    expect(doc.getState().announcement?.text).toBe(ES.card.done("informe-word.docx"));
    expect(store.running).toBe(false);
    expect(store.heldBytesForTests()).toBeNull();
  });

  it("exportar NO toca el historial ni el estado «guardado»", async () => {
    const doc = await openedDoc();
    const before = doc.getState().document!;
    const control = controllable();
    getExportStore(doc).start(request(control.entry));
    control.resolve();
    await tick();
    const after = doc.getState();
    expect(after.document!.snapshots).toEqual(before.snapshots);
    expect(after.dirty).toBe(false);
  });

  it("tras terminar se puede empezar otra: cada exportacion tiene su propio id", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const first = controllable("word");
    const a = store.start(request(first.entry));
    first.resolve();
    await tick();
    const second = controllable("excel");
    const b = store.start(request(second.entry));
    expect(a.ok && b.ok && b.jobId > a.jobId).toBe(true);
    expect(store.getState().job).toMatchObject({ formatId: "excel", phase: "running" });
  });

  it("si la descarga falla (bloqueada) la exportacion queda con error y no se anuncia como hecha", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    downloads.fail = true;
    control.resolve();
    await tick();
    expect(store.getState().job!.phase).toBe("error");
    expect(doc.getState().announcement?.text).not.toBe(ES.card.done("salida.docx"));
  });
});

describe("exportStore · cancelar y carreras", () => {
  it("cancelar aborta la señal, deja `cancelled`, anuncia y suelta los bytes", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    expect(store.cancel()).toBe(true);
    expect(control.signal().aborted).toBe(true);
    expect(store.getState().job!.phase).toBe("cancelled");
    expect(doc.getState().announcement?.text).toBe(ES.card.cancelled);
    expect(store.heldBytesForTests()).toBeNull();
    expect(store.running).toBe(false);
    // Sin nada en curso, cancelar no hace nada (ni anuncia otra vez).
    const announced = doc.getState().announcement!.id;
    expect(store.cancel()).toBe(false);
    expect(doc.getState().announcement!.id).toBe(announced);
  });

  it("un resultado TARDIO de una exportacion cancelada no se descarga", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    let late!: (value: ProExportResult) => void;
    const entry: ProExport = {
      id: "word",
      title: () => "w",
      body: () => "w",
      slug: "pdf-to-word",
      requiresNetwork: false,
      run: () => new Promise<ProExportResult>((resolve) => (late = resolve)), // ignora la señal a proposito
    };
    store.start(request(entry));
    store.cancel();
    late({ blob: new Blob(["tarde"]), filename: "tarde.docx" });
    await tick();
    expect(downloads.items).toEqual([]);
    expect(store.getState().job!.phase).toBe("cancelled");
  });

  it("cancelar y terminar en el MISMO turno: gana cancelar (una sola descarga o ninguna, nunca dos)", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    control.resolve({ filename: "gana-el-resultado.docx" });
    // El motor ya resolvio, pero su continuacion aun no corrio: el usuario cancela en este mismo turno.
    store.cancel();
    await tick();
    expect(downloads.items).toEqual([]);
    expect(store.getState().job!.phase).toBe("cancelled");
  });

  it("cancelar DESPUES de terminar no deshace nada: sigue `done` con su unica descarga", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    control.resolve({ filename: "uno.docx" });
    await tick();
    expect(store.cancel()).toBe(false);
    await tick();
    expect(downloads.items.map((item) => item.name)).toEqual(["uno.docx"]);
    expect(store.getState().job!.phase).toBe("done");
  });

  it("el resultado tardio de la A cancelada NO termina la B que empezo despues", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    let lateA!: (value: ProExportResult) => void;
    const ignoring: ProExport = {
      id: "word",
      title: () => "w",
      body: () => "w",
      slug: "pdf-to-word",
      requiresNetwork: false,
      run: () => new Promise<ProExportResult>((resolve) => (lateA = resolve)),
    };
    store.start(request(ignoring));
    store.cancel();
    const b = controllable("excel");
    store.start(request(b.entry));
    lateA({ blob: new Blob(["A"]), filename: "a.docx" });
    await tick();
    expect(downloads.items).toEqual([]);
    expect(store.getState().job).toMatchObject({ formatId: "excel", phase: "running" });
    b.resolve({ filename: "b.xlsx" });
    await tick();
    expect(downloads.items.map((item) => item.name)).toEqual(["b.xlsx"]);
  });

  it("un motor que se cancela por su cuenta (`cancelled`) queda cancelado, no como error", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    control.reject(new PdfError("cancelled"));
    await tick();
    expect(store.getState().job).toMatchObject({ phase: "cancelled", error: null });
    expect(downloads.items).toEqual([]);
  });
});

describe("exportStore · una a la vez", () => {
  it("un segundo inicio con otra en curso devuelve `busy` y NO arranca otro motor ni cambia el trabajo", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const first = controllable("word");
    const second = controllable("excel");
    const a = store.start(request(first.entry));
    const before = store.getState();
    expect(store.start(request(second.entry))).toEqual({ ok: false, reason: "busy" });
    expect(store.start(request(first.entry))).toEqual({ ok: false, reason: "busy" });
    expect(second.calls).toHaveLength(0);
    expect(first.calls).toHaveLength(1);
    expect(store.getState()).toBe(before);
    expect(a.ok && store.getState().job!.id).toBe(a.ok ? a.jobId : -1);
  });

  it("tras cancelar o fallar la anterior, otra puede empezar", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const first = controllable("word");
    store.start(request(first.entry));
    store.cancel();
    expect(store.start(request(controllable("excel").entry)).ok).toBe(true);
    const failing = controllable("csv");
    store.cancel();
    store.start(request(failing.entry));
    failing.reject(new PdfError("noTablesFound"));
    await tick();
    expect(store.start(request(controllable("json").entry)).ok).toBe(true);
  });
});

describe("exportStore · copia FIJA del documento", () => {
  it("aplicar otra operacion mientras exporta NO cambia lo que se exporta ni la version del resultado", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const original = doc.currentSnapshot()!;
    const control = controllable();
    store.start(request(control.entry));
    await doc.commit(fakeBytes(300, 7), "Rotar 90°", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(400, 8), "Marca de agua", "operation", { pageCount: 3 });
    expect(doc.currentSnapshot()!.id).not.toBe(original.id);
    // El motor ya tenia (y sigue teniendo) los bytes del original.
    expect(control.byteArgs[0]).toBe(original.bytes);
    expect(control.calls[0].file?.size).toBe(original.byteLength);
    expect(store.getState().job).toMatchObject({ snapshotId: original.id, versionLabel: "Original", phase: "running" });
    control.resolve({ filename: "desde-original.docx" });
    await tick();
    expect(store.getState().job).toMatchObject({ snapshotId: original.id, versionLabel: "Original", phase: "done" });
  });

  it("deshacer o ir a otra version tampoco cambia la copia en curso", async () => {
    const doc = await openedDoc();
    await doc.commit(fakeBytes(300, 7), "Rotar 90°", "operation", { pageCount: 3 });
    const store = getExportStore(doc);
    const rotated = doc.currentSnapshot()!;
    const control = controllable();
    store.start(request(control.entry));
    expect(store.getState().job!.versionLabel).toBe("Rotar 90°");
    doc.undo();
    expect(doc.currentSnapshot()!.label).toBe("Original");
    expect(control.byteArgs[0]).toBe(rotated.bytes);
    expect(store.getState().job).toMatchObject({ snapshotId: rotated.id, versionLabel: "Rotar 90°" });
  });

  it("aunque el historial VUELQUE a disco o recorte ese paso, la exportacion conserva sus bytes", async () => {
    const rows = new Map<string, Uint8Array>();
    const history: ProHistoryStore = {
      name: "optimuspdf-pro-history-test",
      put: async (id, bytes) => void rows.set(id, new Uint8Array(bytes)),
      get: async (id) => rows.get(id) ?? null,
      remove: async (ids) => void ids.forEach((id) => rows.delete(id)),
      clear: async () => rows.clear(),
      dispose: async () => rows.clear(),
    };
    const doc = await openedDoc({ historyStore: history, hotBytes: 250 });
    const store = getExportStore(doc);
    const original = doc.currentSnapshot()!;
    const originalCopy = new Uint8Array(original.bytes);
    const control = controllable();
    store.start(request(control.entry));
    for (let step = 0; step < 5; step += 1) {
      await doc.commit(fakeBytes(130, step + 2), `Paso ${step + 1}`, "operation", { pageCount: 3 });
    }
    await vi.waitFor(() => expect(doc.getState().document!.snapshots[0].offloaded).toBe(true));
    // El objeto del historial quedo VACIO (volcado), pero lo que retiene la exportacion es el PDF entero.
    expect(doc.getState().document!.snapshots[0].bytes.byteLength).toBe(0);
    expect(original.bytes.byteLength).toBe(0);
    expect(control.byteArgs[0].byteLength).toBe(originalCopy.byteLength);
    expect(Array.from(control.byteArgs[0])).toEqual(Array.from(originalCopy));
    expect(control.calls[0].file?.size).toBe(originalCopy.byteLength);
    expect(store.heldBytesForTests()).toBe(control.byteArgs[0]);
    control.resolve();
    await tick();
    expect(downloads.items).toHaveLength(1);
  });

  it("recortada por el presupuesto (sin disco), la exportacion sigue siendo del paso de inicio", async () => {
    const doc = await openedDoc({ historyStore: null, maxSnapshots: 2 });
    const store = getExportStore(doc);
    const original = doc.currentSnapshot()!;
    const control = controllable();
    store.start(request(control.entry));
    await doc.commit(fakeBytes(130, 2), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(130, 3), "B", "operation", { pageCount: 3 });
    expect(doc.getState().document!.snapshots.some((snapshot) => snapshot.id === original.id)).toBe(true);
    await doc.commit(fakeBytes(130, 4), "C", "operation", { pageCount: 3 });
    expect(control.byteArgs[0]).toBe(original.bytes);
    expect(store.getState().job).toMatchObject({ snapshotId: original.id, versionLabel: "Original" });
  });
});

describe("exportStore · el documento manda", () => {
  it("cerrar el documento cancela el motor, borra el estado y no deja descargar nada tarde", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    const announced = doc.getState().announcement!.id;
    doc.close();
    expect(control.signal().aborted).toBe(true);
    expect(store.getState().job).toBeNull();
    expect(store.running).toBe(false);
    expect(store.heldBytesForTests()).toBeNull();
    control.resolve();
    await tick();
    expect(downloads.items).toEqual([]);
    // Solo se anuncia «Documento cerrado» (una vez): la exportacion no pisa su anuncio.
    expect(doc.getState().announcement!.id).toBe(announced + 1);
    expect(doc.getState().announcement!.text).not.toBe(ES.card.cancelled);
  });

  it("abrir OTRO documento cancela la exportacion del anterior; su resultado tardio no se descarga", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    let late!: (value: ProExportResult) => void;
    const entry: ProExport = {
      id: "word",
      title: () => "w",
      body: () => "w",
      slug: "pdf-to-word",
      requiresNetwork: false,
      run: (_bytes, context) => {
        context.signal.addEventListener("abort", () => undefined);
        return new Promise<ProExportResult>((resolve) => (late = resolve));
      },
    };
    store.start(request(entry));
    const first = store.getState().job!;
    await doc.open(fakeFile(90, "otro.pdf"), { pageCount: 2 });
    expect(store.getState().job).toBeNull();
    late({ blob: new Blob(["A"]), filename: "del-anterior.docx" });
    await tick();
    expect(downloads.items).toEqual([]);
    expect(store.getState().job).toBeNull();
    // El documento nuevo puede exportar con normalidad y su trabajo es de OTRO documento.
    const control = controllable("excel");
    store.start(request(control.entry));
    expect(store.getState().job!.docId).not.toBe(first.docId);
    expect(store.getState().job!.versionLabel).toBe("Original");
  });

  it("el resultado terminado de un documento se descarta al abrir otro (no se muestra en el nuevo)", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    control.resolve();
    await tick();
    expect(store.getState().job!.phase).toBe("done");
    await doc.open(fakeFile(90, "otro.pdf"), { pageCount: 2 });
    expect(store.getState().job).toBeNull();
  });

  it("discard() aborta y olvida sin anunciar nada; dismiss() solo cierra lo terminado", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    store.dismiss();
    expect(store.running).toBe(true); // dismiss no toca una que corre
    const announced = doc.getState().announcement!.id;
    store.discard();
    expect(control.signal().aborted).toBe(true);
    expect(store.getState().job).toBeNull();
    expect(doc.getState().announcement!.id).toBe(announced);
    const next = controllable("excel");
    store.start(request(next.entry));
    next.reject(new PdfError("noTablesFound"));
    await tick();
    expect(store.getState().job!.phase).toBe("error");
    store.dismiss();
    expect(store.getState().job).toBeNull();
  });

  it("dispose() deja de escuchar al documento y aborta lo que corra", async () => {
    const doc = await openedDoc();
    const store = new ExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    store.dispose();
    expect(control.signal().aborted).toBe(true);
    expect(store.getState().job).toBeNull();
  });
});

describe("exportStore · errores y avisos", () => {
  it("un error del motor deja `error` con su codigo tipado y NO descarga", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    control.reject(new PdfError("noTablesFound"));
    await tick();
    expect(store.getState().job).toMatchObject({ phase: "error", error: "noTablesFound", filename: null });
    expect(downloads.items).toEqual([]);
    expect(store.heldBytesForTests()).toBeNull();
  });

  it("sin la pestaña «Convertir» a la vista, un error se ANUNCIA (una vez) en la region viva; con ella, no (su alerta lo dice)", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const away = controllable("word");
    store.start(request(away.entry));
    away.reject(new PdfError("offline"));
    await tick();
    expect(doc.getState().announcement?.text).toBe(ES.notices.failedAway(ES.formatsShort.word));

    const release = store.registerView();
    const announced = doc.getState().announcement!.id;
    const seen = controllable("excel");
    store.dismiss();
    store.start(request(seen.entry));
    seen.reject(new PdfError("noTablesFound"));
    await tick();
    expect(doc.getState().announcement!.id).toBe(announced);
    // Retirar la vista dos veces no descuadra el contador.
    release();
    release();
    const again = controllable("csv");
    store.start(request(again.entry));
    again.reject(new PdfError("corrupt"));
    await tick();
    expect(doc.getState().announcement?.text).toBe(ES.notices.failedAway(ES.formatsShort.csv));
  });

  it("los anuncios del almacen salen en el idioma vigente", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry, { language: "en" }));
    store.cancel();
    expect(doc.getState().announcement?.text).toBe(EN.card.cancelled);
    store.setLanguage("es");
    const next = controllable("excel");
    store.start(request(next.entry, { language: "es" }));
    next.resolve({ filename: "a.xlsx" });
    await tick();
    expect(doc.getState().announcement?.text).toBe(ES.card.done("a.xlsx"));
  });
});

describe("exportStore · opciones por formato", () => {
  it("las opciones se fusionan por formato, sobreviven al «desmontar» (mismo almacen) y se reinician con el documento", async () => {
    const doc = await openedDoc();
    const store = getExportStore(doc);
    const defaults = { format: "jpg", quality: 0.9 };
    store.setOptions("images", defaults, { format: "png" });
    store.setOptions("images", defaults, { quality: 0.6 });
    expect(store.getState().options.images).toEqual({ format: "png", quality: 0.6 });
    expect(getExportStore(doc)).toBe(store);
    const snapshot: ExportStoreState = store.getState();
    await doc.open(fakeFile(90, "otro.pdf"), { pageCount: 2 });
    expect(store.getState()).not.toBe(snapshot);
    expect(store.getState().options).toEqual({});
  });
});

describe("getExportStore", () => {
  it("un almacen por documento de trabajo (distintos documentos no comparten estado)", async () => {
    const a = await openedDoc();
    const b = await openedDoc();
    expect(getExportStore(a)).toBe(getExportStore(a));
    expect(getExportStore(a)).not.toBe(getExportStore(b));
    const control = controllable();
    getExportStore(a).start(request(control.entry));
    expect(getExportStore(b).getState().job).toBeNull();
  });

  it("el almacen creado DESPUES de abrir el documento lo toma como actual (no lo confunde con un cambio)", async () => {
    const doc: ProWorkingDoc = await openedDoc();
    const store = getExportStore(doc);
    const control = controllable();
    store.start(request(control.entry));
    await doc.commit(fakeBytes(200, 3), "Girar", "operation", { pageCount: 3 });
    expect(store.getState().job?.phase).toBe("running");
  });
});
