import type { DocId, DocState } from "@/app/sign-pdf/docSet";
import { fieldTypeOf, type DetectedField } from "@/lib/pdf/detectFields";
import { defaultSoloRect, refitSoloRect } from "@/app/sign-pdf/soloSignature";
import type { NormalizedRect } from "@/lib/pdf/watermark";

/*
 * Aritmetica de la vista continua (W4-U4): varios PDF individuales que se
 * ven como UNO. Funciones puras, sin React ni pdf.js. El paginador global, la
 * navegacion entre documentos, el salto al siguiente campo pendiente de otro
 * documento y "Aplicar a todos los documentos" de "Solo yo" salen de aqui.
 */

/** Paginas de cada documento; `undefined` = aun no se sabe. */
export type PageCounts = Readonly<Record<DocId, number | undefined>>;

export type SequencePosition = {
  /** Posicion del documento en la cola (1-based). */
  docNumber: number;
  docCount: number;
  /** Pagina dentro del documento (1-based) y total del documento (`null` = aun no se sabe). */
  local: number;
  localTotal: number | null;
  /** Numeracion global «Pagina 7 de 12»; `null` mientras falte el recuento de algun documento. */
  global: number | null;
  total: number | null;
};

/**
 * Donde esta la persona dentro del PDF continuo. El numero global solo se da
 * cuando se conoce el recuento de TODOS los documentos: un «7 de 12» a medias
 * (con los de delante contados y los de detras no) cambiaria de total a cada
 * recuento que llegue.
 */
export function sequencePosition(
  order: readonly DocId[],
  counts: PageCounts,
  docId: DocId,
  pageIndex: number,
): SequencePosition {
  const index = Math.max(0, order.indexOf(docId));
  const own = counts[docId];
  const local = pageIndex + 1;
  let total: number | null = 0;
  let before = 0;
  order.forEach((id, position) => {
    const count = counts[id];
    if (count === undefined) {
      total = null;
      return;
    }
    if (total !== null) total += count;
    if (position < index) before += count;
  });
  return {
    docNumber: index + 1,
    docCount: order.length,
    local,
    localTotal: own ?? null,
    global: total === null ? null : before + local,
    total,
  };
}

export type PageTarget = { docId: DocId; pageIndex: number };

/**
 * Pagina siguiente (`dir` 1) o anterior (-1) de la secuencia, cruzando de un
 * documento al vecino en los limites. `null` = no hay (primera/ultima pagina
 * del conjunto) o aun no se puede saber (recuento del documento vecino
 * pendiente al retroceder, o del actual al avanzar).
 */
export function stepPage(
  order: readonly DocId[],
  counts: PageCounts,
  from: PageTarget,
  dir: 1 | -1,
): PageTarget | null {
  const index = order.indexOf(from.docId);
  if (index === -1) return null;
  if (dir === 1) {
    const own = counts[from.docId];
    if (own === undefined) return null;
    if (from.pageIndex + 1 < own) {
      return { docId: from.docId, pageIndex: from.pageIndex + 1 };
    }
    const next = order[index + 1];
    return next ? { docId: next, pageIndex: 0 } : null;
  }
  if (from.pageIndex > 0) {
    return { docId: from.docId, pageIndex: from.pageIndex - 1 };
  }
  const previous = order[index - 1];
  if (!previous) return null;
  const count = counts[previous];
  return count === undefined ? null : { docId: previous, pageIndex: count - 1 };
}

/* ------------------------------------------------------------------ *
 * Siguiente campo pendiente entre documentos
 * ------------------------------------------------------------------ */

export type PendingTarget = { docId: DocId; fieldId: string; pageIndex: number };

/** Orden de lectura: pagina, luego de arriba abajo y de izquierda a derecha. */
function readingOrder(a: DetectedField, b: DetectedField): number {
  return (
    a.pageIndex - b.pageIndex || a.rect.y - b.rect.y || a.rect.x - b.rect.x
  );
}

/**
 * Pendiente para la navegacion de un documento que NO esta abierto: sin valor
 * (una casilla sin marcar tambien lo es: nadie la ha visitado aun en este
 * documento, porque el lienzo recuerda las visitadas solo mientras esta
 * montado). No hay noción de campo «obligatorio» en el modelo (`DetectedField`
 * no la lleva), asi que una casilla sin marcar cuenta igual que dentro del
 * documento abierto; si algun dia se anade, es aqui donde se excluyen las
 * opcionales.
 */
export function isPendingElsewhere(
  field: DetectedField,
  values: Readonly<Record<string, string>>,
): boolean {
  const value = values[field.id] ?? "";
  return fieldTypeOf(field) === "checkbox"
    ? value.length === 0
    : value.trim().length === 0;
}

/** Cuantos campos pendientes tiene un documento. */
export function pendingCount(
  doc: Pick<DocState, "textFields" | "textValues">,
): number {
  return doc.textFields.filter((field) => isPendingElsewhere(field, doc.textValues))
    .length;
}

/**
 * Campo pendiente del siguiente (`dir` 1) o anterior (-1) documento que lo
 * tenga, dando la vuelta a la cola y SIN mirar el documento de partida (si no
 * hay nada en los demas, el propio lienzo da la vuelta dentro de su
 * documento). Hacia delante es el primero del documento; hacia atras, el
 * ultimo.
 */
export function findPendingInOtherDocs(
  order: readonly DocId[],
  docs: Readonly<Record<DocId, Pick<DocState, "textFields" | "textValues">>>,
  fromDocId: DocId,
  dir: 1 | -1,
): PendingTarget | null {
  const start = order.indexOf(fromDocId);
  if (start === -1) return null;
  for (let step = 1; step < order.length; step += 1) {
    const index = (((start + dir * step) % order.length) + order.length) % order.length;
    const docId = order[index];
    const doc = docs[docId];
    if (!doc) continue;
    const pending = doc.textFields
      .filter((field) => isPendingElsewhere(field, doc.textValues))
      .sort(readingOrder);
    if (pending.length === 0) continue;
    const field = dir === 1 ? pending[0] : pending[pending.length - 1];
    return { docId, fieldId: field.id, pageIndex: field.pageIndex };
  }
  return null;
}

/** Hay algun campo pendiente en un documento distinto del dado. */
export function hasPendingInOtherDocs(
  order: readonly DocId[],
  docs: Readonly<Record<DocId, Pick<DocState, "textFields" | "textValues">>>,
  docId: DocId,
): boolean {
  return order.some((id) => {
    if (id === docId) return false;
    const doc = docs[id];
    return doc ? pendingCount(doc) > 0 : false;
  });
}

/* ------------------------------------------------------------------ *
 * "Solo yo": firma colocada por documento
 * ------------------------------------------------------------------ */

/** Estado de la firma propia en un documento: colocada o pendiente de colocar. */
export function soloPlacement(
  doc: Pick<DocState, "rect"> | undefined,
): "placed" | "pending" {
  return doc && doc.rect.width > 0 ? "placed" : "pending";
}

/** Cuantos documentos tienen ya la firma colocada. */
export function soloPlacedCount(
  order: readonly DocId[],
  docs: Readonly<Record<DocId, Pick<DocState, "rect">>>,
): number {
  return order.filter((id) => soloPlacement(docs[id]) === "placed").length;
}

export type SoloPlacementInput = {
  docId: DocId;
  /** Pagina visible del documento (donde se coloca por defecto si no hay referencia). */
  visiblePage: number;
  /** Paginas del documento y proporcion ancho/alto de la pagina elegida, ya leidas con pdf.js. */
  info: { count: number; aspect: number } | null;
};

export type SoloReference = { rect: NormalizedRect; pageIndex: number };

/**
 * Colocacion de la firma en cada documento para «Aplicar a todos los
 * documentos». Cada documento tiene paginas y tamanos propios, asi que el alto
 * se calcula con la proporcion de SU pagina (`info.aspect`):
 *  - con una firma ya colocada en el documento de referencia (el activo),
 *    se copian su posicion y su ancho en la misma pagina (o la ultima, si el
 *    documento tiene menos) y solo cambia el alto (`refitSoloRect`);
 *  - sin referencia, la colocacion por defecto (`defaultSoloRect`) en la
 *    pagina visible de cada documento.
 * Una pagina que no se pudo leer usa una proporcion de 0,75 (la del lienzo
 * sin medir), como el resto del lienzo.
 */
export function planSoloPlacements(
  ratio: number,
  reference: SoloReference | null,
  inputs: readonly SoloPlacementInput[],
): Record<DocId, { rect: NormalizedRect; pageIndex: number }> {
  const plan: Record<DocId, { rect: NormalizedRect; pageIndex: number }> = {};
  if (!(ratio > 0)) return plan;
  for (const input of inputs) {
    const aspect = input.info?.aspect ?? 0.75;
    const last = input.info ? input.info.count - 1 : Number.POSITIVE_INFINITY;
    const wanted = reference ? reference.pageIndex : input.visiblePage;
    const pageIndex = Math.max(0, Math.min(wanted, last));
    const rect = reference
      ? refitSoloRect(reference.rect, ratio, aspect)
      : defaultSoloRect(ratio, aspect);
    plan[input.docId] = { rect, pageIndex };
  }
  return plan;
}
