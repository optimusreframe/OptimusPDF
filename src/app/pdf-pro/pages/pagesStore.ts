import type { PdfErrorCode } from "@/lib/pdf/core";
import {
  identityPlan,
  type ExternalSource,
  type PageEntry,
  type PageInfo,
} from "@/lib/pdf/pageAssembly";
import { defaultPageId, summarizePlan, type IdFactory, type PlanSummary } from "@/lib/pdf/pageAssemblyPlan";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Estado del organizador de paginas (Wave 7 · U4): el PLAN virtual que se edita al instante, su
 * propia pila de deshacer/rehacer, la seleccion y los documentos/imagenes que se han ido sumando.
 * Modulo sin React: `usePagesStore` lo conecta con `useSyncExternalStore`.
 *
 * Vive en un `WeakMap` por documento de trabajo (`getPagesStore`), asi que sobrevive a cambiar de
 * pestana y se descarta solo cuando el snapshot base cambia por otra via (deshacer global, otra
 * operacion): el plan ya no describiria el documento que hay.
 */

export const MAX_PAGES_PDF_SOURCES = 10;
/** Pasos de deshacer que se conservan (cada uno comparte las entradas con el anterior: es barato). */
export const MAX_PAGES_HISTORY = 200;

export type PagesSourceStatus = "reading" | "password" | "ready" | "error";

export type PagesSource = {
  id: string;
  kind: "pdf" | "image";
  name: string;
  size: number;
  status: PagesSourceStatus;
  error?: PdfErrorCode;
  /** El archivo elegido (para pedir la contrasena de nuevo). */
  file?: File;
  /** PDF listo para el motor (copia descifrada si estaba cifrado). */
  data?: Uint8Array;
  /** Imagen lista para el motor. */
  blob?: Blob;
  pageCount?: number;
  infos?: PageInfo[];
  /** URL local de la imagen para la miniatura (se revoca al soltar la fuente). */
  previewUrl?: string;
  /** Se abrio con una copia descifrada. */
  decrypted?: boolean;
};

export type PagesHistoryStep = {
  /** El plan DESPUES de este paso (en `past`: el de ANTES; ver `undo`). */
  plan: readonly PageEntry[];
  /** Descripcion corta del paso («Girar 3 páginas»), ya traducida. */
  label: string;
};

export type PagesState = {
  /** Snapshot del documento de trabajo del que parte el plan. */
  baseSnapshotId: string | null;
  basePageCount: number;
  plan: readonly PageEntry[];
  past: readonly PagesHistoryStep[];
  future: readonly PagesHistoryStep[];
  selection: ReadonlySet<string>;
  /** Extremo fijo de la seleccion con Mayus. */
  anchorId: string | null;
  focusId: string | null;
  sources: Readonly<Record<string, PagesSource>>;
  summary: PlanSummary;
  /** Hay cambios sin aplicar (el plan no es la identidad). */
  dirty: boolean;
  /** «N cambios sin aplicar»: pasos hechos si el plan difiere del documento, 0 si no. */
  changeCount: number;
};

export type SelectionInput = ReadonlySet<string> | readonly string[];

const EMPTY_SET: ReadonlySet<string> = new Set();

function toSet(input: SelectionInput): ReadonlySet<string> {
  return input instanceof Set ? input : new Set(input);
}

function revoke(source: PagesSource): void {
  if (!source.previewUrl) return;
  try {
    URL.revokeObjectURL(source.previewUrl);
  } catch {
    // jsdom o un contexto sin URL.revokeObjectURL: nada que soltar.
  }
}

export class PagesStore {
  private state: PagesState;
  private readonly listeners = new Set<() => void>();
  /** Se esta aplicando el plan: el cambio de snapshot que sigue es nuestro, no un descarte. */
  private applying = false;
  private readonly makeId: IdFactory;

  constructor(makeId: IdFactory = defaultPageId) {
    this.makeId = makeId;
    this.state = this.build({
      baseSnapshotId: null,
      basePageCount: 0,
      plan: [],
      past: [],
      future: [],
      selection: EMPTY_SET,
      anchorId: null,
      focusId: null,
      sources: {},
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): PagesState => this.state;

  private build(
    base: Omit<PagesState, "summary" | "dirty" | "changeCount">,
  ): PagesState {
    const summary = summarizePlan(base.plan, base.basePageCount);
    const dirty = base.basePageCount > 0 && !summary.identity;
    return {
      ...base,
      summary,
      dirty,
      changeCount: dirty ? Math.max(1, base.past.length) : 0,
    };
  }

  private set(next: Omit<PagesState, "summary" | "dirty" | "changeCount">): void {
    this.state = this.build(next);
    for (const listener of [...this.listeners]) listener();
  }

  private releaseSources(sources: Readonly<Record<string, PagesSource>>): void {
    for (const source of Object.values(sources)) revoke(source);
  }

  /* ---------------- base ---------------- */

  /**
   * Alinea el plan con el snapshot actual del documento. Si el snapshot cambio, el plan se
   * reinicia a la identidad (y las fuentes se sueltan). Devuelve `discarded` cuando habia cambios
   * sin aplicar que se perdieron por ello.
   */
  syncBase(snapshotId: string, pageCount: number): "unchanged" | "reset" | "discarded" {
    const current = this.state;
    if (current.baseSnapshotId === snapshotId && current.basePageCount === pageCount) return "unchanged";
    const hadPending = current.dirty && !this.applying;
    this.applying = false;
    this.releaseSources(current.sources);
    this.set({
      baseSnapshotId: snapshotId,
      basePageCount: pageCount,
      plan: identityPlan(pageCount, () => this.makeId()),
      past: [],
      future: [],
      selection: EMPTY_SET,
      anchorId: null,
      focusId: null,
      sources: {},
    });
    return hadPending ? "discarded" : "reset";
  }

  /** Marca que el siguiente cambio de snapshot lo provoca «Aplicar» (no es un descarte). */
  beginApply(): void {
    this.applying = true;
  }

  /** «Aplicar» fallo o se cancelo: el plan sigue pendiente. */
  cancelApply(): void {
    this.applying = false;
  }

  /** Vuelve a la identidad y suelta los documentos sumados. `true` si habia algo que descartar. */
  discard(): boolean {
    const current = this.state;
    if (current.baseSnapshotId === null) return false;
    const had = current.dirty || Object.keys(current.sources).length > 0 || current.past.length > 0;
    this.releaseSources(current.sources);
    this.set({
      ...current,
      plan: identityPlan(current.basePageCount, () => this.makeId()),
      past: [],
      future: [],
      selection: EMPTY_SET,
      anchorId: null,
      focusId: null,
      sources: {},
    });
    return had;
  }

  /* ---------------- edicion con historial propio ---------------- */

  /**
   * Sustituye el plan por `next` como UN paso de historial. Si es el mismo arreglo, no hace nada
   * (devuelve `false`). `select`: `"keep"` conserva la seleccion (solo ids que aun existen),
   * `"clear"` la vacia, o una lista de ids a seleccionar.
   */
  commit(
    next: readonly PageEntry[],
    label: string,
    select: "keep" | "clear" | SelectionInput = "keep",
  ): boolean {
    const current = this.state;
    if (next === current.plan) return false;
    const ids = new Set(next.map((entry) => entry.id));
    let selection: ReadonlySet<string>;
    if (select === "keep") selection = new Set([...current.selection].filter((id) => ids.has(id)));
    else if (select === "clear") selection = EMPTY_SET;
    else selection = new Set([...toSet(select)].filter((id) => ids.has(id)));
    const past = [...current.past, { plan: current.plan, label }].slice(-MAX_PAGES_HISTORY);
    const anchorId = current.anchorId && ids.has(current.anchorId) ? current.anchorId : null;
    const focusId = current.focusId && ids.has(current.focusId) ? current.focusId : null;
    this.set({ ...current, plan: next, past, future: [], selection, anchorId, focusId });
    return true;
  }

  /** Deshace el ultimo paso del organizador. Devuelve su descripcion, o `null` si no hay nada. */
  undo(): string | null {
    const current = this.state;
    const step = current.past[current.past.length - 1];
    if (!step) return null;
    return this.travel(step, current.past.slice(0, -1), [...current.future, { plan: current.plan, label: step.label }]);
  }

  /** Rehace el ultimo paso deshecho. */
  redo(): string | null {
    const current = this.state;
    const step = current.future[current.future.length - 1];
    if (!step) return null;
    return this.travel(
      step,
      [...current.past, { plan: current.plan, label: step.label }].slice(-MAX_PAGES_HISTORY),
      current.future.slice(0, -1),
    );
  }

  private travel(
    target: PagesHistoryStep,
    past: readonly PagesHistoryStep[],
    future: readonly PagesHistoryStep[],
  ): string {
    const current = this.state;
    const ids = new Set(target.plan.map((entry) => entry.id));
    this.set({
      ...current,
      plan: target.plan,
      past,
      future,
      selection: new Set([...current.selection].filter((id) => ids.has(id))),
      anchorId: current.anchorId && ids.has(current.anchorId) ? current.anchorId : null,
      focusId: current.focusId && ids.has(current.focusId) ? current.focusId : null,
    });
    return target.label;
  }

  get canUndo(): boolean {
    return this.state.past.length > 0;
  }

  get canRedo(): boolean {
    return this.state.future.length > 0;
  }

  /* ---------------- seleccion y foco ---------------- */

  setSelection(ids: SelectionInput, anchorId?: string | null, focusId?: string | null): void {
    const current = this.state;
    const valid = new Set(current.plan.map((entry) => entry.id));
    const selection = new Set([...toSet(ids)].filter((id) => valid.has(id)));
    this.set({
      ...current,
      selection,
      anchorId: anchorId === undefined ? current.anchorId : anchorId,
      focusId: focusId === undefined ? current.focusId : focusId,
    });
  }

  setFocus(id: string | null): void {
    if (this.state.focusId === id) return;
    this.set({ ...this.state, focusId: id });
  }

  /* ---------------- documentos e imagenes sumados ---------------- */

  /** Numero de documentos PDF externos ya sumados (cuentan para el limite). */
  pdfSourceCount(): number {
    return Object.values(this.state.sources).filter((source) => source.kind === "pdf").length;
  }

  addSource(source: PagesSource): void {
    const current = this.state;
    this.set({ ...current, sources: { ...current.sources, [source.id]: source } });
  }

  patchSource(id: string, patch: Partial<PagesSource>): void {
    const current = this.state;
    const existing = current.sources[id];
    if (!existing) return;
    this.set({ ...current, sources: { ...current.sources, [id]: { ...existing, ...patch } } });
  }

  /** Quita una fuente que ningun paso del plan (ni del historial) usa. */
  removeSource(id: string): void {
    const current = this.state;
    const existing = current.sources[id];
    if (!existing || this.isSourceReferenced(id)) return;
    revoke(existing);
    const sources = { ...current.sources };
    delete sources[id];
    this.set({ ...current, sources });
  }

  private isSourceReferenced(id: string): boolean {
    const uses = (plan: readonly PageEntry[]) =>
      plan.some((entry) => (entry.kind === "external" || entry.kind === "image") && entry.sourceId === id);
    const { plan, past, future } = this.state;
    return uses(plan) || past.some((step) => uses(step.plan)) || future.some((step) => uses(step.plan));
  }

  /** Fuentes que usa el plan actual, como entrada del motor. */
  externalsForPlan(): Record<string, ExternalSource> {
    const out: Record<string, ExternalSource> = {};
    for (const entry of this.state.plan) {
      if (entry.kind !== "external" && entry.kind !== "image") continue;
      const source = this.state.sources[entry.sourceId];
      const data = source?.kind === "pdf" ? source.data : source?.blob;
      if (source && data) out[entry.sourceId] = data;
    }
    return out;
  }

  /** Suelta todo (al desmontar el documento). */
  dispose(): void {
    this.releaseSources(this.state.sources);
    this.listeners.clear();
  }
}

const stores = new WeakMap<ProWorkingDoc, PagesStore>();

/** El organizador del documento de trabajo dado (uno por instancia; sobrevive al cambio de pestana). */
export function getPagesStore(doc: ProWorkingDoc): PagesStore {
  let store = stores.get(doc);
  if (!store) {
    store = new PagesStore();
    stores.set(doc, store);
  }
  return store;
}
