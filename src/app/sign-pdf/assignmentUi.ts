import {
  byGroups,
  blockGroups,
  canonicalMatrix,
  groupIdAt,
  groupIndexOf,
  groupsOf,
  type AssignmentMatrix,
  type GroupId,
  type StrokeImpact,
} from "@/app/sign-pdf/assignment";
import { docLabel } from "@/app/sign-pdf/blockModel";
import { copiesOf, type DocId, type DocState, type SignMode, type SignerBlock } from "@/app/sign-pdf/docSet";
import { MAX_COPIES, MAX_OUTPUT_FILES, normalizeCopies } from "@/lib/pdf/signCopies";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

/*
 * Logica pura de la interfaz «¿Quien firma que?» (Firma agil · Fase 1 · U1.2): que pasa al tocar una celda, el atajo
 * «Por grupos», el modo derivado de la tabla, las copias con su tope de archivos y la descripcion de los trazos que un
 * cambio se llevaria por delante. Sin React ni textos: `AssignmentMatrix.tsx` la usa y las pruebas la ejercitan sola.
 */

/* ------------------------------------------------------------------ *
 * Tocar una celda
 * ------------------------------------------------------------------ */

export type CellCycle = {
  matrix: AssignmentMatrix;
  /**
   * Era la ultima celda con firma de ese firmante: «no firma» no es una opcion (un firmante sin ningun documento no
   * existe en la tabla: `ensureBlocks` le devolveria todos). La interfaz lo dice.
   */
  lastCell: boolean;
};

function cellAt(matrix: AssignmentMatrix, row: number, col: number): GroupId | null {
  const value = matrix.cells[row]?.[col];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * El siguiente valor de una celda al tocarla. Las opciones de la celda son los grupos que ya usan las OTRAS celdas del
 * firmante (por orden de aparicion), luego «un grupo nuevo» y, si no es su unica celda con firma, «no firma»; al tocar se
 * pasa a la siguiente de la lista y despues de la ultima se vuelve a la primera. Asi, en una columna `A A A A`, tocar la
 * tercera da `A A B A`, otra vez `A A — A` y otra mas `A A A A`; y tocar la cuarta tras la tercera da `A A B B`.
 * Devuelve la tabla canonica; un documento o firmante que no estan en la tabla no cambian nada.
 */
export function cycleCell(matrix: AssignmentMatrix, docId: DocId, signerId: string): CellCycle {
  const row = matrix.docIds.indexOf(docId);
  const col = matrix.signerIds.indexOf(signerId);
  if (row === -1 || col === -1) return { matrix, lastCell: false };

  const current = cellAt(matrix, row, col);
  const others: GroupId[] = [];
  let withSignature = 0;
  matrix.docIds.forEach((_, r) => {
    const label = cellAt(matrix, r, col);
    if (label !== null) withSignature += 1;
    if (r === row || label === null) return;
    if (!others.includes(label)) others.push(label);
  });
  // En el orden de las letras (A, B, C...): asi tocar siempre recorre las opciones en el mismo orden, vengan donde vengan.
  others.sort((a, b) => groupIndexOf(a) - groupIndexOf(b));
  let fresh = 0;
  while (others.includes(groupIdAt(fresh))) fresh += 1;
  const created = groupIdAt(fresh);

  const lastCell = current !== null && withSignature === 1;
  const options: (GroupId | null)[] = [...others, created, ...(lastCell ? [] : [null])];
  // La posicion de la celda: su grupo si lo comparte con otra, «nuevo» si es el unico de su grupo, y «no firma» al final.
  let at: number;
  if (current === null) at = options.length - 1;
  else if (others.includes(current)) at = others.indexOf(current);
  else at = others.length;
  // Una unica opcion (la unica celda con firma de un firmante): no hay a donde pasar.
  if (options.length === 1) return { matrix, lastCell };
  const next = options[(at + 1) % options.length];

  const cells = matrix.docIds.map((_, r) => matrix.signerIds.map((__, c) => cellAt(matrix, r, c)));
  cells[row][col] = next;
  return { matrix: canonicalMatrix({ ...matrix, cells }), lastCell: false };
}

/* ------------------------------------------------------------------ *
 * Atajo «Por grupos»
 * ------------------------------------------------------------------ */

/**
 * Parte los documentos en DOS grupos seguidos: la primera mitad (la mayor si son impares) comparte la firma A y el resto
 * la B, para todos los firmantes (`A A B B`, `A A B` con tres). Con menos de dos documentos no hay nada que partir.
 */
export function groupsInHalves(matrix: AssignmentMatrix): AssignmentMatrix {
  const half = Math.ceil(matrix.docIds.length / 2);
  return byGroups(matrix, [matrix.docIds.slice(0, half), matrix.docIds.slice(half)]);
}

/* ------------------------------------------------------------------ *
 * Modo derivado
 * ------------------------------------------------------------------ */

/**
 * El `signMode` que corresponde a una tabla. «Mismas» deja que `ensureBlocks` sume solo los documentos nuevos al grupo
 * unico y NO repare las celdas «no firma»; «distintas» crea un bloque por cada documento que nadie reclama, asi que solo
 * vale cuando no hay ninguna celda vacia y cada firmante tiene un grupo por documento. El modo ya no se elige en pantalla:
 * se deduce de la tabla para que un borrador antiguo y la tabla nueva hablen de lo mismo.
 */
export function signModeFor(matrix: AssignmentMatrix): SignMode {
  const docCount = matrix.docIds.length;
  if (docCount < 2 || matrix.signerIds.length === 0) return "same";
  const perDocument = matrix.signerIds.every((signerId) => {
    const groups = groupsOf(matrix, signerId);
    return groups.length === docCount && groups.every((entry) => entry.docIds.length === 1);
  });
  return perDocument ? "independent" : "same";
}

/* ------------------------------------------------------------------ *
 * Copias
 * ------------------------------------------------------------------ */

/** `{ [docId]: copias }` de los documentos de la cola (1 si no hay dato). */
export function copiesMap(
  docs: Readonly<Record<DocId, DocState>>,
  docIds: readonly DocId[],
): Record<DocId, number> {
  const out: Record<DocId, number> = {};
  for (const id of docIds) out[id] = copiesOf(docs[id]);
  return out;
}

export function totalFiles(copies: Readonly<Record<DocId, number>>, docIds: readonly DocId[]): number {
  return docIds.reduce((sum, id) => sum + normalizeCopies(copies[id]), 0);
}

export type CopyStep = { value: number; blocked: "none" | "perDocument" | "totalFiles" };

/**
 * `delta` (+1 / -1) copias a UN documento, dentro de 1..`MAX_COPIES` y sin pasar de `MAX_OUTPUT_FILES` archivos en total.
 * `blocked` dice por que no se pudo subir (para decirlo en pantalla); bajar nunca se bloquea salvo en 1.
 */
export function stepCopies(
  copies: Readonly<Record<DocId, number>>,
  docIds: readonly DocId[],
  docId: DocId,
  delta: 1 | -1,
): CopyStep {
  const current = normalizeCopies(copies[docId]);
  if (delta < 0) return { value: Math.max(1, current - 1), blocked: "none" };
  if (current >= MAX_COPIES) return { value: current, blocked: "perDocument" };
  if (totalFiles(copies, docIds) + 1 > MAX_OUTPUT_FILES) return { value: current, blocked: "totalFiles" };
  return { value: current + 1, blocked: "none" };
}

export type AllCopiesStep = { copies: Record<DocId, number>; value: number; blocked: "none" | "perDocument" | "totalFiles" };

/**
 * Una copia mas (o menos) en TODOS los documentos a la vez, partiendo del mayor numero de copias que ya haya, para que
 * «Copias de todos» los deje iguales. Sube solo si todos caben (documentos x copias <= `MAX_OUTPUT_FILES`).
 */
export function stepAllCopies(
  copies: Readonly<Record<DocId, number>>,
  docIds: readonly DocId[],
  delta: 1 | -1,
): AllCopiesStep {
  const base = docIds.length === 0 ? 1 : Math.max(...docIds.map((id) => normalizeCopies(copies[id])));
  const target = base + delta;
  const unchanged = Object.fromEntries(docIds.map((id) => [id, normalizeCopies(copies[id])]));
  if (target < 1) return { copies: Object.fromEntries(docIds.map((id) => [id, 1])), value: 1, blocked: "none" };
  if (target > MAX_COPIES) return { copies: unchanged, value: base, blocked: "perDocument" };
  if (target * docIds.length > MAX_OUTPUT_FILES) return { copies: unchanged, value: base, blocked: "totalFiles" };
  return { copies: Object.fromEntries(docIds.map((id) => [id, target])), value: target, blocked: "none" };
}

/** Todos los documentos tienen las mismas copias: ese numero; si no, `null`. */
export function uniformCopies(copies: Readonly<Record<DocId, number>>, docIds: readonly DocId[]): number | null {
  if (docIds.length === 0) return null;
  const first = normalizeCopies(copies[docIds[0]]);
  return docIds.every((id) => normalizeCopies(copies[id]) === first) ? first : null;
}

/* ------------------------------------------------------------------ *
 * Trazos afectados por un cambio
 * ------------------------------------------------------------------ */

export type ImpactLine = {
  kind: "lost" | "reconfirm";
  signerId: string;
  /** Letra del grupo (la de ANTES del cambio). */
  group: GroupId;
  /** Documentos afectados: los que perdian el trazo (`lost`) o los nuevos sin sello (`reconfirm`). */
  docs: number;
  strokes: SignatureFieldType[];
};

/** Traduce los `StrokeImpact` de `applyMatrix` a lineas para la confirmacion, con la letra que el grupo tenia antes. */
export function describeImpacts(
  impacts: readonly StrokeImpact[],
  previous: readonly SignerBlock[],
  docIds: readonly DocId[],
  signers: readonly Pick<Signer, "id">[],
): ImpactLine[] {
  const letters = blockGroups(previous, docIds, signers);
  return impacts.map((impact) => ({
    kind: impact.outcome === "lost" ? "lost" : "reconfirm",
    signerId: impact.signerId,
    group: letters[impact.blockId] ?? "A",
    docs: impact.outcome === "lost" ? impact.before.length : impact.docsToConfirm.length,
    strokes: impact.types,
  }));
}

/* ------------------------------------------------------------------ *
 * Documentos de un grupo
 * ------------------------------------------------------------------ */

/** Documentos que se nombran antes de resumir el resto como «+N». */
const GROUP_DOC_NAMES = 4;

/** «Contrato, Anexo» / «Contrato, Anexo, Acta, Carta +2»: los documentos de un grupo, en el orden de la cola. */
export function groupDocsText(
  block: { appliesTo: readonly DocId[] },
  docs: readonly { id: DocId; name: string }[],
): string {
  const names = docs.filter((doc) => block.appliesTo.includes(doc.id)).map((doc) => docLabel(doc.name));
  const shown = names.slice(0, GROUP_DOC_NAMES);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", ");
}
