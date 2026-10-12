import { PdfError } from "@/lib/pdf/core";
import { BLANK_PAGE_SIZES, type PageEntry } from "@/lib/pdf/pageAssembly";
import {
  deletePages,
  duplicatePages,
  idsByParity,
  idsInRange,
  insertBlankPages,
  insertExternalPages,
  insertImagePages,
  movePages,
  neighbourBlankSize,
  rotatePages,
  shiftPages,
} from "@/lib/pdf/pageAssemblyPlan";
import type { ImageLayout } from "@/lib/pdf/imagesToPdf";
import type { PagesStrings } from "@/app/pdf-pro/pages/pagesStrings";
import type { PagesStore } from "@/app/pdf-pro/pages/pagesStore";

/**
 * Acciones del organizador (Wave 7 · U4): cada una edita el plan virtual como UN paso de historial,
 * anuncia el resultado en la region viva unica y deja seleccion y foco donde el usuario espera.
 * Todas devuelven `true` si cambiaron algo.
 */

export type ActionDeps = {
  store: PagesStore;
  strings: PagesStrings;
  announce: (text: string) => void;
  /** Tamano visible de una entrada del plan (para heredar el de la vecina en las paginas en blanco). */
  sizeOf: (entry: PageEntry) => { width: number; height: number } | null;
};

export type InsertPosition = "start" | "before" | "after" | "end";

/** A que paginas afecta una accion: la seleccion (en orden del plan) o, sin ella, la pagina con el foco. */
export function actionTargets(store: PagesStore): string[] {
  const { plan, selection, focusId } = store.getState();
  if (selection.size > 0) return plan.filter((entry) => selection.has(entry.id as string)).map((entry) => entry.id as string);
  return focusId && plan.some((entry) => entry.id === focusId) ? [focusId] : [];
}

/** Hueco del plan (0..n) para colocar algo `position` respecto de la seleccion. */
export function positionIndex(store: PagesStore, position: InsertPosition): number {
  const { plan, selection, focusId } = store.getState();
  if (position === "start") return 0;
  if (position === "end") return plan.length;
  const marked = new Set(selection.size > 0 ? selection : focusId ? [focusId] : []);
  const indices = plan.map((entry, index) => (marked.has(entry.id as string) ? index : -1)).filter((index) => index >= 0);
  if (indices.length === 0) return position === "before" ? 0 : plan.length;
  return position === "before" ? indices[0] : indices[indices.length - 1] + 1;
}

function focusFirst(store: PagesStore, ids: readonly string[]): void {
  const { plan } = store.getState();
  const first = plan.find((entry) => ids.includes(entry.id as string));
  if (first) store.setFocus(first.id as string);
}

export function rotateTargets(deps: ActionDeps, degrees: 90 | -90 | 180): boolean {
  const { store, strings } = deps;
  const ids = actionTargets(store);
  if (ids.length === 0) return false;
  const changed = store.commit(rotatePages(store.getState().plan, ids, degrees), strings.label.join([strings.label.rotate(ids.length)]), "keep");
  if (changed) deps.announce(strings.announce.rotated(ids.length, degrees === 180 ? 180 : degrees));
  return changed;
}

/** `"blocked"` si quitaria todas las paginas (un PDF necesita al menos una). */
export function removeTargets(deps: ActionDeps): "removed" | "blocked" | "none" {
  const { store, strings } = deps;
  const ids = actionTargets(store);
  if (ids.length === 0) return "none";
  const state = store.getState();
  if (ids.length >= state.plan.length) {
    deps.announce(strings.announce.cannotRemoveAll);
    return "blocked";
  }
  const firstIndex = state.plan.findIndex((entry) => entry.id === ids[0]);
  let next: readonly PageEntry[];
  try {
    next = deletePages(state.plan, ids);
  } catch (error) {
    if (error instanceof PdfError && error.code === "empty") {
      deps.announce(strings.announce.cannotRemoveAll);
      return "blocked";
    }
    throw error;
  }
  if (!store.commit(next, strings.label.join([strings.label.remove(ids.length)]), "clear")) return "none";
  // El foco pasa a la pagina que ocupa ahora el sitio de la primera eliminada (o a la ultima).
  const after = store.getState().plan;
  const target = after[Math.min(firstIndex, after.length - 1)];
  store.setFocus(target ? (target.id as string) : null);
  deps.announce(strings.announce.removed(ids.length));
  return "removed";
}

export function duplicateTargets(deps: ActionDeps): boolean {
  const { store, strings } = deps;
  const ids = actionTargets(store);
  if (ids.length === 0) return false;
  const before = new Set(store.getState().plan.map((entry) => entry.id as string));
  const next = duplicatePages(store.getState().plan, ids);
  const created = next.filter((entry) => !before.has(entry.id as string)).map((entry) => entry.id as string);
  if (!store.commit(next, strings.label.join([strings.label.duplicate(ids.length)]), created)) return false;
  focusFirst(store, created);
  deps.announce(strings.announce.duplicated(ids.length));
  return true;
}

export function shiftTargets(deps: ActionDeps, direction: -1 | 1): boolean {
  const { store, strings } = deps;
  const ids = actionTargets(store);
  if (ids.length === 0) return false;
  const next = shiftPages(store.getState().plan, ids, direction);
  if (!store.commit(next, strings.label.join([strings.label.move(ids.length)]), ids)) return false;
  const position = next.findIndex((entry) => entry.id === ids[0]) + 1;
  deps.announce(strings.announce.moved(ids.length, position));
  return true;
}

/** Suelta `ids` justo antes del hueco `insertBefore` (arrastre). */
export function moveTargetsTo(deps: ActionDeps, ids: readonly string[], insertBefore: number): boolean {
  const { store, strings } = deps;
  if (ids.length === 0) return false;
  const next = movePages(store.getState().plan, ids, insertBefore);
  if (!store.commit(next, strings.label.join([strings.label.move(ids.length)]), ids)) return false;
  const first = next.findIndex((entry) => ids.includes(entry.id as string));
  store.setFocus(ids[0]);
  deps.announce(strings.announce.moved(ids.length, first + 1));
  return true;
}

export type BlankSizeChoice = "neighbour" | "a4" | "letter";

export function insertBlank(
  deps: ActionDeps,
  options: { position: InsertPosition; size: BlankSizeChoice; count: number },
): boolean {
  const { store, strings } = deps;
  const at = positionIndex(store, options.position);
  const plan = store.getState().plan;
  const size =
    options.size === "a4"
      ? { ...BLANK_PAGE_SIZES.a4 }
      : options.size === "letter"
        ? { ...BLANK_PAGE_SIZES.letter }
        : neighbourBlankSize(plan, at, deps.sizeOf);
  const next = insertBlankPages(plan, at, size, options.count);
  const before = new Set(plan.map((entry) => entry.id as string));
  const created = next.filter((entry) => !before.has(entry.id as string)).map((entry) => entry.id as string);
  if (!store.commit(next, strings.label.join([strings.label.blank(created.length)]), created)) return false;
  focusFirst(store, created);
  deps.announce(strings.announce.inserted(created.length, at + 1));
  return true;
}

export function insertPdfPages(
  deps: ActionDeps,
  sourceId: string,
  sourceIndices: readonly number[],
  position: InsertPosition,
): boolean {
  const { store, strings } = deps;
  if (sourceIndices.length === 0) return false;
  const at = positionIndex(store, position);
  const plan = store.getState().plan;
  const next = insertExternalPages(plan, at, sourceId, sourceIndices);
  const before = new Set(plan.map((entry) => entry.id as string));
  const created = next.filter((entry) => !before.has(entry.id as string)).map((entry) => entry.id as string);
  if (!store.commit(next, strings.label.join([strings.label.fromPdf(created.length)]), created)) return false;
  focusFirst(store, created);
  deps.announce(strings.announce.inserted(created.length, at + 1));
  return true;
}

/** Suma varios documentos completos (cada uno con todas sus paginas), en orden, en una posicion. */
export function mergeSources(
  deps: ActionDeps,
  sources: readonly { id: string; pageCount: number }[],
  position: InsertPosition,
): boolean {
  const { store, strings } = deps;
  if (sources.length === 0) return false;
  let at = positionIndex(store, position === "before" || position === "after" ? "end" : position);
  const startAt = at;
  let plan = store.getState().plan;
  const before = new Set(plan.map((entry) => entry.id as string));
  for (const source of sources) {
    plan = insertExternalPages(
      plan,
      at,
      source.id,
      Array.from({ length: source.pageCount }, (_, index) => index),
    );
    at += source.pageCount;
  }
  const created = plan.filter((entry) => !before.has(entry.id as string)).map((entry) => entry.id as string);
  if (!store.commit(plan, strings.label.join([strings.label.merge(sources.length)]), created)) return false;
  focusFirst(store, created);
  deps.announce(strings.announce.inserted(created.length, startAt + 1));
  return true;
}

export function insertImages(
  deps: ActionDeps,
  sourceIds: readonly string[],
  position: InsertPosition,
  layout?: Partial<ImageLayout>,
): boolean {
  const { store, strings } = deps;
  if (sourceIds.length === 0) return false;
  const at = positionIndex(store, position);
  const plan = store.getState().plan;
  const next = insertImagePages(plan, at, sourceIds, layout);
  const before = new Set(plan.map((entry) => entry.id as string));
  const created = next.filter((entry) => !before.has(entry.id as string)).map((entry) => entry.id as string);
  if (!store.commit(next, strings.label.join([strings.label.images(created.length)]), created)) return false;
  focusFirst(store, created);
  deps.announce(strings.announce.inserted(created.length, at + 1));
  return true;
}

/* ---------------- seleccion ---------------- */

export function selectAll(deps: ActionDeps): void {
  const { store, strings } = deps;
  const ids = store.getState().plan.map((entry) => entry.id as string);
  store.setSelection(ids, ids[0] ?? null);
  deps.announce(strings.announce.selected(ids.length));
}

export function clearSelection(deps: ActionDeps): void {
  const { store, strings } = deps;
  if (store.getState().selection.size === 0) return;
  store.setSelection([], null);
  deps.announce(strings.announce.selectionCleared);
}

export function selectParity(deps: ActionDeps, parity: "even" | "odd"): void {
  const { store, strings } = deps;
  const ids = idsByParity(store.getState().plan, parity);
  store.setSelection(ids, ids[0] ?? null);
  deps.announce(strings.announce.selected(ids.length));
}

export function selectPositions(deps: ActionDeps, positions: readonly number[]): void {
  const { store, strings } = deps;
  const plan = store.getState().plan;
  const ids: string[] = [];
  for (const position of positions) {
    const id = plan[position - 1]?.id;
    if (id !== undefined) ids.push(id);
  }
  store.setSelection(ids, ids[0] ?? null);
  deps.announce(strings.announce.selected(ids.length));
}

export function selectSpan(deps: ActionDeps, from: number, to: number): void {
  const { store, strings } = deps;
  const ids = idsInRange(store.getState().plan, from, to);
  store.setSelection(ids, ids[0] ?? null);
  deps.announce(strings.announce.selected(ids.length));
}

/* ---------------- historial ---------------- */

export function undoPlan(deps: ActionDeps): boolean {
  const label = deps.store.undo();
  deps.announce(label === null ? deps.strings.announce.nothingToUndo : deps.strings.announce.undone(label));
  return label !== null;
}

export function redoPlan(deps: ActionDeps): boolean {
  const label = deps.store.redo();
  deps.announce(label === null ? deps.strings.announce.nothingToRedo : deps.strings.announce.redone(label));
  return label !== null;
}
