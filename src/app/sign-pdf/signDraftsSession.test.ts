import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_DOC_STATE,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import {
  MAX_DRAFTS,
  MAX_DRAFTS_TOTAL_BYTES,
  MAX_SESSION_DRAFT_BYTES,
  __closeWarmDraftsConnectionForTests,
  __hasWarmDraftsConnectionForTests,
  __setDraftsBlockedTimeoutForTests,
  warmDraftsConnection,
  buildSessionMeta,
  clearAllDrafts,
  deleteDraft,
  deleteDraftEntry,
  deleteSessionDraft,
  isSessionDraftMeta,
  listAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  saveDraft,
  saveSessionDraft,
  sessionFileKey,
  subscribeToDrafts,
  type SaveDraftParams,
  type SaveSessionParams,
  type SessionDocInput,
} from "@/app/sign-pdf/signDrafts";

/**
 * Borradores por SESION (Wave 4 · U5) sobre `fake-indexeddb`: el mismo motor
 * de transacciones que un navegador, sin mocks a mano.
 */

const MB = 1024 * 1024;
const DB_NAME = "optimuspdf-sign-drafts";

const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };

function docInput(
  id: string,
  overrides: Partial<SessionDocInput> & { bytes?: Uint8Array } = {},
): SessionDocInput {
  const bytes = overrides.bytes ?? new Uint8Array([1, 2, 3, id.length]);
  return {
    id,
    fileName: `${id}.pdf`,
    size: bytes.byteLength,
    state: { ...EMPTY_DOC_STATE } as DocState,
    getBytes: async () => bytes,
    ...overrides,
  };
}

function sessionParams(
  id: string,
  docIds: string[] = ["doc-1", "doc-2"],
  overrides: Partial<SaveSessionParams> = {},
): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [],
    documents: docIds.map((docId) => docInput(docId)),
    activeDocId: docIds[0] ?? null,
    step: "signers",
    ...overrides,
  };
}

function v1Params(id: string, size = 4): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array(size),
    fileName: `${id}.pdf`,
    manifest: {
      mode: "multi",
      signers: [SIGNER],
      fields: [],
      textFields: [],
      textValues: {},
    },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  };
}

/** Lee TODAS las claves de un almacen, saltandose la API del modulo. */
async function rawKeys(store: string): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Escribe a mano en un almacen (huerfanos, datos corruptos...). */
async function rawPut(store: string, value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(store).put(value);
    });
  } finally {
    db.close();
  }
}

async function rawDelete(store: string, key: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(store).delete(key);
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  __setDraftsBlockedTimeoutForTests(150);
  await clearAllDrafts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("borrador de sesion — guardar y leer", () => {
  it("guarda una sesion y la lee entera, con los bytes de cada documento y su orden", async () => {
    const params = sessionParams("s-a", ["doc-1", "doc-2", "doc-3"], {
      documents: [
        docInput("doc-1", { bytes: new Uint8Array([1, 1]) }),
        docInput("doc-2", { bytes: new Uint8Array([2, 2, 2]) }),
        docInput("doc-3", { bytes: new Uint8Array([3]) }),
      ],
    });
    await expect(saveSessionDraft(params)).resolves.toEqual({ ok: true });

    const loaded = await loadSessionDraft("s-a");
    expect(loaded).not.toBeNull();
    expect(loaded!.files.map((file) => file.id)).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(loaded!.files[1].bytes).toEqual(new Uint8Array([2, 2, 2]));
    expect(loaded!.meta.documentCount).toBe(3);
    expect(loaded!.meta.fileSize).toBe(6);
  });

  it("los bytes van en draftFiles con clave sessionId/docId y los metadatos en sessionMeta", async () => {
    await saveSessionDraft(sessionParams("s-b"));
    expect((await rawKeys("draftFiles")).sort()).toEqual([
      sessionFileKey("s-b", "doc-1"),
      sessionFileKey("s-b", "doc-2"),
    ]);
    expect(await rawKeys("sessionMeta")).toEqual(["s-b"]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("guarda la sesion completa: firmantes, modo, bloques con trazos y sellos, estado por documento, activo y paso", async () => {
    const block: SignerBlock = {
      id: "bk-1",
      signerId: "sg-1",
      appliesTo: ["doc-1", "doc-2"],
      signature: { dataUrl: "data:image/png;base64,AAAA", ratio: 0.4 },
      initials: { dataUrl: "data:image/png;base64,BBBB", ratio: 0.5 },
      stamps: { "doc-1": "k1~f", "doc-2": "k2~f" },
      auto: true,
    };
    const state: DocState = {
      ...EMPTY_DOC_STATE,
      textValues: { "txt-1": "Ana" },
      fieldPageIndex: 2,
      sealedKey: "k1",
    };
    await saveSessionDraft(
      sessionParams("s-c", ["doc-1", "doc-2"], {
        signMode: "independent",
        blocks: [block],
        activeDocId: "doc-2",
        step: "sign",
        documents: [docInput("doc-1", { state }), docInput("doc-2")],
      }),
    );
    const { meta } = (await loadSessionDraft("s-c"))!;
    expect(meta.signMode).toBe("independent");
    expect(meta.signers).toEqual([SIGNER]);
    expect(meta.blocks).toEqual([block]);
    expect(meta.activeDocId).toBe("doc-2");
    expect(meta.step).toBe("sign");
    expect(meta.docStates["doc-1"].textValues).toEqual({ "txt-1": "Ana" });
    expect(meta.docStates["doc-1"].fieldPageIndex).toBe(2);
  });

  it("guarda y lee el turno de la ceremonia (Fase 0 · U0.2): de quien es y en que etapa, tal cual", async () => {
    const SIGNER_2 = { id: "sg-2", name: "Luis", color: "#0f9d68" };
    await saveSessionDraft(
      sessionParams("s-turn", ["doc-1", "doc-2"], {
        signers: [SIGNER, SIGNER_2],
        step: "sign",
        ceremony: { signerId: "sg-2", stage: "capture" },
      }),
    );
    const { meta } = (await loadSessionDraft("s-turn"))!;
    expect(meta.ceremony).toEqual({ signerId: "sg-2", stage: "capture" });
    expect(isSessionDraftMeta(meta)).toBe(true);
  });

  it("sin turno el borrador no trae el campo (los anteriores y los nuevos sin turno son iguales)", async () => {
    await saveSessionDraft(sessionParams("s-noturn"));
    const { meta } = (await loadSessionDraft("s-noturn"))!;
    expect("ceremony" in meta).toBe(false);
    expect("ceremony" in buildSessionMeta(sessionParams("s-x"))).toBe(false);
  });

  it("buildSessionMeta suma los tamanos y resume con el primer nombre", () => {
    const meta = buildSessionMeta(
      sessionParams("s-d", ["a", "b"], {
        documents: [
          docInput("a", { size: 10, fileName: "uno.pdf" }),
          docInput("b", { size: 32, fileName: "dos.pdf" }),
        ],
      }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(meta.fileSize).toBe(42);
    expect(meta.fileName).toBe("uno.pdf");
    expect(meta.documentCount).toBe(2);
    expect(meta.savedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("un guardado posterior no vuelve a leer los bytes que ya estan", async () => {
    const first = sessionParams("s-e");
    await saveSessionDraft(first);

    const reads = vi.fn(async () => new Uint8Array([9]));
    const second = sessionParams("s-e", ["doc-1", "doc-2"], {
      documents: [
        docInput("doc-1", { getBytes: reads }),
        docInput("doc-2", { getBytes: reads }),
      ],
      step: "document",
    });
    await saveSessionDraft(second);

    expect(reads).not.toHaveBeenCalled();
    expect((await loadSessionDraft("s-e"))!.meta.step).toBe("document");
  });

  it("anadir un documento solo lee los bytes del nuevo", async () => {
    await saveSessionDraft(sessionParams("s-f"));
    const reads = vi.fn(async () => new Uint8Array([7, 7]));
    await saveSessionDraft(
      sessionParams("s-f", ["doc-1", "doc-2", "doc-3"], {
        documents: [
          docInput("doc-1", { getBytes: vi.fn() as never }),
          docInput("doc-2", { getBytes: vi.fn() as never }),
          docInput("doc-3", { getBytes: reads }),
        ],
      }),
    );
    expect(reads).toHaveBeenCalledTimes(1);
    expect((await loadSessionDraft("s-f"))!.files).toHaveLength(3);
  });

  it("quitar un documento borra su archivo: no queda ningun huerfano", async () => {
    await saveSessionDraft(sessionParams("s-g", ["doc-1", "doc-2", "doc-3"]));
    await saveSessionDraft(sessionParams("s-g", ["doc-1", "doc-3"]));
    expect((await rawKeys("draftFiles")).sort()).toEqual([
      sessionFileKey("s-g", "doc-1"),
      sessionFileKey("s-g", "doc-3"),
    ]);
    expect((await loadSessionDraft("s-g"))!.meta.documentCount).toBe(2);
  });

  it("dos sesiones con ids parecidos no se mezclan (s-1 y s-10)", async () => {
    await saveSessionDraft(sessionParams("s-1", ["doc-1"]));
    await saveSessionDraft(sessionParams("s-10", ["doc-1", "doc-2"]));
    await saveSessionDraft(sessionParams("s-1", ["doc-1"], { step: "document" }));
    expect((await loadSessionDraft("s-10"))!.files).toHaveLength(2);
    expect((await loadSessionDraft("s-1"))!.files).toHaveLength(1);
  });

  it("si un archivo desaparece entre medias (otra pestana lo expulso) reintenta y deja la sesion completa", async () => {
    await saveSessionDraft(sessionParams("s-h"));
    const replacement = new Uint8Array([5, 5]);
    await saveSessionDraft(
      sessionParams("s-h", ["doc-1", "doc-2", "doc-3"], {
        documents: [
          docInput("doc-1", { bytes: new Uint8Array([1]) }),
          docInput("doc-2", { bytes: new Uint8Array([2]) }),
          docInput("doc-3", {
            // Se pide DESPUES de leer las claves existentes: aqui "otra pestana" borra doc-1.
            getBytes: async () => {
              await rawDelete("draftFiles", sessionFileKey("s-h", "doc-1"));
              return replacement;
            },
          }),
        ],
      }),
    );
    const loaded = await loadSessionDraft("s-h");
    expect(loaded).not.toBeNull();
    expect(loaded!.files.map((file) => file.id)).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(loaded!.files[2].bytes).toEqual(replacement);
  });

  it("dos guardados entrelazados de la MISMA sesion (otra pestana) no dejan archivos huerfanos en una sesion viva", async () => {
    await saveSessionDraft(sessionParams("s-conc", ["doc-1"]));
    // La pestana A ya leyo las claves existentes ({doc-1}) cuando la pestana B guarda {doc-1, doc-3}.
    const resultA = await saveSessionDraft(
      sessionParams("s-conc", ["doc-1", "doc-2"], {
        documents: [
          docInput("doc-1"),
          docInput("doc-2", {
            getBytes: async () => {
              await saveSessionDraft(sessionParams("s-conc", ["doc-1", "doc-3"]));
              return new Uint8Array([2]);
            },
          }),
        ],
      }),
    );
    expect(resultA).toEqual({ ok: true });
    // Gana la ultima escritura (A): sus archivos y NINGUNO mas.
    expect((await rawKeys("draftFiles")).sort()).toEqual([
      sessionFileKey("s-conc", "doc-1"),
      sessionFileKey("s-conc", "doc-2"),
    ]);
    const loaded = await loadSessionDraft("s-conc");
    expect(loaded!.files.map((file) => file.id)).toEqual(["doc-1", "doc-2"]);
  });

  it("el orden contrario (gana B) tampoco deja huerfanos", async () => {
    await saveSessionDraft(sessionParams("s-conc2", ["doc-1", "doc-2"]));
    await saveSessionDraft(
      sessionParams("s-conc2", ["doc-1", "doc-4"], {
        documents: [
          docInput("doc-1"),
          docInput("doc-4", {
            getBytes: async () => {
              await saveSessionDraft(sessionParams("s-conc2", ["doc-1", "doc-2", "doc-5"]));
              return new Uint8Array([4]);
            },
          }),
        ],
      }),
    );
    const keys = (await rawKeys("draftFiles")).sort();
    const meta = (await listSessionDrafts())[0];
    expect(keys).toEqual(meta.documents.map((doc) => sessionFileKey("s-conc2", doc.id)).sort());
  });

  it("isCurrent=false justo antes de escribir: no escribe nada", async () => {
    const result = await saveSessionDraft({
      ...sessionParams("s-i"),
      isCurrent: () => false,
    });
    expect(result).toEqual({ ok: false, reason: "superseded" });
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("isCurrent se consulta DESPUES de leer los bytes (un volcado tardio no resucita lo borrado)", async () => {
    let current = true;
    const result = await saveSessionDraft({
      ...sessionParams("s-j", ["doc-1"]),
      documents: [
        docInput("doc-1", {
          getBytes: async () => {
            current = false;
            return new Uint8Array([1]);
          },
        }),
      ],
      isCurrent: () => current,
    });
    expect(result.ok).toBe(false);
    expect(await rawKeys("sessionMeta")).toEqual([]);
  });
});

describe("borrador de sesion — listar y borrar", () => {
  it("listSessionDrafts ordena del mas reciente al mas antiguo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    await saveSessionDraft(sessionParams("s-old"));
    vi.setSystemTime(new Date("2026-03-01T11:00:00Z"));
    await saveSessionDraft(sessionParams("s-new"));
    expect((await listSessionDrafts()).map((meta) => meta.id)).toEqual(["s-new", "s-old"]);
  });

  it("listAllDrafts mezcla documentos sueltos (v1) y sesiones, del mas reciente al mas antiguo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    await saveDraft(v1Params("hash-a"));
    vi.setSystemTime(new Date("2026-03-01T11:00:00Z"));
    await saveSessionDraft(sessionParams("s-mix"));
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    await saveDraft(v1Params("hash-b"));
    const entries = await listAllDrafts();
    expect(entries.map((entry) => `${entry.kind}:${entry.meta.id}`)).toEqual([
      "document:hash-b",
      "session:s-mix",
      "document:hash-a",
    ]);
  });

  it("listDrafts (v1) no incluye las sesiones", async () => {
    await saveSessionDraft(sessionParams("s-k"));
    await saveDraft(v1Params("hash-c"));
    expect((await listDrafts()).map((meta) => meta.id)).toEqual(["hash-c"]);
  });

  it("deleteSessionDraft borra los metadatos y TODOS los archivos de la sesion", async () => {
    await saveSessionDraft(sessionParams("s-l", ["doc-1", "doc-2", "doc-3"]));
    await saveSessionDraft(sessionParams("s-m", ["doc-1"]));
    await deleteSessionDraft("s-l");
    expect(await rawKeys("sessionMeta")).toEqual(["s-m"]);
    expect(await rawKeys("draftFiles")).toEqual([sessionFileKey("s-m", "doc-1")]);
  });

  it("deleteDraftEntry despacha segun el tipo de entrada", async () => {
    await saveSessionDraft(sessionParams("s-n"));
    await saveDraft(v1Params("hash-d"));
    const [first, second] = await listAllDrafts();
    await deleteDraftEntry(first);
    await deleteDraftEntry(second);
    expect(await listAllDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("clearAllDrafts vacia tambien las sesiones y sus archivos", async () => {
    await saveSessionDraft(sessionParams("s-o"));
    await saveDraft(v1Params("hash-e"));
    await expect(clearAllDrafts()).resolves.toEqual({ ok: true });
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("subscribeToDrafts avisa al guardar y al borrar una sesion", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToDrafts(listener);
    await saveSessionDraft(sessionParams("s-p"));
    expect(listener).toHaveBeenCalledTimes(1);
    await deleteSessionDraft("s-p");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("loadSessionDraft de un id inexistente devuelve null", async () => {
    await expect(loadSessionDraft("nada")).resolves.toBeNull();
  });

  it("si falta un archivo de la sesion no se puede retomar a medias: devuelve null y limpia lo que quedaba", async () => {
    await saveSessionDraft(sessionParams("s-q", ["doc-1", "doc-2"]));
    await rawDelete("draftFiles", sessionFileKey("s-q", "doc-2"));
    await expect(loadSessionDraft("s-q")).resolves.toBeNull();
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("isSessionDraftMeta rechaza lo que no tiene la forma de una sesion", () => {
    const good = buildSessionMeta(sessionParams("s-r"));
    expect(isSessionDraftMeta(good)).toBe(true);
    expect(isSessionDraftMeta({ ...good, kind: "document" })).toBe(false);
    expect(isSessionDraftMeta({ ...good, documents: [{ id: 1 }] })).toBe(false);
    expect(isSessionDraftMeta({ ...good, signMode: "otra" })).toBe(false);
    expect(isSessionDraftMeta({ ...good, blocks: [{ id: "x" }] })).toBe(false);
    expect(isSessionDraftMeta(null)).toBe(false);
    expect(isSessionDraftMeta("texto")).toBe(false);
  });

  it("una fila corrupta en sessionMeta no rompe el listado ni la lectura", async () => {
    await saveSessionDraft(sessionParams("s-s"));
    await rawPut("sessionMeta", { id: "s-roto", kind: "session" });
    expect((await listSessionDrafts()).map((meta) => meta.id)).toEqual(["s-s"]);
    await expect(loadSessionDraft("s-roto")).resolves.toBeNull();
  });
});

describe("borrador de sesion — presupuesto", () => {
  it("una sesion cuenta como UN borrador: caben MAX_DRAFTS sesiones aunque cada una tenga varios documentos", async () => {
    for (let index = 0; index < MAX_DRAFTS; index += 1) {
      await saveSessionDraft(sessionParams(`s-${index}`, ["a", "b", "c", "d"]));
    }
    expect(await listSessionDrafts()).toHaveLength(MAX_DRAFTS);
    expect(await rawKeys("draftFiles")).toHaveLength(MAX_DRAFTS * 4);
  });

  it(`expulsa la sesion mas antigua al superar ${MAX_DRAFTS} borradores, con TODOS sus archivos`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index <= MAX_DRAFTS; index += 1) {
      vi.setSystemTime(new Date(2026, 2, 1, 10, index));
      await saveSessionDraft(sessionParams(`s-${index}`, ["a", "b"]));
    }
    const ids = (await listSessionDrafts()).map((meta) => meta.id);
    expect(ids).toHaveLength(MAX_DRAFTS);
    expect(ids).not.toContain("s-0");
    const files = await rawKeys("draftFiles");
    expect(files.filter((key) => key.startsWith("s-0/"))).toEqual([]);
    expect(files).toHaveLength(MAX_DRAFTS * 2);
  });

  it("v1 y sesiones comparten el tope de borradores", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index < 6; index += 1) {
      vi.setSystemTime(new Date(2026, 2, 1, 10, index));
      await saveDraft(v1Params(`hash-${index}`));
    }
    for (let index = 0; index < 6; index += 1) {
      vi.setSystemTime(new Date(2026, 2, 1, 11, index));
      await saveSessionDraft(sessionParams(`s-${index}`));
    }
    const entries = await listAllDrafts();
    expect(entries).toHaveLength(MAX_DRAFTS);
    // Salieron los 2 v1 mas antiguos.
    expect(entries.some((entry) => entry.meta.id === "hash-0")).toBe(false);
    expect(entries.some((entry) => entry.meta.id === "hash-1")).toBe(false);
    expect(await rawKeys("draftFiles")).toHaveLength(4 + 6 * 2);
  });

  it("expulsa por bytes totales sumando los documentos de cada sesion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const big = (id: string) =>
      sessionParams(id, ["a", "b"], {
        documents: [
          docInput("a", { size: 70 * MB }),
          docInput("b", { size: 70 * MB }),
        ],
      });
    vi.setSystemTime(new Date(2026, 2, 1, 10, 0));
    await saveSessionDraft(big("s-1")); // 140 MB
    vi.setSystemTime(new Date(2026, 2, 1, 10, 1));
    await saveSessionDraft(big("s-2")); // 280 MB
    expect(await listSessionDrafts()).toHaveLength(2);
    vi.setSystemTime(new Date(2026, 2, 1, 10, 2));
    await saveSessionDraft(big("s-3")); // 420 MB > 300 MB: sale la mas antigua
    const ids = (await listSessionDrafts()).map((meta) => meta.id).sort();
    expect(ids).toEqual(["s-2", "s-3"]);
    expect((await rawKeys("draftFiles")).some((key) => key.startsWith("s-1/"))).toBe(false);
    expect(MAX_DRAFTS_TOTAL_BYTES).toBe(300 * MB);
  });

  it("la sesion que se acaba de guardar NUNCA se expulsa a si misma, aunque sea la 'mas antigua'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index < MAX_DRAFTS; index += 1) {
      vi.setSystemTime(new Date(2026, 2, 1, 10, index));
      await saveSessionDraft(sessionParams(`s-${index}`, ["a"]));
    }
    // El reloj va hacia atras (cambio de hora, reloj mal puesto): la nueva parece la mas vieja.
    vi.setSystemTime(new Date(2026, 1, 1, 10, 0));
    await saveSessionDraft(sessionParams("s-nueva", ["a", "b"]));
    const ids = (await listSessionDrafts()).map((meta) => meta.id);
    expect(ids).toContain("s-nueva");
    expect(ids).toHaveLength(MAX_DRAFTS);
    expect(ids).not.toContain("s-0");
    expect((await loadSessionDraft("s-nueva"))!.files).toHaveLength(2);
  });

  it("barre los archivos huerfanos (sin borrador que los reclame) al guardar", async () => {
    await rawPut("draftFiles", { id: "s-fantasma/doc-1", bytes: new Uint8Array([1]) });
    await rawPut("draftFiles", { id: "hash-fantasma", bytes: new Uint8Array([1]) });
    await saveSessionDraft(sessionParams("s-t", ["doc-1"]));
    expect(await rawKeys("draftFiles")).toEqual([sessionFileKey("s-t", "doc-1")]);
  });

  it("un guardado v1 tambien barre huerfanos de sesiones y respeta las sesiones vivas", async () => {
    await saveSessionDraft(sessionParams("s-u", ["doc-1", "doc-2"]));
    await rawPut("draftFiles", { id: "s-muerta/doc-1", bytes: new Uint8Array([1]) });
    await saveDraft(v1Params("hash-f"));
    const files = (await rawKeys("draftFiles")).sort();
    expect(files).toEqual(["hash-f", sessionFileKey("s-u", "doc-1"), sessionFileKey("s-u", "doc-2")]);
  });

  it("purga las filas corruptas de sessionMeta y sus archivos sessionId/* al guardar", async () => {
    await rawPut("sessionMeta", { id: "s-roto", kind: "session" });
    await rawPut("draftFiles", { id: "s-roto/doc-1", bytes: new Uint8Array([1]) });
    await rawPut("draftFiles", { id: "s-roto/doc-2", bytes: new Uint8Array([2]) });
    await saveSessionDraft(sessionParams("s-sana", ["doc-1"]));
    expect(await rawKeys("sessionMeta")).toEqual(["s-sana"]);
    expect(await rawKeys("draftFiles")).toEqual([sessionFileKey("s-sana", "doc-1")]);
  });

  it("un guardado v1 tambien purga las filas corruptas de sesion", async () => {
    await rawPut("sessionMeta", { id: "s-roto", kind: "session", documents: "no" });
    await rawPut("draftFiles", { id: "s-roto/doc-1", bytes: new Uint8Array([1]) });
    await saveDraft(v1Params("hash-purga"));
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual(["hash-purga"]);
  });

  it("las filas corruptas no cuentan para el tope de borradores ni expulsan a las sanas", async () => {
    for (let index = 0; index < 5; index += 1) {
      await rawPut("sessionMeta", { id: `s-roto-${index}` });
    }
    for (let index = 0; index < MAX_DRAFTS; index += 1) {
      await saveSessionDraft(sessionParams(`s-ok-${index}`, ["a"]));
    }
    expect(await listSessionDrafts()).toHaveLength(MAX_DRAFTS);
  });

  it("una sesion que pasa de 150 MB no se guarda y avisa; ni siquiera lee los bytes", async () => {
    const getBytes = vi.fn(async () => new Uint8Array([1]));
    const result = await saveSessionDraft(
      sessionParams("s-v", ["a", "b"], {
        documents: [
          docInput("a", { size: 100 * MB, getBytes }),
          docInput("b", { size: 51 * MB, getBytes }),
        ],
      }),
    );
    expect(result).toEqual({ ok: false, reason: "tooBig" });
    expect(getBytes).not.toHaveBeenCalled();
    expect(await listSessionDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });

  it("justo en el tope (150 MB) si se guarda", async () => {
    const result = await saveSessionDraft(
      sessionParams("s-w", ["a", "b"], {
        documents: [
          docInput("a", { size: 100 * MB }),
          docInput("b", { size: 50 * MB }),
        ],
      }),
    );
    expect(MAX_SESSION_DRAFT_BYTES).toBe(150 * MB);
    expect(result).toEqual({ ok: true });
  });

  it("lo ya guardado de una sesion no se toca cuando una version posterior pasa del tope", async () => {
    await saveSessionDraft(sessionParams("s-x", ["a"]));
    const tooBig = await saveSessionDraft(
      sessionParams("s-x", ["a", "b"], {
        documents: [docInput("a"), docInput("b", { size: 200 * MB })],
      }),
    );
    expect(tooBig.ok).toBe(false);
    expect((await loadSessionDraft("s-x"))!.meta.documentCount).toBe(1);
  });
});

describe("migracion v1 -> v2 y otra pestana", () => {
  /** Una base recien creada como la dejaba la version anterior: v1, dos almacenes. */
  async function createV1Database(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("draftFiles", { keyPath: "id" });
        request.result.createObjectStore("draftMeta", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["draftFiles", "draftMeta"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore("draftFiles").put({ id: "hash-viejo", bytes: new Uint8Array([4, 5, 6]) });
      tx.objectStore("draftMeta").put({
        id: "hash-viejo",
        fileName: "viejo.pdf",
        fileSize: 3,
        savedAt: "2026-01-01T00:00:00.000Z",
        mode: "multi",
        signers: [SIGNER],
        fields: [],
        textFields: [],
        textValues: {},
        step: "fields",
        captures: {},
        textFieldsDetectedFor: null,
      });
    });
    db.close();
  }

  /** Abre la base en v1 y la deja ABIERTA (otra pestana con la version anterior). */
  async function openV1Connection(onVersionChange?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (onVersionChange) db.onversionchange = () => onVersionChange(db);
    return db;
  }

  it("un borrador v1 existente se sigue leyendo tal cual tras subir a v2", async () => {
    await createV1Database();
    const drafts = await listDrafts();
    expect(drafts.map((draft) => draft.id)).toEqual(["hash-viejo"]);
    expect(drafts[0].step).toBe("fields");
    const loaded = await loadDraft("hash-viejo");
    expect(loaded!.bytes).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("al subir a v2 aparece el almacen de sesiones sin tocar los datos v1", async () => {
    await createV1Database();
    await saveSessionDraft(sessionParams("s-y"));
    expect(await rawKeys("sessionMeta")).toEqual(["s-y"]);
    expect(await rawKeys("draftMeta")).toEqual(["hash-viejo"]);
    expect((await rawKeys("draftFiles")).sort()).toEqual([
      "hash-viejo",
      sessionFileKey("s-y", "doc-1"),
      sessionFileKey("s-y", "doc-2"),
    ]);
  });

  it("listAllDrafts mezcla el borrador v1 migrado con sesiones nuevas", async () => {
    await createV1Database();
    await saveSessionDraft(sessionParams("s-z"));
    const kinds = (await listAllDrafts()).map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["document", "session"]);
  });

  it("con una pestana en v1 que cierra su conexion al pedirselo, la subida a v2 sigue adelante", async () => {
    await createV1Database();
    const other = await openV1Connection((db) => db.close());
    await expect(saveSessionDraft(sessionParams("s-tab"))).resolves.toEqual({ ok: true });
    expect(await rawKeys("sessionMeta")).toEqual(["s-tab"]);
    expect(await rawKeys("draftMeta")).toEqual(["hash-viejo"]);
    other.close();
  });

  it("con una pestana en v1 que NO cierra su conexion, nada lanza y la operacion se abandona tras el plazo", async () => {
    await createV1Database();
    const other = await openV1Connection();
    await expect(saveSessionDraft(sessionParams("s-bloq"))).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    // F0-fix (D2): `saveDraft` ya no calla: INFORMA de que no se pudo guardar (antes devolvia `undefined`).
    await expect(saveDraft(v1Params("hash-bloq"))).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(listDrafts()).resolves.toEqual([]);
    await expect(listSessionDrafts()).resolves.toEqual([]);
    await expect(loadSessionDraft("s-bloq")).resolves.toBeNull();
    await expect(clearAllDrafts()).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(deleteDraft("x")).resolves.toBeUndefined();
    other.close();
  });

  it("al cerrarse la pestana vieja, lo siguiente funciona y no quedo ninguna conexion colgada del intento anterior", async () => {
    await createV1Database();
    const other = await openV1Connection();
    await saveSessionDraft(sessionParams("s-late"));
    other.close();
    await expect(saveSessionDraft(sessionParams("s-late"))).resolves.toEqual({ ok: true });
    expect((await listSessionDrafts()).map((meta) => meta.id)).toEqual(["s-late"]);
    // Si el intento abandonado hubiera dejado su conexion abierta, esto se bloquearia.
    await expect(clearAllDrafts()).resolves.toEqual({ ok: true });
  });

  it("una pestana mas nueva que pide subir la version no queda bloqueada por una conexion nuestra (onversionchange)", async () => {
    await saveSessionDraft(sessionParams("s-ver"));
    // Simula una futura v3 abierta desde otra pestana: no debe bloquearse por nosotros.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onblocked = () => reject(new Error("bloqueada por una conexion nuestra"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    upgraded.close();
    // La base queda en v3: se borra para no contaminar a los demas tests.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
});

describe("compatibilidad con el borrador de un documento", () => {
  it("con un documento se sigue guardando el formato v1 (draftMeta), no una sesion", async () => {
    await saveDraft(v1Params("hash-solo"));
    expect(await rawKeys("draftMeta")).toEqual(["hash-solo"]);
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual(["hash-solo"]);
  });

  it("la expulsion por presupuesto de un v1 sigue borrando sus bytes junto con los metadatos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let index = 0; index <= MAX_DRAFTS; index += 1) {
      vi.setSystemTime(new Date(2026, 2, 1, 10, index));
      await saveDraft(v1Params(`hash-${index}`));
    }
    expect(await rawKeys("draftFiles")).not.toContain("hash-0");
    expect(await rawKeys("draftMeta")).not.toContain("hash-0");
    expect(await rawKeys("draftFiles")).toHaveLength(MAX_DRAFTS);
  });
});

describe("camino rapido: conexion abierta y escritura que arranca en la misma pasada sincrona (sobrevive a pagehide)", () => {
  /** Cuenta las transacciones que se CREAN, para saber si ocurrieron antes de cualquier espera. */
  function spyTransactions() {
    return vi.spyOn(IDBDatabase.prototype, "transaction");
  }

  it("warmDraftsConnection deja una conexion abierta y es idempotente", async () => {
    __closeWarmDraftsConnectionForTests();
    expect(__hasWarmDraftsConnectionForTests()).toBe(false);
    await warmDraftsConnection();
    await warmDraftsConnection();
    expect(__hasWarmDraftsConnectionForTests()).toBe(true);
  });

  it("con la conexion abierta, la transaccion de escritura se crea SIN esperar nada (sincrona)", async () => {
    await saveSessionDraft(sessionParams("s-fast"));
    await warmDraftsConnection();
    const spy = spyTransactions();
    spy.mockClear();
    // Sin `await`: lo que ocurre en esta misma pasada es lo que sobrevive a una descarga de pagina.
    const pending = saveSessionDraft(sessionParams("s-fast", ["doc-1", "doc-2"], { step: "document" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe("readwrite");
    await expect(pending).resolves.toEqual({ ok: true });
    spy.mockRestore();
    expect((await loadSessionDraft("s-fast"))!.meta.step).toBe("document");
  });

  it("el camino rapido no lee los bytes de los archivos que ya estan guardados", async () => {
    await saveSessionDraft(sessionParams("s-nobytes"));
    await warmDraftsConnection();
    const reads = vi.fn(async () => new Uint8Array([9]));
    const result = await saveSessionDraft(
      sessionParams("s-nobytes", ["doc-1", "doc-2"], {
        documents: [docInput("doc-1", { getBytes: reads }), docInput("doc-2", { getBytes: reads })],
        step: "sign",
      }),
    );
    expect(result.ok).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect((await loadSessionDraft("s-nobytes"))!.meta.step).toBe("sign");
  });

  it("un documento NUEVO aborta el camino rapido sin escribir nada a medias y sigue por el lento (con bytes)", async () => {
    await saveSessionDraft(sessionParams("s-new", ["doc-1"]));
    await warmDraftsConnection();
    const bytes = new Uint8Array([4, 4]);
    const result = await saveSessionDraft(
      sessionParams("s-new", ["doc-1", "doc-2"], {
        documents: [docInput("doc-1"), docInput("doc-2", { bytes })],
      }),
    );
    expect(result).toEqual({ ok: true });
    const loaded = await loadSessionDraft("s-new");
    expect(loaded!.files.map((file) => file.id)).toEqual(["doc-1", "doc-2"]);
    expect(Array.from(loaded!.files[1].bytes)).toEqual([4, 4]);
  });

  it("el camino rapido tambien sincroniza archivos sobrantes (quitar un documento)", async () => {
    await saveSessionDraft(sessionParams("s-less", ["doc-1", "doc-2", "doc-3"]));
    await warmDraftsConnection();
    await saveSessionDraft(sessionParams("s-less", ["doc-1", "doc-3"]));
    expect((await rawKeys("draftFiles")).sort()).toEqual([
      sessionFileKey("s-less", "doc-1"),
      sessionFileKey("s-less", "doc-3"),
    ]);
  });

  it("respeta isCurrent: un guardado ya superado no escribe ni siquiera por el camino rapido", async () => {
    await saveSessionDraft(sessionParams("s-gen"));
    await warmDraftsConnection();
    const result = await saveSessionDraft({
      ...sessionParams("s-gen", ["doc-1", "doc-2"], { step: "sign" }),
      isCurrent: () => false,
    });
    expect(result.ok).toBe(false);
    expect((await loadSessionDraft("s-gen"))!.meta.step).toBe("signers");
  });

  it("la conexion se aparta sola ante onversionchange (no bloquea una subida de version de otra pestana) y el guardado siguiente la reabre", async () => {
    await saveSessionDraft(sessionParams("s-ver2"));
    await warmDraftsConnection();
    expect(__hasWarmDraftsConnectionForTests()).toBe(true);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 3);
      request.onblocked = () => reject(new Error("bloqueada por la conexion de vida larga"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    upgraded.close();
    expect(__hasWarmDraftsConnectionForTests()).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await expect(saveSessionDraft(sessionParams("s-ver2"))).resolves.toEqual({ ok: true });
    expect(__hasWarmDraftsConnectionForTests()).toBe(true);
  });

  it("si la conexion de vida larga quedo muerta, el guardado no lanza y se recupera por el camino normal", async () => {
    await saveSessionDraft(sessionParams("s-dead"));
    await warmDraftsConnection();
    // Se cierra por debajo sin que el modulo se entere (el navegador la cierra por su cuenta).
    const original = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new DOMException("closed", "InvalidStateError");
    });
    const result = await saveSessionDraft(sessionParams("s-dead", ["doc-1", "doc-2"], { step: "document" }));
    spy.mockRestore();
    expect(IDBDatabase.prototype.transaction).toBe(original);
    expect(result).toEqual({ ok: true });
    expect((await loadSessionDraft("s-dead"))!.meta.step).toBe("document");
  });

  it("el primer guardado (sin conexion previa) adopta la conexion para los siguientes", async () => {
    __closeWarmDraftsConnectionForTests();
    await saveSessionDraft(sessionParams("s-adopt"));
    expect(__hasWarmDraftsConnectionForTests()).toBe(true);
  });

  it("con la conexion de vida larga, clearAllDrafts y las demas operaciones siguen funcionando", async () => {
    await saveSessionDraft(sessionParams("s-clear"));
    await warmDraftsConnection();
    await expect(clearAllDrafts()).resolves.toEqual({ ok: true });
    expect(await listSessionDrafts()).toEqual([]);
    await expect(saveSessionDraft(sessionParams("s-clear"))).resolves.toEqual({ ok: true });
    expect(await listSessionDrafts()).toHaveLength(1);
  });
});
