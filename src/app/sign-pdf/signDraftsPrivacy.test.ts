import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignerBlock } from "@/app/sign-pdf/docSet";
import { EMPTY_DOC_STATE, type DocState } from "@/app/sign-pdf/docSet";
import {
  SIGNATURE_DRAFT_TTL_MS,
} from "@/app/sign-pdf/draftPrivacy";
import {
  buildSessionMeta,
  clearAllDrafts,
  draftExists,
  listAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  purgeExpiredDrafts,
  saveDraft,
  saveSessionDraft,
  subscribeToDrafts,
  type SaveDraftParams,
  type SaveSessionParams,
  type SessionDocInput,
} from "@/app/sign-pdf/signDrafts";

/**
 * Privacidad de los borradores con firmas (F0 · U0.4) sobre `fake-indexeddb`: con «guardar las firmas» apagado no hay trazos
 * en la base; con trazos hay fecha de caducidad (7 dias) y la purga quita lo caducado con todos sus bytes; sin trazos no caduca nada.
 */

const DB_NAME = "optimuspdf-sign-drafts";
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T10:00:00.000Z");
const SIGNER = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const STROKE = { dataUrl: "data:image/png;base64,TRAZO-SECRETO", ratio: 0.3 };

function docInput(id: string): SessionDocInput {
  const bytes = new Uint8Array([1, 2, 3, id.length]);
  return {
    id,
    fileName: `${id}.pdf`,
    size: bytes.byteLength,
    state: { ...EMPTY_DOC_STATE } as DocState,
    getBytes: async () => bytes,
  };
}

function signedBlock(overrides: Partial<SignerBlock> = {}): SignerBlock {
  return {
    id: "bk-1",
    signerId: "sg-1",
    appliesTo: ["doc-1", "doc-2"],
    signature: STROKE,
    initials: STROKE,
    stamps: { "doc-1": "huella-1", "doc-2": "huella-2" },
    auto: true,
    ...overrides,
  };
}

function sessionParams(id: string, overrides: Partial<SaveSessionParams> = {}): SaveSessionParams {
  return {
    id,
    mode: "multi",
    signMode: "same",
    signers: [SIGNER],
    blocks: [signedBlock()],
    documents: [docInput("doc-1"), docInput("doc-2")],
    activeDocId: "doc-1",
    step: "sign",
    ceremony: { signerId: "sg-1", stage: "review" },
    ...overrides,
  };
}

function v1Params(id: string, overrides: Partial<SaveDraftParams> = {}): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([9, 9, 9]),
    fileName: `${id}.pdf`,
    manifest: { mode: "multi", signers: [SIGNER], fields: [], textFields: [], textValues: {} },
    step: "sign",
    captures: { "sg-1": { signature: STROKE, initials: null, stamp: "huella" } },
    textFieldsDetectedFor: null,
    ...overrides,
  };
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawAll(store: string): Promise<unknown[]> {
  const db = await openRaw();
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(store, "readonly").objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function rawKeys(store: string): Promise<string[]> {
  const db = await openRaw();
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

/** Todo lo que hay en la base, como texto: si un trazo se colo, aparece aqui. */
async function wholeDatabaseText(): Promise<string> {
  const metas = await rawAll("draftMeta");
  const sessions = await rawAll("sessionMeta");
  return JSON.stringify({ metas, sessions });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  await clearAllDrafts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sin «guardar las firmas»: ningun trazo llega a IndexedDB", () => {
  it("sesion: los bloques salen sin firma, iniciales ni sellos; el resto del trabajo se guarda", async () => {
    const result = await saveSessionDraft(sessionParams("s-off", { keepSignatures: false }));
    expect(result).toEqual({ ok: true });

    expect(await wholeDatabaseText()).not.toContain("TRAZO-SECRETO");
    expect(await wholeDatabaseText()).not.toContain("data:image");
    const [meta] = await listSessionDrafts();
    expect(meta.blocks).toHaveLength(1);
    expect(meta.blocks[0]).toMatchObject({ id: "bk-1", signerId: "sg-1", appliesTo: ["doc-1", "doc-2"], signature: null, initials: null, stamps: {}, auto: true });
    // Todo lo demas, intacto.
    expect(meta.signers).toEqual([SIGNER]);
    expect(meta.documents.map((doc) => doc.fileName)).toEqual(["doc-1.pdf", "doc-2.pdf"]);
    expect(meta.step).toBe("sign");
    expect(meta.signaturesOmitted).toBe(true);
  });

  it("sesion: sin trazos no hay caducidad y el turno guardado se descarta (describia un avance que ya no existe)", async () => {
    await saveSessionDraft(sessionParams("s-off", { keepSignatures: false }));
    const [meta] = await listSessionDrafts();
    expect(meta.expiresAt).toBeUndefined();
    expect(meta.ceremony).toBeUndefined();
  });

  it("sesion: apagado pero sin trazos que quitar no marca nada (no hubo nada omitido) y conserva el turno", async () => {
    await saveSessionDraft(
      sessionParams("s-off", {
        keepSignatures: false,
        blocks: [signedBlock({ signature: null, initials: null, stamps: {} })],
        ceremony: { signerId: "sg-1", stage: "handoff" },
      }),
    );
    const [meta] = await listSessionDrafts();
    expect(meta.signaturesOmitted).toBeUndefined();
    expect(meta.expiresAt).toBeUndefined();
    expect(meta.ceremony).toEqual({ signerId: "sg-1", stage: "handoff" });
  });

  it("documento suelto: las capturas salen vacias, sin fecha de caducidad", async () => {
    await saveDraft(v1Params("doc-v1", { keepSignatures: false }));
    expect(await wholeDatabaseText()).not.toContain("TRAZO-SECRETO");
    const [meta] = await listDrafts();
    expect(meta.captures).toEqual({});
    expect(meta.signaturesOmitted).toBe(true);
    expect(meta.expiresAt).toBeUndefined();
    expect(meta.signers).toEqual([SIGNER]);
  });

  it("el borrador sigue siendo retomable: se carga con sus documentos y sus firmantes", async () => {
    await saveSessionDraft(sessionParams("s-off", { keepSignatures: false }));
    const loaded = await loadSessionDraft("s-off");
    expect(loaded?.files.map((file) => file.fileName)).toEqual(["doc-1.pdf", "doc-2.pdf"]);
    expect(loaded?.meta.signers).toEqual([SIGNER]);
  });

  it("buildSessionMeta (puro): solo `keepSignatures === false` quita trazos; sin decir nada, se conservan", () => {
    const kept = buildSessionMeta(sessionParams("s-x"), T0.toISOString());
    expect(kept.blocks[0].signature).toEqual(STROKE);
    const dropped = buildSessionMeta(sessionParams("s-x", { keepSignatures: false }), T0.toISOString());
    expect(dropped.blocks[0].signature).toBeNull();
    expect(dropped.signaturesOmitted).toBe(true);
  });
});

describe("con «guardar las firmas»: fecha de caducidad a los 7 dias", () => {
  it("sesion con trazos: expiresAt = savedAt + 7 dias, sin marca de omitido", async () => {
    await saveSessionDraft(sessionParams("s-on", { keepSignatures: true }));
    const [meta] = await listSessionDrafts();
    expect(meta.blocks[0].signature).toEqual(STROKE);
    expect(meta.savedAt).toBe(T0.toISOString());
    expect(meta.expiresAt).toBe(new Date(T0.getTime() + SIGNATURE_DRAFT_TTL_MS).toISOString());
    expect(meta.signaturesOmitted).toBeUndefined();
    expect(meta.ceremony).toEqual({ signerId: "sg-1", stage: "review" });
  });

  it("documento suelto con trazos: lo mismo", async () => {
    await saveDraft(v1Params("doc-v1", { keepSignatures: true }));
    const [meta] = await listDrafts();
    expect(meta.captures["sg-1"].signature).toEqual(STROKE);
    expect(meta.expiresAt).toBe(new Date(T0.getTime() + 7 * DAY).toISOString());
  });

  it("un borrador SIN trazos (aunque tenga firmantes y huecos) no lleva fecha de caducidad", async () => {
    await saveSessionDraft(sessionParams("s-plain", { keepSignatures: true, blocks: [signedBlock({ signature: null, initials: null, stamps: {} })] }));
    await saveDraft(v1Params("doc-plain", { keepSignatures: true, captures: {} }));
    expect((await listSessionDrafts())[0].expiresAt).toBeUndefined();
    expect((await listDrafts())[0].expiresAt).toBeUndefined();
  });

  it("cada guardado renueva el plazo (cuenta desde el ultimo guardado)", async () => {
    await saveSessionDraft(sessionParams("s-renew"));
    vi.setSystemTime(new Date(T0.getTime() + 5 * DAY));
    await saveSessionDraft(sessionParams("s-renew"));
    const [meta] = await listSessionDrafts();
    expect(meta.expiresAt).toBe(new Date(T0.getTime() + 12 * DAY).toISOString());
  });
});

describe("la purga de lo caducado", () => {
  it("a los 7 dias menos 1 ms sigue; a los 7 dias exactos ya no esta (sesion y documento suelto, y todos sus bytes)", async () => {
    await saveSessionDraft(sessionParams("s-old"));
    await saveDraft(v1Params("doc-old"));
    expect(await rawKeys("draftFiles")).toEqual(expect.arrayContaining(["doc-old", "s-old/doc-1", "s-old/doc-2"]));

    vi.setSystemTime(new Date(T0.getTime() + 7 * DAY - 1));
    expect((await listAllDrafts()).map((entry) => entry.meta.id).sort()).toEqual(["doc-old", "s-old"]);

    vi.setSystemTime(new Date(T0.getTime() + 7 * DAY));
    expect(await listAllDrafts()).toEqual([]);
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
    // Sin huerfanos: ni los bytes del documento suelto ni los de la sesion siguen ocupando cuota.
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(await wholeDatabaseText()).not.toContain("TRAZO-SECRETO");
  });

  it("solo purga lo caducado: un borrador sin trazos (guardado a la vez) sigue pasados 30 dias", async () => {
    await saveSessionDraft(sessionParams("s-old"));
    await saveSessionDraft(sessionParams("s-plain", { blocks: [], ceremony: undefined }));
    await saveDraft(v1Params("doc-plain", { captures: {} }));

    vi.setSystemTime(new Date(T0.getTime() + 30 * DAY));
    const ids = (await listAllDrafts()).map((entry) => entry.meta.id).sort();
    expect(ids).toEqual(["doc-plain", "s-plain"]);
    expect(await rawKeys("draftFiles")).toEqual(expect.arrayContaining(["doc-plain", "s-plain/doc-1", "s-plain/doc-2"]));
    expect(await rawKeys("draftFiles")).not.toContain("s-old/doc-1");
  });

  it("un borrador renovado por un guardado reciente no caduca con el anterior", async () => {
    await saveSessionDraft(sessionParams("s-live"));
    vi.setSystemTime(new Date(T0.getTime() + 6 * DAY));
    await saveSessionDraft(sessionParams("s-live"));
    vi.setSystemTime(new Date(T0.getTime() + 8 * DAY));
    expect((await listAllDrafts()).map((entry) => entry.meta.id)).toEqual(["s-live"]);
  });

  it("purgeExpiredDrafts devuelve cuantos borro y avisa a los demas solo si borro algo", async () => {
    await saveSessionDraft(sessionParams("s-old"));
    await saveDraft(v1Params("doc-old"));
    const listener = vi.fn();
    const unsubscribe = subscribeToDrafts(listener);
    try {
      listener.mockClear();
      expect(await purgeExpiredDrafts(T0.getTime() + 7 * DAY - 1)).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      expect(await purgeExpiredDrafts(T0.getTime() + 7 * DAY)).toBe(2);
      expect(listener).toHaveBeenCalled();
      expect(await purgeExpiredDrafts(T0.getTime() + 8 * DAY)).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("un borrador caducado ya no se retoma aunque la purga no haya corrido (se borra al intentar cargarlo)", async () => {
    await saveSessionDraft(sessionParams("s-old"));
    await saveDraft(v1Params("doc-old"));
    vi.setSystemTime(new Date(T0.getTime() + 9 * DAY));
    expect(await loadSessionDraft("s-old")).toBeNull();
    expect(await loadDraft("doc-old")).toBeNull();
    expect(await rawKeys("draftFiles")).toEqual([]);
    expect(await rawKeys("sessionMeta")).toEqual([]);
    expect(await rawKeys("draftMeta")).toEqual([]);
  });

  it("las listas sueltas tampoco ofrecen lo caducado (defensa si la purga aun no corrio)", async () => {
    await saveSessionDraft(sessionParams("s-old"));
    await saveDraft(v1Params("doc-old"));
    vi.setSystemTime(new Date(T0.getTime() + 7 * DAY));
    expect(await listSessionDrafts()).toEqual([]);
    expect(await listDrafts()).toEqual([]);
  });

  it("un expiresAt corrupto (no es fecha) se purga, no se queda para siempre", async () => {
    await saveSessionDraft(sessionParams("s-rota"));
    const db = await openRaw();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("sessionMeta", "readwrite");
        const store = tx.objectStore("sessionMeta");
        const get = store.get("s-rota");
        get.onsuccess = () => store.put({ ...(get.result as object), expiresAt: "ayer" });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    expect(await listAllDrafts()).toEqual([]);
    expect(await rawKeys("draftFiles")).toEqual([]);
  });
});

describe("draftExists", () => {
  it("dice si hay borrador de ese tipo y id, y deja de decirlo al borrarse", async () => {
    await saveSessionDraft(sessionParams("s-here"));
    await saveDraft(v1Params("doc-here"));
    expect(await draftExists("session", "s-here")).toBe(true);
    expect(await draftExists("document", "doc-here")).toBe(true);
    expect(await draftExists("session", "doc-here")).toBe(false);
    expect(await draftExists("document", "s-here")).toBe(false);
    expect(await draftExists("session", "otro")).toBe(false);
    await clearAllDrafts();
    expect(await draftExists("session", "s-here")).toBe(false);
  });
});
