import { PDFDocument } from "@cantoo/pdf-lib";
import type { Language } from "@/lib/i18n";
import { PdfError, readFileBytes, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";
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
 */

/**
 * Tope de NUMERO de snapshots en RAM (original + actual + intermedios). Es solo una red de seguridad: el limite que manda
 * es el de BYTES (`PRO_MAX_SNAPSHOT_BYTES`). Con un PDF pequeño caben decenas de pasos de deshacer; con uno grande,
 * los que quepan en ~400 MB.
 */
export const PRO_MAX_SNAPSHOTS = 50;
/** Presupuesto de bytes de todos los snapshots en RAM (~400 MB). */
export const PRO_MAX_SNAPSHOT_BYTES = 400 * 1024 * 1024;

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

type Evictable = { snapshots: ProSnapshot[]; cursor: number };


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

/**
 * Aplica el presupuesto: mientras haya mas de `maxSnapshots` o mas de `maxBytes`, descarta el
 * snapshot mas ANTIGUO que no sea el original (indice 0) ni el actual (`cursor`), de modo que queda siempre el
 * ORIGINAL + la cadena contigua mas reciente. El siguiente snapshot anota las etiquetas de lo descartado
 * (`skippedLabels`) para que deshacer lo anuncie. Puro: devuelve la lista nueva, el cursor reajustado y lo descartado.
 */
export function enforceProBudget(
  state: Evictable,
  limits: { maxSnapshots: number; maxBytes: number },
): Evictable & { evicted: ProSnapshot[] } {
  const snapshots = [...state.snapshots];
  let cursor = state.cursor;
  const evicted: ProSnapshot[] = [];
  const total = () => snapshots.reduce((sum, snapshot) => sum + snapshot.byteLength, 0);
  while (snapshots.length > limits.maxSnapshots || total() > limits.maxBytes) {
    let index = -1;
    for (let i = 1; i < snapshots.length; i += 1) {
      if (i !== cursor) {
        index = i;
        break;
      }
    }
    if (index < 0) break; // solo quedan el original y el actual: no hay mas que descartar
    const dropped = snapshots[index];
    evicted.push(dropped);
    snapshots.splice(index, 1);
    if (index < cursor) cursor -= 1;
    // El que queda justo despues hereda lo que se salta al deshacer (lo suyo antiguo, el descartado y lo posterior).
    const next = snapshots[index];
    if (next) {
      snapshots[index] = {
        ...next,
        skippedLabels: [...(dropped.skippedLabels ?? []), dropped.label, ...(next.skippedLabels ?? [])],
      };
    }
  }
  return { snapshots, cursor, evicted };
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

  constructor(options: ProWorkingDocOptions = {}) {
    this.maxSnapshots = options.maxSnapshots ?? PRO_MAX_SNAPSHOTS;
    this.maxBytes = options.maxBytes ?? PRO_MAX_SNAPSHOT_BYTES;
    this.now = options.now ?? (() => Date.now());
    this.language = options.language ?? "es";
    this.countPages = options.countPages ?? defaultCountPages;
    this.fingerprintFn = options.fingerprint ?? fingerprintProBytes;
    this.inspectSignaturesFn = options.inspectSignatures ?? defaultInspectSignatures;
    this.onEvict = options.onEvict;
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
      return { ok: true, document: this.document };
    } catch (error) {
      if (epoch !== this.epoch) return { ok: false, code: "cancelled" };
      const code = error instanceof PdfError ? error.code : toPdfError(error).code;
      return { ok: false, code };
    }
  }

  /** Cierra el documento y suelta todos los bytes. */
  close(): void {
    this.epoch += 1;
    this.chain = Promise.resolve();
    if (!this.document) return;
    this.document = null;
    this.fileCache = null;
    this.announcement = { id: ++this.announcementId, text: getProStrings(this.language).announce.closed };
    this.recompute();
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
      const budget = enforceProBudget(
        { snapshots: [...kept, snapshot], cursor: kept.length },
        { maxSnapshots: this.maxSnapshots, maxBytes: this.maxBytes },
      );
      for (const dropped of budget.evicted) this.onEvict?.(dropped);
      // El `File` en cache era una copia ENTERA del snapshot anterior: se suelta (se rehace al pedirlo).
      this.fileCache = null;
      const strings = getProStrings(this.language);
      const trimmed = budget.evicted.length > 0;
      this.document = {
        ...document,
        snapshots: budget.snapshots,
        cursor: budget.cursor,
        trimmedCount: document.trimmedCount + budget.evicted.length,
      };
      this.announcement = {
        id: ++this.announcementId,
        text: trimmed
          ? `${strings.announce.applied(label)}. ${strings.announce.historyTrimmed}`
          : strings.announce.applied(label),
      };
      this.recompute();
      return snapshot;
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => null);
    return result;
  }

  /**
   * Mueve el cursor y anuncia TODOS los pasos que se cruzan (varios si se salta con el historial, o si el presupuesto
   * de memoria descarto pasos intermedios): nunca se salta un paso en silencio.
   */
  private move(to: number, announce: (labels: string) => string): boolean {
    const document = this.document;
    if (!document) return false;
    if (to < 0 || to >= document.snapshots.length || to === document.cursor) return false;
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
    return true;
  }

  /** Vuelve un paso atras. `false` si no hay nada que deshacer. */
  undo(): boolean {
    const document = this.document;
    if (!document || document.cursor <= 0) return false;
    const strings = getProStrings(this.language);
    return this.move(document.cursor - 1, (labels) => strings.announce.undone(labels));
  }

  /** Avanza un paso. `false` si no hay nada que rehacer. */
  redo(): boolean {
    const document = this.document;
    if (!document || document.cursor >= document.snapshots.length - 1) return false;
    const strings = getProStrings(this.language);
    return this.move(document.cursor + 1, (labels) => strings.announce.redone(labels));
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
