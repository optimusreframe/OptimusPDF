import { PDFDocument } from "@cantoo/pdf-lib";
import type { Language } from "@/lib/i18n";
import { PdfError, readFileBytes, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";
import { createProHistoryStore, type ProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { CHUNK_MIN_TOTAL_BYTES, planChunks, shouldChunk } from "@/app/pdf-pro/proChunks";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import type {
  ProDocument,
  ProModeId,
  ProRestoredInfo,
  ProSignatureState,
  ProSnapshot,
  ProSnapshotSource,
  ProWorkingState,
} from "@/app/pdf-pro/proTypes";

/**
 * Documento de trabajo de PDF Pro (Wave 7 · U2): historial LINEAL de snapshots de bytes
 * inmutables. Modulo puro (sin React): `useProWorkingDoc` lo conecta a la interfaz con
 * `useSyncExternalStore`.
 *
 * Presupuesto de memoria POR BYTES: como mucho `PRO_MAX_SNAPSHOTS` snapshots y
 * `PRO_MAX_SNAPSHOT_BYTES` en total. Al pasarse se descartan los MAS ANTIGUOS, conservando
 * siempre el original (indice 0) y el actual; el historial descartado se avisa (`trimmedCount`).
 * Confirmar un cambio estando atras en el historial (tras deshacer) DESCARTA la rama de
 * rehacer, como en cualquier editor.
 *
 * Wave 8 · memoria del historial: solo una VENTANA CALIENTE de snapshots vive en RAM (el actual y sus vecinos,
 * hasta `PRO_HOT_SNAPSHOT_BYTES`); el resto se vuelca a disco (`proHistoryStore`, IndexedDB) y queda en la lista
 * con `offloaded: true` y `bytes` vacio. Deshacer/rehacer hacia un paso volcado lo recupera de forma perezosa
 * (`restoring` en el estado) y luego mueve el cursor; el anuncio multipaso no cambia porque sale de las etiquetas.
 * Si el volcado falla (sin IndexedDB, cuota) el documento queda marcado (`historyOffloadFailed`, aviso visible) y
 * se recorta por bytes como antes. El presupuesto por bytes cuenta solo lo RESIDENTE.
 *
 * Wave 9 · escritura: los snapshots grandes (>= 4 MB) se guardan TROCEADOS por contenido y sin repetir (`proChunks`): un
 * paso cuesta ~7 % de su peso a disco, no el 100 %. El plan de trozos de cada snapshot se calcula en segundo plano en
 * cuanto nace (`prewarmChunkPlan`), para que ni el volcado ni el borrador esperen ese calculo. Palanca de memoria que NO
 * se ha movido: `PRO_HOT_SNAPSHOT_BYTES` (con 40 MB deja 4 snapshots residentes; con la mitad, 2).
 */

/**
 * Tope de NUMERO de snapshots en RAM (original + actual + intermedios). Es solo una red de seguridad: el limite que manda
 * es el de BYTES (`PRO_MAX_SNAPSHOT_BYTES`). Con un PDF pequeño caben decenas de pasos de deshacer; con uno grande,
 * los que quepan en ~400 MB.
 */
export const PRO_MAX_SNAPSHOTS = 50;
/** Presupuesto de bytes de todos los snapshots RESIDENTES en RAM (~400 MB): red de seguridad si no hay disco. */
export const PRO_MAX_SNAPSHOT_BYTES = 400 * 1024 * 1024;
/**
 * Ventana caliente (Wave 8): bytes de snapshots que se mantienen en RAM. El actual y el anterior estan SIEMPRE
 * (deshacer un paso es instantaneo); el resto se añade por cercania al cursor (siguiente, anterior del anterior,
 * ...) mientras quepa. Con PDF pequeños cabe el historial entero (nada se vuelca); con 40 MB, cuatro pasos; con
 * 100 MB, el actual y el anterior. Lo demas se vuelca a disco.
 */
export const PRO_HOT_SNAPSHOT_BYTES = 192 * 1024 * 1024;
const EMPTY_BYTES = new Uint8Array(0);

export type ProWorkingDocOptions = {
  maxSnapshots?: number;
  maxBytes?: number;
  now?: () => number;
  /** Idioma de los anuncios y de las etiquetas por defecto (se puede cambiar con `setLanguage`). */
  language?: Language;
  /** Cuenta las paginas de unos bytes (por defecto, pdf-lib). */
  countPages?: (bytes: Uint8Array) => Promise<number>;
  /** Huella SHA-256 hex del archivo abierto (por defecto, `crypto.subtle`; `null` si no hay). */
  fingerprint?: (bytes: Uint8Array) => Promise<string | null>;
  /** Firmas digitales del PDF abierto (por defecto, `inspectProtection`). */
  inspectSignatures?: (file: File) => Promise<ProSignatureState>;
  /** Se llama con cada snapshot descartado por el presupuesto (gancho para volcarlo a disco). */
  onEvict?: (snapshot: ProSnapshot) => void;
  /**
   * Almacen en disco del historial (Wave 8). `undefined` = crear el de la sesion (`createProHistoryStore`);
   * `null` = sin disco (solo memoria, recorte por bytes).
   */
  historyStore?: ProHistoryStore | null;
  /** Bytes de la ventana caliente, actual incluido (por defecto `PRO_HOT_SNAPSHOT_BYTES`). */
  hotBytes?: number;
};

export type ProOpenOptions = {
  /** El archivo es una copia descifrada (por defecto, se mira `isDecryptedCopy`). */
  encrypted?: boolean;
  /** Huella ya conocida del archivo ORIGINAL (un borrador restaurado conserva la suya). */
  fingerprint?: string | null;
  signatures?: ProSignatureState;
  /** Documento recuperado de un borrador: queda con cambios sin guardar. */
  restored?: ProRestoredInfo;
  /** Etiqueta del primer snapshot (por defecto «Original»). */
  label?: string;
  pageCount?: number;
};

export type ProOpenResult = { ok: true; document: ProDocument } | { ok: false; code: PdfErrorCode };

export type ProCommitExtra = {
  opId?: string;
  /** Si la operacion ya sabe cuantas paginas salieron, no se recuentan. */
  pageCount?: number;
};

export type ProModeRegistration = { hasOwnUndo: boolean };

export const EMPTY_PRO_STATE: ProWorkingState = {
  document: null,
  canUndo: false,
  canRedo: false,
  dirty: false,
  pageCount: 0,
  announcement: null,
  activeModes: [],
  ownUndoActive: false,
  restoring: false,
  stepInFlight: false,
};

/** Huella SHA-256 hex, o `null` si no se puede calcular (sin `crypto.subtle`, contexto no seguro). */
export async function fingerprintProBytes(bytes: Uint8Array): Promise<string | null> {
  try {
    const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
    if (!subtle || typeof subtle.digest !== "function") return null;
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

async function defaultCountPages(bytes: Uint8Array): Promise<number> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPageCount();
}

async function defaultInspectSignatures(file: File): Promise<ProSignatureState> {
  try {
    const { inspectProtection } = await import("@/lib/pdf/unlock");
    const inspection = await inspectProtection(file);
    if (inspection.kind !== "ready") return "unknown";
    return inspection.profile.hasActiveSignatures ? "active" : "none";
  } catch {
    // Nunca se interpreta un fallo como «sin firmas».
    return "unknown";
  }
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

type Evictable = { snapshots: readonly ProSnapshot[]; cursor: number };


/**
 * Junta las etiquetas IGUALES CONSECUTIVAS de un anuncio largo: «Rotar, Rotar, Rotar, Recortar» se lee «Rotar ×3,
 * Recortar». Nunca se pierde un paso (el contador lo cuenta), pero un salto de muchos pasos iguales deja de ser una
 * lista interminable para el lector de pantalla. Solo agrupa vecinas: «Rotar, Recortar, Rotar» no cambia.
 */
export function groupRepeatedLabels(labels: readonly string[]): string[] {
  const grouped: string[] = [];
  for (let index = 0; index < labels.length; ) {
    let end = index + 1;
    while (end < labels.length && labels[end] === labels[index]) end += 1;
    const count = end - index;
    grouped.push(count > 1 ? `${labels[index]} ×${count}` : labels[index]);
    index = end;
  }
  return grouped;
}

/** Bytes que un snapshot ocupa en RAM (0 si esta volcado a disco). */
export function residentBytes(snapshot: Pick<ProSnapshot, "byteLength" | "offloaded">): number {
  return snapshot.offloaded ? 0 : snapshot.byteLength;
}

/**
 * Quita el snapshot `index` de la lista (sin mutar la original): el que queda justo despues hereda las etiquetas
 * que deshacer saltara (lo suyo antiguo, el quitado y lo posterior), asi nunca se salta un paso en silencio.
 */
export function dropSnapshotAt(state: Evictable, index: number): Evictable & { dropped: ProSnapshot } {
  const snapshots = [...state.snapshots];
  const dropped = snapshots[index];
  snapshots.splice(index, 1);
  const cursor = index < state.cursor ? state.cursor - 1 : state.cursor;
  const next = snapshots[index];
  if (next) {
    snapshots[index] = {
      ...next,
      skippedLabels: [...(dropped.skippedLabels ?? []), dropped.label, ...(next.skippedLabels ?? [])],
    };
  }
  return { snapshots, cursor, dropped };
}

/**
 * Aplica el presupuesto: mientras haya mas de `maxSnapshots` snapshots, o mas de `maxBytes` RESIDENTES en RAM,
 * descarta el mas ANTIGUO que no sea el original (indice 0) ni el actual (`cursor`), de modo que queda siempre el
 * ORIGINAL + la cadena contigua mas reciente. Por bytes solo se descartan snapshots residentes (uno volcado a disco
 * no ocupa RAM). El siguiente snapshot anota las etiquetas de lo descartado (`skippedLabels`) para que deshacer lo
 * anuncie. Puro: devuelve la lista nueva, el cursor reajustado y lo descartado.
 */
export function enforceProBudget(
  state: Evictable,
  limits: { maxSnapshots: number; maxBytes: number },
): Evictable & { evicted: ProSnapshot[] } {
  let current: Evictable = { snapshots: [...state.snapshots], cursor: state.cursor };
  const evicted: ProSnapshot[] = [];
  const total = () => current.snapshots.reduce((sum, snapshot) => sum + residentBytes(snapshot), 0);
  for (;;) {
    const overCount = current.snapshots.length > limits.maxSnapshots;
    const overBytes = total() > limits.maxBytes;
    if (!overCount && !overBytes) break;
    let index = -1;
    for (let i = 1; i < current.snapshots.length; i += 1) {
      if (i === current.cursor) continue;
      if (!overCount && current.snapshots[i].offloaded) continue; // volcado: no libera RAM
      index = i;
      break;
    }
    if (index < 0) break; // solo quedan el original y el actual (o nada residente que soltar)
    const result = dropSnapshotAt(current, index);
    evicted.push(result.dropped);
    current = { snapshots: result.snapshots, cursor: result.cursor };
  }
  return { snapshots: current.snapshots, cursor: current.cursor, evicted };
}

export class ProWorkingDoc {
  private state: ProWorkingState = EMPTY_PRO_STATE;
  private document: ProDocument | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly modes = new Map<ProModeId, ProModeRegistration[]>();
  private announcementId = 0;
  private announcement: ProWorkingState["announcement"] = null;
  private epoch = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private fileCache: { id: string; file: File } | null = null;
  private language: Language;
  private readonly maxSnapshots: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly countPages: (bytes: Uint8Array) => Promise<number>;
  private readonly fingerprintFn: (bytes: Uint8Array) => Promise<string | null>;
  private readonly inspectSignaturesFn: (file: File) => Promise<ProSignatureState>;
  private readonly onEvict?: (snapshot: ProSnapshot) => void;
  /* ---- Wave 8: historial en disco ---- */
  private readonly store: ProHistoryStore | null;
  private readonly hotBytes: number;
  /** Ids con bytes YA guardados en disco (soltar sus bytes de RAM es gratis). */
  private readonly storedIds = new Set<string>();
  /** Escrituras y lecturas en vuelo (no se repiten). */
  private readonly putting = new Map<string, Promise<void>>();
  private readonly fetching = new Set<string>();
  /** Movimiento pendiente de recuperar bytes de disco: el ultimo pedido gana. */
  private moveToken = 0;
  private pendingTarget: number | null = null;
  private restoring = false;
  /** Pasos en vuelo (`trackStep`): operaciones corriendo y confirmaciones encoladas. */
  private inFlight = 0;

  constructor(options: ProWorkingDocOptions = {}) {
    this.maxSnapshots = options.maxSnapshots ?? PRO_MAX_SNAPSHOTS;
    this.maxBytes = options.maxBytes ?? PRO_MAX_SNAPSHOT_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.language = options.language ?? "es";
    this.countPages = options.countPages ?? defaultCountPages;
    this.fingerprintFn = options.fingerprint ?? fingerprintProBytes;
    this.inspectSignaturesFn = options.inspectSignatures ?? defaultInspectSignatures;
    this.onEvict = options.onEvict;
    this.store = options.historyStore === undefined ? createProHistoryStore() : options.historyStore;
    this.hotBytes = options.hotBytes ?? PRO_HOT_SNAPSHOT_BYTES;
  }

  /* ---------------- suscripcion (useSyncExternalStore) ---------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Estado actual. Misma referencia mientras nada cambie. */
  getState = (): ProWorkingState => this.state;

  private recompute(): void {
    const document = this.document;
    const modes = [...this.modes.keys()];
    const ownUndoActive = [...this.modes.values()].some((regs) => regs.some((r) => r.hasOwnUndo));
    const current = document ? document.snapshots[document.cursor] : null;
    this.state = {
      document,
      canUndo: !!document && document.cursor > 0,
      canRedo: !!document && document.cursor < document.snapshots.length - 1,
      dirty: !!document && !!current && current.id !== document.savedSnapshotId,
      pageCount: current?.pageCount ?? 0,
      announcement: this.announcement,
      activeModes: modes,
      ownUndoActive,
      restoring: this.restoring,
      stepInFlight: this.inFlight > 0,
    };
    for (const listener of [...this.listeners]) listener();
  }

  setLanguage(language: Language): void {
    this.language = language;
  }

  /** Ultimo anuncio hecho con `announce` y cuando (para sumar el siguiente si llega pegado). */
  private spoken: { id: number; at: number } | null = null;

  /**
   * Anuncia un texto en la region viva unica. Con `mergeWithinMs`, si el anuncio anterior (hecho tambien con `announce`)
   * es de hace menos de ese tiempo, el nuevo se SUMA a el en vez de pisarlo: la region guarda un solo texto y un lector de
   * pantalla cortaria el primero.
   */
  announce(text: string, options: { mergeWithinMs?: number } = {}): void {
    const previous = this.announcement;
    const now = this.now();
    const merge =
      options.mergeWithinMs !== undefined &&
      previous !== null &&
      this.spoken !== null &&
      this.spoken.id === previous.id &&
      now - this.spoken.at < options.mergeWithinMs;
    this.announcementId += 1;
    this.announcement = { id: this.announcementId, text: merge ? `${previous.text} ${text}` : text };
    this.spoken = { id: this.announcementId, at: now };
    this.recompute();
  }

  /* ---------------- abrir / cerrar ---------------- */

  /** Abre un PDF como original del historial. Reemplaza al documento que hubiera. */
  async open(file: File, options: ProOpenOptions = {}): Promise<ProOpenResult> {
    const epoch = ++this.epoch;
    this.chain = Promise.resolve();
    this.releaseHistory();
    try {
      const bytes = await readFileBytes(file);
      if (bytes.byteLength === 0) return { ok: false, code: "emptyFile" };
      const pageCountPromise =
        options.pageCount !== undefined ? Promise.resolve(options.pageCount) : this.countPages(bytes);
      const [pageCount, fingerprint, signatures] = await Promise.all([
        pageCountPromise,
        options.fingerprint !== undefined ? Promise.resolve(options.fingerprint) : this.fingerprintFn(bytes),
        options.signatures !== undefined
          ? Promise.resolve(options.signatures)
          : this.inspectSignaturesFn(file),
      ]);
      if (epoch !== this.epoch) return { ok: false, code: "cancelled" };
      const strings = getProStrings(this.language);
      const first: ProSnapshot = {
        id: nextId("snap"),
        bytes,
        label: options.label ?? (options.restored ? strings.labels.restored : strings.labels.original),
        createdAt: this.now(),
        pageCount,
        byteLength: bytes.byteLength,
        source: "open",
      };
      this.document = {
        id: nextId("doc"),
        name: file.name,
        snapshots: [first],
        cursor: 0,
        // Un borrador recuperado ya trae cambios respecto del archivo original: sin guardar.
        savedSnapshotId: options.restored ? null : first.id,
        fingerprint,
        wasEncrypted: options.encrypted ?? isDecryptedCopy(file),
        signatures,
        trimmedCount: 0,
        openedAt: this.now(),
        ...(options.restored ? { restored: options.restored } : {}),
      };
      this.fileCache = null;
      this.announcement = { id: ++this.announcementId, text: strings.announce.opened(file.name) };
      this.recompute();
      this.prewarmChunkPlan(first);
      return { ok: true, document: this.document };
    } catch (error) {
      if (epoch !== this.epoch) return { ok: false, code: "cancelled" };
      const code = error instanceof PdfError ? error.code : toPdfError(error).code;
      return { ok: false, code };
    }
  }

  /** Cierra el documento y suelta todos los bytes (tambien los volcados a disco). */
  close(): void {
    this.epoch += 1;
    this.chain = Promise.resolve();
    this.releaseHistory();
    if (!this.document) return;
    this.document = null;
    this.fileCache = null;
    this.announcement = { id: ++this.announcementId, text: getProStrings(this.language).announce.closed };
    this.recompute();
  }

  /** Cierra el documento y BORRA la base de historial de esta sesion (al desmontar la suite). */
  async dispose(): Promise<void> {
    this.close();
    await this.store?.dispose();
  }

  /**
   * Cierra y BORRA solo la base de historial de esta sesion, SIN cerrar el documento (el estado y el borrador
   * automatico quedan como estan). Es lo que corre al cerrar la pestana (`pagehide`): el historial es un cache de
   * sesion que nadie volvera a leer, y asi no se queda en disco (Wave 8 · F2, privacidad).
   */
  async disposeHistoryStore(): Promise<void> {
    await this.store?.dispose();
  }

  /** Olvida todo lo volcado a disco del documento actual (cerrar, abrir otro): sin fugas en IndexedDB. */
  private releaseHistory(): void {
    this.cancelPendingMove();
    this.storedIds.clear();
    this.putting.clear();
    this.fetching.clear();
    void this.store?.clear();
  }

  /* ---------------- historial ---------------- */

  /**
   * Anade un snapshot DESPUES del actual: descarta la rama de rehacer, aplica el presupuesto y
   * anuncia el cambio. Las confirmaciones se encolan (nunca se cruzan dos). Devuelve el snapshot,
   * o `null` si entretanto se cerro o se abrio otro documento (el resultado ya no aplica).
   */
  commit(
    bytes: Uint8Array,
    label: string,
    source: ProSnapshotSource,
    extra: ProCommitExtra = {},
  ): Promise<ProSnapshot | null> {
    const epoch = this.epoch;
    const run = async (): Promise<ProSnapshot | null> => {
      if (epoch !== this.epoch || !this.document) return null;
      const pageCount =
        extra.pageCount !== undefined ? extra.pageCount : await this.countPages(bytes);
      if (epoch !== this.epoch || !this.document) return null;
      // Un deshacer que aun esperaba sus bytes se cancela: el cambio confirmado manda.
      this.cancelPendingMove();
      const document = this.document;
      const snapshot: ProSnapshot = {
        id: nextId("snap"),
        bytes,
        label,
        createdAt: this.now(),
        pageCount,
        byteLength: bytes.byteLength,
        source,
        ...(extra.opId ? { opId: extra.opId } : {}),
      };
      // Rama de rehacer fuera: lo que habia por delante del cursor ya no es alcanzable.
      const kept = document.snapshots.slice(0, document.cursor + 1);
      this.forgetStored(document.snapshots.slice(document.cursor + 1));
      // El `File` en cache era una copia ENTERA del snapshot anterior: se suelta (se rehace al pedirlo).
      this.fileCache = null;
      const strings = getProStrings(this.language);
      // Con disco sano el presupuesto se aplica DESPUES de volcar (abajo): lo residente baja solo. Sin disco (o
      // fallido) se recorta aqui mismo, como siempre, y el anuncio lo dice.
      const diskless = !this.store || document.historyOffloadFailed === true;
      const proposed: Evictable = { snapshots: [...kept, snapshot], cursor: kept.length };
      const budget = diskless
        ? enforceProBudget(proposed, { maxSnapshots: this.maxSnapshots, maxBytes: this.maxBytes })
        : { ...proposed, evicted: [] as ProSnapshot[] };
      for (const dropped of budget.evicted) this.onEvict?.(dropped);
      const trimmed = budget.evicted.length > 0;
      this.document = {
        ...document,
        snapshots: budget.snapshots,
        cursor: budget.cursor,
        trimmedCount: document.trimmedCount + budget.evicted.length,
        ...(trimmed && !this.store ? { historyOffloadFailed: true } : {}),
      };
      this.announcement = {
        id: ++this.announcementId,
        text: trimmed
          ? `${strings.announce.applied(label)}. ${strings.announce.historyTrimmed}`
          : strings.announce.applied(label),
      };
      this.recompute();
      this.prewarmChunkPlan(snapshot);
      this.rebalance();
      if (!diskless) {
        // Se espera a que lo que sale de la ventana este en disco y entonces se aplica el presupuesto a lo que
        // quede residente (red de seguridad: normalmente nada). Asi nunca se descarta un paso a medio volcar.
        await this.settleOffloads();
        if (epoch !== this.epoch || !this.document) return null;
        this.applyBudget(strings.announce.historyTrimmed);
      }
      return snapshot;
    };
    const result = this.trackStep(this.chain.then(run, run));
    this.chain = result.catch(() => null);
    return result;
  }

  /**
   * Cuenta un paso EN VUELO (D7): mientras la promesa no termine, `stepInFlight` es `true` y cerrar o cambiar de
   * documento pide confirmar aunque `dirty` aun sea `false`. `useProOperation` envuelve con esto cada operacion y
   * `commit` cada confirmacion. Devuelve la misma promesa (resuelta o rechazada igual).
   */
  trackStep<T>(step: Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.recompute();
    const done = () => {
      this.inFlight -= 1;
      this.recompute();
    };
    step.then(done, done);
    return step;
  }

  /** `true` mientras haya un paso en vuelo. */
  get stepInFlight(): boolean {
    return this.inFlight > 0;
  }

  /**
   * Mueve el cursor y anuncia TODOS los pasos que se cruzan (varios si se salta con el historial, o si el presupuesto
   * de memoria descarto pasos intermedios): nunca se salta un paso en silencio.
   */
  private move(to: number, announce: (labels: string) => string): boolean {
    const document = this.document;
    if (!document) return false;
    if (to < 0 || to >= document.snapshots.length) return false;
    if (to === document.cursor) {
      // Volver al paso en el que ya se esta cancela un movimiento que esperaba bytes (si lo habia).
      const hadPending = this.pendingTarget !== null;
      this.cancelPendingMove();
      if (hadPending) this.recompute();
      return hadPending;
    }
    const target = document.snapshots[to];
    if (!target.offloaded) {
      this.cancelPendingMove();
      this.applyMove(to, announce);
      return true;
    }
    // Bytes en disco: se recuperan y DESPUES se mueve el cursor. El ultimo pedido gana (token).
    const token = ++this.moveToken;
    const epoch = this.epoch;
    this.pendingTarget = to;
    this.restoring = true;
    this.recompute();
    const run = async () => {
      let bytes: Uint8Array | null = null;
      try {
        bytes = this.store ? await this.store.get(target.id) : null;
      } catch {
        bytes = null;
      }
      if (token !== this.moveToken || epoch !== this.epoch || !this.document) return;
      this.pendingTarget = null;
      this.restoring = false;
      const index = this.document.snapshots.findIndex((snapshot) => snapshot.id === target.id);
      if (index < 0) {
        this.recompute();
        return;
      }
      if (!bytes) {
        this.loseStep(index);
        return;
      }
      this.replaceSnapshot(index, { ...this.document.snapshots[index], bytes, offloaded: false });
      this.applyMove(index, announce);
    };
    void run();
    return true;
  }

  private cancelPendingMove(): void {
    this.moveToken += 1;
    this.pendingTarget = null;
    this.restoring = false;
  }

  /** Mueve el cursor a un snapshot RESIDENTE y anuncia todos los pasos cruzados. */
  private applyMove(to: number, announce: (labels: string) => string): void {
    const document = this.document;
    if (!document || to === document.cursor) return;
    const labels: string[] = [];
    if (to < document.cursor) {
      // Hacia atras: del mas nuevo al mas antiguo; de cada paso, su etiqueta y luego lo descartado antes de el.
      for (let index = document.cursor; index > to; index -= 1) {
        const step = document.snapshots[index];
        labels.push(step.label, ...[...(step.skippedLabels ?? [])].reverse());
      }
    } else {
      for (let index = document.cursor + 1; index <= to; index += 1) {
        const step = document.snapshots[index];
        labels.push(...(step.skippedLabels ?? []), step.label);
      }
    }
    this.document = { ...document, cursor: to };
    // Otro snapshot es el actual: la copia en `File` del anterior (megas enteros) ya no hace falta.
    this.fileCache = null;
    this.announcement = { id: ++this.announcementId, text: announce(groupRepeatedLabels(labels).join(", ")) };
    this.recompute();
    this.rebalance();
  }

  /** Posicion desde la que se cuenta el siguiente deshacer/rehacer: el destino pendiente, si lo hay. */
  private effectiveCursor(document: ProDocument): number {
    return this.pendingTarget ?? document.cursor;
  }

  /** Vuelve un paso atras. `false` si no hay nada que deshacer. */
  undo(): boolean {
    const document = this.document;
    if (!document) return false;
    const from = this.effectiveCursor(document);
    if (from <= 0) return false;
    const strings = getProStrings(this.language);
    return this.move(from - 1, (labels) => strings.announce.undone(labels));
  }

  /** Avanza un paso. `false` si no hay nada que rehacer. */
  redo(): boolean {
    const document = this.document;
    if (!document) return false;
    const from = this.effectiveCursor(document);
    if (from >= document.snapshots.length - 1) return false;
    const strings = getProStrings(this.language);
    return this.move(from + 1, (labels) => strings.announce.redone(labels));
  }

  /** Salta a un paso concreto del historial (indice dentro de `snapshots`). */
  goTo(index: number): boolean {
    const document = this.document;
    if (!document) return false;
    const strings = getProStrings(this.language);
    return this.move(index, (labels) =>
      index < document.cursor ? strings.announce.undone(labels) : strings.announce.wentTo(labels),
    );
  }

  /**
   * Cambia el nombre del documento («Guardar como…»). No crea snapshot ni toca el historial: es un dato del
   * documento, no del contenido. Devuelve `false` si no hay documento o el nombre queda vacio.
   */
  rename(name: string): boolean {
    const document = this.document;
    const next = name.trim();
    if (!document || next.length === 0) return false;
    if (document.name === next) return true;
    this.document = { ...document, name: next, renamed: true };
    this.fileCache = null;
    this.recompute();
    return true;
  }

  /** Marca el snapshot actual como guardado/exportado: `dirty` pasa a `false`. */
  markSaved(): void {
    const document = this.document;
    if (!document) return;
    const current = document.snapshots[document.cursor];
    if (document.savedSnapshotId === current.id) return;
    this.document = { ...document, savedSnapshotId: current.id };
    this.recompute();
  }

  /* ---------------- Wave 8: ventana caliente y disco ---------------- */

  /**
   * Ids que deben estar en RAM: el actual y el anterior siempre; los demas por cercania al cursor (siguiente,
   * anterior del anterior, ...) mientras el total quepa en `hotBytes`.
   */
  private hotIds(document: ProDocument): Set<string> {
    const ids = new Set<string>();
    const { snapshots, cursor } = document;
    let total = 0;
    const take = (index: number, always: boolean) => {
      const snapshot = snapshots[index];
      if (!snapshot || ids.has(snapshot.id)) return;
      if (!always && total + snapshot.byteLength > this.hotBytes) return;
      ids.add(snapshot.id);
      total += snapshot.byteLength;
    };
    take(cursor, true);
    take(cursor - 1, true);
    for (let distance = 1; cursor - distance >= 0 || cursor + distance < snapshots.length; distance += 1) {
      take(cursor + distance, false);
      take(cursor - distance - 1, false);
    }
    return ids;
  }

  private replaceSnapshot(index: number, snapshot: ProSnapshot): void {
    const document = this.document;
    if (!document) return;
    const snapshots = [...document.snapshots];
    snapshots[index] = snapshot;
    this.document = { ...document, snapshots };
  }

  /** Borra del disco los registros de esos snapshots (los que no esten, se ignoran). */
  private forgetStored(snapshots: readonly ProSnapshot[]): void {
    const ids = snapshots.map((snapshot) => snapshot.id).filter((id) => this.storedIds.has(id) || this.putting.has(id));
    for (const id of ids) this.storedIds.delete(id);
    if (ids.length > 0) void this.store?.remove(ids);
  }

  /**
   * Tras cada cambio de historial o de cursor: suelta de RAM lo que ya esta en disco y queda fuera de la ventana
   * caliente, vuelca lo residente que sale de ella y trae por adelantado lo volcado que entra en ella. Nunca toca
   * el actual. Sin disco (o con el disco fallido) no vuelca nada: el presupuesto por bytes manda, como antes.
   */
  private rebalance(): void {
    const document = this.document;
    if (!document) return;
    const hot = this.hotIds(document);
    const toPut: ProSnapshot[] = [];
    const toFetch: ProSnapshot[] = [];
    let dropped = false;
    for (let index = 0; index < document.snapshots.length; index += 1) {
      const snapshot = document.snapshots[index];
      const isHot = hot.has(snapshot.id);
      if (!snapshot.offloaded && !isHot) {
        if (this.storedIds.has(snapshot.id)) {
          this.replaceSnapshot(index, { ...snapshot, bytes: EMPTY_BYTES, offloaded: true });
          // Tambien en el objeto viejo: una referencia rezagada (deps de un `useMemo`, props anteriores de React)
          // retendria si no 100 MB una generacion entera. Quien ya tomo `bytes` conserva su Uint8Array.
          (snapshot as { bytes: Uint8Array; offloaded?: boolean }).bytes = EMPTY_BYTES;
          (snapshot as { bytes: Uint8Array; offloaded?: boolean }).offloaded = true;
          dropped = true;
        } else if (!this.putting.has(snapshot.id)) {
          toPut.push(snapshot);
        }
      } else if (snapshot.offloaded && isHot && !this.fetching.has(snapshot.id) && !document.historyOffloadFailed) {
        // Con el disco fallido no se trae nada por adelantado: lo residente crecería y el presupuesto por bytes
        // descartaría pasos. Deshacer hacia un paso volcado sigue recuperándolo (de uno en uno).
        toFetch.push(snapshot);
      }
    }
    if (dropped) this.recompute();
    if (toPut.length > 0) {
      if (!this.store || document.historyOffloadFailed) {
        this.degrade(false);
      } else {
        for (const snapshot of toPut) this.offload(snapshot);
      }
    }
    for (const snapshot of toFetch) this.prefetch(snapshot);
  }

  /**
   * Wave 9: el plan de trozos de un snapshot GRANDE (hashes por contenido, ~0,3 s por 100 MB, cedido al hilo cada ~8 ms)
   * lo necesitan despues el borrador y el volcado al historial. Se calcula en segundo plano, EN CUANTO el navegador esta
   * ocioso tras nacer el snapshot (`requestIdleCallback`, como tarde a los 1,5 s): asi no compite con la primera pintura
   * de un documento recien abierto (medido: con 100 MB, abrir pasaba de 0,44 a 0,93 s si el calculo arrancaba al instante)
   * y, cuando hace falta (autoguardado tras 0,6 s, volcado del paso que sale de la ventana), ya esta hecho o en marcha.
   * El resultado queda recordado por objeto (`planChunks`); un fallo se ignora (los almacenes guardan entero).
   */
  private prewarmChunkPlan(snapshot: ProSnapshot): void {
    if (!this.store || !shouldChunk(snapshot.byteLength, CHUNK_MIN_TOTAL_BYTES)) return;
    const start = () => void planChunks(snapshot.bytes).catch(() => undefined);
    const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof idle === "function") idle.call(globalThis, start, { timeout: 1500 });
    else setTimeout(start, 50);
  }

  private offload(snapshot: ProSnapshot): void {
    const store = this.store;
    if (!store) return;
    const epoch = this.epoch;
    const pending = store.put(snapshot.id, snapshot.bytes).then(
      () => {
        this.putting.delete(snapshot.id);
        if (epoch !== this.epoch || !this.document) {
          void store.remove([snapshot.id]); // el documento se cerro entretanto: sin restos
          return;
        }
        const index = this.document.snapshots.findIndex((item) => item.id === snapshot.id);
        if (index < 0) {
          void store.remove([snapshot.id]); // descartado (rama de rehacer, presupuesto) mientras se escribia
          return;
        }
        this.storedIds.add(snapshot.id);
        // Puede haber vuelto a la ventana caliente (p. ej. se deshizo hasta el): entonces se queda en RAM.
        this.rebalance();
      },
      () => {
        this.putting.delete(snapshot.id);
        if (epoch !== this.epoch || !this.document) return;
        this.degrade(true);
      },
    );
    this.putting.set(snapshot.id, pending);
  }

  /** Espera (con plazo) a las escrituras en vuelo; un disco colgado no bloquea una confirmacion para siempre. */
  private async settleOffloads(timeoutMs = 10_000): Promise<void> {
    if (this.putting.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.putting.values()]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  /** Presupuesto de siempre sobre lo RESIDENTE (tras volcar). Si descarta algo, lo anuncia y lo borra del disco. */
  private applyBudget(trimmedText: string): void {
    const document = this.document;
    if (!document) return;
    const budget = enforceProBudget(
      { snapshots: document.snapshots, cursor: document.cursor },
      { maxSnapshots: this.maxSnapshots, maxBytes: this.maxBytes },
    );
    if (budget.evicted.length === 0) return;
    for (const dropped of budget.evicted) this.onEvict?.(dropped);
    this.forgetStored(budget.evicted);
    this.document = {
      ...document,
      snapshots: budget.snapshots,
      cursor: budget.cursor,
      trimmedCount: document.trimmedCount + budget.evicted.length,
    };
    this.announcement = { id: ++this.announcementId, text: `${this.announcement?.text ?? ""} ${trimmedText}`.trim() };
    this.recompute();
  }

  private prefetch(snapshot: ProSnapshot): void {
    const store = this.store;
    if (!store) return;
    const epoch = this.epoch;
    this.fetching.add(snapshot.id);
    store.get(snapshot.id).then(
      (bytes) => {
        this.fetching.delete(snapshot.id);
        if (!bytes || epoch !== this.epoch || !this.document) return;
        const index = this.document.snapshots.findIndex((item) => item.id === snapshot.id);
        if (index < 0 || !this.document.snapshots[index].offloaded) return;
        if (!this.hotIds(this.document).has(snapshot.id)) return; // ya salio de la ventana: no se trae
        this.replaceSnapshot(index, { ...this.document.snapshots[index], bytes, offloaded: false });
        this.recompute();
      },
      () => {
        this.fetching.delete(snapshot.id);
      },
    );
  }

  /**
   * El disco no esta o fallo: el historial vive solo en RAM. Se marca el documento (aviso visible en el panel), se
   * anuncia si se pide, y se aplica el presupuesto por bytes de siempre a lo residente.
   */
  private degrade(announce: boolean): void {
    const document = this.document;
    if (!document) return;
    const strings = getProStrings(this.language);
    const budget = enforceProBudget(
      { snapshots: document.snapshots, cursor: document.cursor },
      { maxSnapshots: this.maxSnapshots, maxBytes: this.maxBytes },
    );
    for (const evicted of budget.evicted) this.onEvict?.(evicted);
    this.forgetStored(budget.evicted);
    const alreadyFailed = document.historyOffloadFailed === true;
    if (alreadyFailed && budget.evicted.length === 0) return;
    this.document = {
      ...document,
      snapshots: budget.snapshots,
      cursor: budget.cursor,
      trimmedCount: document.trimmedCount + budget.evicted.length,
      historyOffloadFailed: true,
    };
    if (announce && !alreadyFailed) {
      const trimmed = budget.evicted.length > 0 ? ` ${strings.announce.historyTrimmed}` : "";
      this.announcement = { id: ++this.announcementId, text: `${strings.announce.historyOffloadFailed}${trimmed}` };
    } else if (budget.evicted.length > 0) {
      // Se SUMA al anuncio recien hecho (el «Deshecho: …» o el «Aplicado: …» que provoco el reequilibrio): un lector de
      // pantalla no debe perder el paso por el aviso de recorte.
      this.announcement = {
        id: ++this.announcementId,
        text: `${this.announcement?.text ?? ""} ${strings.announce.historyTrimmed}`.trim(),
      };
    }
    this.recompute();
  }

  /** Un paso volcado no se pudo recuperar: se retira del historial y se anuncia (nunca en silencio). */
  private loseStep(index: number): void {
    const document = this.document;
    if (!document) return;
    const strings = getProStrings(this.language);
    const result = dropSnapshotAt({ snapshots: document.snapshots, cursor: document.cursor }, index);
    this.storedIds.delete(result.dropped.id);
    this.document = {
      ...document,
      snapshots: result.snapshots,
      cursor: result.cursor,
      trimmedCount: document.trimmedCount + 1,
      historyOffloadFailed: true,
    };
    this.announcement = { id: ++this.announcementId, text: strings.announce.historyStepLost(result.dropped.label) };
    this.recompute();
  }

  /* ---------------- lectura ---------------- */

  /** Snapshot actual, o `null`. */
  currentSnapshot(): ProSnapshot | null {
    const document = this.document;
    return document ? document.snapshots[document.cursor] : null;
  }

  /** Bytes del snapshot actual. */
  current(): Uint8Array | null {
    return this.currentSnapshot()?.bytes ?? null;
  }

  /** El snapshot actual como `File` con el nombre del documento (para motores que piden `File`). */
  currentFile(): File | null {
    const snapshot = this.currentSnapshot();
    const document = this.document;
    if (!snapshot || !document) return null;
    if (this.fileCache?.id === snapshot.id) return this.fileCache.file;
    const file = new File([snapshot.bytes as unknown as BlobPart], document.name, {
      type: "application/pdf",
      lastModified: snapshot.createdAt,
    });
    this.fileCache = { id: snapshot.id, file };
    return file;
  }

  /** Numero de paginas del snapshot actual (0 sin documento). */
  get pageCount(): number {
    return this.state.pageCount;
  }

  get dirty(): boolean {
    return this.state.dirty;
  }

  get canUndo(): boolean {
    return this.state.canUndo;
  }

  get canRedo(): boolean {
    return this.state.canRedo;
  }

  get fingerprint(): string | null {
    return this.document?.fingerprint ?? null;
  }

  /* ---------------- modos con sesion propia ---------------- */

  /**
   * Un modo con sesion propia (Editar, Firmar...) se registra mientras esta activo.
   * Si declara `hasOwnUndo`, el Ctrl/Cmd+Z global NO actua (lo gestiona el modo). Devuelve
   * la funcion que lo retira. Se pueden registrar varios a la vez.
   */
  registerMode(modeId: ProModeId, registration: ProModeRegistration): () => void {
    const entry: ProModeRegistration = { hasOwnUndo: registration.hasOwnUndo };
    const list = this.modes.get(modeId) ?? [];
    this.modes.set(modeId, [...list, entry]);
    this.recompute();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.modes.get(modeId) ?? [];
      const next = current.filter((item) => item !== entry);
      if (next.length === 0) this.modes.delete(modeId);
      else this.modes.set(modeId, next);
      this.recompute();
    };
  }

  /** `true` si algun modo activo gestiona su propio deshacer. */
  isOwnUndoActive(): boolean {
    return this.state.ownUndoActive;
  }
}

/** Fabrica (tests y proveedores): un documento de trabajo nuevo. */
export function createProWorkingDoc(options?: ProWorkingDocOptions): ProWorkingDoc {
  return new ProWorkingDoc(options);
}
