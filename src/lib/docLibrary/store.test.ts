import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLibraryForTests,
  __setLibraryOpenTimeoutForTests,
  clearLibrary,
  deleteDocument,
  estimateUsage,
  getDocument,
  getDocumentBytes,
  getLibraryMeta,
  libraryStatus,
  listDocuments,
  markBackup,
  putDocument,
  renameDocument,
  replaceDocumentBytes,
  requestPersistence,
  subscribeToLibrary,
  updateDocument,
} from "./store";
import { sampleBytes, sampleFingerprint, sampleInput } from "./testing/sampleDocs";
import { FingerprintError, LIBRARY_LIMITS, LibraryError, type Fingerprint } from "./types";

const DB_NAME = "optimuspdf-doc-library";
/** Versión actual de la base (v2 desde U2.2: almacén `templates`). */
const DB_VERSION = 2;

/** Una base nueva en cada prueba (otro `IDBFactory`) y el estado en memoria del módulo a cero. */
beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  __resetLibraryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectLibraryError(promise: Promise<unknown>, code: string, detail?: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LibraryError);
  expect((error as LibraryError).code).toBe(code);
  if (detail) expect((error as LibraryError).detail).toBe(detail);
}

/** Acceso crudo a la base, para fabricar corrupción y ocupaciones enormes sin pasar por la API. */
async function rawDb(): Promise<IDBDatabase> {
  await libraryStatus();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawPut(store: string, value: unknown): Promise<void> {
  const db = await rawDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function rawGetAll(store: string): Promise<unknown[]> {
  const db = await rawDb();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

describe("altas, lecturas y borrado", () => {
  it("guarda un documento con sus bytes y lo devuelve con rev 1", async () => {
    const stored = await putDocument(sampleInput("doc-1"), sampleBytes(100));
    expect(stored).toMatchObject({ id: "doc-1", rev: 1, byteLength: 100, name: "Contrato doc-1", templateIds: [] });
    expect(stored.createdAt).toBe(stored.updatedAt);
    expect(await getDocument("doc-1")).toEqual(stored);
    expect(await getDocumentBytes("doc-1")).toEqual(sampleBytes(100));
  });

  it("listar no carga bytes y ordena por fecha de modificación (el más reciente primero)", async () => {
    const times = ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"];
    for (const [index, id] of ["a", "b", "c"].entries()) {
      await putDocument(sampleInput(id), sampleBytes(10), { now: () => new Date(times[index]) });
    }
    const listed = await listDocuments();
    expect(listed.available).toBe(true);
    expect(listed.documents.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(listed.skipped).toEqual([]);
    expect("bytes" in listed.documents[0]).toBe(false);
  });

  it("los bytes devueltos son una copia: tocarlos no cambia lo guardado", async () => {
    const original = sampleBytes(20, 5);
    await putDocument(sampleInput("c1"), original);
    original.fill(0);
    const first = await getDocumentBytes("c1");
    first!.fill(1);
    expect(await getDocumentBytes("c1")).toEqual(sampleBytes(20, 5));
  });

  it("una VISTA de un buffer mayor guarda solo sus bytes (no todo el buffer)", async () => {
    const big = new Uint8Array(10_000).fill(9);
    const view = big.subarray(100, 150);
    await putDocument(sampleInput("view1"), view);
    const [record] = (await rawGetAll("blobs")) as Array<{ bytes: Uint8Array; byteLength: number }>;
    expect(record.byteLength).toBe(50);
    expect(record.bytes.buffer.byteLength).toBe(50);
    expect(await getDocumentBytes("view1")).toEqual(new Uint8Array(50).fill(9));
    // También al sustituir la copia.
    await replaceDocumentBytes("view1", big.subarray(0, 20), { fingerprinter: async () => sampleFingerprint(3, 1) });
    const [again] = (await rawGetAll("blobs")) as Array<{ bytes: Uint8Array }>;
    expect(again.bytes.buffer.byteLength).toBe(20);
  });

  it("acepta ArrayBuffer", async () => {
    await putDocument(sampleInput("ab"), sampleBytes(30).buffer as ArrayBuffer);
    expect((await getDocumentBytes("ab"))?.length).toBe(30);
  });

  it("un documento sin bytes se guarda sin copia (byteLength 0)", async () => {
    const stored = await putDocument(sampleInput("nobytes"));
    expect(stored.byteLength).toBe(0);
    expect(await getDocumentBytes("nobytes")).toBeNull();
  });

  it("borrar quita la entrada y la copia, y dice si existía", async () => {
    await putDocument(sampleInput("d1"), sampleBytes(10));
    expect(await deleteDocument("d1")).toBe(true);
    expect(await getDocument("d1")).toBeNull();
    expect(await getDocumentBytes("d1")).toBeNull();
    expect(await rawGetAll("blobs")).toEqual([]);
    expect(await deleteDocument("d1")).toBe(false);
  });

  it("ids o consultas mal formados no tocan la base", async () => {
    expect(await getDocument("../x")).toBeNull();
    expect(await getDocumentBytes("a b")).toBeNull();
    await expectLibraryError(deleteDocument("a/b"), "invalid");
    await expectLibraryError(updateDocument("a/b", { name: "x" }), "invalid");
    await expectLibraryError(replaceDocumentBytes("a/b", sampleBytes(4)), "invalid");
  });

  it("clearLibrary vacía documentos y copias pero conserva meta", async () => {
    await putDocument(sampleInput("x1"), sampleBytes(10));
    await markBackup(new Date("2026-05-05T10:00:00.000Z"));
    await clearLibrary();
    expect((await listDocuments()).documents).toEqual([]);
    expect(await rawGetAll("blobs")).toEqual([]);
    expect((await getLibraryMeta()).lastBackupAt).toBe("2026-05-05T10:00:00.000Z");
  });
});

describe("actualizar y concurrencia optimista (rev)", () => {
  it("actualizar con la rev correcta sube la rev, conserva createdAt y la copia si no se da otra", async () => {
    const first = await putDocument(sampleInput("u1"), sampleBytes(40), { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const second = await putDocument(sampleInput("u1", { name: "Nuevo nombre", expectedRev: first.rev }), undefined, {
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(second).toMatchObject({ rev: 2, name: "Nuevo nombre", byteLength: 40, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(await getDocumentBytes("u1")).toEqual(sampleBytes(40));
    const third = await putDocument(sampleInput("u1", { expectedRev: 2 }), sampleBytes(55, 9));
    expect(third).toMatchObject({ rev: 3, byteLength: 55 });
    expect(await getDocumentBytes("u1")).toEqual(sampleBytes(55, 9));
  });

  it("DOS PESTAÑAS: la que escribe con una rev vieja recibe conflict y NO pisa nada", async () => {
    const stored = await putDocument(sampleInput("shared"), sampleBytes(10));
    // Las dos pestañas leen la misma versión.
    const tabA = await getDocument("shared");
    const tabB = await getDocument("shared");
    expect(tabA?.rev).toBe(1);
    // La pestaña B guarda primero.
    await renameDocument("shared", "Nombre de B", { expectedRev: tabB!.rev });
    // La pestaña A, con la rev vieja, no puede pisar.
    await expectLibraryError(renameDocument("shared", "Nombre de A", { expectedRev: tabA!.rev }), "conflict");
    await expectLibraryError(putDocument(sampleInput("shared", { name: "A otra vez", expectedRev: tabA!.rev })), "conflict");
    await expectLibraryError(deleteDocument("shared", { expectedRev: tabA!.rev }), "conflict");
    await expectLibraryError(updateDocument("shared", { docType: "x" }, { expectedRev: tabA!.rev }), "conflict");
    await expectLibraryError(replaceDocumentBytes("shared", sampleBytes(12), { expectedRev: tabA!.rev, fingerprinter: async () => sampleFingerprint(3, 4) }), "conflict");
    const now = await getDocument("shared");
    expect(now).toMatchObject({ name: "Nombre de B", rev: 2, byteLength: stored.byteLength });
    expect(await getDocumentBytes("shared")).toEqual(sampleBytes(10));
    // Tras releer, A sí puede.
    await renameDocument("shared", "Nombre de A", { expectedRev: now!.rev });
    expect((await getDocument("shared"))?.rev).toBe(3);
  });

  it("sin expectedRev, renombrar se aplica sobre lo último (no pisa el resto de campos)", async () => {
    await putDocument(sampleInput("r1"), sampleBytes(10));
    await updateDocument("r1", { docType: "otro tipo" });
    await renameDocument("r1", "  Con espacios  ");
    expect(await getDocument("r1")).toMatchObject({ name: "Con espacios", docType: "otro tipo", rev: 3 });
  });

  it("crear dos veces el mismo id sin rev, o con rev de un documento que ya no existe, es conflict", async () => {
    await putDocument(sampleInput("dup"), sampleBytes(10));
    await expectLibraryError(putDocument(sampleInput("dup")), "conflict");
    await deleteDocument("dup");
    await expectLibraryError(putDocument(sampleInput("dup", { expectedRev: 1 })), "conflict");
    expect((await listDocuments()).documents).toEqual([]);
  });

  it("dos altas simultáneas del mismo id: una gana y la otra recibe conflict", async () => {
    const results = await Promise.allSettled([putDocument(sampleInput("race", { name: "A" }), sampleBytes(10)), putDocument(sampleInput("race", { name: "B" }), sampleBytes(10))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as LibraryError).code).toBe("conflict");
    expect((await listDocuments()).documents).toHaveLength(1);
  });

  it("actualizar un documento que no existe → notFound", async () => {
    await expectLibraryError(updateDocument("nope", { name: "x" }), "notFound");
    await expectLibraryError(replaceDocumentBytes("nope", sampleBytes(4), { fingerprinter: async () => sampleFingerprint() }), "notFound");
  });

  it("templateIds y tipo se actualizan; ids repetidos o raros son invalid y no cambian nada", async () => {
    await putDocument(sampleInput("t1"), sampleBytes(10));
    const updated = await updateDocument("t1", { templateIds: ["tpl-1", "tpl-2"], docType: "otro" });
    expect(updated).toMatchObject({ templateIds: ["tpl-1", "tpl-2"], docType: "otro", rev: 2 });
    await expectLibraryError(updateDocument("t1", { templateIds: ["a", "a"] }), "invalid");
    await expectLibraryError(updateDocument("t1", { templateIds: ["con espacio"] }), "invalid");
    expect((await getDocument("t1"))?.rev).toBe(2);
  });

  it("restaurar conserva createdAt y updatedAt dados", async () => {
    const stored = await putDocument(sampleInput("rest", { createdAt: "2025-01-01T00:00:00.000Z" }), sampleBytes(10), { updatedAt: "2025-06-01T00:00:00.000Z" });
    expect(stored).toMatchObject({ createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z" });
    await expectLibraryError(putDocument(sampleInput("rest2"), sampleBytes(10), { updatedAt: "ayer" }), "invalid");
  });
});

describe("validación al escribir", () => {
  it.each([
    ["id con caracteres raros", { id: "a/b" }],
    ["id vacío", { id: "" }],
    ["nombre vacío", { name: "   " }],
    ["nombre con marcas bidi", { name: "abc‮def" }],
    ["nombre larguísimo", { name: "x".repeat(LIBRARY_LIMITS.maxNameLength + 1) }],
    ["pageCount que no cuadra con la huella", { pageCount: 99 }],
    ["tamaños que no cuadran", { pageSizes: [] }],
    ["templateIds duplicados", { templateIds: ["a", "a"] }],
  ])("%s → invalid y no se guarda nada", async (_name, override) => {
    await expectLibraryError(putDocument(sampleInput("ok-id", override as never), sampleBytes(10)), "invalid");
    expect((await listDocuments()).documents).toEqual([]);
    expect(await rawGetAll("blobs")).toEqual([]);
  });

  it("bytes vacíos → invalid", async () => {
    await expectLibraryError(putDocument(sampleInput("e"), new Uint8Array()), "invalid");
  });

  it("un renombrado a vacío o con controles es invalid", async () => {
    await putDocument(sampleInput("n"), sampleBytes(10));
    await expectLibraryError(renameDocument("n", "   "), "invalid");
    await expectLibraryError(renameDocument("n", "a\u0000b"), "invalid");
  });

  it("los errores no llevan nombres de archivo ni contenido (sin PII)", async () => {
    const error = await putDocument(sampleInput("p", { name: "Juan Pérez contrato", fileName: "juan-perez.pdf", fingerprint: sampleFingerprint(3), pageCount: 7 }), sampleBytes(10)).catch((reason: unknown) => reason as LibraryError);
    expect((error as LibraryError).message).toBe("invalid");
    expect(String(error)).not.toMatch(/Juan|juan-perez/);
  });
});

describe("límites", () => {
  it("máximo 50 documentos: el 51.º es full/count y los demás siguen", async () => {
    for (let index = 0; index < LIBRARY_LIMITS.maxDocuments; index += 1) await putDocument(sampleInput(`doc-${index}`), sampleBytes(8));
    await expectLibraryError(putDocument(sampleInput("one-too-many"), sampleBytes(8)), "full", "count");
    expect((await listDocuments()).documents).toHaveLength(50);
    // Actualizar uno existente sigue permitido con la biblioteca llena.
    const existing = await getDocument("doc-3");
    await putDocument(sampleInput("doc-3", { name: "Cambiado", expectedRev: existing!.rev }));
    // Y borrar uno deja sitio.
    await deleteDocument("doc-0");
    await putDocument(sampleInput("one-too-many"), sampleBytes(8));
  }, 60_000);

  it("simultáneas con 49 guardados: solo una de dos altas cabe", async () => {
    for (let index = 0; index < 49; index += 1) await putDocument(sampleInput(`doc-${index}`));
    const results = await Promise.allSettled([putDocument(sampleInput("x-1")), putDocument(sampleInput("x-2"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listDocuments()).documents).toHaveLength(50);
  }, 60_000);

  it("100 MiB por documento: justo ese tamaño cabe; un byte más es tooBig (sin abrir la base)", async () => {
    const huge = new Uint8Array(LIBRARY_LIMITS.maxDocumentBytes + 1);
    await expectLibraryError(putDocument(sampleInput("big"), huge), "tooBig");
    await expectLibraryError(replaceDocumentBytes("big", huge, { fingerprinter: async () => sampleFingerprint() }), "tooBig");
    expect((await listDocuments()).documents).toEqual([]);
    const exact = await putDocument(sampleInput("exact"), new Uint8Array(LIBRARY_LIMITS.maxDocumentBytes).fill(1));
    expect(exact.byteLength).toBe(LIBRARY_LIMITS.maxDocumentBytes);
  }, 60_000);

  it("400 MiB en total: lo que pasa del total es full/total; lo que cabe justo, entra", async () => {
    const MiB = 1024 * 1024;
    // 4 documentos «de 99 MiB» fabricados directamente (sin asignar 400 MB de bytes).
    for (let index = 0; index < 4; index += 1) {
      const entry = await putDocument(sampleInput(`fat-${index}`));
      await rawPut("documents", { ...entry, byteLength: 99 * MiB });
    }
    // Quedan 4 MiB libres.
    await expectLibraryError(putDocument(sampleInput("over"), new Uint8Array(4 * MiB + 1)), "full", "total");
    const fits = await putDocument(sampleInput("fits"), new Uint8Array(4 * MiB));
    expect(fits.byteLength).toBe(4 * MiB);
    // Ya está al límite: ni un byte más.
    await expectLibraryError(putDocument(sampleInput("none-left"), sampleBytes(1)), "full", "total");
    // Sustituir la copia de uno por otra mayor que lo que queda también se rechaza; por otra menor, no.
    await expectLibraryError(replaceDocumentBytes("fits", new Uint8Array(4 * MiB + 1), { fingerprinter: async () => sampleFingerprint() }), "full", "total");
    await replaceDocumentBytes("fits", new Uint8Array(MiB), { fingerprinter: async () => sampleFingerprint() });
    expect((await estimateUsage()).bytes).toBe(4 * 99 * MiB + MiB);
  }, 60_000);
});

describe("cuota del navegador y atomicidad", () => {
  it("QuotaExceededError al escribir la copia → quota, y la entrada NO queda guardada", async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "blobs") throw new DOMException("sin espacio", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expectLibraryError(putDocument(sampleInput("q1"), sampleBytes(100)), "quota");
    vi.restoreAllMocks();
    expect((await listDocuments()).documents).toEqual([]);
    expect(await rawGetAll("blobs")).toEqual([]);
  });

  it("cuota agotada al REEMPLAZAR bytes: queda la versión anterior intacta (entrada y copia)", async () => {
    await putDocument(sampleInput("q2"), sampleBytes(50, 3));
    const before = await getDocument("q2");
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "blobs") throw new DOMException("sin espacio", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expectLibraryError(replaceDocumentBytes("q2", sampleBytes(60), { fingerprinter: async () => sampleFingerprint(2, 9) }), "quota");
    vi.restoreAllMocks();
    expect(await getDocument("q2")).toEqual(before);
    expect(await getDocumentBytes("q2")).toEqual(sampleBytes(50, 3));
  });

  it("un error que llega por la PETICIÓN (no por excepción) también aborta todo", async () => {
    await rawPut("blobs", { documentId: "async1", bytes: new Uint8Array(3), byteLength: 3 });
    // La copia se escribe con `add` en vez de `put`: la clave ya existe y la petición falla (ConstraintError) más tarde.
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      return this.name === "blobs" ? this.add(value, key) : original.call(this, value, key);
    });
    await expectLibraryError(putDocument(sampleInput("async1"), sampleBytes(100)), "failed");
    vi.restoreAllMocks();
    expect((await listDocuments()).documents).toEqual([]);
  });

  it("otro fallo cualquiera del almacén → failed", async () => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("no clonable", "DataCloneError");
    });
    await expectLibraryError(putDocument(sampleInput("f1"), sampleBytes(10)), "failed");
  });
});

describe("datos dañados", () => {
  it("una entrada corrupta se ignora con aviso y NO rompe la lista", async () => {
    const good = await putDocument(sampleInput("good"), sampleBytes(10));
    await rawPut("documents", { id: "bad-shape", name: 42 });
    await rawPut("documents", { ...good, id: "bad-minhash", fingerprint: { ...good.fingerprint, pages: [{ textHash: "a".repeat(64), minhash: [1, 2, 3] }, ...good.fingerprint.pages.slice(1)] } });
    await rawPut("documents", { ...good, id: "bad-count", pageCount: 99 });
    await rawPut("documents", { ...good, id: "bad-rev", rev: 0 });
    await rawPut("documents", { ...good, id: "bad-date", createdAt: "ayer" });
    await rawPut("documents", { ...good, id: "bad-name", name: "x‮y" });
    await rawPut("documents", { ...good, id: "bad-bytes", byteLength: -1 });
    await rawPut("documents", { ...good, id: "bad-fp-version", fingerprint: { ...good.fingerprint, version: 99 } });
    await rawPut("documents", { ...good, id: "bad-exact", fingerprint: { ...good.fingerprint, exact: "xyz" } });
    await rawPut("documents", { ...good, id: "bad-dhash", fingerprint: { ...good.fingerprint, pages: [{ textHash: "", minhash: [], dhash: "nothex" }, ...good.fingerprint.pages.slice(1)] } });
    const listed = await listDocuments();
    expect(listed.available).toBe(true);
    expect(listed.documents.map((entry) => entry.id)).toEqual(["good"]);
    expect(listed.skipped.map((skipped) => skipped.id).sort()).toEqual(
      ["bad-bytes", "bad-count", "bad-date", "bad-dhash", "bad-exact", "bad-fp-version", "bad-minhash", "bad-name", "bad-rev", "bad-shape"].sort(),
    );
    expect(listed.skipped.every((skipped) => skipped.reason === "invalid")).toBe(true);
    expect(await getDocument("bad-shape")).toBeNull();
  });

  it("una entrada sin id válido se lista como «?» sin filtrar su contenido", async () => {
    const db = await rawDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("documents", "readwrite");
      tx.objectStore("documents").put({ id: "con espacios y datos de Juan" });
      tx.oncomplete = () => resolve();
    });
    db.close();
    const listed = await listDocuments();
    expect(listed.skipped).toEqual([{ id: "?", reason: "invalid" }]);
  });

  it("una copia dañada (longitud que no cuadra, o no es binaria) se trata como ausente", async () => {
    await putDocument(sampleInput("c1"), sampleBytes(10));
    await rawPut("blobs", { documentId: "c1", bytes: new Uint8Array(5), byteLength: 10 });
    expect(await getDocumentBytes("c1")).toBeNull();
    await rawPut("blobs", { documentId: "c1", bytes: "texto", byteLength: 5 });
    expect(await getDocumentBytes("c1")).toBeNull();
  });

  it("se puede volver a guardar encima de un registro corrupto (rev 0)", async () => {
    await rawPut("documents", { id: "ruin", name: 1 });
    const stored = await putDocument(sampleInput("ruin"), sampleBytes(10));
    expect(stored.rev).toBe(1);
    expect((await listDocuments()).skipped).toEqual([]);
  });
});

describe("IndexedDB no disponible (Safari privado, cookies bloqueadas…)", () => {
  it("sin indexedDB: estado explícito, lecturas vacías y escrituras con unavailable", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    expect(await libraryStatus()).toEqual({ available: false, reason: "noIndexedDB" });
    expect(await listDocuments()).toEqual({ available: false, documents: [], skipped: [] });
    expect(await getDocument("x")).toBeNull();
    expect(await getDocumentBytes("x")).toBeNull();
    expect((await estimateUsage()).available).toBe(false);
    expect((await getLibraryMeta()).lastBackupAt).toBeNull();
    await expectLibraryError(putDocument(sampleInput("x"), sampleBytes(4)), "unavailable");
    await expectLibraryError(deleteDocument("x"), "unavailable");
    await expectLibraryError(markBackup(), "unavailable");
  });

  it("si el simple acceso a indexedDB lanza", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new DOMException("bloqueado", "SecurityError");
      },
    });
    expect((await libraryStatus()).available).toBe(false);
    expect((await listDocuments()).available).toBe(false);
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: new IDBFactory() });
  });

  it("si open() lanza o falla", async () => {
    const factory = new IDBFactory();
    vi.spyOn(factory, "open").mockImplementation(() => {
      throw new DOMException("no", "SecurityError");
    });
    globalThis.indexedDB = factory;
    expect(await libraryStatus()).toEqual({ available: false, reason: "openFailed" });
    await expectLibraryError(putDocument(sampleInput("x"), sampleBytes(4)), "unavailable");
  });

  it("si la apertura se cuelga, se abandona en el plazo", async () => {
    __setLibraryOpenTimeoutForTests(30);
    const factory = new IDBFactory();
    vi.spyOn(factory, "open").mockImplementation(() => ({}) as IDBOpenDBRequest);
    globalThis.indexedDB = factory;
    const started = Date.now();
    expect((await listDocuments()).available).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("si hay una base de una versión MÁS NUEVA (otra pestaña actualizó), se degrada sin romper", async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION + 1);
      request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "id" });
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    expect((await libraryStatus()).available).toBe(false);
    expect((await listDocuments()).available).toBe(false);
  });

  it("tras un fallo, la siguiente operación vuelve a intentarlo (no queda «roto» para siempre)", async () => {
    const factory = new IDBFactory();
    const open = factory.open.bind(factory);
    let failures = 1;
    vi.spyOn(factory, "open").mockImplementation((name: string, version?: number) => {
      if (failures-- > 0) throw new DOMException("no", "SecurityError");
      return open(name, version);
    });
    globalThis.indexedDB = factory;
    expect((await libraryStatus()).available).toBe(false);
    expect((await libraryStatus()).available).toBe(true);
    await putDocument(sampleInput("again"), sampleBytes(4));
  });
});

describe("avisos entre pestañas", () => {
  it("una escritura avisa a los suscritos y a otra pestaña (BroadcastChannel)", async () => {
    const calls: string[] = [];
    const unsubscribe = subscribeToLibrary(() => calls.push("local"));
    const other = new BroadcastChannel("optimuspdf-doc-library");
    const received = new Promise<unknown>((resolve) => {
      other.onmessage = (event) => resolve(event.data);
    });
    await putDocument(sampleInput("bc"), sampleBytes(10));
    expect(calls).toEqual(["local"]);
    expect(await received).toBe("changed");
    unsubscribe();
    await deleteDocument("bc");
    expect(calls).toEqual(["local"]);
    other.close();
  });

  it("un aviso de otra pestaña dispara el refresco", async () => {
    let refreshed = 0;
    const done = new Promise<void>((resolve) => {
      subscribeToLibrary(() => {
        refreshed += 1;
        resolve();
      });
    });
    const other = new BroadcastChannel("optimuspdf-doc-library");
    other.postMessage("changed");
    await done;
    expect(refreshed).toBe(1);
    other.close();
  });

  it("un oyente que lanza no impide avisar a los demás ni rompe la escritura", async () => {
    const ok = vi.fn();
    subscribeToLibrary(() => {
      throw new Error("oyente roto");
    });
    subscribeToLibrary(ok);
    await putDocument(sampleInput("l"), sampleBytes(4));
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("sin BroadcastChannel usa el evento storage", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const windowStub = new EventTarget() as EventTarget & { localStorage: Storage };
    const store = new Map<string, string>();
    windowStub.localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null } as unknown as Storage;
    vi.stubGlobal("window", windowStub);
    let calls = 0;
    subscribeToLibrary(() => (calls += 1));
    await putDocument(sampleInput("st"), sampleBytes(4));
    expect([...store.keys()]).toEqual(["optimuspdf.doc-library.signal"]);
    const before = calls;
    const event = new Event("storage") as Event & { key: string; newValue: string };
    event.key = "optimuspdf.doc-library.signal";
    event.newValue = "{}";
    windowStub.dispatchEvent(event);
    expect(calls).toBe(before + 1);
    const wrong = new Event("storage") as Event & { key: string; newValue: string };
    wrong.key = "otra";
    wrong.newValue = "{}";
    windowStub.dispatchEvent(wrong);
    expect(calls).toBe(before + 1);
  });
});

describe("reemplazar el PDF base", () => {
  it("recalcula huella, páginas y tamaños; conserva nombre, tipo y plantillas", async () => {
    await putDocument(sampleInput("rep", { templateIds: ["t-1"], name: "Mi contrato", docType: "mitigación" }), sampleBytes(30));
    const newFp: Fingerprint = sampleFingerprint(5, 9);
    const calls: number[] = [];
    const updated = await replaceDocumentBytes("rep", sampleBytes(77, 2), {
      fingerprinter: async (bytes) => {
        calls.push(bytes.length);
        return newFp;
      },
      fileName: "nuevo.pdf",
    });
    expect(calls).toEqual([77]);
    expect(updated).toMatchObject({ name: "Mi contrato", docType: "mitigación", templateIds: ["t-1"], pageCount: 5, byteLength: 77, fileName: "nuevo.pdf", rev: 2 });
    expect(updated.fingerprint).toEqual(newFp);
    expect(updated.pageSizes).toEqual(newFp.pageSizes);
    expect(await getDocumentBytes("rep")).toEqual(sampleBytes(77, 2));
  });

  it("si la huella falla (PDF dañado), no se escribe nada y el error se propaga", async () => {
    await putDocument(sampleInput("rep2"), sampleBytes(30));
    const before = await getDocument("rep2");
    const failure = await replaceDocumentBytes("rep2", sampleBytes(10), {
      fingerprinter: async () => {
        throw new FingerprintError("corrupt");
      },
    }).catch((reason: unknown) => reason);
    expect((failure as FingerprintError).code).toBe("corrupt");
    expect(await getDocument("rep2")).toEqual(before);
    expect(await getDocumentBytes("rep2")).toEqual(sampleBytes(30));
  });

  it("pasa la señal de cancelación a la huella", async () => {
    await putDocument(sampleInput("rep3"), sampleBytes(30));
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    await replaceDocumentBytes("rep3", sampleBytes(10), {
      signal: controller.signal,
      fingerprinter: async (_bytes, options) => {
        received = options.signal;
        return sampleFingerprint(3, 1);
      },
    });
    expect(received).toBe(controller.signal);
  });

  it("un nombre de archivo inválido es invalid", async () => {
    await putDocument(sampleInput("rep4"), sampleBytes(30));
    await expectLibraryError(replaceDocumentBytes("rep4", sampleBytes(10), { fingerprinter: async () => sampleFingerprint(), fileName: "a\u0000b.pdf" }), "invalid");
  });
});

describe("uso, persistencia y copia de seguridad", () => {
  it("estimateUsage cuenta documentos y bytes y da la estimación del navegador", async () => {
    await putDocument(sampleInput("e1"), sampleBytes(1000));
    await putDocument(sampleInput("e2"), sampleBytes(500));
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 123, quota: 456 }) } });
    const usage = await estimateUsage();
    expect(usage).toMatchObject({ available: true, documents: 2, bytes: 1500, browser: { usage: 123, quota: 456 } });
    expect(usage.limits).toEqual({ maxDocuments: 50, maxDocumentBytes: 100 * 1024 * 1024, maxTotalBytes: 400 * 1024 * 1024 });
  });

  it("estimateUsage sin storage.estimate: sin campo browser", async () => {
    vi.stubGlobal("navigator", {});
    expect((await estimateUsage()).browser).toBeUndefined();
  });

  it("requestPersistence: concedida, y la recuerda en meta", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist, persisted: async () => false } });
    expect(await requestPersistence()).toEqual({ granted: true, supported: true });
    expect(persist).toHaveBeenCalledTimes(1);
    const meta = await getLibraryMeta();
    expect(meta.persistence).toMatchObject({ granted: true, supported: true });
    expect(meta.schema).toBe(2);
  });

  it("requestPersistence: ya persistente no vuelve a pedirla; denegada se recuerda", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist, persisted: async () => true } });
    expect(await requestPersistence()).toEqual({ granted: true, supported: true });
    expect(persist).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { storage: { persist: async () => false } });
    expect(await requestPersistence()).toEqual({ granted: false, supported: true });
    expect((await getLibraryMeta()).persistence).toMatchObject({ granted: false, supported: true });
  });

  it("requestPersistence: sin soporte, o si persist() lanza, devuelve granted:false y nunca lanza", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistence()).toEqual({ granted: false, supported: false });
    expect((await getLibraryMeta()).persistence).toMatchObject({ granted: false, supported: false });
    vi.stubGlobal("navigator", { storage: { persist: async () => { throw new Error("no"); } } });
    expect(await requestPersistence()).toEqual({ granted: false, supported: true });
  });

  it("requestPersistence sin IndexedDB sigue devolviendo el resultado", async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    vi.stubGlobal("navigator", { storage: { persist: async () => true } });
    expect(await requestPersistence()).toEqual({ granted: true, supported: true });
  });

  it("markBackup y getLibraryMeta", async () => {
    expect(await getLibraryMeta()).toEqual({ schema: 2, lastBackupAt: null, persistence: null });
    await markBackup(new Date("2026-10-15T12:00:00.000Z"));
    expect((await getLibraryMeta()).lastBackupAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("un valor de meta dañado se ignora", async () => {
    await rawPut("meta", { key: "lastBackupAt", value: "ayer" });
    await rawPut("meta", { key: "persistence", value: { granted: "sí", supported: true, checkedAt: "x" } });
    expect(await getLibraryMeta()).toEqual({ schema: 2, lastBackupAt: null, persistence: null });
  });
});
