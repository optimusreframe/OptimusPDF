import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { CaptureMap, SignerCapture } from "@/app/sign-pdf/captures";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { TextEdit } from "@/lib/pdf/editTypes";
import type { SignatureField, Signer } from "@/lib/pdf/sign";
import { DEFAULT_COPIES, normalizeCopies } from "@/lib/pdf/signCopies";
import type { NormalizedRect } from "@/lib/pdf/watermark";

/*
 * Modelo de datos de la ronda con VARIOS documentos (Wave 4). Funciones puras,
 * sin React ni pdf.js: lo usan la sesion de `SignToolClient`, la ceremonia por
 * bloques (U3), la vista continua (U4) y los borradores (U5).
 *
 * Tres ideas:
 *  - Cada documento tiene un `DocId` ESTABLE, ligado al objeto `File` (como
 *    las filas de `FileList`), nunca a su huella. La huella llega tarde (o no
 *    llega) y dos copias identicas comparten huella: atar el estado del
 *    documento a ella es lo que producia las carreras a4/a5. Con `DocId` el
 *    estado de un documento se queda con SU documento aunque otro entre,
 *    salga o se reordene mientras tanto.
 *  - Un BLOQUE (`SignerBlock`) es lo que un firmante ha creado (firma +
 *    iniciales) y a que documentos aplica. Los trazos viven en el bloque; el
 *    sello (la huella de lo que vio) es POR DOCUMENTO.
 *  - Invariante: un documento pertenece a como maximo UN bloque de cada
 *    firmante. Lo garantizan `setBlockScope` y `normalizeBlocks`.
 */

/** Identificador estable de un documento cargado (`doc-N`). */
export type DocId = string;

/** Todos los documentos con la firma "mismas" o cada uno con la suya. */
export type SignMode = "same" | "independent";

/** Lo que describe UN documento: huecos, campos de texto y, en "Solo yo", la firma colocada. */
export type DocState = {
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  /** Huella para la que `textFields` ya viene resuelto (ver `SignToolOptions`). */
  textFieldsDetectedFor: string | null;
  /** "Solo yo": rectangulo de la firma; `width: 0` = sin colocar. */
  rect: NormalizedRect;
  pageIndex: number;
  /** Pagina visible del lienzo del paso "Documento". */
  fieldPageIndex: number;
  /** Huella del contenido que sella este estado; `""` = aun sin sellar. */
  sealedKey: string;
  /**
   * Ediciones del texto ORIGINAL de este documento (herramienta «Editar texto»,
   * W6-A). Ausente = ninguna. Se aplican al PDF ANTES de estampar las firmas, y
   * entran en la huella de las capturas (`stampKeyOf` en `textEdits.ts`).
   */
  textEdits?: TextEdit[];
  /**
   * Copias que se entregan de este documento (1..`MAX_COPIES`; Firma agil, U1.1): el mismo PDF firmado, escrito N veces
   * con nombres distintos. Ausente = 1 (borradores y configuraciones anteriores no la traen): se escribe SOLO cuando
   * vale mas de 1 (`setDocCopies`), asi un documento sin copias tiene la misma forma de siempre. Se lee con `copiesOf`.
   */
  copies?: number;
};

export const EMPTY_DOC_STATE: DocState = {
  fields: [],
  textFields: [],
  textValues: {},
  textFieldsDetectedFor: null,
  rect: { x: 0, y: 0, width: 0, height: 0 },
  pageIndex: 0,
  fieldPageIndex: 0,
  sealedKey: "",
};

/** Bloque de firma+iniciales de un firmante y los documentos a los que aplica. */
export type SignerBlock = {
  /** `bk-N`. */
  id: string;
  signerId: string;
  /** Documentos del alcance, en el orden de la cola. */
  appliesTo: DocId[];
  signature: SignatureDraft | null;
  initials: SignatureDraft | null;
  /** Sello de lo visto por documento (`captureStamp`); vacio o ausente = no vale. */
  stamps: Record<DocId, string>;
  /**
   * Alcance automatico: mientras sea `true`, los documentos nuevos se suman
   * solos al bloque. Editar el alcance a mano lo apaga.
   */
  auto: boolean;
};

/* ------------------------------------------------------------------ *
 * Identidad de documentos y bloques
 * ------------------------------------------------------------------ */

const docIds = new WeakMap<File, DocId>();
let docCounter = 0;

/**
 * `DocId` del archivo: se asigna la primera vez que se pregunta y no cambia
 * mientras el objeto `File` viva. Mismo patron que `fileId` de `FileList`.
 */
export function docIdOf(file: File): DocId {
  let id = docIds.get(file);
  if (id === undefined) {
    docCounter += 1;
    id = `doc-${docCounter}`;
    docIds.set(file, id);
  }
  return id;
}

export function docIdsOf(files: readonly File[]): DocId[] {
  return files.map(docIdOf);
}

let blockCounter = 0;

export function nextBlockId(): string {
  blockCounter += 1;
  return `bk-${blockCounter}`;
}

/** Mismo motivo que `reserveSignerIds`: tras restaurar bloques ya numerados, el contador no puede repetirlos. */
export function reserveBlockIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^bk-(\d+)$/.exec(id);
    if (match) blockCounter = Math.max(blockCounter, Number(match[1]));
  }
}

/* ------------------------------------------------------------------ *
 * Utilidades de lectura
 * ------------------------------------------------------------------ */

export function docStateOf(
  docs: Readonly<Record<DocId, DocState>>,
  docId: DocId,
): DocState {
  return docs[docId] ?? EMPTY_DOC_STATE;
}

/** Copias del documento ya normalizadas (1..`MAX_COPIES`; ausente o raro = 1). */
export function copiesOf(state: Pick<DocState, "copies"> | undefined): number {
  return normalizeCopies(state?.copies);
}

/**
 * Fija las copias de UN documento y devuelve la tabla nueva (la MISMA si no cambia nada). El valor se lleva a
 * 1..`MAX_COPIES`; 1 se guarda como «sin dato» (se quita la propiedad) para que el estado siga siendo identico al de
 * antes de existir las copias. Un documento sin estado se crea en blanco.
 */
export function setDocCopies(
  docs: Readonly<Record<DocId, DocState>>,
  docId: DocId,
  copies: number,
): Record<DocId, DocState> {
  const value = normalizeCopies(copies);
  const current = docStateOf(docs, docId);
  if (copiesOf(current) === value && (docId in docs || value === DEFAULT_COPIES)) {
    return docs as Record<DocId, DocState>;
  }
  const { copies: previous, ...rest } = current;
  void previous;
  const next: DocState = value > DEFAULT_COPIES ? { ...rest, copies: value } : rest;
  return { ...docs, [docId]: next };
}

/** Los huecos del documento cuyo firmante sigue en la lista (los de un firmante quitado quedan ocultos, no perdidos: ver `Deshacer`). */
export function liveFields(
  state: Pick<DocState, "fields">,
  signers: readonly Pick<Signer, "id">[],
): SignatureField[] {
  const alive = new Set(signers.map((signer) => signer.id));
  // Misma referencia si no hay nada que ocultar: los flujos usan `fields`
  // como dependencia de efectos y no deben ver un array nuevo por nada.
  if (state.fields.every((field) => alive.has(field.signerId))) {
    return state.fields;
  }
  return state.fields.filter((field) => alive.has(field.signerId));
}

/** Quita de `docs` lo que ya no corresponde a ningun documento vivo. Devuelve el mismo objeto si no hay nada que quitar. */
export function pruneDocs(
  docs: Readonly<Record<DocId, DocState>>,
  live: readonly DocId[],
): Record<DocId, DocState> {
  const keep = new Set(live);
  const ids = Object.keys(docs);
  if (ids.every((id) => keep.has(id))) return docs as Record<DocId, DocState>;
  const next: Record<DocId, DocState> = {};
  for (const id of ids) if (keep.has(id)) next[id] = docs[id];
  return next;
}

/**
 * Documento activo tras un cambio de la cola. Si el actual sigue, se queda;
 * si se quito, pasa al que ocupa su lugar (o al ultimo); sin documentos, `null`.
 */
export function nextActiveDoc(
  previousOrder: readonly DocId[],
  order: readonly DocId[],
  current: DocId | null,
): DocId | null {
  if (order.length === 0) return null;
  if (current && order.includes(current)) return current;
  const index = current ? previousOrder.indexOf(current) : -1;
  if (index < 0) return order[0];
  return order[Math.min(index, order.length - 1)];
}

/* ------------------------------------------------------------------ *
 * Bloques: asegurar, resolver, cambiar de alcance
 * ------------------------------------------------------------------ */

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function byOrder(order: readonly DocId[]): (a: DocId, b: DocId) => number {
  return (a, b) => order.indexOf(a) - order.indexOf(b);
}

/** Bloque con el alcance reducido a los documentos vivos (y los sellos de los que se van, fuera). */
function pruneBlock(block: SignerBlock, live: ReadonlySet<DocId>): SignerBlock {
  const appliesTo = block.appliesTo.filter((id) => live.has(id));
  const stampIds = Object.keys(block.stamps);
  if (
    appliesTo.length === block.appliesTo.length &&
    stampIds.every((id) => live.has(id))
  ) {
    return block;
  }
  const stamps: Record<DocId, string> = {};
  for (const id of stampIds) if (live.has(id)) stamps[id] = block.stamps[id];
  return { ...block, appliesTo, stamps };
}

function newBlock(
  signerId: string,
  appliesTo: DocId[],
  auto: boolean,
  mint: () => string,
): SignerBlock {
  return {
    id: mint(),
    signerId,
    appliesTo,
    signature: null,
    initials: null,
    stamps: {},
    auto,
  };
}

/**
 * Deja los bloques coherentes con firmantes y documentos. Idempotente: si ya
 * lo estan devuelve la MISMA lista (misma referencia), asi se puede llamar en
 * cada cambio sin provocar renders en cadena.
 *
 *  - Quita los bloques de firmantes que ya no estan y los documentos que ya
 *    no estan de cada alcance (con sus sellos). Con `docOrder` vacio no se
 *    poda nada: es "no hay documentos cargados ahora", no "borra todo".
 *  - "same": un bloque automatico por firmante que cubre todos los documentos;
 *    un documento nuevo (que ningun bloque del firmante reclama) se suma solo
 *    al bloque automatico. Si el firmante ya no tiene ninguno automatico, el
 *    documento queda con hueco (lo detecta `coverageIssues`; no se inventa un
 *    bloque que el usuario ya habia sustituido a mano).
 *  - "independent": un bloque por (firmante, documento); crea los que falten.
 */
export function ensureBlocks(
  signers: readonly Pick<Signer, "id">[],
  docOrder: readonly DocId[],
  mode: SignMode,
  blocks: readonly SignerBlock[],
  mint: () => string = nextBlockId,
): SignerBlock[] {
  const signerIds = new Set(signers.map((signer) => signer.id));
  const live = new Set(docOrder);
  const prune = docOrder.length > 0;

  let next: SignerBlock[] = [];
  for (const block of blocks) {
    if (!signerIds.has(block.signerId)) continue;
    const pruned = prune ? pruneBlock(block, live) : block;
    if (prune && pruned.appliesTo.length === 0) continue;
    next.push(pruned);
  }

  if (prune) {
    const order = byOrder(docOrder);
    for (const signer of signers) {
      const own = next.filter((block) => block.signerId === signer.id);
      const claimed = new Set(own.flatMap((block) => block.appliesTo));
      const unclaimed = docOrder.filter((id) => !claimed.has(id));
      if (unclaimed.length === 0) continue;

      if (mode === "same") {
        const auto = own.find((block) => block.auto);
        if (auto) {
          const grown: SignerBlock = {
            ...auto,
            appliesTo: [...auto.appliesTo, ...unclaimed].sort(order),
          };
          next = next.map((block) => (block === auto ? grown : block));
        } else if (own.length === 0) {
          next.push(newBlock(signer.id, [...unclaimed], true, mint));
        }
      } else {
        for (const id of unclaimed) {
          next.push(newBlock(signer.id, [id], false, mint));
        }
      }
    }
  }

  return sameList(next, blocks) ? (blocks as SignerBlock[]) : next;
}

export type ResolvedBlock = {
  /** El bloque que firma `docId` por `signerId`; `null` = hueco de cobertura. */
  block: SignerBlock | null;
  /** Mas de un bloque lo reclama (dato corrupto): gana el primero y hay que avisar. */
  ambiguous: boolean;
};

/** Determinista: gana el primer bloque del firmante que incluye el documento. */
export function resolveBlock(
  blocks: readonly SignerBlock[],
  signerId: string,
  docId: DocId,
): ResolvedBlock {
  let found: SignerBlock | null = null;
  let ambiguous = false;
  for (const block of blocks) {
    if (block.signerId !== signerId || !block.appliesTo.includes(docId)) continue;
    if (found) ambiguous = true;
    else found = block;
  }
  return { block: found, ambiguous };
}

export type ScopeMove = {
  docId: DocId;
  /** Bloque del que salio. */
  fromBlockId: string;
  /** Bloque al que paso. */
  toBlockId: string;
};

export type ScopeChange = {
  blocks: SignerBlock[];
  /** Lo que cambio de bloque para cumplir el invariante: sirve para anunciarlo. */
  moved: ScopeMove[];
  /** Bloques que se quedaron sin documentos y se retiraron. */
  removed: string[];
};

/**
 * Fija el alcance de un bloque, respetando "un documento, como mucho un bloque
 * por firmante": si un documento ya lo tenia otro bloque del MISMO firmante,
 * se le quita (y su sello) y se devuelve en `moved` para anunciarlo. Los
 * bloques que se quedan sin documentos se retiran. Editar el alcance apaga el
 * modo automatico del bloque. Un alcance vacio no se aplica (un bloque que no
 * firma nada no tiene sentido; quitarlo es otra accion).
 */
export function setBlockScope(
  blocks: readonly SignerBlock[],
  blockId: string,
  docIdsInScope: readonly DocId[],
  docOrder?: readonly DocId[],
): ScopeChange {
  const target = blocks.find((block) => block.id === blockId);
  const unique = [...new Set(docIdsInScope)];
  if (!target || unique.length === 0) {
    return { blocks: blocks as SignerBlock[], moved: [], removed: [] };
  }
  const scope = docOrder ? [...unique].sort(byOrder(docOrder)) : unique;
  const moved: ScopeMove[] = [];
  const removed: string[] = [];
  const next: SignerBlock[] = [];

  for (const block of blocks) {
    if (block.id === blockId) {
      const stamps: Record<DocId, string> = {};
      for (const id of scope) if (block.stamps[id]) stamps[id] = block.stamps[id];
      next.push({ ...block, appliesTo: scope, stamps, auto: false });
      continue;
    }
    if (block.signerId !== target.signerId) {
      next.push(block);
      continue;
    }
    const taken = block.appliesTo.filter((id) => scope.includes(id));
    if (taken.length === 0) {
      next.push(block);
      continue;
    }
    for (const docId of taken) {
      moved.push({ docId, fromBlockId: block.id, toBlockId: blockId });
    }
    const appliesTo = block.appliesTo.filter((id) => !scope.includes(id));
    if (appliesTo.length === 0) {
      removed.push(block.id);
      continue;
    }
    const stamps: Record<DocId, string> = {};
    for (const id of appliesTo) if (block.stamps[id]) stamps[id] = block.stamps[id];
    next.push({ ...block, appliesTo, stamps });
  }
  return { blocks: next, moved, removed };
}

export type BlockWarning = {
  signerId: string;
  docId: DocId;
  /** Bloque que se queda con el documento. */
  keptBlockId: string;
  /** Bloque del que se quito. */
  droppedBlockId: string;
};

/**
 * Normaliza un dato corrupto (borrador, configuracion) que rompe el
 * invariante: el primer bloque se queda el documento y el resto lo pierde.
 * Devuelve los avisos para mostrarlos; sin conflictos, la misma lista.
 */
export function normalizeBlocks(
  blocks: readonly SignerBlock[],
  knownDocs?: Iterable<DocId>,
): {
  blocks: SignerBlock[];
  warnings: BlockWarning[];
} {
  const known = knownDocs ? new Set(knownDocs) : null;
  const warnings: BlockWarning[] = [];
  const owner = new Map<string, string>();
  const next: SignerBlock[] = [];
  let changed = false;
  for (const block of blocks) {
    const keep: DocId[] = [];
    const seen = new Set<DocId>();
    for (const docId of block.appliesTo) {
      // Un mismo documento repetido DENTRO del bloque no es un conflicto: se
      // deja una vez, sin aviso. Los ids que el contexto no conoce se descartan.
      if (seen.has(docId)) continue;
      seen.add(docId);
      if (known && !known.has(docId)) continue;
      const key = `${block.signerId}|${docId}`;
      const first = owner.get(key);
      if (first && first !== block.id) {
        warnings.push({
          signerId: block.signerId,
          docId,
          keptBlockId: first,
          droppedBlockId: block.id,
        });
      } else {
        owner.set(key, block.id);
        keep.push(docId);
      }
    }
    if (keep.length === block.appliesTo.length) {
      next.push(block);
    } else {
      changed = true;
      if (keep.length > 0) {
        const stamps: Record<DocId, string> = {};
        for (const id of keep) if (block.stamps[id]) stamps[id] = block.stamps[id];
        next.push({ ...block, appliesTo: keep, stamps });
      }
    }
  }
  return warnings.length === 0 && !changed
    ? { blocks: blocks as SignerBlock[], warnings }
    : { blocks: next, warnings };
}

export type CoverageIssue = { signerId: string; docId: DocId };

/**
 * Huecos de cobertura: firmante con huecos de firma en un documento y ningun
 * bloque que lo firme ("Falta el bloque de {S} para {D}"). Orden: por
 * documento y, dentro, por firmante.
 */
export function coverageIssues(
  signers: readonly Pick<Signer, "id">[],
  docOrder: readonly DocId[],
  docs: Readonly<Record<DocId, Pick<DocState, "fields">>>,
  blocks: readonly SignerBlock[],
): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const docId of docOrder) {
    const fields = docs[docId]?.fields ?? [];
    for (const signer of signers) {
      const needed = fields.some((field) => field.signerId === signer.id);
      if (needed && !resolveBlock(blocks, signer.id, docId).block) {
        issues.push({ signerId: signer.id, docId });
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Compatibilidad con el CaptureMap de siempre
 * ------------------------------------------------------------------ */

/**
 * El `CaptureMap` de siempre (por firmante) para UN documento: lo que
 * `SigningCeremony`, `validCapture` y `pendingSigners` ya entienden. Solo
 * entran los firmantes cuyo bloque tiene algo (trazo o sello) para ese
 * documento; sin sello para el, `stamp` queda vacio y `validCapture` no da la
 * captura por buena: nunca vale una firma que su dueno no vio sobre ESE
 * documento.
 */
export function projectCaptures(
  blocks: readonly SignerBlock[],
  docId: DocId,
): CaptureMap {
  const captures: CaptureMap = {};
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.signerId)) continue;
    const { block: resolved } = resolveBlock(blocks, block.signerId, docId);
    if (!resolved) continue;
    seen.add(block.signerId);
    const stamp = resolved.stamps[docId] ?? "";
    if (!resolved.signature && !resolved.initials && !stamp) continue;
    captures[block.signerId] = {
      signature: resolved.signature,
      initials: resolved.initials,
      stamp,
    };
  }
  return captures;
}

function sameDraft(a: SignatureDraft | null, b: SignatureDraft | null): boolean {
  if (a === b) return true;
  return !!a && !!b && a.dataUrl === b.dataUrl && a.ratio === b.ratio;
}

function sameCapture(a: SignerCapture | undefined, b: SignerCapture | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.stamp === b.stamp &&
    sameDraft(a.signature, b.signature) &&
    sameDraft(a.initials, b.initials)
  );
}

/**
 * Operacion inversa de `projectCaptures`: vuelca en los bloques lo que un
 * flujo (que solo conoce el `CaptureMap` de SU documento) acaba de cambiar.
 * Solo se tocan los firmantes cuya captura cambio (por valor).
 *  - Captura nueva o cambiada: trazos al bloque y sello a `stamps[docId]`.
 *  - Captura que desaparece: se borra el sello de ese documento y, si el
 *    bloque solo cubre ese documento, tambien los trazos (es lo que antes
 *    significaba "sin captura"); en un bloque compartido los trazos se
 *    quedan: siguen valiendo para los demas documentos.
 * Un firmante sin bloque para el documento se ignora (no hay donde guardarlo).
 */
export function applyCaptures(
  blocks: readonly SignerBlock[],
  docId: DocId,
  next: CaptureMap,
): SignerBlock[] {
  const before = projectCaptures(blocks, docId);
  const ids = new Set([...Object.keys(before), ...Object.keys(next)]);
  let result = blocks as SignerBlock[];
  for (const signerId of ids) {
    if (sameCapture(before[signerId], next[signerId])) continue;
    const { block } = resolveBlock(result, signerId, docId);
    if (!block) continue;
    const capture = next[signerId];
    let updated: SignerBlock;
    if (capture) {
      updated = {
        ...block,
        signature: capture.signature,
        initials: capture.initials,
        stamps: capture.stamp
          ? { ...block.stamps, [docId]: capture.stamp }
          : omitKey(block.stamps, docId),
      };
    } else {
      updated = {
        ...block,
        stamps: omitKey(block.stamps, docId),
        ...(block.appliesTo.length === 1
          ? { signature: null, initials: null }
          : {}),
      };
    }
    result = result.map((candidate) => (candidate === block ? updated : candidate));
  }
  return result;
}

function omitKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) return record;
  const { [key]: removed, ...rest } = record;
  void removed;
  return rest;
}

/**
 * Borradores v1 (un documento): su `CaptureMap` pasa a un bloque automatico
 * por firmante que cubre ese documento, con el sello que traia.
 */
export function migrateCaptures(
  captures: CaptureMap,
  docId: DocId,
  mint: () => string = nextBlockId,
): SignerBlock[] {
  const blocks: SignerBlock[] = [];
  for (const [signerId, capture] of Object.entries(captures)) {
    if (!capture.signature && !capture.initials && !capture.stamp) continue;
    blocks.push({
      id: mint(),
      signerId,
      appliesTo: [docId],
      signature: capture.signature,
      initials: capture.initials,
      stamps: capture.stamp ? { [docId]: capture.stamp } : {},
      auto: true,
    });
  }
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Cambio de modo global
 * ------------------------------------------------------------------ */

export type ModeSwitch = {
  blocks: SignerBlock[];
  /**
   * Bloques cuyos trazos no sobreviven a la fusion (Distintas -> Mismas): son
   * los originales, para ofrecer "Deshacer" (volver a poner `blocks` de antes
   * y el modo anterior). Vacio = no se pierde nada.
   */
  discarded: SignerBlock[];
};

/**
 * Cambia el modo global conservando lo posible:
 *  - Mismas -> Distintas: cada bloque se reparte en uno por documento. Los
 *    trazos se copian y cada documento se queda con SU sello: no se pierde
 *    nada y nada se da por visto de mas.
 *  - Distintas -> Mismas: un bloque automatico por firmante con todos los
 *    documentos. Se queda con los trazos del primer bloque que los tenga
 *    (los iniciales faltantes se completan con el primero que los tenga) y
 *    solo conserva el sello de los documentos cuyo bloque tenia ESOS mismos
 *    trazos; el resto se devuelve en `discarded`.
 */
export function switchMode(
  blocks: readonly SignerBlock[],
  signers: readonly Pick<Signer, "id">[],
  docOrder: readonly DocId[],
  to: SignMode,
  mint: () => string = nextBlockId,
): ModeSwitch {
  const order = byOrder(docOrder);

  if (to === "independent") {
    const split: SignerBlock[] = [];
    for (const block of blocks) {
      const scope = docOrder.length > 0
        ? [...block.appliesTo].sort(order)
        : block.appliesTo;
      scope.forEach((docId, index) => {
        split.push({
          ...block,
          id: index === 0 ? block.id : mint(),
          appliesTo: [docId],
          stamps: block.stamps[docId] ? { [docId]: block.stamps[docId] } : {},
          auto: false,
        });
      });
      if (scope.length === 0) split.push(block);
    }
    return {
      blocks: ensureBlocks(signers, docOrder, "independent", split, mint),
      discarded: [],
    };
  }

  const merged: SignerBlock[] = [];
  const discarded: SignerBlock[] = [];
  for (const signer of signers) {
    const own = blocks.filter((block) => block.signerId === signer.id);
    if (own.length === 0) continue;
    const survivor =
      own.find((block) => block.signature || block.initials) ?? own[0];
    const signature =
      survivor.signature ?? own.find((block) => block.signature)?.signature ?? null;
    const initials =
      survivor.initials ?? own.find((block) => block.initials)?.initials ?? null;
    const appliesTo = [...new Set(own.flatMap((block) => block.appliesTo))].sort(order);
    const stamps: Record<DocId, string> = {};
    for (const block of own) {
      const same =
        sameDraft(block.signature, signature) && sameDraft(block.initials, initials);
      for (const docId of block.appliesTo) {
        if (same && block.stamps[docId]) stamps[docId] = block.stamps[docId];
      }
      if (!same && (block.signature || block.initials)) discarded.push(block);
    }
    merged.push({
      id: survivor.id,
      signerId: signer.id,
      appliesTo,
      signature,
      initials,
      stamps,
      auto: true,
    });
  }
  return {
    blocks: ensureBlocks(signers, docOrder, "same", merged, mint),
    discarded,
  };
}

/* ------------------------------------------------------------------ *
 * Huellas repetidas
 * ------------------------------------------------------------------ */

/**
 * Grupos de documentos con la MISMA huella (copias identicas). Se aceptan,
 * pero conviene avisarlo (informativo, no bloquea). Solo cuentan los que ya
 * tienen huella. Los grupos y sus miembros salen en el orden de la cola.
 */
export function duplicateGroups(
  keys: Readonly<Record<DocId, string | null>>,
  docOrder?: readonly DocId[],
): DocId[][] {
  const ids = docOrder ?? Object.keys(keys);
  const byKey = new Map<string, DocId[]>();
  for (const id of ids) {
    const key = keys[id];
    if (!key) continue;
    const group = byKey.get(key);
    if (group) group.push(id);
    else byKey.set(key, [id]);
  }
  return [...byKey.values()].filter((group) => group.length > 1);
}
