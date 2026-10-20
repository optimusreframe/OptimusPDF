import type { CaptureMap } from "@/app/sign-pdf/SigningCeremony";
import type { CeremonyState } from "@/app/sign-pdf/blockModel";
import type {
  DocState,
  SignMode as BlockSignMode,
  SignerBlock,
} from "@/app/sign-pdf/docSet";
import type {
  LegacyMultiStep,
  MultiStep,
  SignMode,
} from "@/app/sign-pdf/SignToolClient";
import type { SignConfigManifest } from "@/app/sign-pdf/signConfig";
import {
  blocksHaveStrokes,
  capturesHaveStrokes,
  expiryFor,
  isExpired,
  withoutBlockStrokes,
  withoutCaptureStrokes,
} from "@/app/sign-pdf/draftPrivacy";
import { newDocumentDraftId, newSessionCopyId, newTabId } from "@/app/sign-pdf/draftIds";
import { readSignaturesInDraft } from "@/app/sign-pdf/signFeatureFlags";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { TextEdit } from "@/lib/pdf/editTypes";
import type { Signer, SignatureField } from "@/lib/pdf/sign";

/**
 * Borradores locales de `/sign-pdf`, auto-guardados en IndexedDB: el PDF
 * completo + todo el estado de la ronda (firmantes, huecos, capturas,
 * valores de texto). Primer uso de IndexedDB en el repo -- por eso, y por
 * guardar el PDF completo + capturas de firma indefinidamente por
 * defecto, este modulo paso por una revision de arquitectura dedicada
 * antes de escribirse (ver PrivacyNotice.tsx para el aviso al usuario).
 *
 * Wave 4 (U5): con VARIOS documentos el borrador es uno POR SESION
 * (`sessionMeta` + `draftFiles` con clave `sessionId/docId`), no uno por
 * documento; la sesion entera cuenta como UN borrador (su tamano es la suma
 * de los PDF). Con UN documento se sigue guardando el formato de siempre
 * (`draftMeta`), y los borradores v1 se siguen leyendo tal cual.
 *
 * REGLA DURA igual que `recent.ts`/`valueHistory.ts`: ninguna funcion de
 * aqui puede lanzar hacia la UI. Modo privado (Safari/Firefox bloquean
 * `indexedDB` por completo), cuota agotada, otra pestaña aun en la version
 * anterior de la base, o el navegador expulsando datos bajo presion de
 * almacenamiento -- todo se traga en silencio. El autoguardado es
 * prescindible; la firma nunca debe bloquearse por el.
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
  /** Texto original editado (W6-A). Ausente en borradores anteriores. Al leer, pasa por `sanitizeTextEdits`. */
  textEdits?: TextEdit[];
  /**
   * Cuando caduca (ISO 8601): solo un borrador CON trazos de firma lo lleva (7 dias despues de guardarse, U0.4). Ausente =
   * no caduca. Lo purgan `listAllDrafts` y la apertura de la herramienta.
   */
  expiresAt?: string;
  /** Se guardo con el ajuste «guardar las firmas» apagado Y habia trazos que dejar fuera: al retomarlo se piden de nuevo. */
  signaturesOmitted?: true;
  /**
   * Huella SHA-256 (hexadecimal) del PDF. Desde F0-fix el `id` de un borrador de documento suelto es UNICO POR SESION (dos
   * clientes con la misma plantilla no se pisan) y la huella vive aqui: es lo que usa la oferta «Retomar lo que tenias».
   * Un borrador anterior no la lleva: entonces su `id` ES la huella (`draftFingerprint`).
   */
  fingerprint?: string;
  /** Contador de version: sube en cada guardado. Ver `isStaleWrite`. Ausente = 0 (borrador anterior). */
  rev?: number;
  /** La pestana que hizo el ultimo guardado (`tabWriterId`). */
  writerId?: string;
  /** Este borrador es la copia que una pestana guardo aparte porque otra habia modificado el original: id del original. */
  copyOf?: string;
};

/** Un documento de un borrador de sesion (los bytes viven en `draftFiles`). */
export type SessionDocMeta = {
  /** Id del documento DENTRO de la sesion guardada (no es el `DocId` vivo: ese cambia al recargar). */
  id: string;
  fileName: string;
  fileSize: number;
};

/**
 * Borrador de una ronda con VARIOS documentos. `blocks` lleva los trazos y
 * los sellos tal cual; `docStates` el estado de cada documento (huecos,
 * campos, valores...). Todos los ids de documento son los guardados
 * (`SessionDocMeta.id`).
 */
export type SessionDraftMeta = {
  kind: "session";
  id: string;
  /** ISO 8601. */
  savedAt: string;
  /** "Solo yo" / "Varios firmantes" (el borrador solo se guarda en "multi"). */
  mode: SignMode;
  /** "Mismas" o "distintas" firmas por documento. */
  signMode: BlockSignMode;
  signers: Signer[];
  blocks: SignerBlock[];
  /** Documentos en el orden de la cola. */
  documents: SessionDocMeta[];
  docStates: Record<string, DocState>;
  activeDocId: string | null;
  step: LegacyMultiStep;
  /**
   * Turno de la ceremonia (de quien es y en que etapa) al guardar. Ausente en borradores
   * anteriores: se deriva del primer firmante pendiente. Al leer pasa por `sanitizeCeremony`.
   */
  ceremony?: CeremonyState;
  /** Orden de los turnos de la ceremonia por bloques (ids de firmante); ausente = el de la lista de firmantes. */
  turnOrder?: string[];
  /** Suma de los PDF: es lo que cuenta para el presupuesto. */
  fileSize: number;
  /** Nombre del primer documento (resumen para listas simples). */
  fileName: string;
  documentCount: number;
  /** Ver `DraftMeta.expiresAt`. */
  expiresAt?: string;
  /** Ver `DraftMeta.signaturesOmitted`. */
  signaturesOmitted?: true;
  /** Ver `DraftMeta.rev`. */
  rev?: number;
  /** Ver `DraftMeta.writerId`. */
  writerId?: string;
  /** Ver `DraftMeta.copyOf`. */
  copyOf?: string;
};

/** La huella del PDF de un borrador de documento suelto: la guardada o, en un borrador anterior, su propio id. */
export function draftFingerprint(meta: Pick<DraftMeta, "id" | "fingerprint">): string {
  return meta.fingerprint ?? meta.id;
}

/** Lo que muestra la hoja de borradores: un documento suelto (v1) o una sesion. */
export type DraftEntry =
  | { kind: "document"; meta: DraftMeta }
  | { kind: "session"; meta: SessionDraftMeta };

type FileRecord = { id: string; bytes: Uint8Array };

const DB_NAME = "optimuspdf-sign-drafts";
const DB_VERSION = 2;
const FILES_STORE = "draftFiles";
const META_STORE = "draftMeta";
const SESSION_STORE = "sessionMeta";
const BROADCAST_CHANNEL_NAME = "optimuspdf.sign-drafts";

/** Borradores totales (una sesion cuenta como UNO) antes de expulsar el mas antiguo. */
export const MAX_DRAFTS = 10;
/** Bytes totales (PDF + capturas) antes de expulsar el mas antiguo. */
export const MAX_DRAFTS_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB
/** Una sesion que pesa mas que esto no se guarda como borrador. */
export const MAX_SESSION_DRAFT_BYTES = 150 * 1024 * 1024; // 150 MB

/**
 * Ids para los que ya se escribieron los bytes del PDF EN ESTA PESTAÑA:
 * evita una lectura a IndexedDB en cada autoguardado (el debounce puede
 * disparar docenas de veces mientras alguien rellena campos). Se invalida
 * por completo ante cualquier cambio anunciado por otra pestaña (borrado,
 * expulsion por cuota): mas barato que llevar la cuenta exacta, y nunca
 * miente hacia el lado peligroso (como mucho repite una escritura ya
 * innecesaria, nunca se salta una que hace falta). Solo para borradores v1;
 * los de sesion consultan las claves existentes en cada guardado.
 */
const writtenFileIds = new Set<string>();

/**
 * Borradores v1 que ESTA pestaña ha guardado (y no ha borrado). Sirve para
 * retirar el borrador de un documento suelto cuando la ronda pasa a tener
 * varios y su sesion lo sustituye -- sin tocar jamas un borrador del mismo PDF
 * que viniera de otra ronda u otra pestaña.
 */
const savedDraftIdsHere = new Set<string>();

export function wasDraftSavedHere(id: string): boolean {
  return savedDraftIdsHere.has(id);
}

/* ------------------------------------------------------------------ *
 * Control de concurrencia entre pestañas (F0-fix, D1)
 * ------------------------------------------------------------------ */

/**
 * Dos pestañas pueden tener abierta la MISMA sesion (retomada con `?s=`, o la misma pagina duplicada). Sin version, la
 * ultima en escribir gana y la pestaña vieja pisaba el trabajo de la nueva (una ronda de 4 firmas volvia a 2). Cada
 * borrador lleva ahora un contador `rev` y el `writerId` de la pestaña que lo escribio; cada pestaña recuerda la `rev`
 * que cargo o escribio por ultima vez (`knownRevs`). Al guardar, DENTRO de la misma transaccion, se compara:
 * si lo guardado lo escribio OTRA pestaña con una `rev` mayor que la que esta conoce, NO se pisa (`isStaleWrite`) y esta
 * pestaña guarda su copia como borrador aparte. Una sola pestaña nunca se compite a si misma (mismo `writerId`).
 */
type TabState = {
  id: string;
  knownRevs: Map<string, number>;
  /**
   * Lo que esta pestaña LEYO al restaurar cada borrador (`contentKeyOf`), mientras no lo haya modificado: un guardado cuyo
   * contenido es identico a eso no escribe nada (F0-fix2, N3). Se retira en cuanto esta pestaña escribe o borra ese borrador.
   */
  restored: Map<string, string>;
};
let tab: TabState = { id: newTabId(), knownRevs: new Map(), restored: new Map() };

/** El id de esta pestaña (el `writerId` de lo que escribe). */
export function tabWriterId(): string {
  return tab.id;
}

/** La version del borrador que esta pestaña cargo o escribio por ultima vez (0 = no la conoce). */
export function knownDraftRev(id: string): number {
  return tab.knownRevs.get(id) ?? 0;
}

function noteRev(id: string, rev: number): void {
  if (rev > knownDraftRev(id)) tab.knownRevs.set(id, rev);
}

/* ------------------------------------------------------------------ *
 * Restaurar no es editar (F0-fix2, N3)
 * ------------------------------------------------------------------ */

/**
 * Abrir o restaurar un borrador en una pestaña (la misma sesion en otra pestaña, «Retomar», `?s=`) montaba el autoguardado, y
 * el autoguardado escribia lo que acababa de leer: `rev` + 1 y `writerId` nuevo SIN que la persona cambiara nada. La pestaña
 * que ya estaba abierta con esa sesion quedaba «desactualizada» y su siguiente cambio REAL terminaba en una «Copia aparte».
 *
 * Regla: lo que una pestaña acaba de leer no se reescribe. Al cargar un borrador se recuerda una huella estable de su
 * contenido (`contentKeyOf`: JSON con las claves ordenadas, sin fechas ni version); un guardado cuyo contenido tiene esa misma
 * huella no escribe nada (`unchanged`). La primera edicion REAL cambia la huella, escribe (con la comprobacion de version de
 * siempre, D1) y deja de aplicarse la excepcion. Si lo que hay guardado ya cambio mientras tanto (otra pestaña), tampoco se
 * pisa ni se le anota a esta pestaña como «visto»: su siguiente cambio real forkea, como antes.
 */
const VOLATILE_META_KEYS: ReadonlySet<string> = new Set(["savedAt", "expiresAt", "rev", "writerId", "copyOf"]);

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const body = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const item = (value as Record<string, unknown>)[key];
      return item === undefined ? [] : [`${JSON.stringify(key)}:${stableStringify(item)}`];
    });
  return `{${body.join(",")}}`;
}

/** Huella estable del CONTENIDO de un borrador: sin fecha de guardado, caducidad, version, autor ni «copia de». */
function contentKeyOf(meta: object): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!VOLATILE_META_KEYS.has(key)) content[key] = value;
  }
  return stableStringify(content);
}

function noteRestored(id: string, meta: object): void {
  tab.restored.set(id, contentKeyOf(meta));
}

/**
 * ¿Lo que hay guardado es una version MAS NUEVA, escrita por OTRA pestaña, que esta no ha visto? Entonces escribir encima
 * la pisaria. Un borrador anterior (sin `rev` ni `writerId`) nunca cuenta: se sobrescribe como siempre.
 */
export function isStaleWrite(
  stored: { rev?: unknown; writerId?: unknown } | null | undefined,
  knownRev: number,
  writerId: string,
): boolean {
  if (typeof stored !== "object" || stored === null) return false;
  if (stored.writerId === writerId) return false;
  const rev = typeof stored.rev === "number" ? stored.rev : 0;
  return rev > knownRev;
}

/** Solo para tests: una «pestaña» distinta (otro id y su propia memoria de versiones) dentro del mismo proceso. */
export type DraftsTab = TabState;
export function __createTabForTests(id: string = newTabId()): DraftsTab {
  return { id, knownRevs: new Map(), restored: new Map() };
}
/** Solo para tests: hace de esta «pestaña» la actual. Devuelve la anterior. */
export function __useTabForTests(next: DraftsTab): DraftsTab {
  const previous = tab;
  tab = next;
  return previous;
}

/* ------------------------------------------------------------------ *
 * Avisos entre pestañas
 * ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let signalsReady = false;
/** Clave de `localStorage` por la que se avisa cuando no hay `BroadcastChannel` (Safari anterior a 15.4): evento `storage`. */
const SIGNAL_STORAGE_KEY = "optimuspdf.sign-drafts.signal";

/** Lo que otra pestaña escribio: la que guardo `id`, con que version. */
export type RemoteDraftWrite = { id: string; rev: number; writerId: string };
const remoteWriteListeners = new Set<(write: RemoteDraftWrite) => void>();

function parseWriteSignal(raw: unknown): RemoteDraftWrite | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, id, rev, writerId } = raw as Record<string, unknown>;
  if (type !== "write" || typeof id !== "string" || typeof rev !== "number" || typeof writerId !== "string") {
    return null;
  }
  return { id, rev, writerId };
}

function handleSignal(raw: unknown): void {
  writtenFileIds.clear();
  const write = parseWriteSignal(raw);
  if (write && write.writerId !== tab.id) {
    for (const listener of [...remoteWriteListeners]) listener(write);
  }
  for (const listener of [...listeners]) listener();
}

/** Empieza a escuchar a las demas pestañas (una sola vez): `BroadcastChannel` o, sin el, el evento `storage`. */
function ensureSignals(): void {
  if (signalsReady) return;
  signalsReady = true;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      channel.addEventListener("message", (event) => handleSignal(event.data));
      return;
    } catch {
      channel = null;
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== SIGNAL_STORAGE_KEY || !event.newValue) return;
      try {
        handleSignal((JSON.parse(event.newValue) as { m?: unknown }).m);
      } catch {
        // Un aviso ilegible no le importa a nadie.
      }
    });
  }
}

function postSignal(message: unknown): void {
  ensureSignals();
  if (channel) {
    try {
      channel.postMessage(message);
    } catch {
      // Canal cerrado: nadie a quien avisar.
    }
    return;
  }
  try {
    // El evento `storage` solo salta si el valor cambia: el azar lo garantiza.
    window.localStorage.setItem(SIGNAL_STORAGE_KEY, JSON.stringify({ m: message, n: Math.random() }));
  } catch {
    // Sin `localStorage` (modo privado muy estricto): sin aviso entre pestañas, nada mas.
  }
}

/** Avisa de que cambio algo. Con `write` dice ademas que borrador se guardo y con que version (para detectar versiones nuevas). */
function announceChange(write?: { id: string; rev: number }): void {
  postSignal(write ? { type: "write", id: write.id, rev: write.rev, writerId: tab.id } : "changed");
  for (const listener of [...listeners]) listener();
}

/** Para que `DraftsSheet` sepa cuando refrescar su lista (incluida otra pestaña). */
export function subscribeToDrafts(listener: () => void): () => void {
  listeners.add(listener);
  ensureSignals();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Para saber que OTRA pestaña acaba de guardar un borrador (y con que version): quien tiene abierta esa misma sesion se
 * entera de que hay una version mas nueva antes de pisarla. No avisa de las escrituras de esta pestaña.
 */
export function subscribeToRemoteDraftWrites(listener: (write: RemoteDraftWrite) => void): () => void {
  remoteWriteListeners.add(listener);
  ensureSignals();
  return () => {
    remoteWriteListeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ *
 * Apertura de la base (v2) y convivencia con otra pestaña en v1
 * ------------------------------------------------------------------ */

/**
 * Cuanto se espera, como mucho, a que se pueda subir la base a v2. Otra pestaña
 * con la version anterior abierta (y sin cerrarla) bloquea la subida (`blocked`);
 * las demas peticiones de apertura quedan ENCOLADAS detras de la bloqueada y ni
 * siquiera llegan a recibir ese evento, por eso el plazo cuenta desde que se pide
 * la conexion, no desde `blocked`. Pasado el plazo la operacion se abandona en
 * silencio (el autoguardado es prescindible) en vez de quedarse colgada; si la
 * apertura se completa mas tarde, su conexion se cierra sola.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 4000;
const DEFAULT_BLOCKED_TIMEOUT_MS = 2000;
let openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;
let blockedTimeoutMs = DEFAULT_BLOCKED_TIMEOUT_MS;

/** Solo para tests: acorta los plazos de apertura y de `onblocked`. */
export function __setDraftsBlockedTimeoutForTests(ms: number): void {
  openTimeoutMs = ms;
  blockedTimeoutMs = ms;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      reject(new Error("indexedDB no disponible"));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const giveUp = (reason: string, delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(reason));
      }, delay);
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    giveUp("la base de borradores tarda demasiado en abrirse", openTimeoutMs);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Condicional por almacen: sube de v1 (dos almacenes) sin tocar lo que
      // ya hay, y una base recien creada recibe los tres.
      if (!db.objectStoreNames.contains(FILES_STORE)) {
        db.createObjectStore(FILES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    };
    // Otra pestaña mantiene abierta la version anterior y no la cierra: se
    // le da un plazo mas corto; si no la cierra, esta operacion se abandona.
    request.onblocked = () => {
      if (!settled) {
        giveUp("base de borradores bloqueada por otra pestaña", blockedTimeoutMs);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Si una pestaña mas nueva pide subir la version, esta conexion se
      // aparta (las nuestras son de vida corta): nunca bloquea a otras.
      db.onversionchange = () => db.close();
      if (timer) clearTimeout(timer);
      if (settled) {
        // La operacion ya se abandono por el plazo: no dejar la conexion abierta.
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    request.onerror = () => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(request.error);
    };
  });
}

/**
 * Conexion de vida larga SOLO para guardar sesiones. Abrir la base es asincrono
 * y un volcado en `pagehide` no puede esperarlo (la pagina se esta descargando):
 * con la conexion ya abierta, la escritura arranca en la misma pasada sincrona.
 * Se aparta sola si otra pestaña pide subir la version (`onversionchange`) o el
 * navegador la cierra (`onclose`), de modo que nunca bloquea una migracion ni se
 * queda con un manejador muerto.
 */
let warmDb: IDBDatabase | null = null;
let warming: Promise<void> | null = null;

function dropWarm(db: IDBDatabase): void {
  if (warmDb === db) warmDb = null;
  try {
    db.close();
  } catch {
    // Ya cerrada.
  }
}

/** Adopta `db` como conexion de vida larga (si no hay otra). Devuelve si quedo adoptada. */
function adoptWarm(db: IDBDatabase): boolean {
  if (warmDb) return false;
  warmDb = db;
  db.onversionchange = () => dropWarm(db);
  db.onclose = () => {
    if (warmDb === db) warmDb = null;
  };
  return true;
}

/**
 * Deja abierta la conexion de guardado de sesiones para que el primer volcado
 * (incluido el de `pagehide`) no tenga que esperar a `openDb`. Idempotente y
 * silencioso: si no se puede abrir, el guardado sigue por el camino normal.
 */
export function warmDraftsConnection(): Promise<void> {
  if (warmDb) return Promise.resolve();
  warming ??= openDb()
    .then((db) => {
      if (!adoptWarm(db)) db.close();
    })
    .catch(() => {})
    .finally(() => {
      warming = null;
    });
  return warming;
}

/** Solo para tests: cierra y olvida la conexion de vida larga. */
export function __closeWarmDraftsConnectionForTests(): void {
  if (warmDb) dropWarm(warmDb);
}

/** Solo para tests: hay una conexion de vida larga abierta. */
export function __hasWarmDraftsConnectionForTests(): boolean {
  return warmDb !== null;
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

function getKeysFromStore(
  db: IDBDatabase,
  storeName: string,
  range?: IDBKeyRange,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAllKeys(range);
    request.onsuccess = () => resolve(request.result as string[]);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------------------------------------------ *
 * Borrador de UN documento (formato v1, sin cambios)
 * ------------------------------------------------------------------ */

export type SaveDraftParams = {
  id: string;
  /**
   * Huella SHA-256 del PDF. Desde F0-fix el `id` de un documento suelto es unico por sesion de trabajo y la huella viaja
   * aparte. Ausente (llamadas anteriores, pruebas) = el `id` ES la huella, como siempre.
   */
  fingerprint?: string;
  fileBytes: Uint8Array;
  fileName: string;
  manifest: Omit<SignConfigManifest, "version">;
  step: MultiStep;
  captures: CaptureMap;
  textFieldsDetectedFor: string | null;
  /** Texto original editado (W6-A); vacio/ausente = ninguno. */
  textEdits?: readonly TextEdit[];
  /**
   * ¿Se guardan tambien los trazos de las firmas recogidas? Ausente = lo que diga el ajuste «Guardar tambien las firmas»
   * en el momento de escribir. `false` deja `captures` vacio y no pone fecha de caducidad (no hay firmas que caduquen).
   */
  keepSignatures?: boolean;
};

type DraftWriteInfo = {
  /** El id bajo el que quedo guardado (el pedido, o el de la copia aparte si otra pestaña tenia una version mas nueva). */
  id: string;
  rev: number;
  /** Se guardo como copia aparte: id del borrador que NO se piso. */
  forkedFrom?: string;
  /** No se escribio nada: el contenido es el que esta pestaña acababa de restaurar (F0-fix2, N3). */
  unchanged?: true;
};

/**
 * Una unica transaccion que abarca ambos almacenes: IndexedDB da
 * atomicidad por transaccion, la unica forma real de garantizar "si hay
 * metadatos, hay bytes" (revision de arquitectura, riesgo de estado a
 * medias tras un fallo de cuota a mitad de guardar). Los bytes del PDF
 * solo se escriben la primera vez que se ve este `id`; los metadatos se
 * reescriben siempre, con la marca de tiempo puesta al vuelo.
 *
 * Primero lee lo que hay guardado bajo ese `id` y lo compara con lo que esta pestaña conoce (`isStaleWrite`, F0-fix D1):
 * si otra pestaña lo modifico despues, NO lo pisa y escribe la copia (bytes incluidos) bajo un id nuevo.
 */
function saveDraftTx(db: IDBDatabase, params: SaveDraftParams): Promise<DraftWriteInfo> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    let info: DraftWriteInfo = { id: params.id, rev: 1 };
    tx.oncomplete = () => resolve(info);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));

    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const fingerprint = params.fingerprint ?? params.id;

    const storedRequest = metaStore.get(params.id);
    storedRequest.onsuccess = () => {
      const stored = storedRequest.result as DraftMeta | undefined;
      const stale = isStaleWrite(stored, knownDraftRev(params.id), tab.id);
      const targetId = stale ? newDocumentDraftId(fingerprint) : params.id;
      const rev = stale ? 1 : Math.max(stored?.rev ?? 0, knownDraftRev(params.id)) + 1;
      const copyOf = stale ? params.id : stored?.copyOf;
      info = { id: targetId, rev, ...(stale ? { forkedFrom: params.id } : {}) };

      const buildMeta = (): DraftMeta => {
        const savedAt = new Date().toISOString();
        const kept = params.keepSignatures ?? readSignaturesInDraft();
        // Sin «guardar las firmas», los trazos no llegan a IndexedDB: se retiran justo antes de escribir.
        const { captures, stripped } = kept
          ? { captures: params.captures, stripped: false }
          : withoutCaptureStrokes(params.captures);
        return {
          id: targetId,
          fingerprint,
          fileName: params.fileName,
          fileSize: params.fileBytes.byteLength,
          savedAt,
          mode: params.manifest.mode,
          signers: params.manifest.signers,
          fields: params.manifest.fields,
          textFields: params.manifest.textFields,
          textValues: params.manifest.textValues,
          step: params.step,
          captures,
          textFieldsDetectedFor: params.textFieldsDetectedFor,
          ...(params.textEdits && params.textEdits.length > 0
            ? { textEdits: [...params.textEdits] }
            : {}),
          ...(capturesHaveStrokes(captures) ? { expiresAt: expiryFor(savedAt) } : {}),
          ...(stripped ? { signaturesOmitted: true as const } : {}),
          rev,
          writerId: tab.id,
          ...(copyOf ? { copyOf } : {}),
        };
      };
      const putMeta = () => {
        metaStore.put(buildMeta());
      };

      // Restaurado y sin tocar (F0-fix2, N3): nada que escribir. Solo si lo guardado sigue ahi con sus bytes.
      const baseline = stale ? undefined : tab.restored.get(params.id);
      const unchangedCandidate = baseline !== undefined && stored !== undefined && contentKeyOf(buildMeta()) === baseline;

      if (!stale && writtenFileIds.has(targetId) && !unchangedCandidate) {
        putMeta();
        return;
      }
      const existing = filesStore.get(targetId);
      existing.onsuccess = () => {
        if (unchangedCandidate && existing.result) {
          info = { id: params.id, rev: stored?.rev ?? 0, unchanged: true };
          return;
        }
        if (!existing.result) {
          const record: FileRecord = { id: targetId, bytes: params.fileBytes };
          filesStore.put(record);
        }
        writtenFileIds.add(targetId);
        putMeta();
      };
    };
  });
}

/** Clave de los bytes de un documento de una sesion: `sessionId/docId`. */
export function sessionFileKey(sessionId: string, docId: string): string {
  return `${sessionId}/${docId}`;
}

/** Todas las claves de archivo de una sesion (`sessionId/...`). */
function sessionKeyRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${sessionId}/`, `${sessionId}/￿`);
}

/** El id de sesion al que pertenece una clave de archivo, o `null` si es de un borrador v1. */
function sessionIdOfFileKey(key: string): string | null {
  const slash = key.indexOf("/");
  return slash < 0 ? null : key.slice(0, slash);
}

type BudgetEntry = {
  kind: "document" | "session";
  id: string;
  savedAt: string;
  bytes: number;
};

/**
 * Expulsa los borradores mas antiguos por encima de `MAX_DRAFTS` o
 * `MAX_DRAFTS_TOTAL_BYTES` (una sesion cuenta como UN borrador, con la suma de
 * sus PDF como tamano). Nunca expulsa `protectedId` (el que se acaba de
 * guardar: una sesion no puede borrarse a si misma). Borra SIEMPRE los bytes
 * junto con los metadatos -- una sesion expulsada pierde todos sus archivos --
 * y barre cualquier archivo huerfano (sin borrador que lo referencie), de modo
 * que nunca queda nada consumiendo cuota. Todo en UNA transaccion: otra
 * pestaña no puede ver (ni producir) un estado a medias.
 */
function enforceDraftBudget(db: IDBDatabase, protectedId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE, SESSION_STORE], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    const filesStore = tx.objectStore(FILES_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const sessionStore = tx.objectStore(SESSION_STORE);

    const metasRequest = metaStore.getAll();
    const sessionsRequest = sessionStore.getAll();
    const keysRequest = filesStore.getAllKeys();
    let pending = 3;
    const onRead = () => {
      pending -= 1;
      if (pending > 0) return;

      const metas = metasRequest.result as DraftMeta[];
      const sessionRows = sessionsRequest.result as unknown[];
      const sessions = sessionRows.filter(isSessionDraftMeta);
      // Filas corruptas (no pasan la validacion): nadie las puede retomar ni
      // listar y consumirian cuota para siempre. Se purgan; sus archivos
      // `sessionId/*` caen en el barrido de huerfanos de mas abajo.
      for (const row of sessionRows) {
        if (!isSessionDraftMeta(row) && isRecord(row) && typeof row.id === "string") {
          sessionStore.delete(row.id);
        }
      }
      const entries: BudgetEntry[] = [
        ...metas.map<BudgetEntry>((meta) => ({
          kind: "document",
          id: meta.id,
          savedAt: meta.savedAt,
          bytes: meta.fileSize,
        })),
        ...sessions.map<BudgetEntry>((meta) => ({
          kind: "session",
          id: meta.id,
          savedAt: meta.savedAt,
          bytes: meta.fileSize,
        })),
      ];
      const oldestFirst = entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));

      let totalBytes = oldestFirst.reduce((sum, entry) => sum + entry.bytes, 0);
      let count = oldestFirst.length;
      const evicted = new Set<BudgetEntry>();
      for (const entry of oldestFirst) {
        if (count <= MAX_DRAFTS && totalBytes <= MAX_DRAFTS_TOTAL_BYTES) break;
        if (entry.id === protectedId) continue;
        evicted.add(entry);
        count -= 1;
        totalBytes -= entry.bytes;
      }

      const keptDocuments = new Set<string>();
      const keptSessions = new Set<string>();
      for (const entry of oldestFirst) {
        if (evicted.has(entry)) {
          if (entry.kind === "document") {
            metaStore.delete(entry.id);
            writtenFileIds.delete(entry.id);
          } else {
            sessionStore.delete(entry.id);
          }
        } else if (entry.kind === "document") {
          keptDocuments.add(entry.id);
        } else {
          keptSessions.add(entry.id);
        }
      }

      // Cada archivo se queda solo si hay un borrador vivo que lo reclame.
      for (const key of keysRequest.result as string[]) {
        const sessionId = sessionIdOfFileKey(key);
        const alive =
          sessionId === null ? keptDocuments.has(key) : keptSessions.has(sessionId);
        if (!alive) {
          filesStore.delete(key);
          if (sessionId === null) writtenFileIds.delete(key);
        }
      }
    };
    metasRequest.onsuccess = onRead;
    sessionsRequest.onsuccess = onRead;
    keysRequest.onsuccess = onRead;
  });
}

/** Lo que dice `saveDraft`: guardado, guardado como copia aparte (otra pestaña tenia una version mas nueva) o no se pudo. */
export type SaveDraftResult =
  | { ok: true; forkedTo?: string; unchanged?: true }
  | { ok: false; reason: "unavailable" };

/**
 * Guarda (o actualiza) el borrador de UN documento. Nunca lanza (ver «REGLA DURA»), pero INFORMA: `{ ok: false }` si no se
 * pudo guardar (cuota llena, almacenamiento bloqueado, base no disponible...) para que la interfaz no diga «guardado»
 * cuando no lo esta; `{ ok: true, forkedTo }` si otra pestaña tenia una version mas nueva y esta se guardo aparte.
 */
export async function saveDraft(params: SaveDraftParams): Promise<SaveDraftResult> {
  try {
    const db = await openDb();
    let info: DraftWriteInfo;
    try {
      info = await saveDraftTx(db, params);
      savedDraftIdsHere.add(info.id);
      if (info.unchanged) return { ok: true, unchanged: true };
      noteRev(info.id, info.rev);
      // Esta pestaña ya modifico el borrador: lo que restauro dejo de ser la referencia.
      tab.restored.delete(params.id);
      tab.restored.delete(info.id);
      try {
        await enforceDraftBudget(db, info.id);
      } catch {
        // El presupuesto es limpieza: lo guardado ya esta guardado.
      }
    } finally {
      db.close();
    }
    announceChange({ id: info.id, rev: info.rev });
    return info.forkedFrom ? { ok: true, forkedTo: info.id } : { ok: true };
  } catch {
    // Ver la nota de "REGLA DURA" arriba: nunca interrumpe la firma.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Un borrador CON trazos de firma caduca a los 7 dias de guardarse (`expiresAt`, U0.4). Los guardados ANTES de que
 * existiera esa regla no llevan fecha y, sin esto, no caducarian nunca aunque el aviso prometa «7 dias» (F0-fix, D4): la
 * primera vez que se listan o se abren se les asigna `savedAt + 7 dias` y se guarda. Devuelve el MISMO objeto si no hay
 * nada que asignar (sin trazos, o ya con fecha).
 */
export function withLegacyExpiry<T extends { savedAt: string; expiresAt?: string }>(meta: T, hasStrokes: boolean): T {
  if (meta.expiresAt !== undefined || !hasStrokes) return meta;
  return { ...meta, expiresAt: expiryFor(meta.savedAt) };
}

const documentHasStrokes = (meta: DraftMeta): boolean => capturesHaveStrokes(meta.captures);
const sessionHasStrokes = (meta: SessionDraftMeta): boolean => blocksHaveStrokes(meta.blocks);

/** Guarda la fecha asignada por `withLegacyExpiry` SIN tocar `rev` ni `writerId` y solo si nadie la cambio mientras tanto. Nunca lanza. */
async function persistLegacyExpiry(
  db: IDBDatabase,
  storeName: string,
  stamped: { id: string; savedAt: string; expiresAt?: string },
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
      const store = tx.objectStore(storeName);
      const request = store.get(stamped.id);
      request.onsuccess = () => {
        const current = request.result as { savedAt?: string; expiresAt?: string } | undefined;
        // Si entretanto se guardo otra version (otra fecha) o ya tiene caducidad, no se toca.
        if (!current || current.expiresAt !== undefined || current.savedAt !== stamped.savedAt) return;
        store.put({ ...current, expiresAt: stamped.expiresAt });
      };
    });
  } catch {
    // Se vuelve a calcular la proxima vez: nada se pierde.
  }
}

/** Borradores de UN documento (v1), del mas reciente al mas antiguo. Las sesiones: `listSessionDrafts` / `listAllDrafts`. */
export async function listDrafts(): Promise<DraftMeta[]> {
  try {
    const db = await openDb();
    try {
      const metas = await getAllFromStore<DraftMeta>(db, META_STORE);
      // Un borrador caducado no se ofrece aunque aun no se haya purgado (la purga es `purgeExpiredDrafts`); uno con firmas
      // y sin fecha (anterior a U0.4) caduca a los 7 dias de guardarse.
      const now = Date.now();
      return metas
        .map((meta) => withLegacyExpiry(meta, documentHasStrokes(meta)))
        .filter((meta) => !isExpired(meta, now))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
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
      const stored = await getFromStore<DraftMeta>(db, META_STORE, id);
      if (!stored) return null;
      const meta = withLegacyExpiry(stored, documentHasStrokes(stored));
      // Caducado: no se retoma, y se borra (con sus bytes) en vez de dejarlo esperando a la proxima purga.
      if (isExpired(meta, Date.now())) {
        await deleteDraftTx(db, id);
        writtenFileIds.delete(id);
        forgetSavedDraft(id);
        announceChange();
        return null;
      }
      const fileRecord = await getFromStore<FileRecord>(db, FILES_STORE, id);
      if (!fileRecord) {
        await deleteDraftTx(db, id);
        return null;
      }
      if (meta !== stored) await persistLegacyExpiry(db, META_STORE, meta);
      // Esta pestaña parte de ESTA version: lo que otra pestaña guarde despues ya no se pisara a ciegas.
      noteRev(id, meta.rev ?? 0);
      noteRestored(id, meta);
      return { meta, bytes: fileRecord.bytes };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function forgetSavedDraft(id: string): void {
  savedDraftIdsHere.delete(id);
}

/**
 * Borra un borrador v1 (metadatos y bytes) en una transaccion. Con `unlessNewer`, solo si esta pestaña no esta
 * desactualizada respecto a lo guardado (`isStaleWrite`): una pestaña vieja que decide «ya no hay nada que guardar» no
 * puede borrar lo que otra pestaña guardo despues. Devuelve si lo borro.
 */
function deleteDraftTx(db: IDBDatabase, id: string, unlessNewer = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, META_STORE], "readwrite");
    let deleted = false;
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    const remove = () => {
      deleted = true;
      tx.objectStore(FILES_STORE).delete(id);
      tx.objectStore(META_STORE).delete(id);
    };
    if (!unlessNewer) {
      remove();
      return;
    }
    const stored = tx.objectStore(META_STORE).get(id);
    stored.onsuccess = () => {
      if (!isStaleWrite(stored.result, knownDraftRev(id), tab.id)) remove();
    };
  });
}

export async function deleteDraft(id: string, options: { unlessNewer?: boolean } = {}): Promise<void> {
  try {
    const db = await openDb();
    let deleted = false;
    try {
      deleted = await deleteDraftTx(db, id, options.unlessNewer === true);
      if (deleted) {
        writtenFileIds.delete(id);
        forgetSavedDraft(id);
        tab.restored.delete(id);
      }
    } finally {
      db.close();
    }
    if (deleted) announceChange();
  } catch {
    // Tolerado.
  }
}

/* ------------------------------------------------------------------ *
 * Borrador de SESION (varios documentos)
 * ------------------------------------------------------------------ */

/** Un documento a guardar: sus bytes se leen solo si todavia no estan en la base. */
export type SessionDocInput = {
  /** Id del documento dentro de la sesion guardada (estable entre guardados). */
  id: string;
  fileName: string;
  size: number;
  state: DocState;
  getBytes: () => Promise<Uint8Array>;
};

export type SaveSessionParams = {
  id: string;
  mode: SignMode;
  signMode: BlockSignMode;
  signers: Signer[];
  blocks: SignerBlock[];
  /** En el orden de la cola. */
  documents: SessionDocInput[];
  activeDocId: string | null;
  step: MultiStep;
  /** Turno de la ceremonia; ausente = sin turno guardado. */
  ceremony?: CeremonyState;
  /** Orden de los turnos (ids de firmante); ausente = el de la lista de firmantes. */
  turnOrder?: string[];
  /** Ver `SaveDraftParams.keepSignatures`: `false` deja los bloques sin trazos ni sellos (y sin turno guardado). */
  keepSignatures?: boolean;
  /**
   * Se consulta justo antes de escribir (y tras leer los bytes): `false` =
   * este guardado ya lo reemplazo otro mas nuevo (o un borrado) y no debe
   * escribir nada. Evita que un volcado tardio resucite un estado dejado atras.
   */
  isCurrent?: () => boolean;
};

/**
 * Resultado de guardar una sesion. `ok: false` con `tooBig` (no cabe) o `unavailable` (cuota llena, almacenamiento
 * bloqueado, base no disponible... cualquier fallo de escritura): en ambos casos el trabajo NO esta guardado y la interfaz
 * no puede decir que lo esta. `superseded` no es un fallo: lo reemplazo un guardado mas nuevo. `forkedTo` = otra pestaña
 * habia guardado una version mas nueva de esta sesion y esta se guardo aparte bajo ese id (F0-fix, D1).
 */
export type SaveSessionResult =
  | { ok: true; forkedTo?: string; unchanged?: true }
  | { ok: false; reason: "tooBig" | "unavailable" | "superseded" };

/** Version y autor de un guardado (`buildSessionMeta`). */
export type SessionWriteStamp = { rev: number; writerId: string; copyOf?: string };

/** Los metadatos que se persisten (sin bytes ni funciones). Puro: lo reutilizan los tests. */
export function buildSessionMeta(
  params: SaveSessionParams,
  savedAt: string = new Date().toISOString(),
  stamp?: SessionWriteStamp,
): SessionDraftMeta {
  const docStates: Record<string, DocState> = {};
  for (const doc of params.documents) docStates[doc.id] = doc.state;
  // Sin «guardar las firmas», los bloques salen sin trazos ni sellos. Y el turno que se guardo describia un avance que ya
  // no existe en el borrador (quien ya firmo vuelve a estar pendiente): se deriva de nuevo al retomar.
  const { blocks, stripped } =
    params.keepSignatures === false
      ? withoutBlockStrokes(params.blocks)
      : { blocks: params.blocks, stripped: false };
  return {
    kind: "session",
    id: params.id,
    savedAt,
    mode: params.mode,
    signMode: params.signMode,
    signers: params.signers,
    blocks,
    documents: params.documents.map((doc) => ({
      id: doc.id,
      fileName: doc.fileName,
      fileSize: doc.size,
    })),
    docStates,
    activeDocId: params.activeDocId,
    step: params.step,
    ...(params.ceremony && !stripped ? { ceremony: params.ceremony } : {}),
    ...(params.turnOrder && params.turnOrder.length > 0 ? { turnOrder: params.turnOrder } : {}),
    fileSize: params.documents.reduce((sum, doc) => sum + doc.size, 0),
    fileName: params.documents[0]?.fileName ?? "",
    documentCount: params.documents.length,
    ...(blocksHaveStrokes(blocks) ? { expiresAt: expiryFor(savedAt) } : {}),
    ...(stripped ? { signaturesOmitted: true as const } : {}),
    ...(stamp
      ? { rev: stamp.rev, writerId: stamp.writerId, ...(stamp.copyOf ? { copyOf: stamp.copyOf } : {}) }
      : {}),
  };
}

/** Suma de bytes de los documentos de la sesion. */
export function sessionBytes(documents: readonly { size: number }[]): number {
  return documents.reduce((sum, doc) => sum + doc.size, 0);
}

type WriteOutcome = "ok" | "retry";

/**
 * Lo que una escritura de sesion va decidiendo entre intentos: si otra pestaña tenia una version mas nueva (`forkId` = el
 * id de la copia aparte donde escribir) y con que version quedo lo guardado.
 */
type SessionWriteState = { forkId?: string; forkedFrom?: string; rev?: number; unchanged?: boolean };

/**
 * Escribe la sesion en UNA transaccion: borra los archivos de documentos que
 * ya no estan, anade los que faltan y reescribe los metadatos. Las claves que
 * existen se leen DENTRO de esta misma transaccion de escritura (no de una
 * lectura anterior): asi, si otra pestaña guardo la misma sesion entre medias,
 * sus archivos sobrantes tambien se borran y no queda ningun huerfano dentro de
 * una sesion viva. Si un archivo que se daba por presente ha desaparecido (otra
 * pestaña lo expulso) aborta TODO y pide reintentar leyendo los bytes de nuevo:
 * nunca quedan metadatos apuntando a bytes que no existen.
 *
 * Tambien lee, en la misma transaccion, el borrador que hay ahora bajo este id: si otra pestaña lo guardo con una version
 * que esta no ha visto (`isStaleWrite`), NO lo pisa: aborta sin escribir nada, deja en `state.forkId` el id de una copia
 * aparte y pide reintentar (el reintento escribe la sesion entera, bytes incluidos, bajo ese id nuevo).
 */
function writeSessionTx(
  db: IDBDatabase,
  params: SaveSessionParams,
  loaded: ReadonlyMap<string, Uint8Array>,
  state: SessionWriteState,
): Promise<WriteOutcome> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, SESSION_STORE], "readwrite");
    let needRetry = false;
    tx.oncomplete = () => resolve("ok");
    tx.onerror = () => {
      if (!needRetry) reject(tx.error);
    };
    tx.onabort = () =>
      needRetry ? resolve("retry") : reject(tx.error ?? new Error("transaccion abortada"));

    const filesStore = tx.objectStore(FILES_STORE);
    const sessionStore = tx.objectStore(SESSION_STORE);
    const wanted = new Set(params.documents.map((doc) => sessionFileKey(params.id, doc.id)));

    // La version guardada se pide ANTES que las claves: las peticiones de una transaccion se atienden en orden, asi que ya
    // esta leida cuando llegan las claves. Una copia aparte (id nuevo) no tiene nada que comparar.
    const storedRequest = state.forkId ? null : sessionStore.get(params.id);
    const current = filesStore.getAllKeys(sessionKeyRange(params.id));
    current.onsuccess = () => {
      const storedRow: unknown = storedRequest?.result;
      const stored = isSessionDraftMeta(storedRow) ? storedRow : undefined;
      const present = new Set(current.result as string[]);
      // Restaurado y sin tocar (F0-fix2, N3): ni metadatos ni archivos que escribir. Solo si lo guardado sigue ahi entero.
      const baseline = state.forkId ? undefined : tab.restored.get(params.id);
      if (
        baseline !== undefined &&
        stored &&
        present.size === wanted.size &&
        [...wanted].every((key) => present.has(key)) &&
        contentKeyOf(buildSessionMeta(params)) === baseline
      ) {
        state.unchanged = true;
        return;
      }
      if (storedRequest && isStaleWrite(storedRow as { rev?: unknown; writerId?: unknown } | undefined, knownDraftRev(params.id), tab.id)) {
        state.forkId = newSessionCopyId();
        state.forkedFrom = params.id;
        needRetry = true;
        tx.abort();
        return;
      }
      for (const key of present) {
        if (!wanted.has(key)) filesStore.delete(key);
      }
      for (const key of wanted) {
        const bytes = loaded.get(key);
        if (bytes) {
          const record: FileRecord = { id: key, bytes };
          filesStore.put(record);
        } else if (!present.has(key)) {
          needRetry = true;
          tx.abort();
          return;
        }
      }
      const rev = state.forkId ? 1 : Math.max(stored?.rev ?? 0, knownDraftRev(params.id)) + 1;
      state.rev = rev;
      const copyOf = state.forkId ? state.forkedFrom : stored?.copyOf;
      sessionStore.put(
        buildSessionMeta(params, undefined, { rev, writerId: tab.id, ...(copyOf ? { copyOf } : {}) }),
      );
    };
  });
}

/**
 * Guarda (o actualiza) el borrador de una sesion. Una sesion que pasa de
 * `MAX_SESSION_DRAFT_BYTES` no se guarda: devuelve `tooBig` para que la
 * interfaz avise con amabilidad (lo ya guardado de esa sesion no se toca).
 * Nunca lanza, pero SIEMPRE dice como fue: `ok: false` si no se pudo escribir por
 * cualquier motivo (F0-fix, D2), para que la interfaz no afirme que esta guardado.
 */
export async function saveSessionDraft(
  requested: SaveSessionParams,
): Promise<SaveSessionResult> {
  // El ajuste «guardar las firmas» se lee AQUI, al escribir (no al agendar): lo que diga en este instante es lo que manda.
  const params: SaveSessionParams = {
    ...requested,
    keepSignatures: requested.keepSignatures ?? readSignaturesInDraft(),
  };
  if (sessionBytes(params.documents) > MAX_SESSION_DRAFT_BYTES) {
    return { ok: false, reason: "tooBig" };
  }
  const state: SessionWriteState = {};
  /** Lo que se escribio de verdad: el id (el pedido o el de la copia aparte) y su version. */
  const written = (): { id: string; rev: number } => ({ id: state.forkId ?? params.id, rev: state.rev ?? 1 });
  const succeeded = (): SaveSessionResult => {
    // Nada escrito (F0-fix2, N3): ni version nueva, ni aviso a otras pestañas, ni «visto» de lo que otra pestaña haya guardado.
    if (state.unchanged) return { ok: true, unchanged: true };
    const { id, rev } = written();
    noteRev(id, rev);
    // Esta pestaña ya modifico el borrador: lo que restauro dejo de ser la referencia.
    tab.restored.delete(params.id);
    tab.restored.delete(id);
    announceChange({ id, rev });
    return state.forkId ? { ok: true, forkedTo: state.forkId } : { ok: true };
  };

  // CAMINO RAPIDO. Con una conexion ya abierta, la transaccion se CREA aqui, en
  // esta misma pasada sincrona, sin ninguna espera antes: es lo unico que
  // sobrevive de forma fiable a un `pagehide` (durante la descarga de la pagina
  // el navegador mata las promesas pendientes, pero una transaccion ya lanzada
  // al proceso de IndexedDB se completa). Solo reescribe los metadatos y sincroniza
  // la lista de archivos; si falta algun archivo (documento nuevo) aborta sin
  // escribir nada y se sigue por el camino lento, que lee los bytes que falten.
  const warm = warmDb;
  if (warm && (!params.isCurrent || params.isCurrent())) {
    let fast: WriteOutcome | null = null;
    try {
      fast = await writeSessionTx(warm, params, new Map(), state);
    } catch {
      dropWarm(warm);
    }
    if (fast === "ok") {
      if (!state.unchanged) {
        try {
          await enforceDraftBudget(warm, written().id);
        } catch {
          // El presupuesto es limpieza: lo guardado ya esta guardado.
        }
      }
      return succeeded();
    }
  }

  try {
    const db = warmDb ?? (await openDb());
    const adopted = db === warmDb || adoptWarm(db);
    try {
      let outcome: WriteOutcome = "retry";
      for (let attempt = 0; attempt < 3 && outcome === "retry"; attempt += 1) {
        // Con una version mas nueva de otra pestaña, se escribe la COPIA (id nuevo, todos los bytes).
        const target: SaveSessionParams = state.forkId ? { ...params, id: state.forkId } : params;
        const existing = new Set(
          await getKeysFromStore(db, FILES_STORE, sessionKeyRange(target.id)),
        );
        const loaded = new Map<string, Uint8Array>();
        for (const doc of target.documents) {
          const key = sessionFileKey(target.id, doc.id);
          // Primer intento: solo lo que falta. Tras un reintento, todo: no
          // se fia de nada de lo que "estaba".
          if (attempt === 0 && existing.has(key)) continue;
          loaded.set(key, await doc.getBytes());
        }
        if (params.isCurrent && !params.isCurrent()) {
          return { ok: false, reason: "superseded" };
        }
        outcome = await writeSessionTx(db, target, loaded, state);
      }
      if (outcome !== "ok") return { ok: false, reason: "unavailable" };
      if (!state.unchanged) {
        try {
          await enforceDraftBudget(db, written().id);
        } catch {
          // El presupuesto es limpieza: lo guardado ya esta guardado.
        }
      }
    } finally {
      if (!adopted) db.close();
    }
    return succeeded();
  } catch {
    // Ver la nota de "REGLA DURA" arriba: nunca interrumpe la firma.
    return { ok: false, reason: "unavailable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Forma minima de un borrador de sesion: lo que viene de IndexedDB no se da por bueno. */
export function isSessionDraftMeta(value: unknown): value is SessionDraftMeta {
  if (!isRecord(value)) return false;
  if (value.kind !== "session") return false;
  if (typeof value.id !== "string" || typeof value.savedAt !== "string") return false;
  if (value.signMode !== "same" && value.signMode !== "independent") return false;
  if (typeof value.step !== "string") return false;
  if (typeof value.fileSize !== "number") return false;
  if (!Array.isArray(value.signers)) return false;
  if (
    !Array.isArray(value.documents) ||
    !value.documents.every(
      (doc) =>
        isRecord(doc) &&
        typeof doc.id === "string" &&
        typeof doc.fileName === "string" &&
        typeof doc.fileSize === "number",
    )
  ) {
    return false;
  }
  if (!isRecord(value.docStates)) return false;
  // Sin `blocks` (un borrador anterior al modelo de bloques) se migra al restaurar.
  if (value.blocks !== undefined) {
    if (
      !Array.isArray(value.blocks) ||
      !value.blocks.every(
        (block) =>
          isRecord(block) &&
          typeof block.id === "string" &&
          typeof block.signerId === "string" &&
          Array.isArray(block.appliesTo) &&
          isRecord(block.stamps),
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function listSessionDrafts(): Promise<SessionDraftMeta[]> {
  try {
    const db = await openDb();
    try {
      const metas = await getAllFromStore<unknown>(db, SESSION_STORE);
      const now = Date.now();
      return metas
        .filter(isSessionDraftMeta)
        .map((meta) => withLegacyExpiry(meta, sessionHasStrokes(meta)))
        .filter((meta) => !isExpired(meta, now))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Sesiones y borradores v1 juntos, del mas reciente al mas antiguo. Antes de listar purga los caducados (borradores con
 * firmas guardadas de hace mas de 7 dias, U0.4): quien lista (la tarjeta de entrada, «Ver borradores», Recientes, `?s=`)
 * nunca ve ni ofrece uno que ya no deberia existir.
 */
export async function listAllDrafts(): Promise<DraftEntry[]> {
  await purgeExpiredDrafts();
  const [documents, sessions] = await Promise.all([
    listDrafts(),
    listSessionDrafts(),
  ]);
  const entries: DraftEntry[] = [
    ...documents.map<DraftEntry>((meta) => ({ kind: "document", meta })),
    ...sessions.map<DraftEntry>((meta) => ({ kind: "session", meta })),
  ];
  return entries.sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
}

export type LoadedSessionDraft = {
  meta: SessionDraftMeta;
  /** En el orden de `meta.documents`. */
  files: { id: string; fileName: string; bytes: Uint8Array }[];
};

/** Borra una sesion (metadatos y todos sus archivos). Con `unlessNewer`, solo si esta pestaña no esta desactualizada (ver `deleteDraftTx`). */
function deleteSessionTx(db: IDBDatabase, id: string, unlessNewer = false): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_STORE, SESSION_STORE], "readwrite");
    let deleted = false;
    tx.oncomplete = () => resolve(deleted);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
    const remove = () => {
      deleted = true;
      tx.objectStore(FILES_STORE).delete(sessionKeyRange(id));
      tx.objectStore(SESSION_STORE).delete(id);
    };
    if (!unlessNewer) {
      remove();
      return;
    }
    const stored = tx.objectStore(SESSION_STORE).get(id);
    stored.onsuccess = () => {
      if (!isStaleWrite(stored.result, knownDraftRev(id), tab.id)) remove();
    };
  });
}

/**
 * Lee una sesion con los bytes de TODOS sus documentos. Si falta alguno
 * (expulsado por otra pestaña o por el navegador) la sesion no se puede
 * retomar entera: se limpia lo que quedaba en vez de devolver una ronda con
 * documentos de menos.
 */
export async function loadSessionDraft(
  id: string,
): Promise<LoadedSessionDraft | null> {
  try {
    const db = await openDb();
    try {
      const row = await getFromStore<unknown>(db, SESSION_STORE, id);
      if (!isSessionDraftMeta(row)) return null;
      // Una sesion con firmas y sin fecha (anterior a U0.4) caduca a los 7 dias de guardarse (F0-fix, D4).
      const meta = withLegacyExpiry(row, sessionHasStrokes(row));
      // Caducada: no se retoma, y se borra entera (archivos incluidos).
      if (isExpired(meta, Date.now())) {
        await deleteSessionTx(db, id);
        announceChange();
        return null;
      }
      const files: LoadedSessionDraft["files"] = [];
      for (const doc of meta.documents) {
        const record = await getFromStore<FileRecord>(
          db,
          FILES_STORE,
          sessionFileKey(id, doc.id),
        );
        if (!record) {
          await deleteSessionTx(db, id);
          return null;
        }
        files.push({ id: doc.id, fileName: doc.fileName, bytes: record.bytes });
      }
      if (meta !== row) await persistLegacyExpiry(db, SESSION_STORE, meta);
      // Esta pestaña parte de ESTA version: lo que otra pestaña guarde despues ya no se pisara a ciegas.
      noteRev(id, meta.rev ?? 0);
      noteRestored(id, meta);
      return { meta, files };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function deleteSessionDraft(id: string, options: { unlessNewer?: boolean } = {}): Promise<void> {
  try {
    const db = await openDb();
    let deleted = false;
    try {
      deleted = await deleteSessionTx(db, id, options.unlessNewer === true);
      if (deleted) tab.restored.delete(id);
    } finally {
      db.close();
    }
    if (deleted) announceChange();
  } catch {
    // Tolerado.
  }
}

/**
 * Borra los borradores caducados (con firmas guardadas de hace mas de 7 dias) con todos sus bytes, en UNA transaccion, y
 * avisa a los demas suscriptores si quito alguno. Devuelve cuantos borro. Nunca lanza (sin IndexedDB, 0). Los borradores
 * SIN firmas no se tocan (no caducan). Un borrador CON firmas guardado antes de que existiera la caducidad (sin `expiresAt`)
 * recibe aqui su fecha, `savedAt` + 7 dias, y se guarda: el aviso «se borran a los 7 dias» tiene que ser cierto tambien
 * para ellos (F0-fix, D4).
 */
export async function purgeExpiredDrafts(now: number = Date.now()): Promise<number> {
  try {
    const db = await openDb();
    try {
      const removed = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction([FILES_STORE, META_STORE, SESSION_STORE], "readwrite");
        let count = 0;
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
        const filesStore = tx.objectStore(FILES_STORE);
        const metaStore = tx.objectStore(META_STORE);
        const sessionStore = tx.objectStore(SESSION_STORE);
        const metasRequest = metaStore.getAll();
        const sessionsRequest = sessionStore.getAll();
        let pending = 2;
        const onRead = () => {
          pending -= 1;
          if (pending > 0) return;
          for (const stored of metasRequest.result as DraftMeta[]) {
            // Un borrador con firmas y sin fecha de caducidad (anterior a U0.4) la recibe aqui: `savedAt` + 7 dias (F0-fix, D4).
            // Si ya paso, caduca de inmediato; si no, se guarda la fecha (sin tocar `rev` ni `writerId`).
            const meta = withLegacyExpiry(stored, documentHasStrokes(stored));
            if (isExpired(meta, now)) {
              metaStore.delete(meta.id);
              filesStore.delete(meta.id);
              writtenFileIds.delete(meta.id);
              forgetSavedDraft(meta.id);
              count += 1;
            } else if (meta !== stored) {
              metaStore.put(meta);
            }
          }
          for (const row of sessionsRequest.result as unknown[]) {
            if (!isSessionDraftMeta(row)) continue;
            const meta = withLegacyExpiry(row, sessionHasStrokes(row));
            if (isExpired(meta, now)) {
              sessionStore.delete(meta.id);
              filesStore.delete(sessionKeyRange(meta.id));
              count += 1;
            } else if (meta !== row) {
              sessionStore.put(meta);
            }
          }
        };
        metasRequest.onsuccess = onRead;
        sessionsRequest.onsuccess = onRead;
      });
      if (removed > 0) announceChange();
      return removed;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/** Lo que dice `stripSignaturesFromDrafts`: cuantos borradores de sesion y de documento suelto llevaban firmas y ya no, o que no se pudo. */
export type StripSignaturesResult =
  | { ok: true; sessions: number; documents: number }
  | { ok: false; reason: "unavailable" };

/**
 * «Quitar ahora las firmas de los borradores guardados» (F0-fix2, N2). Apagar «Guardar tambien las firmas recogidas» solo
 * afecta a lo que se guarda DESDE ENTONCES: los borradores ya guardados conservan sus trazos hasta que caducan (7 dias). Esto
 * los quita ya, de TODOS los borradores (sesiones y documentos sueltos), en UNA transaccion: reescribe cada uno
 * conservando todo menos los trazos (`withoutBlockStrokes` / `withoutCaptureStrokes`), sin caducidad, marcado como
 * `signaturesOmitted` (al retomarlo se piden las firmas de nuevo) y, en las sesiones, sin el turno guardado (describia un
 * avance que ya no existe, igual que al guardar con el interruptor apagado). Los PDF no se tocan.
 *
 * Respeta la version: NO sube `rev`, no cambia `writerId` ni `savedAt` (como la fecha de `withLegacyExpiry`): no es un guardado
 * de esta pestaña, y asi ninguna otra queda «desactualizada» ni acaba guardando una «Copia aparte» solo porque se limpiaron
 * firmas. Lee y escribe cada fila DENTRO de la misma transaccion, asi que un guardado concurrente de otra pestaña no se pierde.
 * Los borradores sin firmas no se reescriben. Nunca lanza: si no se pudo, `{ ok: false }`.
 */
export async function stripSignaturesFromDrafts(): Promise<StripSignaturesResult> {
  try {
    const db = await openDb();
    try {
      const counts = await new Promise<{ sessions: number; documents: number }>((resolve, reject) => {
        const tx = db.transaction([META_STORE, SESSION_STORE], "readwrite");
        const counted = { sessions: 0, documents: 0 };
        tx.oncomplete = () => resolve(counted);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
        const metaStore = tx.objectStore(META_STORE);
        const sessionStore = tx.objectStore(SESSION_STORE);
        const metasRequest = metaStore.getAll();
        const sessionsRequest = sessionStore.getAll();
        let pending = 2;
        const onRead = () => {
          pending -= 1;
          if (pending > 0) return;
          for (const stored of metasRequest.result as DraftMeta[]) {
            const { captures, stripped } = withoutCaptureStrokes(stored.captures ?? {});
            if (!stripped) continue;
            const { expiresAt: _expires, ...rest } = stored;
            void _expires;
            metaStore.put({ ...rest, captures, signaturesOmitted: true as const });
            counted.documents += 1;
          }
          for (const row of sessionsRequest.result as unknown[]) {
            if (!isSessionDraftMeta(row) || !blocksHaveStrokes(row.blocks)) continue;
            const { expiresAt: _expires, ceremony: _ceremony, ...rest } = row;
            void [_expires, _ceremony];
            sessionStore.put({ ...rest, blocks: withoutBlockStrokes(row.blocks).blocks, signaturesOmitted: true as const });
            counted.sessions += 1;
          }
        };
        metasRequest.onsuccess = onRead;
        sessionsRequest.onsuccess = onRead;
      });
      if (counts.sessions + counts.documents > 0) announceChange();
      return { ok: true, ...counts };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** ¿Sigue habiendo un borrador con este id (de un documento suelto o de una sesion)? Sin IndexedDB, `false`. */
export async function draftExists(kind: "document" | "session", id: string): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      const row = await getFromStore<unknown>(db, kind === "session" ? SESSION_STORE : META_STORE, id);
      return row !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Borra una entrada de la lista, sea un documento suelto o una sesion. */
export function deleteDraftEntry(entry: DraftEntry): Promise<void> {
  return entry.kind === "session"
    ? deleteSessionDraft(entry.meta.id)
    : deleteDraft(entry.meta.id);
}

export type ClearDraftsResult = { ok: true } | { ok: false; reason: "unavailable" };

/**
 * Async a proposito (a diferencia de `clearValueHistory`, sincrono):
 * IndexedDB es asincrono por naturaleza, y quien llama (`PrivacyNotice`)
 * espera esto antes de afirmar "Datos borrados" -- afirmarlo antes de
 * que la operacion termine mentiria si fallara.
 *
 * Sigue sin lanzar nunca, pero ahora INFORMA: `{ ok: false }` si la base
 * existe y no se pudo vaciar (bloqueada por otra pestaña, cuota...). Sin
 * IndexedDB en el navegador no hay nada guardado que borrar: `{ ok: true }`.
 * Vacia tambien las sesiones (borradores de varios documentos).
 */
export async function clearAllDrafts(): Promise<ClearDraftsResult> {
  if (typeof indexedDB === "undefined" || indexedDB === null) return { ok: true };
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const stores = [FILES_STORE, META_STORE, SESSION_STORE].filter((name) =>
          db.objectStoreNames.contains(name),
        );
        const tx = db.transaction(stores, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
        for (const name of stores) tx.objectStore(name).clear();
      });
      writtenFileIds.clear();
      savedDraftIdsHere.clear();
      tab.restored.clear();
    } finally {
      db.close();
    }
    announceChange();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/* ------------------------------------------------------------------ *
 * Respaldo (U4.6): leer sin efectos y escribir importando
 * ------------------------------------------------------------------ */

/**
 * Forma minima de un borrador de UN documento (lo que viene de IndexedDB no se da por bueno). No existia: los borradores v1
 * se leian a ciegas porque solo los escribia esta misma herramienta; el respaldo los vuelve a leer para EXPORTARLOS.
 */
export function isDocumentDraftMeta(value: unknown): value is DraftMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.fileName === "string" &&
    typeof value.fileSize === "number" &&
    typeof value.savedAt === "string" &&
    typeof value.step === "string" &&
    Array.isArray(value.signers) &&
    Array.isArray(value.fields) &&
    Array.isArray(value.textFields) &&
    isRecord(value.textValues) &&
    isRecord(value.captures)
  );
}

/**
 * Lee un borrador de UN documento SIN efectos: no borra nada (ni lo caducado ni lo huerfano), no persiste fechas de
 * caducidad y NO anota la version leida en esta pestana (`noteRev`/`noteRestored`): exportar o comparar no es restaurar, y
 * anotarla haria que esta pestana creyera haber visto una version que otra pestana escribio (D1). `null` si no existe,
 * esta caducado (el respaldo no exporta borradores caducados), no es valido o le faltan los bytes.
 */
export async function peekDocumentDraft(id: string, now: number = Date.now()): Promise<LoadedDraft | null> {
  try {
    const db = await openDb();
    try {
      const stored = await getFromStore<unknown>(db, META_STORE, id);
      if (!isDocumentDraftMeta(stored)) return null;
      const meta = withLegacyExpiry(stored, documentHasStrokes(stored));
      if (isExpired(meta, now)) return null;
      const record = await getFromStore<FileRecord>(db, FILES_STORE, id);
      return record ? { meta, bytes: record.bytes } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Igual que `peekDocumentDraft` para una sesion de varios documentos (sin efectos; `null` si falta cualquier documento). */
export async function peekSessionDraft(id: string, now: number = Date.now()): Promise<LoadedSessionDraft | null> {
  try {
    const db = await openDb();
    try {
      const row = await getFromStore<unknown>(db, SESSION_STORE, id);
      if (!isSessionDraftMeta(row)) return null;
      const meta = withLegacyExpiry(row, sessionHasStrokes(row));
      if (isExpired(meta, now)) return null;
      const files: LoadedSessionDraft["files"] = [];
      for (const doc of meta.documents) {
        const record = await getFromStore<FileRecord>(db, FILES_STORE, sessionFileKey(id, doc.id));
        if (!record) return null;
        files.push({ id: doc.id, fileName: doc.fileName, bytes: record.bytes });
      }
      return { meta, files };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export type DraftListings = {
  documents: DraftMeta[];
  sessions: SessionDraftMeta[];
  /** Filas de documento que no tienen una forma valida (no se pueden exportar). */
  unreadable: number;
  /** Borradores caducados que NO se ofrecen (todavia no se purgaron). */
  expired: number;
};

/**
 * Metadatos de TODOS los borradores vigentes (sin bytes y sin efectos): lo que el resumen previo a exportar cuenta.
 * `null` si no hay IndexedDB o no se pudo leer.
 */
export async function listDraftsForBackup(now: number = Date.now()): Promise<DraftListings | null> {
  try {
    const db = await openDb();
    try {
      const metaRows = await getAllFromStore<unknown>(db, META_STORE);
      const sessionRows = await getAllFromStore<unknown>(db, SESSION_STORE);
      const documents: DraftMeta[] = [];
      const sessions: SessionDraftMeta[] = [];
      let unreadable = 0;
      let expired = 0;
      for (const row of metaRows) {
        if (!isDocumentDraftMeta(row)) {
          unreadable += 1;
          continue;
        }
        const meta = withLegacyExpiry(row, documentHasStrokes(row));
        if (isExpired(meta, now)) expired += 1;
        else documents.push(meta);
      }
      for (const row of sessionRows) {
        if (!isSessionDraftMeta(row)) {
          unreadable += 1;
          continue;
        }
        const meta = withLegacyExpiry(row, sessionHasStrokes(row));
        if (isExpired(meta, now)) expired += 1;
        else sessions.push(meta);
      }
      return { documents, sessions, unreadable, expired };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Un borrador de documento suelto que se importa (sin `rev` ni `writerId`: los pone la escritura). */
export type DraftImportDocument = { meta: Omit<DraftMeta, "rev" | "writerId">; bytes: Uint8Array };
/** Una sesion que se importa; `files` son TODOS sus documentos (mismos ids que `meta.documents`). */
export type DraftImportSession = {
  meta: Omit<SessionDraftMeta, "rev" | "writerId">;
  files: ReadonlyArray<{ id: string; bytes: Uint8Array }>;
};
/** Lo que la vista previa vio de cada borrador local que se va a SUSTITUIR: se compara dentro de la transaccion. */
export type DraftImportExpectation = { kind: "document" | "session"; id: string; savedAt: string; rev: number };

export type CommitDraftImportInput = {
  documents: readonly DraftImportDocument[];
  sessions: readonly DraftImportSession[];
  /** Ids locales que las escrituras sustituyen. Una escritura sobre un id ocupado que no esta aqui es un choque (`changed`). */
  replace: readonly DraftImportExpectation[];
};

export type CommitDraftImportResult =
  | {
      ok: true;
      written: number;
      replaced: number;
      /** Deshace TODO lo escrito (restaura lo sustituido y borra lo creado). Nunca lanza. */
      undo: () => Promise<void>;
    }
  | { ok: false; reason: "invalid" | "changed" | "limit" | "unavailable" };

type StoredRows = {
  metas: Map<string, DraftMeta>;
  sessions: Map<string, SessionDraftMeta>;
  files: Map<string, FileRecord>;
};

function isFileList(value: unknown): value is ReadonlyArray<{ id: string; bytes: Uint8Array }> {
  return Array.isArray(value);
}

type CommitOutcome =
  | {
      ok: true;
      written: number;
      replaced: number;
      stamps: { id: string; rev: number }[];
      before: StoredRows;
      createdDocs: string[];
      createdSessions: string[];
    }
  | { ok: false; reason: "changed" | "limit" };

/**
 * Escribe borradores IMPORTADOS en UNA transaccion (los tres almacenes): o entran todos o no entra ninguno. Dentro de la
 * propia transaccion comprueba que lo que se va a sustituir sigue siendo lo que vio la vista previa (`replace`), que los
 * ids nuevos no estan ocupados y que el resultado cabe en el presupuesto (`MAX_DRAFTS` borradores, `MAX_DRAFTS_TOTAL_BYTES`,
 * `MAX_SESSION_DRAFT_BYTES` por sesion): NO expulsa borradores para hacer sitio (el respaldo nunca borra trabajo ajeno a
 * escondidas), devuelve `limit` sin escribir nada.
 *
 * Versionado coherente (D1): un borrador nuevo entra con `rev` 1; uno que sustituye a otro, con `max(rev del local, rev
 * conocida) + 1`, y todos con el `writerId` de ESTA pestana, de modo que otra pestana que tuviera abierta esa sesion se
 * entera (`announceChange({ id, rev })`) y no la pisa a ciegas. Conserva `savedAt` y `expiresAt` del paquete.
 */
export async function commitDraftImport(input: CommitDraftImportInput): Promise<CommitDraftImportResult> {
  try {
    const documents = input?.documents;
    const sessions = input?.sessions;
    const replace = input?.replace;
    if (!Array.isArray(documents) || !Array.isArray(sessions) || !Array.isArray(replace)) {
      return { ok: false, reason: "invalid" };
    }
    const newIds = new Set<string>();
    for (const doc of documents) {
      if (!doc || typeof doc.meta?.id !== "string" || !(doc.bytes instanceof Uint8Array) || newIds.has(`d:${doc.meta.id}`)) {
        return { ok: false, reason: "invalid" };
      }
      newIds.add(`d:${doc.meta.id}`);
    }
    for (const session of sessions) {
      const meta = session?.meta as SessionDraftMeta | undefined;
      const sessionFiles: unknown = session?.files;
      if (
        !meta ||
        !isSessionDraftMeta({ ...meta, rev: 1 }) ||
        newIds.has(`s:${meta.id}`) ||
        !isFileList(sessionFiles) ||
        sessionFiles.length !== meta.documents.length ||
        !meta.documents.every((d) => sessionFiles.some((f) => f.id === d.id && f.bytes instanceof Uint8Array))
      ) {
        return { ok: false, reason: "invalid" };
      }
      newIds.add(`s:${meta.id}`);
    }
    if (documents.length + sessions.length === 0) return { ok: true, written: 0, replaced: 0, undo: async () => {} };

    const db = await openDb();
    let outcome: CommitOutcome;
    try {
      outcome = await new Promise<CommitOutcome>((resolve, reject) => {
        const tx = db.transaction([FILES_STORE, META_STORE, SESSION_STORE], "readwrite");
        let result: Parameters<typeof resolve>[0] | null = null;
        let failure: unknown;
        tx.oncomplete = () => (result ? resolve(result) : reject(new Error("sin resultado")));
        tx.onerror = () => {
          failure ??= tx.error;
        };
        tx.onabort = () => reject(failure ?? tx.error ?? new Error("transaccion abortada"));
        const filesStore = tx.objectStore(FILES_STORE);
        const metaStore = tx.objectStore(META_STORE);
        const sessionStore = tx.objectStore(SESSION_STORE);

        const metasRequest = metaStore.getAll();
        const sessionsRequest = sessionStore.getAll();
        const fileKeysRequest = filesStore.getAllKeys();
        let pending = 3;
        const onRead = () => {
          pending -= 1;
          if (pending > 0) return;
          try {
            const metaRows = (metasRequest.result as unknown[]).filter(isDocumentDraftMeta);
            const sessionRows = (sessionsRequest.result as unknown[]).filter(isSessionDraftMeta);
            const localDocs = new Map(metaRows.map((m) => [m.id, m]));
            const localSessions = new Map(sessionRows.map((m) => [m.id, m]));

            // 1) Lo que se sustituye sigue siendo lo que vio la vista previa.
            const replaceDocs = new Set<string>();
            const replaceSessions = new Set<string>();
            for (const expected of replace) {
              const current = (expected.kind === "document" ? localDocs : localSessions).get(expected.id);
              if (!current || current.savedAt !== expected.savedAt || (current.rev ?? 0) !== expected.rev) {
                result = { ok: false, reason: "changed" };
                return;
              }
              (expected.kind === "document" ? replaceDocs : replaceSessions).add(expected.id);
            }
            // 2) Los ids nuevos no estan ocupados por algo que NO se sustituye.
            for (const doc of documents) {
              if (localDocs.has(doc.meta.id) && !replaceDocs.has(doc.meta.id)) {
                result = { ok: false, reason: "changed" };
                return;
              }
            }
            for (const session of sessions) {
              if (localSessions.has(session.meta.id) && !replaceSessions.has(session.meta.id)) {
                result = { ok: false, reason: "changed" };
                return;
              }
            }
            // 3) Cabe sin expulsar nada.
            let count = metaRows.length + sessionRows.length - replaceDocs.size - replaceSessions.size;
            let bytes = 0;
            for (const meta of metaRows) if (!replaceDocs.has(meta.id)) bytes += meta.fileSize;
            for (const meta of sessionRows) if (!replaceSessions.has(meta.id)) bytes += meta.fileSize;
            for (const doc of documents) {
              count += 1;
              bytes += doc.bytes.byteLength;
            }
            for (const session of sessions) {
              const size = session.files.reduce((sum: number, f: { bytes: Uint8Array }) => sum + f.bytes.byteLength, 0);
              if (size > MAX_SESSION_DRAFT_BYTES) {
                result = { ok: false, reason: "limit" };
                return;
              }
              count += 1;
              bytes += size;
            }
            if (count > MAX_DRAFTS || bytes > MAX_DRAFTS_TOTAL_BYTES) {
              result = { ok: false, reason: "limit" };
              return;
            }

            // 4) Copia de seguridad de lo que se sustituye (para `undo`) y borrado.
            const before: StoredRows = { metas: new Map(), sessions: new Map(), files: new Map() };
            for (const id of replaceDocs) before.metas.set(id, localDocs.get(id) as DraftMeta);
            for (const id of replaceSessions) before.sessions.set(id, localSessions.get(id) as SessionDraftMeta);
            const fileKeys = fileKeysRequest.result as string[];
            const doomedKeys = fileKeys.filter((key) => {
              const sid = sessionIdOfFileKey(key);
              return sid === null ? replaceDocs.has(key) : replaceSessions.has(sid);
            });
            const backups = doomedKeys.map((key) => filesStore.get(key));
            let backupsPending = backups.length;
            const write = () => {
              try {
                for (const key of doomedKeys) filesStore.delete(key);
                for (const id of replaceDocs) metaStore.delete(id);
                for (const id of replaceSessions) sessionStore.delete(id);
                const stamps: { id: string; rev: number }[] = [];
                for (const doc of documents) {
                  const previous = localDocs.get(doc.meta.id);
                  const rev = previous ? Math.max(previous.rev ?? 0, knownDraftRev(doc.meta.id)) + 1 : 1;
                  stamps.push({ id: doc.meta.id, rev });
                  filesStore.put({ id: doc.meta.id, bytes: doc.bytes } satisfies FileRecord);
                  metaStore.put({ ...doc.meta, rev, writerId: tab.id } satisfies DraftMeta);
                }
                for (const session of sessions) {
                  const previous = localSessions.get(session.meta.id);
                  const rev = previous ? Math.max(previous.rev ?? 0, knownDraftRev(session.meta.id)) + 1 : 1;
                  stamps.push({ id: session.meta.id, rev });
                  for (const file of session.files) {
                    filesStore.put({ id: sessionFileKey(session.meta.id, file.id), bytes: file.bytes } satisfies FileRecord);
                  }
                  sessionStore.put({ ...session.meta, rev, writerId: tab.id } satisfies SessionDraftMeta);
                }
                result = {
                  ok: true,
                  written: documents.length + sessions.length,
                  replaced: replaceDocs.size + replaceSessions.size,
                  stamps,
                  before,
                  createdDocs: documents.filter((d) => !replaceDocs.has(d.meta.id)).map((d) => d.meta.id),
                  createdSessions: sessions.filter((s) => !replaceSessions.has(s.meta.id)).map((s) => s.meta.id),
                };
              } catch (error) {
                failure = error;
                try {
                  tx.abort();
                } catch {
                  // ya terminada
                }
              }
            };
            if (backups.length === 0) {
              write();
              return;
            }
            backups.forEach((request) => {
              request.onsuccess = () => {
                const record = request.result as FileRecord | undefined;
                if (record) before.files.set(record.id, record);
                backupsPending -= 1;
                if (backupsPending === 0) write();
              };
            });
          } catch (error) {
            failure = error;
            try {
              tx.abort();
            } catch {
              // ya terminada
            }
          }
        };
        metasRequest.onsuccess = onRead;
        sessionsRequest.onsuccess = onRead;
        fileKeysRequest.onsuccess = onRead;
      });
    } finally {
      db.close();
    }
    if (!outcome.ok) return outcome;

    // Esta pestana ya conoce las versiones que acaba de escribir, y lo que restauro de ellos dejo de ser la referencia.
    for (const stamp of outcome.stamps) {
      noteRev(stamp.id, stamp.rev);
      tab.restored.delete(stamp.id);
      writtenFileIds.delete(stamp.id);
    }
    const created = new Set([...outcome.createdDocs, ...outcome.createdSessions]);
    for (const stamp of outcome.stamps) {
      announceChange(created.has(stamp.id) ? undefined : stamp);
    }
    if (outcome.stamps.length === 0) announceChange();
    const undo = async (): Promise<void> => {
      try {
        const udb = await openDb();
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = udb.transaction([FILES_STORE, META_STORE, SESSION_STORE], "readwrite");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error("transaccion abortada"));
            const filesStore = tx.objectStore(FILES_STORE);
            const metaStore = tx.objectStore(META_STORE);
            const sessionStore = tx.objectStore(SESSION_STORE);
            for (const id of outcome.createdDocs) {
              filesStore.delete(id);
              metaStore.delete(id);
              writtenFileIds.delete(id);
            }
            for (const id of outcome.createdSessions) {
              filesStore.delete(sessionKeyRange(id));
              sessionStore.delete(id);
            }
            // Lo sustituido se devuelve tal como estaba (los archivos de la sesion nueva ya se borraron arriba por rango).
            for (const stamp of outcome.stamps) {
              if (outcome.before.sessions.has(stamp.id)) filesStore.delete(sessionKeyRange(stamp.id));
              if (outcome.before.metas.has(stamp.id)) filesStore.delete(stamp.id);
            }
            for (const meta of outcome.before.metas.values()) metaStore.put(meta);
            for (const meta of outcome.before.sessions.values()) sessionStore.put(meta);
            for (const record of outcome.before.files.values()) filesStore.put(record);
          });
        } finally {
          udb.close();
        }
        announceChange();
      } catch {
        // Nada mas que hacer: el llamador informa de que el respaldo no se pudo deshacer del todo.
      }
    };
    return { ok: true, written: outcome.written, replaced: outcome.replaced, undo };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
