import type { CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import type {
  LegacyMultiStep,
  MultiStep,
  SignMode,
} from "@/app/sign-pdf/SignToolClient";
import type { SignConfigManifest } from "@/app/sign-pdf/signConfig";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { Signer, SignatureField } from "@/lib/pdf/sign";

/**
 * Borradores locales de `/sign-pdf`, auto-guardados en IndexedDB: el PDF
 * completo + todo el estado de la ronda (firmantes, huecos, capturas,
 * valores de texto). Primer uso de IndexedDB en el repo -- por eso, y por
 * guardar el PDF completo + capturas de firma indefinidamente por
 * defecto, este modulo paso por una revision de arquitectura dedicada
 * antes de escribirse (ver PrivacyNotice.tsx para el aviso al usuario).
 *
 * REGLA DURA igual que `recent.ts`/`valueHistory.ts`: ninguna funcion de
 * aqui puede lanzar hacia la UI. Modo privado (Safari/Firefox bloquean
 * `indexedDB` por completo), cuota agotada, o el navegador expulsando
 * datos bajo presion de almacenamiento -- todo se traga en silencio. El
 * autoguardado es prescindible; la firma nunca debe bloquearse por el.
 */

export type DraftMeta = {
  id: string;
  fileName: string;
  fileSize: number;
  /** ISO 8601. */
  savedAt: string;
  mode: SignMode;
  signers: Signer[];
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /**
   * Paso en el que se dejo el borrador. Al LEER puede venir un valor
   * anterior a W2-A ("fields"/"text"): se normaliza con `migrateStep`
   * en `SignToolClient` al reanudar; al escribir siempre va un paso
   * vigente (`SaveDraftParams.step`). Los datos (huecos, campos, valores)
   * no cambian de formato.
   */
  step: LegacyMultiStep;
  captures: CaptureMap;
  /** Espejo de `SignToolOptions.textFieldsDetectedFor` -- ver ese campo. */
  textFieldsDetectedFor: string | null;
};

type FileRecord = { id: string; bytes: Uint8Array };

const DB_NAME = "optimuspdf-sign-drafts";
const DB_VERSION = 1;
const FILES_STORE = "draftFiles";
const META_STORE = "draftMeta";
const BROADCAST_CHANNEL_NAME = "optimuspdf.sign-drafts";

/** Borradores totales antes de expulsar el mas antiguo. */
export const MAX_DRAFTS = 10;
/** Bytes totales (PDF + capturas) antes de expulsar el mas antiguo. */
export const MAX_DRAFTS_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB

/**
 * Ids para los que ya se escribieron los bytes del PDF EN ESTA PESTAÑA:
 * evita una lectura a IndexedDB en cada autoguardado (el debounce puede
 * disparar docenas de veces mientras alguien rellena campos). Se invalida
 * por completo ante cualquier cambio anunciado por otra pestaña (borrado,
 * expulsion por cuota): mas barato que llevar la cuenta exacta, y nunca
 * miente hacia el lado peligroso (como mucho repite una escritura ya
 * innecesaria, nunca se salta una que hace falta).
 */
const writtenFileIds = new Set<string>();

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.addEventListener("message", () => {
      writtenFileIds.clear();
      for (const listener of listeners) listener();
    });
  }
  return channel;
}

function announceChange(): void {
  getChannel()?.postMessage("changed");
  for (const listener of listeners) listener();
}

/** Para que `DraftsSheet` sepa cuando refrescar su lista (incluida otra pestaña). */
export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getFromStore<T>(
  db: IDBDatabase,
  storeName: string,
  id: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

export type SaveDraftParams = {
  id: string;
  fileBytes: Uint8Array;
  fileName: string;
  manifest: Omit<SignConfigManifest, "version">;
  step: MultiStep;
  captures: CaptureMap;
  textFieldsDetectedFor: string | null;
};

/**
 * Una unica transaccion que abarca ambos almacenes: IndexedDB da
 * atomicidad por transaccion, la unica forma real de garantizar "si hay
 * metadatos, hay bytes" (revision de arquitectura, riesgo de estado a
 * medias tras un fallo de cuota a mitad de guardar). Los bytes del PDF
 * solo se escriben la primera vez que se ve este `id`; los metadatos se
 * reescriben siempre, con la marca de tiempo puesta al vuelo.
 */
function saveDraftTx(db: IDBDatabase, params: SaveDraftParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));

    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);

    const putMeta = () => {
      const meta: DraftMeta = {
        id: params.id,
        fileName: params.fileName,
        fileSize: params.fileBytes.byteLength,
        savedAt: new Date().toISOString(),
        mode: params.manifest.mode,
        signers: params.manifest.signers,
        fields: params.manifest.fields,
        textFields: params.manifest.textFields,
        textValues: params.manifest.textValues,
        step: params.step,
        captures: params.captures,
        textFieldsDetectedFor: params.textFieldsDetectedFor,
      };
      metaStore.put(meta);
    };

    if (writtenFileIds.has(params.id)) {
      putMeta();
      return;
    }
    const existing = filesStore.get(params.id);
    existing.onsuccess = () => {
      if (!existing.result) {
        const record: FileRecord = { id: params.id, bytes: params.fileBytes };
        filesStore.put(record);
      }
      writtenFileIds.add(params.id);
      putMeta();
    };
  });
}

/**
 * Expulsa los borradores mas antiguos por encima de `MAX_DRAFTS` o
 * `MAX_DRAFTS_TOTAL_BYTES`. Borra SIEMPRE de los dos almacenes a la vez
 * (nunca deja bytes huerfanos consumiendo cuota sin un borrador que los
 * referencie).
 */
async function enforceDraftBudget(db: IDBDatabase): Promise<void> {
  const metas = await getAllFromStore<DraftMeta>(db, META_STORE);
  const oldestFirst = [...metas].sort((a, b) =>
    a.savedAt.localeCompare(b.savedAt),
  );

  let totalBytes = oldestFirst.reduce((sum, meta) => sum + meta.fileSize, 0);
  const toEvict: string[] = [];
  while (
    oldestFirst.length - toEvict.length > MAX_DRAFTS ||
    totalBytes > MAX_DRAFTS_TOTAL_BYTES
  ) {
    const next = oldestFirst[toEvict.length];
    if (!next) break;
    toEvict.push(next.id);
    totalBytes -= next.fileSize;
  }
  if (toEvict.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);
    for (const id of toEvict) {
      filesStore.delete(id);
      metaStore.delete(id);
      writtenFileIds.delete(id);
    }
  });
}

export async function saveDraft(params: SaveDraftParams): Promise<void> {
  try {
    const db = await openDb();
    try {
      await saveDraftTx(db, params);
      await enforceDraftBudget(db);
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Ver la nota de "REGLA DURA" arriba: nunca interrumpe la firma.
  }
}

export async function listDrafts(): Promise<DraftMeta[]> {
  try {
    const db = await openDb();
    try {
      const metas = await getAllFromStore<DraftMeta>(db, META_STORE);
      return metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export type LoadedDraft = { meta: DraftMeta; bytes: Uint8Array };

/**
 * Si los metadatos existen pero los bytes no (expulsados por otra
 * pestaña, o el navegador liberando cuota bajo presion), el borrador no
 * se puede reanudar: se limpia la entrada huerfana en vez de devolver un
 * estado a medias.
 */
export async function loadDraft(id: string): Promise<LoadedDraft | null> {
  try {
    const db = await openDb();
    try {
      const meta = await getFromStore<DraftMeta>(db, META_STORE, id);
      if (!meta) return null;
      const fileRecord = await getFromStore<FileRecord>(db, FILES_STORE, id);
      if (!fileRecord) {
        await deleteDraftTx(db, id);
        return null;
      }
      return { meta, bytes: fileRecord.bytes };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function deleteDraftTx(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(FILES_STORE).delete(id);
    tx.objectStore(META_STORE).delete(id);
  });
}

export async function deleteDraft(id: string): Promise<void> {
  try {
    const db = await openDb();
    try {
      await deleteDraftTx(db, id);
      writtenFileIds.delete(id);
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Tolerado.
  }
}

/**
 * Async a proposito (a diferencia de `clearValueHistory`, sincrono):
 * IndexedDB es asincrono por naturaleza, y quien llama (`PrivacyNotice`)
 * espera esto antes de afirmar "Datos borrados" -- afirmarlo antes de
 * que la operacion termine mentiria si fallara.
 */
export async function clearAllDrafts(): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(FILES_STORE).clear();
        tx.objectStore(META_STORE).clear();
      });
      writtenFileIds.clear();
    } finally {
      db.close();
    }
    announceChange();
  } catch {
    // Tolerado.
  }
}
