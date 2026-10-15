import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  __closeWarmDraftsConnectionForTests,
  __createTabForTests,
  __useTabForTests,
  clearAllDrafts,
  deleteDraft,
  deleteSessionDraft,
  draftFingerprint,
  isStaleWrite,
  knownDraftRev,
  listAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  purgeExpiredDrafts,
  saveDraft,
  saveSessionDraft,
  subscribeToRemoteDraftWrites,
  tabWriterId,
  withLegacyExpiry,
  type DraftMeta,
  type RemoteDraftWrite,
  type SaveDraftParams,
  type SaveSessionParams,
  type SessionDraftMeta,
} from "@/app/sign-pdf/signDrafts";
import { SIGNATURE_DRAFT_TTL_MS } from "@/app/sign-pdf/draftPrivacy";

/**
 * F0-fix · D1 (dos pestanas con la misma sesion), D2 (un fallo de escritura NO es un guardado) y D4 (borradores anteriores
 * con firmas y sin fecha de caducidad), sobre `fake-indexeddb`: el mismo motor de transacciones que un navegador.
 *
 * Dos «pestanas» dentro de un mismo proceso se simulan con `__createTabForTests` / `__useTabForTests`: cada una tiene su
 * `writerId` y su propia memoria de la version (`rev`) que cargo o escribio por ultima vez.
 */

const DB_NAME = "optimuspdf-sign-drafts";
const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

function docInput(id: string, bytes = new Uint8Array([1, 2, 3, id.length])) {
  return { id, fileName: `${id}.pdf`, size: bytes.byteLength, state: { ...EMPTY_DOC_STATE } as DocState, getBytes: async () => bytes };
}

function sessionParams(id: string, overrides: Partial<SaveSessionParams> = {}): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [],
    documents: [docInput("doc-1"), docInput("doc-2")],
    activeDocId: "doc-1",
    step: "signers",
    ...overrides,
  };
}

function signedBlock(): SignerBlock {
  return { id: "bk-1", signerId: SIGNER.id, appliesTo: ["doc-1", "doc-2"], signature: STROKE, initials: null, stamps: {}, auto: true };
}

function v1Params(id: string, overrides: Partial<SaveDraftParams> = {}): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([9, 9, 9]),
    fileName: `${id.slice(0, 6)}.pdf`,
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
    ...overrides,
  };
}

const HASH = (letter: string) => letter.repeat(64);

/** Lee las filas de un almacen saltandose la API del modulo (con bytes). */
async function rawRows<T = Record<string, unknown>>(store: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Escribe una fila tal cual (sin pasar por el modulo): borradores de versiones anteriores, filas a medida. */
async function rawPut(store: string, row: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(store).put(row);
  });
  db.close();
}

let tabA = __createTabForTests("t-aaaa");
let tabB = __createTabForTests("t-bbbb");
let original = __useTabForTests(tabA);

beforeEach(async () => {
  tabA = __createTabForTests("t-aaaa");
  tabB = __createTabForTests("t-bbbb");
  original = __useTabForTests(tabA);
  await clearAllDrafts();
});

afterEach(() => {
  __useTabForTests(original);
  vi.restoreAllMocks();
});

/** Ejecuta `fn` como si fuera la otra pestana. */
async function as<T>(tab: ReturnType<typeof __createTabForTests>, fn: () => Promise<T>): Promise<T> {
  const previous = __useTabForTests(tab);
  try {
    return await fn();
  } finally {
    __useTabForTests(previous);
  }
}

describe("isStaleWrite (puro)", () => {
  it("lo escribio ESTA pestana: nunca es una version ajena, aunque su rev sea mayor", () => {
    expect(isStaleWrite({ rev: 9, writerId: "t-a" }, 2, "t-a")).toBe(false);
  });

  it("lo escribio OTRA pestana con una version mayor que la conocida: es mas nuevo, NO se pisa", () => {
    expect(isStaleWrite({ rev: 5, writerId: "t-b" }, 4, "t-a")).toBe(true);
  });

  it("otra pestana pero con una version que esta ya conocia (igual o menor): se puede escribir", () => {
    expect(isStaleWrite({ rev: 5, writerId: "t-b" }, 5, "t-a")).toBe(false);
    expect(isStaleWrite({ rev: 3, writerId: "t-b" }, 5, "t-a")).toBe(false);
  });

  it("un borrador anterior (sin rev ni writerId), o nada guardado, nunca bloquea", () => {
    expect(isStaleWrite({}, 0, "t-a")).toBe(false);
    expect(isStaleWrite(undefined, 0, "t-a")).toBe(false);
    expect(isStaleWrite(null, 0, "t-a")).toBe(false);
    expect(isStaleWrite({ writerId: "t-b" }, 0, "t-a")).toBe(false);
  });

  it("una pestana que no conoce NINGUNA version (0) y encuentra una de otra: es mas nuevo", () => {
    expect(isStaleWrite({ rev: 1, writerId: "t-b" }, 0, "t-a")).toBe(true);
  });
});

describe("D1 · sesion: una pestana desactualizada no pisa lo de la nueva", () => {
  it("una SOLA pestana nunca se compite a si misma: la version sube 1, 2, 3 y no hay copias", async () => {
    for (let n = 1; n <= 3; n += 1) {
      const result = await saveSessionDraft(sessionParams("s-un-1"));
      expect(result).toEqual({ ok: true });
      expect(knownDraftRev("s-un-1")).toBe(n);
    }
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(3);
    expect(meta.writerId).toBe("t-aaaa");
    expect(meta.copyOf).toBeUndefined();
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("la pestana vieja (conocia la rev 1) NO pisa la rev 2 de la nueva: se guarda como copia aparte, con todos sus archivos", async () => {
    await saveSessionDraft(sessionParams("s-dos-1", { blocks: [signedBlock()] })); // pestana A: rev 1
    // La pestana B retoma la sesion (la carga: conoce la rev 1) y la modifica: rev 2, con otro firmante.
    await as(tabB, async () => {
      expect(await loadSessionDraft("s-dos-1")).not.toBeNull();
      const result = await saveSessionDraft(
        sessionParams("s-dos-1", { signers: [SIGNER, { id: "sg-2", name: "Luis", color: "#0f9d68" }], blocks: [signedBlock()] }),
      );
      expect(result).toEqual({ ok: true });
    });
    // Ahora A (que sigue en la rev 1) guarda un cambio trivial.
    const result = await saveSessionDraft(sessionParams("s-dos-1", { activeDocId: "doc-2", blocks: [signedBlock()] }));
    expect(result.ok).toBe(true);
    const forkedTo = result.ok ? result.forkedTo : undefined;
    expect(forkedTo).toMatch(/^s-[a-z0-9]{1,16}-[a-z0-9]{1,24}$/);
    expect(forkedTo).not.toBe("s-dos-1");

    const metas = await listSessionDrafts();
    expect(metas).toHaveLength(2);
    const kept = metas.find((meta) => meta.id === "s-dos-1") as SessionDraftMeta;
    const copy = metas.find((meta) => meta.id === forkedTo) as SessionDraftMeta;
    // Lo de la pestana nueva NO se toco.
    expect(kept.signers.map((signer) => signer.name)).toEqual(["Ana", "Luis"]);
    expect(kept.rev).toBe(2);
    expect(kept.writerId).toBe("t-bbbb");
    expect(kept.activeDocId).toBe("doc-1");
    // La copia es lo de la pestana vieja, marcada como copia del original, version 1.
    expect(copy.signers.map((signer) => signer.name)).toEqual(["Ana"]);
    expect(copy.activeDocId).toBe("doc-2");
    expect(copy.copyOf).toBe("s-dos-1");
    expect(copy.rev).toBe(1);
    expect(copy.writerId).toBe("t-aaaa");
    // Los PDF de la copia estan de verdad (se puede retomar), y los del original siguen.
    const loadedCopy = await loadSessionDraft(forkedTo as string);
    expect(loadedCopy?.files.map((file) => file.id)).toEqual(["doc-1", "doc-2"]);
    expect(Array.from(loadedCopy?.files[0].bytes ?? [])).toEqual([1, 2, 3, 5]);
    expect((await loadSessionDraft("s-dos-1"))?.files).toHaveLength(2);
  });

  it("tras la copia, la pestana vieja sigue guardando SOBRE LA COPIA sin nuevos conflictos", async () => {
    await saveSessionDraft(sessionParams("s-dos-2"));
    await as(tabB, async () => {
      await loadSessionDraft("s-dos-2");
      await saveSessionDraft(sessionParams("s-dos-2", { activeDocId: "doc-2" }));
    });
    const first = await saveSessionDraft(sessionParams("s-dos-2"));
    const copyId = first.ok ? (first.forkedTo as string) : "";
    expect(copyId).not.toBe("");
    // El resto de guardados de la pestana A van a la copia (quien llama cambia de id con `forkedTo`).
    const second = await saveSessionDraft(sessionParams(copyId, { activeDocId: "doc-2" }));
    expect(second).toEqual({ ok: true });
    const third = await saveSessionDraft(sessionParams(copyId));
    expect(third).toEqual({ ok: true });
    expect((await listSessionDrafts()).map((meta) => meta.id).sort()).toEqual(["s-dos-2", copyId].sort());
    const copy = (await listSessionDrafts()).find((meta) => meta.id === copyId) as SessionDraftMeta;
    expect(copy.rev).toBe(3);
    expect(copy.copyOf).toBe("s-dos-2");
  });

  it("si la pestana vieja RECARGA la sesion antes de guardar, conoce la version nueva y no hay copia", async () => {
    await saveSessionDraft(sessionParams("s-dos-3"));
    await as(tabB, async () => {
      await loadSessionDraft("s-dos-3");
      await saveSessionDraft(sessionParams("s-dos-3", { activeDocId: "doc-2" }));
    });
    expect(await loadSessionDraft("s-dos-3")).not.toBeNull(); // A se pone al dia
    expect(knownDraftRev("s-dos-3")).toBe(2);
    expect(await saveSessionDraft(sessionParams("s-dos-3"))).toEqual({ ok: true });
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("recargar la MISMA pestana (otro writerId que carga la version vigente) escribe encima sin copias", async () => {
    await saveSessionDraft(sessionParams("s-rec-1"));
    await saveSessionDraft(sessionParams("s-rec-1"));
    // La pagina se recarga: nuevo writerId, memoria vacia; retoma lo guardado y sigue.
    const reloaded = __createTabForTests("t-nueva");
    await as(reloaded, async () => {
      await loadSessionDraft("s-rec-1");
      expect(await saveSessionDraft(sessionParams("s-rec-1", { activeDocId: "doc-2" }))).toEqual({ ok: true });
    });
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("una pestana que NUNCA cargo ese borrador (no conoce ninguna version) tampoco lo pisa si otra ya lo escribio", async () => {
    await as(tabB, async () => {
      await saveSessionDraft(sessionParams("s-aj-1", { activeDocId: "doc-2" }));
    });
    const result = await saveSessionDraft(sessionParams("s-aj-1"));
    expect(result.ok && result.forkedTo).toBeTruthy();
    const kept = (await listSessionDrafts()).find((meta) => meta.id === "s-aj-1") as SessionDraftMeta;
    expect(kept.activeDocId).toBe("doc-2");
  });

  it("un borrador ANTERIOR (sin rev ni writerId) se sobrescribe como siempre y recibe version", async () => {
    await rawPut("sessionMeta", {
      kind: "session",
      id: "s-viejo-1",
      savedAt: new Date().toISOString(),
      mode: "multi",
      signMode: "same",
      signers: [SIGNER],
      blocks: [],
      documents: [{ id: "doc-1", fileName: "a.pdf", fileSize: 4 }],
      docStates: {},
      activeDocId: "doc-1",
      step: "signers",
      fileSize: 4,
      fileName: "a.pdf",
      documentCount: 1,
    });
    await rawPut("draftFiles", { id: "s-viejo-1/doc-1", bytes: new Uint8Array([1]) });
    const result = await saveSessionDraft(sessionParams("s-viejo-1", { documents: [docInput("doc-1")] }));
    expect(result).toEqual({ ok: true });
    const [meta] = await listSessionDrafts();
    expect(meta.rev).toBe(1);
    expect(meta.writerId).toBe("t-aaaa");
  });

  it("el camino rapido (conexion abierta) tambien respeta la version: no pisa lo de otra pestana", async () => {
    await saveSessionDraft(sessionParams("s-rap-1"));
    await as(tabB, async () => {
      await loadSessionDraft("s-rap-1");
      await saveSessionDraft(sessionParams("s-rap-1", { activeDocId: "doc-2" }));
    });
    // Ya hay conexion de vida larga (el guardado anterior la adopto): este guardado va por el camino rapido.
    const result = await saveSessionDraft(sessionParams("s-rap-1", { blocks: [signedBlock()] }));
    expect(result.ok && result.forkedTo).toBeTruthy();
    const kept = (await listSessionDrafts()).find((meta) => meta.id === "s-rap-1") as SessionDraftMeta;
    expect(kept.blocks).toEqual([]);
    expect(kept.activeDocId).toBe("doc-2");
  });

  it("borrar con `unlessNewer` (lo que hace el autoguardado al quedarse sin progreso): una pestana desactualizada NO borra lo de otra", async () => {
    await saveSessionDraft(sessionParams("s-del-1"));
    await as(tabB, async () => {
      await loadSessionDraft("s-del-1");
      await saveSessionDraft(sessionParams("s-del-1", { activeDocId: "doc-2" }));
    });
    await deleteSessionDraft("s-del-1", { unlessNewer: true });
    expect(await listSessionDrafts()).toHaveLength(1);
    // Sin la guarda (borrar a proposito desde «Descartar»), si borra.
    await deleteSessionDraft("s-del-1");
    expect(await listSessionDrafts()).toHaveLength(0);
  });

  it("borrar con `unlessNewer` por la pestana que SI esta al dia, borra (y con todos los archivos)", async () => {
    await saveSessionDraft(sessionParams("s-del-2"));
    await deleteSessionDraft("s-del-2", { unlessNewer: true });
    expect(await listSessionDrafts()).toHaveLength(0);
    expect(await rawRows("draftFiles")).toEqual([]);
  });
});

describe("D1 · documento suelto: lo mismo, y la huella viaja aparte", () => {
  it("guarda la huella, la version y el autor; una sola pestana no genera copias", async () => {
    const id = `${HASH("a").slice(0, 32)}${"b".repeat(32)}`;
    expect(await saveDraft(v1Params(id, { fingerprint: HASH("a") }))).toEqual({ ok: true });
    expect(await saveDraft(v1Params(id, { fingerprint: HASH("a") }))).toEqual({ ok: true });
    const [meta] = await listDrafts();
    expect(meta.id).toBe(id);
    expect(meta.fingerprint).toBe(HASH("a"));
    expect(meta.rev).toBe(2);
    expect(meta.writerId).toBe("t-aaaa");
    expect(await listDrafts()).toHaveLength(1);
    expect(draftFingerprint(meta)).toBe(HASH("a"));
  });

  it("un borrador anterior no trae huella: su id ES la huella", () => {
    expect(draftFingerprint({ id: HASH("c") })).toBe(HASH("c"));
    expect(draftFingerprint({ id: "x".repeat(64), fingerprint: HASH("d") })).toBe(HASH("d"));
  });

  it("la pestana vieja no pisa a la nueva: copia aparte con id de 64 hex, con los bytes del PDF y marcada como copia", async () => {
    const id = HASH("e");
    await saveDraft(v1Params(id, { fingerprint: HASH("e"), fileBytes: new Uint8Array([1, 1, 1]) }));
    await as(tabB, async () => {
      await loadDraft(id);
      await saveDraft(
        v1Params(id, {
          fingerprint: HASH("e"),
          manifest: { mode: "multi", signers: [SIGNER, { id: "sg-2", name: "Luis", color: "#0f9d68" }], fields: [], textFields: [], textValues: {} },
        }),
      );
    });
    const result = await saveDraft(v1Params(id, { fingerprint: HASH("e"), fileBytes: new Uint8Array([1, 1, 1]) }));
    expect(result.ok).toBe(true);
    const copyId = result.ok ? (result.forkedTo as string) : "";
    expect(copyId).toMatch(/^[0-9a-f]{64}$/);
    expect(copyId).not.toBe(id);
    // La copia conserva el prefijo de la huella (32) y no es la huella: nunca choca con un borrador anterior.
    expect(copyId.slice(0, 32)).toBe(HASH("e").slice(0, 32));

    const metas = await listDrafts();
    expect(metas).toHaveLength(2);
    const kept = metas.find((meta) => meta.id === id) as DraftMeta;
    const copy = metas.find((meta) => meta.id === copyId) as DraftMeta;
    expect(kept.signers.map((signer) => signer.name)).toEqual(["Ana", "Luis"]);
    expect(copy.signers.map((signer) => signer.name)).toEqual(["Ana"]);
    expect(copy.copyOf).toBe(id);
    expect(copy.fingerprint).toBe(HASH("e"));
    expect(copy.rev).toBe(1);
    const loaded = await loadDraft(copyId);
    expect(Array.from(loaded?.bytes ?? [])).toEqual([1, 1, 1]);
  });

  it("borrar con `unlessNewer`: la pestana desactualizada no borra el borrador de la otra; la actualizada si", async () => {
    const id = HASH("f");
    await saveDraft(v1Params(id, { fingerprint: HASH("f") }));
    await as(tabB, async () => {
      await loadDraft(id);
      // F0-fix2 (N3): restaurar sin cambiar nada ya no escribe; la otra pestaña tiene que hacer un cambio REAL.
      await saveDraft(v1Params(id, { fingerprint: HASH("f"), step: "document" }));
    });
    await deleteDraft(id, { unlessNewer: true });
    expect(await listDrafts()).toHaveLength(1);
    await as(tabB, async () => {
      await deleteDraft(id, { unlessNewer: true });
    });
    expect(await listDrafts()).toHaveLength(0);
    expect(await rawRows("draftFiles")).toEqual([]);
  });

  it("dos sesiones de trabajo del MISMO PDF (ids distintos) conviven: ninguna pisa a la otra", async () => {
    const idA = `${HASH("a").slice(0, 32)}${"1".repeat(32)}`;
    const idB = `${HASH("a").slice(0, 32)}${"2".repeat(32)}`;
    await saveDraft(v1Params(idA, { fingerprint: HASH("a"), manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} } }));
    await saveDraft(
      v1Params(idB, {
        fingerprint: HASH("a"),
        manifest: { mode: "multi", signers: [{ id: "sg-9", name: "Maria", color: "#000" }], fields: [], textFields: [], textValues: {} },
      }),
    );
    await saveDraft(v1Params(idB, { fingerprint: HASH("a"), manifest: { mode: "multi", signers: [{ id: "sg-9", name: "Maria", color: "#000" }], fields: [], textFields: [], textValues: {} } }));
    const metas = await listDrafts();
    expect(metas.map((meta) => meta.signers[0].name).sort()).toEqual(["Ana", "Maria"]);
    expect(metas.every((meta) => draftFingerprint(meta) === HASH("a"))).toBe(true);
  });
});

describe("D1 · aviso entre pestanas (BroadcastChannel)", () => {
  it("una escritura de OTRA pestana llega a los suscriptores con id, version y autor; las propias no", async () => {
    const seen: RemoteDraftWrite[] = [];
    const unsubscribe = subscribeToRemoteDraftWrites((write) => seen.push(write));
    // Esta pestana escribe: no se avisa a si misma.
    await saveSessionDraft(sessionParams("s-bc-1"));
    // «Otra pestana»: otro canal con el mismo nombre (en el mismo proceso se entregan entre instancias distintas).
    const other = new BroadcastChannel("optimuspdf.sign-drafts");
    other.postMessage({ type: "write", id: "s-bc-1", rev: 7, writerId: "t-otra" });
    await vi.waitFor(() => expect(seen).toEqual([{ id: "s-bc-1", rev: 7, writerId: "t-otra" }]));
    // Basura y avisos antiguos («changed») no se interpretan como escrituras.
    other.postMessage("changed");
    other.postMessage({ type: "write", id: 5, rev: "x" });
    other.postMessage({ type: "write", id: "s-bc-1", rev: 8, writerId: tabWriterId() });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen).toHaveLength(1);
    other.close();
    unsubscribe();
  });

  it("al desuscribirse deja de recibir", async () => {
    const seen: RemoteDraftWrite[] = [];
    const unsubscribe = subscribeToRemoteDraftWrites((write) => seen.push(write));
    unsubscribe();
    const other = new BroadcastChannel("optimuspdf.sign-drafts");
    other.postMessage({ type: "write", id: "s-bc-2", rev: 1, writerId: "t-otra" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen).toEqual([]);
    other.close();
  });
});

describe("D2 · un fallo de escritura NO es un guardado", () => {
  function failPutsOn(...stores: string[]) {
    const original = IDBObjectStore.prototype.put;
    return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (stores.includes(this.name)) throw new DOMException("cuota llena (simulada)", "QuotaExceededError");
      return original.apply(this, args);
    });
  }

  it("sesion: con la cuota llena `saveSessionDraft` devuelve ok:false (unavailable), no «guardado»", async () => {
    failPutsOn("sessionMeta");
    await expect(saveSessionDraft(sessionParams("s-q-1"))).resolves.toEqual({ ok: false, reason: "unavailable" });
    vi.restoreAllMocks();
    expect(await listSessionDrafts()).toEqual([]);
    // Y se recupera en cuanto el navegador vuelve a dejar guardar (el siguiente cambio reintenta).
    await expect(saveSessionDraft(sessionParams("s-q-1"))).resolves.toEqual({ ok: true });
  });

  it("documento suelto: con la cuota llena `saveDraft` devuelve ok:false y no deja nada a medias (ni bytes sin metadatos)", async () => {
    failPutsOn("draftMeta");
    await expect(saveDraft(v1Params(HASH("a"), { fingerprint: HASH("a") }))).resolves.toEqual({ ok: false, reason: "unavailable" });
    vi.restoreAllMocks();
    expect(await listDrafts()).toEqual([]);
    expect(await rawRows("draftFiles")).toEqual([]);
    await expect(saveDraft(v1Params(HASH("a"), { fingerprint: HASH("a") }))).resolves.toEqual({ ok: true });
  });

  it("almacenamiento bloqueado (Safari privado: `indexedDB.open` lanza SecurityError): ambos devuelven ok:false", async () => {
    // Sin conexion abierta de antes (una ya abierta si podria escribir): se cierra la de vida larga.
    __closeWarmDraftsConnectionForTests();
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("bloqueado (simulado)", "SecurityError");
    });
    await expect(saveSessionDraft(sessionParams("s-sec-1"))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(saveDraft(v1Params(HASH("b")))).resolves.toEqual({ ok: false, reason: "unavailable" });
    vi.restoreAllMocks();
    await expect(saveSessionDraft(sessionParams("s-sec-1"))).resolves.toEqual({ ok: true });
  });

  it("sin IndexedDB (navegador sin soporte) tambien es un fallo declarado, no un guardado", async () => {
    __closeWarmDraftsConnectionForTests();
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    try {
      await expect(saveSessionDraft(sessionParams("s-none-1"))).resolves.toEqual({ ok: false, reason: "unavailable" });
      await expect(saveDraft(v1Params(HASH("c")))).resolves.toEqual({ ok: false, reason: "unavailable" });
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = saved;
    }
  });

  it("«tooBig» sigue siendo SU propio motivo (no cabe), distinto de un fallo", async () => {
    const huge = new Uint8Array(1);
    const result = await saveSessionDraft(
      sessionParams("s-big-1", { documents: [{ ...docInput("doc-1", huge), size: 200 * 1024 * 1024 }] }),
    );
    expect(result).toEqual({ ok: false, reason: "tooBig" });
  });
});

describe("D4 · borradores anteriores con firmas y sin fecha de caducidad", () => {
  const SAVED_RECENT = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const SAVED_OLD = () => new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

  async function putLegacyDocument(id: string, savedAt: string, withStrokes: boolean): Promise<void> {
    await rawPut("draftFiles", { id, bytes: new Uint8Array([1]) });
    await rawPut("draftMeta", {
      id,
      fileName: "a.pdf",
      fileSize: 1,
      savedAt,
      mode: "multi",
      signers: [SIGNER],
      fields: [],
      textFields: [],
      textValues: {},
      step: "sign",
      captures: withStrokes ? { [SIGNER.id]: { signature: STROKE, initials: null, stamp: "s" } } : {},
      textFieldsDetectedFor: null,
    });
  }

  async function putLegacySession(id: string, savedAt: string, withStrokes: boolean): Promise<void> {
    await rawPut("draftFiles", { id: `${id}/doc-1`, bytes: new Uint8Array([1]) });
    await rawPut("sessionMeta", {
      kind: "session",
      id,
      savedAt,
      mode: "multi",
      signMode: "same",
      signers: [SIGNER],
      blocks: withStrokes ? [signedBlock()] : [],
      documents: [{ id: "doc-1", fileName: "a.pdf", fileSize: 1 }],
      docStates: {},
      activeDocId: "doc-1",
      step: "sign",
      fileSize: 1,
      fileName: "a.pdf",
      documentCount: 1,
    });
  }

  it("`withLegacyExpiry`: asigna savedAt + 7 dias SOLO con trazos y sin fecha; en cualquier otro caso devuelve el mismo objeto", () => {
    const savedAt = "2026-01-01T00:00:00.000Z";
    const stamped = withLegacyExpiry<{ savedAt: string; expiresAt?: string }>({ savedAt }, true);
    expect(new Date(stamped.expiresAt as string).getTime()).toBe(new Date(savedAt).getTime() + SIGNATURE_DRAFT_TTL_MS);
    const noStrokes = { savedAt };
    expect(withLegacyExpiry(noStrokes, false)).toBe(noStrokes);
    const dated = { savedAt, expiresAt: "2030-01-01T00:00:00.000Z" };
    expect(withLegacyExpiry(dated, true)).toBe(dated);
  });

  it("listar asigna expiresAt (savedAt + 7 dias) a un documento con firmas y lo PERSISTE, sin tocar rev ni autor", async () => {
    const savedAt = SAVED_RECENT();
    await putLegacyDocument(HASH("a"), savedAt, true);
    const listed = await listAllDrafts();
    expect(listed).toHaveLength(1);
    const [row] = await rawRows<DraftMeta>("draftMeta");
    expect(new Date(row.expiresAt as string).getTime()).toBe(new Date(savedAt).getTime() + SIGNATURE_DRAFT_TTL_MS);
    expect(row.rev).toBeUndefined();
    expect(row.writerId).toBeUndefined();
    // El aviso «7 dias» es cierto: la lista ya lo trae.
    expect(listed[0].meta.expiresAt).toBe(row.expiresAt);
  });

  it("lo mismo para una sesion con firmas", async () => {
    const savedAt = SAVED_RECENT();
    await putLegacySession("s-leg-1", savedAt, true);
    await listAllDrafts();
    const [row] = await rawRows<SessionDraftMeta>("sessionMeta");
    expect(new Date(row.expiresAt as string).getTime()).toBe(new Date(savedAt).getTime() + SIGNATURE_DRAFT_TTL_MS);
  });

  it("un borrador con firmas guardado hace MAS de 7 dias caduca de verdad: se purga con todos sus bytes", async () => {
    await putLegacyDocument(HASH("b"), SAVED_OLD(), true);
    await putLegacySession("s-leg-2", SAVED_OLD(), true);
    expect(await purgeExpiredDrafts()).toBe(2);
    expect(await rawRows("draftMeta")).toEqual([]);
    expect(await rawRows("sessionMeta")).toEqual([]);
    expect(await rawRows("draftFiles")).toEqual([]);
  });

  it("sin firmas no hay nada que caduque: ni fecha asignada ni purga, por viejo que sea", async () => {
    await putLegacyDocument(HASH("c"), SAVED_OLD(), false);
    await putLegacySession("s-leg-3", SAVED_OLD(), false);
    expect(await purgeExpiredDrafts()).toBe(0);
    const [doc] = await rawRows<DraftMeta>("draftMeta");
    const [session] = await rawRows<SessionDraftMeta>("sessionMeta");
    expect(doc.expiresAt).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
    expect(await listAllDrafts()).toHaveLength(2);
  });

  it("abrir (loadDraft / loadSessionDraft) tambien la asigna y la persiste; uno ya vencido no se abre y se borra", async () => {
    const recent = SAVED_RECENT();
    await putLegacyDocument(HASH("d"), recent, true);
    await putLegacySession("s-leg-4", recent, true);
    const doc = await loadDraft(HASH("d"));
    const session = await loadSessionDraft("s-leg-4");
    expect(doc?.meta.expiresAt).toBeTruthy();
    expect(session?.meta.expiresAt).toBeTruthy();
    expect((await rawRows<DraftMeta>("draftMeta"))[0].expiresAt).toBe(doc?.meta.expiresAt);
    expect((await rawRows<SessionDraftMeta>("sessionMeta"))[0].expiresAt).toBe(session?.meta.expiresAt);

    await putLegacyDocument(HASH("e"), SAVED_OLD(), true);
    await putLegacySession("s-leg-5", SAVED_OLD(), true);
    expect(await loadDraft(HASH("e"))).toBeNull();
    expect(await loadSessionDraft("s-leg-5")).toBeNull();
    expect((await rawRows<DraftMeta>("draftMeta")).map((row) => row.id)).toEqual([HASH("d")]);
    expect((await rawRows<SessionDraftMeta>("sessionMeta")).map((row) => row.id)).toEqual(["s-leg-4"]);
  });

  it("las listas sueltas (sin purga) ya no ofrecen un borrador con firmas cuya fecha asignada paso", async () => {
    await putLegacyDocument(HASH("f"), SAVED_OLD(), true);
    await putLegacySession("s-leg-6", SAVED_OLD(), true);
    expect(await listDrafts()).toEqual([]);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("un borrador NUEVO con firmas ya sale con fecha y no se vuelve a tocar al listar", async () => {
    await saveSessionDraft(sessionParams("s-nuevo-1", { blocks: [signedBlock()] }));
    const [before] = await rawRows<SessionDraftMeta>("sessionMeta");
    await listAllDrafts();
    const [after] = await rawRows<SessionDraftMeta>("sessionMeta");
    expect(before.expiresAt).toBeTruthy();
    expect(after).toEqual(before);
  });
});
