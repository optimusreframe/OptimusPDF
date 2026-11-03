import { fieldTypeOf, type DetectedField } from "@/lib/pdf/detectFields";
import { isMemoryTag, tagOf } from "@/lib/fieldTags";

/**
 * Propagacion de un dato entre los campos que llevan la MISMA etiqueta (puro, sin React ni almacenamiento).
 *
 * Cuando la persona confirma un campo con etiqueta y valor, los DEMAS campos de texto de la sesion con esa etiqueta (todas
 * las paginas y todos los documentos del conjunto) se rellenan solos:
 *  - nunca se pisa lo que la persona escribio o ya relleno;
 *  - lo autorrellenado se MARCA (`"filled"`); mientras siga marcado y sin tocar, si la persona edita el campo origen el
 *    cambio le llega tambien;
 *  - tocar un campo marcado (escribir en el) lo suelta de la cola: pasa a ser un valor de la persona;
 *  - deshacer deja esos campos como estaban y los saca de la cola (`"declined"`: no se vuelven a rellenar solos).
 * Solo se propaga entre campos del MISMO tipo (texto con texto, fecha con fecha): una fecha ISO no cabe en un campo de texto.
 * La memoria PERSISTENTE (otros documentos o clientes) no entra aqui: solo SUGIERE (`valueHistory.ts`).
 */

/** `"filled"` = lo relleno la propagacion y nadie lo ha tocado; `"declined"` = la persona lo deshizo: queda fuera de la cola. */
export type AutoMark = "filled" | "declined";
export type AutoMarks = Readonly<Record<string, AutoMark>>;

/** Lo que la propagacion necesita de UN documento (un recorte de `DocState`). */
export type PropDoc = {
  textFields: readonly DetectedField[];
  textValues: Readonly<Record<string, string>>;
  autoFilled?: AutoMarks;
};
export type PropDocs = Readonly<Record<string, PropDoc>>;

/** Que cambio en un campo; con esto se deshace exactamente. */
export type FieldChange = {
  docId: string;
  fieldId: string;
  /** Valor de antes (`undefined` = el campo no tenia entrada de valor). */
  before: string | undefined;
  beforeMark: AutoMark | undefined;
  after: string;
};

/** Parche de UN documento: los dos mapas completos (ya con el cambio aplicado). */
export type DocPatch = { textValues: Record<string, string>; autoFilled: Record<string, AutoMark> };

export type Plan = {
  patches: Record<string, DocPatch>;
  changes: FieldChange[];
};

const EMPTY_PLAN: Plan = { patches: {}, changes: [] };

/** Tipos de campo que llevan etiqueta y propagan: texto y fecha (no casillas ni iniciales). */
export function isTaggableType(field: DetectedField): boolean {
  const type = fieldTypeOf(field);
  return type === "text" || type === "date";
}

function isEmpty(value: string | undefined): boolean {
  return (value ?? "").trim() === "";
}

/** Orden de lectura: pagina, de arriba abajo, de izquierda a derecha. */
function reading(a: DetectedField, b: DetectedField): number {
  return a.pageIndex - b.pageIndex || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}

function emptyPatch(doc: PropDoc): DocPatch {
  return { textValues: { ...doc.textValues }, autoFilled: { ...(doc.autoFilled ?? {}) } };
}

/**
 * Plan de lo que cambia al CONFIRMAR el campo `origin` (valor ya escrito en `docs`). Vacio si el campo no lleva etiqueta
 * (o es la fecha de hoy), no tiene valor, o es un campo que solo seguia a otro (autorrellenado y sin tocar).
 */
export function planPropagation(
  docs: PropDocs,
  order: readonly string[],
  origin: { docId: string; fieldId: string },
): Plan {
  const source = docs[origin.docId];
  const field = source?.textFields.find((candidate) => candidate.id === origin.fieldId);
  if (!source || !field || !isTaggableType(field)) return EMPTY_PLAN;
  const tag = tagOf(field);
  if (!tag || !isMemoryTag(tag)) return EMPTY_PLAN;
  const value = (source.textValues[field.id] ?? "").trim();
  if (value === "") return EMPTY_PLAN;
  if (source.autoFilled?.[field.id] === "filled") return EMPTY_PLAN;
  return fillSameTag(docs, order, tag, fieldTypeOf(field), value, { docId: origin.docId, fieldId: field.id });
}

function fillSameTag(
  docs: PropDocs,
  order: readonly string[],
  tag: string,
  type: ReturnType<typeof fieldTypeOf>,
  value: string,
  skip: { docId: string; fieldId: string } | null,
): Plan {
  const patches: Record<string, DocPatch> = {};
  const changes: FieldChange[] = [];
  const ids = order.length > 0 ? order : Object.keys(docs);
  for (const docId of ids) {
    const doc = docs[docId];
    if (!doc) continue;
    const targets = [...doc.textFields].sort(reading);
    for (const target of targets) {
      if (skip && skip.docId === docId && skip.fieldId === target.id) continue;
      if (!isTaggableType(target) || fieldTypeOf(target) !== type || tagOf(target) !== tag) continue;
      const mark = doc.autoFilled?.[target.id];
      if (mark === "declined") continue;
      const current = doc.textValues[target.id];
      const empty = isEmpty(current);
      // Un valor que la persona puso (o dejo marcado como suyo) no se pisa; uno autorrellenado y sin tocar sigue al origen.
      if (!empty && mark !== "filled") continue;
      if (!empty && current === value) continue;
      const patch = (patches[docId] ??= emptyPatch(doc));
      patch.textValues[target.id] = value;
      patch.autoFilled[target.id] = "filled";
      changes.push({ docId, fieldId: target.id, before: current, beforeMark: mark, after: value });
    }
  }
  return changes.length > 0 ? { patches, changes } : EMPTY_PLAN;
}

/**
 * El dato que la sesion ya tiene para `tag` (para rellenar un campo recien etiquetado). `memo` = el ultimo valor confirmado
 * con esa etiqueta, si sigue siendo el que tiene su campo; si no, el primero que haya en el orden de lectura, mejor uno
 * escrito por la persona que uno autorrellenado.
 */
export function sessionValueForTag(
  docs: PropDocs,
  order: readonly string[],
  tag: string,
  type: ReturnType<typeof fieldTypeOf>,
  skip: { docId: string; fieldId: string },
  memo?: { value: string; docId: string; fieldId: string } | null,
): string | null {
  if (!isMemoryTag(tag)) return null;
  if (memo && !(memo.docId === skip.docId && memo.fieldId === skip.fieldId)) {
    const doc = docs[memo.docId];
    const field = doc?.textFields.find((candidate) => candidate.id === memo.fieldId);
    if (doc && field && tagOf(field) === tag && doc.textValues[memo.fieldId] === memo.value && !isEmpty(memo.value)) {
      return memo.value.trim();
    }
  }
  const ids = order.length > 0 ? order : Object.keys(docs);
  let fallback: string | null = null;
  for (const docId of ids) {
    const doc = docs[docId];
    if (!doc) continue;
    for (const field of [...doc.textFields].sort(reading)) {
      if (docId === skip.docId && field.id === skip.fieldId) continue;
      if (!isTaggableType(field) || fieldTypeOf(field) !== type || tagOf(field) !== tag) continue;
      const value = doc.textValues[field.id];
      if (isEmpty(value)) continue;
      if (doc.autoFilled?.[field.id] !== "filled") return (value as string).trim();
      fallback ??= (value as string).trim();
    }
  }
  return fallback;
}

/** Rellena el campo `target` (recien etiquetado y vacio) con el dato que la sesion ya tiene para su etiqueta. */
export function planFillFromSession(
  docs: PropDocs,
  order: readonly string[],
  target: { docId: string; fieldId: string },
  memo?: { value: string; docId: string; fieldId: string } | null,
): Plan {
  const doc = docs[target.docId];
  const field = doc?.textFields.find((candidate) => candidate.id === target.fieldId);
  if (!doc || !field || !isTaggableType(field)) return EMPTY_PLAN;
  const tag = tagOf(field);
  if (!tag || !isMemoryTag(tag) || !isEmpty(doc.textValues[field.id])) return EMPTY_PLAN;
  const value = sessionValueForTag(docs, order, tag, fieldTypeOf(field), target, memo);
  if (value === null) return EMPTY_PLAN;
  const patch = emptyPatch(doc);
  patch.textValues[field.id] = value;
  patch.autoFilled[field.id] = "filled";
  return {
    patches: { [target.docId]: patch },
    changes: [{ docId: target.docId, fieldId: field.id, before: doc.textValues[field.id], beforeMark: doc.autoFilled?.[field.id], after: value }],
  };
}

/**
 * Deshace `changes` EXACTAMENTE: cada campo vuelve a su valor de antes y sale de la cola (`"declined"`). Un campo que la
 * persona toco despues (su valor ya no es el que puso la propagacion) se deja como esta.
 */
export function planUndo(docs: PropDocs, changes: readonly FieldChange[]): Plan {
  const patches: Record<string, DocPatch> = {};
  const reverted: FieldChange[] = [];
  for (const change of changes) {
    const doc = docs[change.docId];
    if (!doc || !doc.textFields.some((field) => field.id === change.fieldId)) continue;
    if ((doc.textValues[change.fieldId] ?? "") !== change.after) continue;
    const patch = (patches[change.docId] ??= emptyPatch(doc));
    if (change.before === undefined) delete patch.textValues[change.fieldId];
    else patch.textValues[change.fieldId] = change.before;
    patch.autoFilled[change.fieldId] = "declined";
    reverted.push({ ...change, before: change.after, beforeMark: "filled", after: change.before ?? "" });
  }
  return reverted.length > 0 ? { patches, changes: reverted } : EMPTY_PLAN;
}

/** Quita una marca (la persona escribio en el campo, lo borro o le cambio la etiqueta). `null` si no habia ninguna. */
export function withoutMark(marks: AutoMarks | undefined, id: string): AutoMarks | null {
  if (!marks || !(id in marks)) return null;
  const next = { ...marks };
  delete next[id];
  return next;
}

/** Deja en `marks` solo las marcas de campos que siguen existiendo. Misma referencia si no sobra ninguna. */
export function pruneMarks(marks: AutoMarks | undefined, alive: ReadonlySet<string>): AutoMarks | undefined {
  if (!marks) return marks;
  const ids = Object.keys(marks);
  if (ids.every((id) => alive.has(id))) return marks;
  const next: Record<string, AutoMark> = {};
  for (const id of ids) if (alive.has(id)) next[id] = marks[id];
  return next;
}
