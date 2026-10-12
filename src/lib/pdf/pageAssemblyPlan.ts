import { PdfError } from "@/lib/pdf/core";
import { normalizeRotation } from "@/lib/pdf/rotate";
import type { ImageLayout } from "@/lib/pdf/imagesToPdf";
import {
  BLANK_PAGE_SIZES,
  entryVisualSize,
  type PageEntry,
} from "@/lib/pdf/pageAssembly";

/**
 * Operaciones de alto nivel sobre el PLAN de paginas (Wave 7 · U4). Todas son PURAS: reciben un
 * plan (`PageEntry[]`) y devuelven uno nuevo; nunca tocan el documento. La seleccion se expresa
 * con los `id` de las entradas (estables al reordenar), no con posiciones.
 *
 * Una operacion que no cambia nada devuelve EL MISMO arreglo, para que la interfaz no apile
 * pasos de historial vacios.
 */

export type IdFactory = () => string;

let idCounter = 0;
/** Identificador unico por sesion (claves de React y seleccion). */
export const defaultPageId: IdFactory = () => {
  idCounter += 1;
  return `pg-${idCounter.toString(36)}`;
};

export type IdSelection = ReadonlySet<string> | readonly string[];

function toSet(ids: IdSelection): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids);
}

/** Da `id` a las entradas que no lo tienen (el resto se queda igual). */
export function ensureIds(plan: readonly PageEntry[], makeId: IdFactory = defaultPageId): PageEntry[] {
  return plan.map((entry) => (entry.id ? entry : { ...entry, id: makeId() }));
}

function sameOrder(a: readonly PageEntry[], b: readonly PageEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/* ------------------------------------------------------------------ *
 * Reordenar
 * ------------------------------------------------------------------ */

/**
 * Mueve las entradas seleccionadas (juntas, en su orden relativo) para que queden justo ANTES de
 * la posicion `insertBefore` del plan actual (0 = al principio, `plan.length` = al final).
 */
export function movePages(plan: readonly PageEntry[], ids: IdSelection, insertBefore: number): PageEntry[] {
  const selected = toSet(ids);
  const moving = plan.filter((entry) => entry.id !== undefined && selected.has(entry.id));
  if (moving.length === 0) return plan as PageEntry[];
  const clamped = Math.max(0, Math.min(plan.length, Math.floor(insertBefore)));
  const target = plan.slice(0, clamped).filter((entry) => !(entry.id !== undefined && selected.has(entry.id))).length;
  const rest = plan.filter((entry) => !(entry.id !== undefined && selected.has(entry.id)));
  const next = [...rest.slice(0, target), ...moving, ...rest.slice(target)];
  return sameOrder(plan, next) ? (plan as PageEntry[]) : next;
}

/** Desplaza cada bloque seleccionado una posicion hacia atras (-1) o hacia delante (+1). */
export function shiftPages(plan: readonly PageEntry[], ids: IdSelection, direction: -1 | 1): PageEntry[] {
  const selected = toSet(ids);
  const isSelected = (entry: PageEntry) => entry.id !== undefined && selected.has(entry.id);
  const next = [...plan];
  if (direction === -1) {
    for (let index = 1; index < next.length; index += 1) {
      if (isSelected(next[index]) && !isSelected(next[index - 1])) {
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
      }
    }
  } else {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (isSelected(next[index]) && !isSelected(next[index + 1])) {
        [next[index + 1], next[index]] = [next[index], next[index + 1]];
      }
    }
  }
  return sameOrder(plan, next) ? (plan as PageEntry[]) : next;
}

/* ------------------------------------------------------------------ *
 * Rotar, eliminar, duplicar
 * ------------------------------------------------------------------ */

/** Suma `degrees` (multiplo de 90, con signo) a la rotacion de las entradas seleccionadas. */
export function rotatePages(plan: readonly PageEntry[], ids: IdSelection, degrees: number): PageEntry[] {
  const selected = toSet(ids);
  const delta = normalizeRotation(degrees);
  if (delta === 0) return plan as PageEntry[];
  let changed = false;
  const next = plan.map((entry) => {
    if (entry.id === undefined || !selected.has(entry.id)) return entry;
    changed = true;
    return { ...entry, rotation: normalizeRotation(entry.rotation + delta) };
  });
  return changed ? next : (plan as PageEntry[]);
}

/**
 * Quita las entradas seleccionadas. Quitarlas TODAS dejaria un PDF sin paginas: error `empty`
 * (la interfaz lo impide antes; aqui se cubre por si acaso).
 */
export function deletePages(plan: readonly PageEntry[], ids: IdSelection): PageEntry[] {
  const selected = toSet(ids);
  const next = plan.filter((entry) => !(entry.id !== undefined && selected.has(entry.id)));
  if (next.length === plan.length) return plan as PageEntry[];
  if (next.length === 0) throw new PdfError("empty");
  return next;
}

function copyOf(entry: PageEntry, makeId: IdFactory): PageEntry {
  if (entry.kind === "existing") return { ...entry, copy: true, id: makeId() };
  return { ...entry, id: makeId() };
}

/**
 * Duplica las entradas seleccionadas: cada bloque contiguo se copia justo DESPUES de si mismo,
 * en el mismo orden. La copia nunca se queda con la hoja original.
 */
export function duplicatePages(
  plan: readonly PageEntry[],
  ids: IdSelection,
  makeId: IdFactory = defaultPageId,
): PageEntry[] {
  const selected = toSet(ids);
  const isSelected = (entry: PageEntry) => entry.id !== undefined && selected.has(entry.id);
  const out: PageEntry[] = [];
  let index = 0;
  let any = false;
  while (index < plan.length) {
    const entry = plan[index];
    if (!isSelected(entry)) {
      out.push(entry);
      index += 1;
      continue;
    }
    const run: PageEntry[] = [];
    while (index < plan.length && isSelected(plan[index])) {
      run.push(plan[index]);
      index += 1;
    }
    out.push(...run, ...run.map((item) => copyOf(item, makeId)));
    any = true;
  }
  return any ? out : (plan as PageEntry[]);
}

/* ------------------------------------------------------------------ *
 * Insertar
 * ------------------------------------------------------------------ */

function clampIndex(plan: readonly PageEntry[], index: number): number {
  return Math.max(0, Math.min(plan.length, Math.floor(index)));
}

/** Tamano en blanco: A4 o Carta (vertical), o el que se indique. */
export type BlankSize = { width: number; height: number };

export function insertBlankPages(
  plan: readonly PageEntry[],
  index: number,
  size: BlankSize,
  count = 1,
  makeId: IdFactory = defaultPageId,
): PageEntry[] {
  const at = clampIndex(plan, index);
  const blanks: PageEntry[] = Array.from({ length: Math.max(0, count) }, () => ({
    kind: "blank" as const,
    width: size.width,
    height: size.height,
    rotation: 0,
    id: makeId(),
  }));
  if (blanks.length === 0) return plan as PageEntry[];
  return [...plan.slice(0, at), ...blanks, ...plan.slice(at)];
}

/**
 * Tamano para una pagina en blanco insertada en `index`: el de la entrada ANTERIOR mas cercana
 * (o, si no hay, la siguiente), con la rotacion final que se vera. Sin vecinas, A4.
 */
export function neighbourBlankSize(
  plan: readonly PageEntry[],
  index: number,
  sizeOf: (entry: PageEntry) => { width: number; height: number } | null,
): BlankSize {
  const at = clampIndex(plan, index);
  for (let i = at - 1; i >= 0; i -= 1) {
    const size = entryVisualSize(plan[i], sizeOf);
    if (size) return { width: size.width, height: size.height };
  }
  for (let i = at; i < plan.length; i += 1) {
    const size = entryVisualSize(plan[i], sizeOf);
    if (size) return { width: size.width, height: size.height };
  }
  return { ...BLANK_PAGE_SIZES.a4 };
}

export function insertExternalPages(
  plan: readonly PageEntry[],
  index: number,
  sourceId: string,
  sourceIndices: readonly number[],
  makeId: IdFactory = defaultPageId,
): PageEntry[] {
  const at = clampIndex(plan, index);
  const added: PageEntry[] = sourceIndices.map((sourceIndex) => ({
    kind: "external" as const,
    sourceId,
    sourceIndex,
    rotation: 0,
    id: makeId(),
  }));
  if (added.length === 0) return plan as PageEntry[];
  return [...plan.slice(0, at), ...added, ...plan.slice(at)];
}

/** Anade TODAS las paginas de otro PDF (`pageCount` paginas) en `index` (por defecto, al final). */
export function appendDocument(
  plan: readonly PageEntry[],
  sourceId: string,
  pageCount: number,
  index: number = plan.length,
  makeId: IdFactory = defaultPageId,
): PageEntry[] {
  return insertExternalPages(
    plan,
    index,
    sourceId,
    Array.from({ length: Math.max(0, pageCount) }, (_, i) => i),
    makeId,
  );
}

export function insertImagePages(
  plan: readonly PageEntry[],
  index: number,
  sourceIds: readonly string[],
  layout?: Partial<ImageLayout>,
  makeId: IdFactory = defaultPageId,
): PageEntry[] {
  const at = clampIndex(plan, index);
  const added: PageEntry[] = sourceIds.map((sourceId) => ({
    kind: "image" as const,
    sourceId,
    rotation: 0,
    ...(layout ? { layout } : {}),
    id: makeId(),
  }));
  if (added.length === 0) return plan as PageEntry[];
  return [...plan.slice(0, at), ...added, ...plan.slice(at)];
}

/** Las entradas seleccionadas, en el orden del plan (para extraer). */
export function selectedEntries(plan: readonly PageEntry[], ids: IdSelection): PageEntry[] {
  const selected = toSet(ids);
  return plan.filter((entry) => entry.id !== undefined && selected.has(entry.id));
}

/* ------------------------------------------------------------------ *
 * Seleccion por posicion
 * ------------------------------------------------------------------ */

/** Ids de las paginas en posiciones pares (2, 4, ...) o impares (1, 3, ...) segun se VEN. */
export function idsByParity(plan: readonly PageEntry[], parity: "even" | "odd"): string[] {
  const ids: string[] = [];
  plan.forEach((entry, index) => {
    const position = index + 1;
    if (entry.id !== undefined && (parity === "odd" ? position % 2 === 1 : position % 2 === 0)) ids.push(entry.id);
  });
  return ids;
}

/** Ids de las posiciones `from..to` (1-based, inclusivo). */
export function idsInRange(plan: readonly PageEntry[], from: number, to: number): string[] {
  const low = Math.max(1, Math.min(from, to));
  const high = Math.min(plan.length, Math.max(from, to));
  const ids: string[] = [];
  for (let position = low; position <= high; position += 1) {
    const id = plan[position - 1]?.id;
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * Resumen de cambios
 * ------------------------------------------------------------------ */

export type PlanSummary = {
  /** Paginas originales que cambiaron de sitio (minimo de movimientos). */
  moved: number;
  /** Entradas con rotacion distinta de 0. */
  rotated: number;
  /** Paginas originales que ya no estan. */
  deleted: number;
  /** Copias de paginas (duplicados). */
  duplicated: number;
  blanks: number;
  /** Paginas de otro PDF. */
  external: number;
  images: number;
  /** El plan deja el documento tal cual. */
  identity: boolean;
};

/** Longitud de la subsecuencia creciente mas larga (O(n log n)). */
function longestIncreasing(values: readonly number[]): number {
  const tails: number[] = [];
  for (const value of values) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
  }
  return tails.length;
}

/** Que hace un plan respecto del documento original (para la etiqueta del snapshot y los avisos). */
export function summarizePlan(plan: readonly PageEntry[], pageCount: number): PlanSummary {
  const seen = new Set<number>();
  const order: number[] = [];
  let duplicated = 0;
  let blanks = 0;
  let external = 0;
  let images = 0;
  let rotated = 0;
  for (const entry of plan) {
    if (normalizeRotation(entry.rotation) !== 0) rotated += 1;
    if (entry.kind === "existing") {
      if (entry.copy || seen.has(entry.sourceIndex)) {
        duplicated += 1;
      } else {
        seen.add(entry.sourceIndex);
        order.push(entry.sourceIndex);
      }
    } else if (entry.kind === "blank") blanks += 1;
    else if (entry.kind === "external") external += 1;
    else images += 1;
  }
  const deleted = Math.max(0, pageCount - seen.size);
  const moved = order.length - longestIncreasing(order);
  const identity = plan.length === pageCount && rotated === 0 && duplicated === 0 && isOrdered(plan);
  return { moved, rotated, deleted, duplicated, blanks, external, images, identity };
}

function isOrdered(plan: readonly PageEntry[]): boolean {
  return plan.every((entry, index) => entry.kind === "existing" && entry.sourceIndex === index && !entry.copy);
}
