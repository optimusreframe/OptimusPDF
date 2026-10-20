/**
 * Baul de firmas local de `/sign-pdf`: firmas e iniciales guardadas en
 * IndexedDB junto con los datos de su firmante, para reutilizarlas en otros
 * documentos. NADA se sube: vive solo en este navegador (ver
 * PrivacyNotice.tsx para el aviso al usuario y el boton "Borrar datos").
 *
 * Base propia (`optimuspdf-signature-vault`), separada de los borradores
 * (`optimuspdf-sign-drafts`): borrar un borrador o su limite de 10 jamas
 * toca el baul, y al reves. Mismo patron que `signDrafts.ts` -- cada
 * operacion abre y cierra la base, y anuncia el cambio por BroadcastChannel
 * para que otras pestañas refresquen su lista.
 *
 * No se guardan colores de firmante ni sellos de documento (`captureStamp`):
 * una firma del baul no esta atada a un documento concreto, solo recuerda
 * en cual se uso (`sourceDocument`, informativo).
 *
 * REGLA DURA igual que `signDrafts.ts`/`recent.ts`: ninguna funcion de aqui
 * lanza hacia la UI. Modo privado (Safari/Firefox bloquean `indexedDB`),
 * cuota agotada o la base bloqueada se devuelven como resultado tipado
 * (`{ ok: false, reason }`) para que la UI pueda decirle al usuario el
 * motivo, nunca como excepcion.
 */

import { noteBackupRelevantChange } from "@/lib/backup/backupReminder";

/** Imagen guardada: bytes PNG crudos (no data URL), mas el tamaño leido. */
export type VaultImage = {
  png: Uint8Array;
  /** alto / ancho, igual que `SignatureCapture.ratio` del compositor. */
  ratio: number;
  width: number;
  height: number;
};

/**
 * Como se creo una firma (informativo, OPCIONAL: las anteriores a este campo no lo traen). `uploaded` = imagen subida
 * por el usuario; `extracted` = sacada de un PDF (Extractor). Misma lista que el modulo «Firmas» del respaldo.
 */
export const VAULT_ORIGINS = ["drawn", "typed", "uploaded", "extracted"] as const;
export type VaultOrigin = (typeof VAULT_ORIGINS)[number];

export function isVaultOrigin(value: unknown): value is VaultOrigin {
  return typeof value === "string" && (VAULT_ORIGINS as readonly string[]).includes(value);
}

export type VaultEntry = {
  id: string;
  schema: 1;
  signerName: string;
  /** `normalizeSignerKey(signerName)`: agrupa y deduplica sin acentos ni mayusculas. */
  signerKey: string;
  role?: string;
  /** Opcional: ausente en las firmas guardadas antes de existir el campo. */
  origin?: VaultOrigin;
  /** Nombre del documento donde se uso/creo por ultima vez. Informativo. */
  sourceDocument: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. Ordena la lista: lo ultimo usado primero. */
  lastUsedAt: string;
  signature: VaultImage | null;
  initials: VaultImage | null;
};

/** Lo que pide guardar quien llama; el baul pone id, fechas y clave. */
export type VaultEntryInput = {
  signerName: string;
  role?: string;
  /** Como se creo; se guarda tal cual si es de la lista (si no, el guardado se rechaza como `invalid`). */
  origin?: VaultOrigin;
  sourceDocument: string;
  signature: VaultImage | null;
  initials: VaultImage | null;
};

export type VaultFailureReason =
  | "limit"
  | "tooLarge"
  | "unavailable"
  | "invalid"
  | "notFound";

/**
 * "limit": baul lleno (30 firmas) o sin espacio (total ~20 MB / cuota).
 * "tooLarge": una imagen individual pasa de 600 KB.
 * "invalid": datos que no son un guardado valido (nombre vacio, PNG falso...).
 * "unavailable": IndexedDB no existe, esta bloqueado o fallo.
 */
export type SaveVaultResult =
  | { ok: true; entry: VaultEntry; duplicate: boolean }
  | { ok: false; reason: "limit" | "tooLarge" | "unavailable" | "invalid" };

/** `entries` siempre existe: vacia cuando `ok` es false. */
export type VaultListResult =
  | { ok: true; entries: VaultEntry[] }
  | { ok: false; reason: "unavailable"; entries: VaultEntry[] };

export type VaultOpResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "notFound" };

export type UpdateVaultResult =
  | { ok: true; entry: VaultEntry }
  | { ok: false; reason: "unavailable" | "notFound" | "invalid" };

export type VaultEntryPatch = {
  signerName?: string;
  /** Cadena vacia = quitar el cargo. `undefined` = no cambia. */
  role?: string;
};

const DB_NAME = "optimuspdf-signature-vault";
const DB_VERSION = 1;
const STORE = "signatures";
const BROADCAST_CHANNEL_NAME = "optimuspdf.signature-vault";
/** Si `indexedDB.open` ni acierta ni falla en este tiempo, se da por no disponible. */
const OPEN_TIMEOUT_MS = 8000;

/** Firmas en el baul antes de rechazar (NO se expulsa en silencio). */
export const MAX_VAULT_ENTRIES = 30;
/** Un PNG individual (firma o iniciales). */
export const MAX_VAULT_IMAGE_BYTES = 600 * 1024;
/** Suma de todos los PNG del baul. */
export const MAX_VAULT_TOTAL_BYTES = 20 * 1024 * 1024;
/** Lado maximo aceptado de un PNG (lo mismo que exige la importacion). */
export const MAX_VAULT_IMAGE_DIMENSION = 4096;
/** Tope de caracteres de nombre / cargo / documento. */
export const MAX_VAULT_TEXT_LENGTH = 200;

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    channel.addEventListener("message", () => {
      for (const listener of listeners) listener();
    });
  }
  return channel;
}

function announceChange(): void {
  try {
    getChannel()?.postMessage("changed");
  } catch {
    // Canal cerrado o no clonable: el aviso entre pestañas es prescindible.
  }
  for (const listener of listeners) listener();
}

/** Para que la UI sepa cuando refrescar su lista (incluida otra pestaña). */
export function subscribeToVault(listener: () => void): () => void {
  listeners.add(listener);
  // Abre el canal ya, para empezar a oir a otras pestañas desde ahora.
  getChannel();
  return () => {
    listeners.delete(listener);
  };
}

/** `true` si este navegador expone IndexedDB (no garantiza que no este bloqueado). */
export function vaultSupported(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Marcas diacriticas combinantes U+0300..U+036F (igual que `slugify`). */
const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Clave de comparacion de un nombre: minusculas, sin acentos, espacios
 * colapsados. Como `slugify` de `lib/pdf/core.ts`, pero SIN descartar las
 * letras no latinas (un nombre en cirilico o chino daria clave vacia y
 * todos colisionarian).
 */
export function normalizeSignerKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Id aleatorio sin `crypto.randomUUID` (no existe en http no seguro). */
function newId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `vault-${hex}`;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TAG = [0x49, 0x48, 0x44, 0x52];
const IHDR_DATA_LENGTH = 13;

function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

/**
 * Lee ancho y alto del chunk IHDR sin canvas (jsdom/Node no decodifican
 * imagenes). Devuelve `null` si la cabecera de 8 bytes no es de un PNG o
 * el primer chunk no es un IHDR completo.
 */
export function readPngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (!isBytes(bytes) || bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  for (let i = 0; i < IHDR_TAG.length; i += 1) {
    if (bytes[12 + i] !== IHDR_TAG[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // El chunk IHDR de un PNG siempre mide 13 bytes de datos: otra longitud es
  // un archivo manipulado (o no es un PNG).
  if (view.getUint32(8) !== IHDR_DATA_LENGTH) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** CRC-32 (el de PNG/zip) de unos bytes. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * `true` si el CRC guardado tras el IHDR coincide con el calculado sobre su
 * tipo y sus 13 bytes de datos. Es barato (17 bytes) y descarta cabeceras
 * manipuladas; solo lo exige la IMPORTACION (los PNG del propio canvas
 * siempre lo traen bien).
 */
export function pngIhdrCrcValid(bytes: Uint8Array): boolean {
  if (!isBytes(bytes) || bytes.length < 33) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return crc32(bytes.subarray(12, 29)) === view.getUint32(29);
}

/** Forma valida de una imagen del baul (no mira el limite de bytes). */
export function isValidVaultImage(value: unknown): value is VaultImage {
  if (typeof value !== "object" || value === null) return false;
  const image = value as Record<string, unknown>;
  if (!isBytes(image.png)) return false;
  if (
    typeof image.ratio !== "number" ||
    !Number.isFinite(image.ratio) ||
    image.ratio <= 0
  ) {
    return false;
  }
  const size = readPngSize(image.png);
  if (!size) return false;
  return (
    image.width === size.width &&
    image.height === size.height &&
    size.width >= 1 &&
    size.height >= 1 &&
    size.width <= MAX_VAULT_IMAGE_DIMENSION &&
    size.height <= MAX_VAULT_IMAGE_DIMENSION
  );
}

const DATA_URL_PREFIX = "data:image/png;base64,";

/** Bytes PNG -> data URL, para pintar la miniatura o alimentar el compositor. */
export function vaultImageToDataUrl(image: VaultImage): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < image.png.length; i += chunk) {
    binary += String.fromCharCode(...image.png.subarray(i, i + chunk));
  }
  return `${DATA_URL_PREFIX}${btoa(binary)}`;
}

/**
 * data URL PNG -> `VaultImage`. `null` si no es un PNG en base64 valido.
 * `ratio` es el del compositor; si no es utilizable se deriva de las
 * dimensiones leidas del IHDR.
 */
export function dataUrlToVaultImage(
  dataUrl: string,
  ratio: number,
): VaultImage | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(DATA_URL_PREFIX)) {
    return null;
  }
  let png: Uint8Array;
  try {
    const binary = atob(dataUrl.slice(DATA_URL_PREFIX.length));
    png = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) png[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  const size = readPngSize(png);
  if (!size || size.width < 1 || size.height < 1) return null;
  const safeRatio =
    Number.isFinite(ratio) && ratio > 0 ? ratio : size.height / size.width;
  return { png, ratio: safeRatio, width: size.width, height: size.height };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    let settled = false;
    // Primero `open` (puede lanzar de forma sincrona); el temporizador
    // despues, para no dejar uno vivo si ya fallo.
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("indexedDB no responde"));
    }, OPEN_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("bySignerKey", "signerKey", { unique: false });
        store.createIndex("byLastUsedAt", "lastUsedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      if (settled) {
        // Llego tarde (ya se dio por no disponible): no dejar la base abierta.
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(request.error ?? new Error("no se pudo abrir indexedDB"));
    };
  });
}

/**
 * Corre `run` dentro de UNA transaccion del unico almacen y resuelve con el
 * valor que `run` fije mediante `setResult` cuando la transaccion termina.
 * Leer-decidir-escribir en una sola transaccion es lo que evita que dos
 * pestañas guardando a la vez superen el limite de entradas.
 */
function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fallback: T,
  run: (store: IDBObjectStore, setResult: (value: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result = fallback;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    run(tx.objectStore(STORE), (value) => {
      result = value;
    });
  });
}

/** Abre, ejecuta y cierra siempre la base. */
async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

/** Registro leido de IndexedDB con la forma minima esperada (descarta basura). Exportada para el respaldo (`lib/backup`). */
export function isStoredEntry(value: unknown): value is VaultEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.schema === 1 &&
    typeof entry.id === "string" &&
    typeof entry.signerName === "string" &&
    typeof entry.signerKey === "string" &&
    typeof entry.sourceDocument === "string" &&
    typeof entry.createdAt === "string" &&
    typeof entry.lastUsedAt === "string" &&
    (entry.role === undefined || typeof entry.role === "string") &&
    (entry.origin === undefined || isVaultOrigin(entry.origin)) &&
    (entry.signature === null || isValidVaultImage(entry.signature)) &&
    (entry.initials === null || isValidVaultImage(entry.initials))
  );
}

function readAll(store: IDBObjectStore, done: (all: VaultEntry[]) => void) {
  const request = store.getAll();
  request.onsuccess = () => {
    const raw = request.result as unknown[];
    done(raw.filter(isStoredEntry));
  };
}

function entryBytes(entry: Pick<VaultEntry, "signature" | "initials">): number {
  return (entry.signature?.png.byteLength ?? 0) + (entry.initials?.png.byteLength ?? 0);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameImage(a: VaultImage | null, b: VaultImage | null): boolean {
  if (a === null || b === null) return a === b;
  return sameBytes(a.png, b.png);
}

/**
 * `a` cubre a `b` cuando cada imagen que `b` trae ya esta en `a` con los
 * mismos bytes (lo que `b` no trae no cuenta). Dos entradas identicas se
 * cubren mutuamente.
 */
function covers(
  a: Pick<VaultEntry, "signature" | "initials">,
  b: Pick<VaultEntry, "signature" | "initials">,
): boolean {
  return (
    (b.signature === null || sameImage(a.signature, b.signature)) &&
    (b.initials === null || sameImage(a.initials, b.initials))
  );
}

/**
 * Marcas de direccion Unicode (LRM/RLM, embebidos y aislados, ALM): no se ven
 * y sirven para disfrazar un nombre (un archivo importado podria colar
 * «Ana\u202Etca»). Se quitan de todo texto que entra en el baul.
 */
export const BIDI_CONTROLS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(BIDI_CONTROLS, "").trim().slice(0, MAX_VAULT_TEXT_LENGTH)
    : "";
}

// ---------------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------------

/** Lo mas usado/guardado recientemente primero. Vacia si IndexedDB no esta. */
export async function listVault(): Promise<VaultListResult> {
  try {
    const entries = await withDb((db) =>
      runTx<VaultEntry[]>(db, "readonly", [], (store, setResult) => {
        readAll(store, (all) => setResult(all));
      }),
    );
    entries.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return { ok: true, entries };
  } catch {
    return { ok: false, reason: "unavailable", entries: [] };
  }
}

export async function getVaultEntry(id: string): Promise<VaultEntry | null> {
  try {
    return await withDb((db) =>
      runTx<VaultEntry | null>(db, "readonly", null, (store, setResult) => {
        const request = store.get(id);
        request.onsuccess = () => {
          setResult(isStoredEntry(request.result) ? request.result : null);
        };
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Guarda una firma/iniciales nuevas. RECHAZA (no expulsa en silencio) al
 * llegar a `MAX_VAULT_ENTRIES`. Si ya existe una entrada con el mismo
 * firmante y los mismos bytes de PNG, no duplica: actualiza `lastUsedAt` y
 * `sourceDocument` de la existente (`duplicate: true`).
 */
export async function saveVaultEntry(
  input: VaultEntryInput,
): Promise<SaveVaultResult> {
  try {
    const signerName = cleanText(input?.signerName);
    const signature = input?.signature ?? null;
    const initials = input?.initials ?? null;
    if (
      !signerName ||
      (typeof input?.signerName === "string" &&
        input.signerName.trim().length > MAX_VAULT_TEXT_LENGTH) ||
      (signature === null && initials === null) ||
      (input.origin !== undefined && !isVaultOrigin(input.origin)) ||
      (signature !== null && !isValidVaultImage(signature)) ||
      (initials !== null && !isValidVaultImage(initials))
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (
      (signature && signature.png.byteLength > MAX_VAULT_IMAGE_BYTES) ||
      (initials && initials.png.byteLength > MAX_VAULT_IMAGE_BYTES)
    ) {
      return { ok: false, reason: "tooLarge" };
    }

    const signerKey = normalizeSignerKey(signerName);
    const role = cleanText(input.role) || undefined;
    const origin = input.origin;
    const sourceDocument = cleanText(input.sourceDocument);
    const now = new Date().toISOString();
    const candidate: VaultEntry = {
      id: newId(),
      schema: 1,
      signerName,
      signerKey,
      ...(role ? { role } : {}),
      ...(origin ? { origin } : {}),
      sourceDocument,
      createdAt: now,
      lastUsedAt: now,
      signature,
      initials,
    };

    const result = await withDb((db) =>
      runTx<SaveVaultResult>(
        db,
        "readwrite",
        { ok: false, reason: "unavailable" },
        (store, setResult) => {
          readAll(store, (all) => {
            const sameSigner = all.filter((entry) => entry.signerKey === signerKey);
            // 1. Ya hay una del mismo firmante que lo CUBRE (mismas imagenes, o
            //    mas): no se duplica, solo se marca como usada.
            const existing = sameSigner.find((entry) =>
              covers(entry, candidate),
            );
            if (existing) {
              const updated: VaultEntry = {
                ...existing,
                lastUsedAt: now,
                sourceDocument: sourceDocument || existing.sourceDocument,
              };
              store.put(updated);
              setResult({ ok: true, entry: updated, duplicate: true });
              return;
            }
            // 2. Lo nuevo AMPLIA a una o mas del mismo firmante (p. ej. firma
            //    sola -> firma + iniciales): se reemplaza en vez de duplicar.
            //    Se conserva el id y la fecha de creacion de la primera.
            const subsumed = sameSigner.filter((entry) => covers(candidate, entry));
            if (subsumed.length > 0) {
              const [first, ...rest] = subsumed;
              const replacedBytes = subsumed.reduce(
                (sum, entry) => sum + entryBytes(entry),
                0,
              );
              const totalBytes = all.reduce((sum, e) => sum + entryBytes(e), 0);
              if (
                totalBytes - replacedBytes + entryBytes(candidate) >
                MAX_VAULT_TOTAL_BYTES
              ) {
                setResult({ ok: false, reason: "limit" });
                return;
              }
              const mergedOrigin = origin ?? first.origin;
              const merged: VaultEntry = {
                ...candidate,
                id: first.id,
                createdAt: first.createdAt,
                ...(role || first.role ? { role: role ?? first.role } : {}),
                // Lo nuevo manda; si no trae `origin`, se conserva el de la entrada que amplia.
                ...(mergedOrigin ? { origin: mergedOrigin } : {}),
                sourceDocument: sourceDocument || first.sourceDocument,
              };
              for (const entry of rest) store.delete(entry.id);
              store.put(merged);
              setResult({ ok: true, entry: merged, duplicate: false });
              return;
            }
            const totalBytes = all.reduce((sum, e) => sum + entryBytes(e), 0);
            if (
              all.length >= MAX_VAULT_ENTRIES ||
              totalBytes + entryBytes(candidate) > MAX_VAULT_TOTAL_BYTES
            ) {
              setResult({ ok: false, reason: "limit" });
              return;
            }
            store.put(candidate);
            setResult({ ok: true, entry: candidate, duplicate: false });
          });
        },
      ),
    );
    if (result.ok) {
      announceChange();
      // U4.7: una firma NUEVA (no repetir una que ya estaba) cuenta para el recordatorio de respaldo.
      if (!result.duplicate) noteBackupRelevantChange();
    }
    return result;
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "limit" : "unavailable" };
  }
}

/** Marca la entrada como recien usada (`lastUsedAt`). */
export async function touchVaultEntry(id: string): Promise<VaultOpResult> {
  try {
    const result = await withDb((db) =>
      runTx<VaultOpResult>(
        db,
        "readwrite",
        { ok: false, reason: "unavailable" },
        (store, setResult) => {
          const request = store.get(id);
          request.onsuccess = () => {
            if (!isStoredEntry(request.result)) {
              setResult({ ok: false, reason: "notFound" });
              return;
            }
            store.put({
              ...request.result,
              lastUsedAt: new Date().toISOString(),
            });
            setResult({ ok: true });
          };
        },
      ),
    );
    if (result.ok) announceChange();
    return result;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Renombra al firmante y/o cambia el cargo. Recalcula `signerKey`. */
export async function updateVaultEntry(
  id: string,
  patch: VaultEntryPatch,
): Promise<UpdateVaultResult> {
  try {
    const rawName = patch?.signerName;
    let nextName: string | undefined;
    if (rawName !== undefined) {
      nextName = cleanText(rawName);
      if (
        !nextName ||
        (typeof rawName === "string" &&
          rawName.trim().length > MAX_VAULT_TEXT_LENGTH)
      ) {
        return { ok: false, reason: "invalid" };
      }
    }
    if (patch?.role !== undefined && typeof patch.role !== "string") {
      return { ok: false, reason: "invalid" };
    }
    const nextRole =
      patch?.role === undefined ? undefined : cleanText(patch.role);

    const result = await withDb((db) =>
      runTx<UpdateVaultResult>(
        db,
        "readwrite",
        { ok: false, reason: "unavailable" },
        (store, setResult) => {
          const request = store.get(id);
          request.onsuccess = () => {
            const current = request.result;
            if (!isStoredEntry(current)) {
              setResult({ ok: false, reason: "notFound" });
              return;
            }
            const { role: currentRole, ...rest } = current;
            const role = nextRole === undefined ? currentRole : nextRole;
            const signerName = nextName ?? current.signerName;
            const updated: VaultEntry = {
              ...rest,
              signerName,
              signerKey: normalizeSignerKey(signerName),
              ...(role ? { role } : {}),
            };
            store.put(updated);
            setResult({ ok: true, entry: updated });
          };
        },
      ),
    );
    if (result.ok) {
      announceChange();
      noteBackupRelevantChange();
    }
    return result;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Idempotente: borrar un id que no existe tambien es `ok`. */
export async function deleteVaultEntry(id: string): Promise<VaultOpResult> {
  try {
    await withDb((db) =>
      runTx<null>(db, "readwrite", null, (store) => {
        store.delete(id);
      }),
    );
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Para "Borrar datos". Async y con resultado a proposito (como
 * `clearAllDrafts`): quien llama espera esto antes de afirmar "Datos
 * borrados"; afirmarlo antes de que termine mentiria si fallara.
 */
export async function clearVault(): Promise<VaultOpResult> {
  try {
    await withDb((db) =>
      runTx<null>(db, "readwrite", null, (store) => {
        store.clear();
      }),
    );
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Importacion en bloque (respaldo)
// ---------------------------------------------------------------------------

export type CommitVaultImportInput = {
  /** Entradas completas a escribir (ya validadas por quien llama; aqui se revalidan). */
  puts: VaultEntry[];
  /** Entradas existentes que se sustituyen (se borran en la MISMA transaccion). */
  deleteIds: string[];
  /**
   * Como estaban, al hacer la vista previa, las entradas que se van a sustituir. Dentro de la MISMA transaccion se
   * compara cada una con la que hay AHORA (nombre, cargo e imagenes; `lastUsedAt` no cuenta): si otra pestaña la
   * cambio (o la borro) mientras el usuario decidia, no se escribe NADA y el resultado es `changed`.
   */
  expectUnchanged?: VaultEntry[];
};

export type CommitVaultImportResult =
  | { ok: true; written: number; skipped: number; deleted: number }
  | { ok: false; reason: "limit" | "tooLarge" | "invalid" | "unavailable" | "changed" };

/** Mismo contenido que importa al usuario: firmante, cargo e imagenes (no las fechas de uso). */
function sameStoredContent(a: VaultEntry, b: VaultEntry): boolean {
  return (
    a.signerName === b.signerName &&
    a.signerKey === b.signerKey &&
    (a.role ?? "") === (b.role ?? "") &&
    sameImage(a.signature, b.signature) &&
    sameImage(a.initials, b.initials)
  );
}

/**
 * Escribe de golpe las entradas de una importacion de respaldo: TODO O NADA.
 * Una sola transaccion lee el baul, comprueba los limites (30 firmas, 20 MB)
 * sobre el resultado final y solo entonces borra/escribe; si algo falla (limite,
 * cuota, base cerrada) la transaccion se aborta o no llega a escribir y el
 * baul queda exactamente como estaba. Una entrada que otra del MISMO firmante
 * ya cubre (mismas imagenes) se omite en vez de duplicarse (`skipped`); un id
 * ya ocupado se reemplaza por uno nuevo. No cambia el esquema ni las demas
 * operaciones del baul.
 */
export async function commitVaultImport(
  input: CommitVaultImportInput,
): Promise<CommitVaultImportResult> {
  try {
    const puts = input?.puts;
    const deleteIds = input?.deleteIds ?? [];
    const expectUnchanged = input?.expectUnchanged ?? [];
    if (
      !Array.isArray(puts) ||
      !Array.isArray(deleteIds) ||
      deleteIds.some((id) => typeof id !== "string") ||
      !Array.isArray(expectUnchanged) ||
      !expectUnchanged.every((entry) => isStoredEntry(entry))
    ) {
      return { ok: false, reason: "invalid" };
    }
    const putIds = new Set<string>();
    for (const entry of puts) {
      if (
        !isStoredEntry(entry) ||
        entry.signerKey !== normalizeSignerKey(entry.signerName) ||
        entry.signerName.length > MAX_VAULT_TEXT_LENGTH ||
        (entry.signature === null && entry.initials === null) ||
        putIds.has(entry.id)
      ) {
        return { ok: false, reason: "invalid" };
      }
      putIds.add(entry.id);
      if (
        (entry.signature && entry.signature.png.byteLength > MAX_VAULT_IMAGE_BYTES) ||
        (entry.initials && entry.initials.png.byteLength > MAX_VAULT_IMAGE_BYTES)
      ) {
        return { ok: false, reason: "tooLarge" };
      }
    }

    const result = await withDb(
      (db) =>
        new Promise<CommitVaultImportResult>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          let outcome: CommitVaultImportResult = { ok: false, reason: "unavailable" };
          let failure: unknown;
          tx.oncomplete = () => resolve(outcome);
          // Si NOSOTROS abortamos por un error de escritura (p. ej. cuota), ese
          // es el motivo: los `error` de las peticiones abortadas llegan antes
          // que el `abort` y no lo saben.
          tx.onerror = () => reject(failure ?? tx.error);
          tx.onabort = () => reject(failure ?? tx.error ?? new Error("transaccion abortada"));
          const store = tx.objectStore(STORE);
          readAll(store, (all) => {
            try {
              // Carrera entre pestañas: lo que se iba a sustituir ya no es lo que vio la vista previa.
              for (const expected of expectUnchanged) {
                const current = all.find((entry) => entry.id === expected.id);
                if (!current || !sameStoredContent(current, expected)) {
                  outcome = { ok: false, reason: "changed" };
                  return;
                }
              }
              const doomed = new Set(deleteIds);
              const pool = all.filter((entry) => !doomed.has(entry.id));
              const toWrite: VaultEntry[] = [];
              let skipped = 0;
              for (const put of puts) {
                const covered = pool.some(
                  (entry) => entry.signerKey === put.signerKey && covers(entry, put),
                );
                if (covered) {
                  skipped += 1;
                  continue;
                }
                const next = pool.some((entry) => entry.id === put.id)
                  ? { ...put, id: newId() }
                  : put;
                toWrite.push(next);
                pool.push(next);
              }
              const totalBytes = pool.reduce((sum, entry) => sum + entryBytes(entry), 0);
              if (pool.length > MAX_VAULT_ENTRIES || totalBytes > MAX_VAULT_TOTAL_BYTES) {
                // Nada escrito todavia: la transaccion termina sin cambios.
                outcome = { ok: false, reason: "limit" };
                return;
              }
              let deleted = 0;
              for (const entry of all) {
                if (doomed.has(entry.id)) {
                  store.delete(entry.id);
                  deleted += 1;
                }
              }
              for (const entry of toWrite) store.put(entry);
              outcome = { ok: true, written: toWrite.length, skipped, deleted };
            } catch (error) {
              failure = error;
              try {
                tx.abort();
              } catch {
                // ya terminada
              }
            }
          });
        }),
    );
    if (result.ok) {
      announceChange();
      if (result.written > 0) noteBackupRelevantChange();
    }
    return result;
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "limit" : "unavailable" };
  }
}
