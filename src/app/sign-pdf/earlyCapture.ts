import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import {
  captureStamp,
  sameStamp,
  staleReason,
  validCapture,
  type CaptureMap,
  type SignerCapture,
  type StaleReason,
} from "@/app/sign-pdf/captures";
import {
  blockStampsValid,
  captureForBlock,
  clearBlock,
  signerBlocks,
  visibleDraft,
  type BlockContext,
  type DraftPatch,
  type SavedDrafts,
} from "@/app/sign-pdf/blockModel";
import type { SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

/*
 * Recoger la firma y las iniciales de un firmante ANTES o DESPUES de poner sus campos. Funciones puras, sin React.
 *
 * Lo recogido va atado al FIRMANTE y al documento que vio (`captureStamp`: solo la huella del archivo + sus ediciones de texto),
 * nunca a los huecos: poner, mover, redimensionar o quitar campos despues no lo invalida, y la ceremonia pide solo lo que
 * falta (`requiredCaptureTypes` / `isSignerComplete`). Aqui no hay estado propio: se lee y se escribe en lo que ya guarda la
 * sesion -- `CaptureMap` con un documento, bloques con sello por documento con varios --, asi que el borrador, «Borrar datos» y
 * quitar un firmante funcionan sin tocar nada.
 *
 * Seguridad: un trazo cuyo sello ya no coincide NO vale ni se reaplica (lo vio su dueño sobre OTRO documento o OTRO texto).
 * Ante cualquier duda -- huella sin calcular, sello vacio -- el estado es «sin recoger» y no se escribe nada.
 */

/** Que tiene recogido un firmante, tal como lo ve la persona. */
export type EarlyKind =
  /** Nada vigente. */
  | "none"
  /** Firma e iniciales, todas vigentes. */
  | "complete"
  | "signature"
  | "initials"
  /** Con varios grupos: hay trazo vigente pero no en todos los grupos (o no de los dos tipos en todos). */
  | "partial"
  /** Habia trazo y ya no vale: cambio el texto del documento o el documento (`reason`). */
  | "stale";

export type EarlyStatus = { kind: EarlyKind; reason: StaleReason | null };

export const NO_EARLY: EarlyStatus = { kind: "none", reason: null };

/** Con varios motivos a la vez se dice el que la persona acaba de provocar (el texto) antes que lo demas. */
const REASON_PRIORITY: readonly StaleReason[] = ["text", "fields", "document", "added"];

function pairKind(signatures: number, initials: number, total: number): EarlyKind {
  if (total === 0 || (signatures === 0 && initials === 0)) return "none";
  if (signatures === total && initials === total) return "complete";
  if (signatures === total && initials === 0) return "signature";
  if (initials === total && signatures === 0) return "initials";
  return "partial";
}

/** Hay algo vigente recogido (cualquier tipo). */
export function hasCollected(status: EarlyStatus): boolean {
  return status.kind !== "none" && status.kind !== "stale";
}

/* ------------------------------------------------------------------ *
 * Un documento: `CaptureMap` por firmante
 * ------------------------------------------------------------------ */

/**
 * Estado de un firmante con UN documento. `stampKey` es la huella con la que se sellan las capturas (`stampKeyOf`); `null` =
 * aun calculandose: nada vale todavia.
 */
export function earlyStatusSingle(
  captures: CaptureMap,
  signerId: string,
  stampKey: string | null,
): EarlyStatus {
  const stored = captures[signerId];
  if (!stored || (!stored.signature && !stored.initials) || !stampKey) return NO_EARLY;
  if (sameStamp(stored.stamp, captureStamp(stampKey))) {
    return {
      kind: pairKind(stored.signature ? 1 : 0, stored.initials ? 1 : 0, 1),
      reason: null,
    };
  }
  const reason = staleReason(stored.stamp, stampKey);
  return reason ? { kind: "stale", reason } : NO_EARLY;
}

/** La captura VIGENTE del firmante (vacia si su sello ya no coincide). */
export function currentCapture(captures: CaptureMap, signerId: string, stampKey: string | null): SignerCapture {
  return validCapture(captures, [], signerId, stampKey);
}

/**
 * Guarda un trazo (firma o iniciales) del firmante sin tocar el otro, ya vigente. Si lo que habia estaba sellado a otro texto u
 * otro documento, se parte de cero: no se mezcla un trazo vigente con otro caducado bajo un sello nuevo.
 */
export function collectSingle(
  captures: CaptureMap,
  signerId: string,
  stampKey: string,
  patch: { signature?: SignatureDraft | null; initials?: SignatureDraft | null },
): CaptureMap {
  const base = currentCapture(captures, signerId, stampKey);
  const next: SignerCapture = {
    signature: patch.signature !== undefined ? patch.signature : base.signature,
    initials: patch.initials !== undefined ? patch.initials : base.initials,
    stamp: captureStamp(stampKey),
  };
  return { ...captures, [signerId]: next };
}

/** Quita lo recogido de un firmante (los demas no cambian). */
export function clearSingle(captures: CaptureMap, signerId: string): CaptureMap {
  if (!(signerId in captures)) return captures;
  const { [signerId]: removed, ...rest } = captures;
  void removed;
  return rest;
}

/**
 * Aplica una firma guardada del baul: sus dos imagenes de una vez. Lo que la entrada no trae no se inventa: queda como
 * estaba (o vacio) y se devuelve en `missing` para avisarlo.
 */
export function applySavedSingle(
  captures: CaptureMap,
  signerId: string,
  stampKey: string,
  saved: SavedDrafts,
): { captures: CaptureMap; missing: SignatureFieldType[] } {
  const base = currentCapture(captures, signerId, stampKey);
  const patch: DraftPatch = {};
  const missing: SignatureFieldType[] = [];
  for (const type of ["signature", "initials"] as const) {
    if (saved[type]) patch[type] = saved[type];
    else if (!base[type]) missing.push(type);
  }
  return { captures: collectSingle(captures, signerId, stampKey, patch), missing };
}

/* ------------------------------------------------------------------ *
 * Varios documentos: bloques con sello por documento
 * ------------------------------------------------------------------ */

/**
 * Estado de un firmante con VARIOS documentos, mirando todos sus grupos (bloques). Un grupo con trazo cuyo sello no
 * coincide en algun documento de su alcance esta caducado: por el texto editado o el documento cambiado, o -- sin sello para
 * un documento -- porque su dueño nunca lo vio (un documento nuevo en el alcance). Sin huella de algun documento nada vale.
 */
export function earlyStatusBlocks(
  blocks: readonly SignerBlock[],
  ctx: BlockContext,
  signerId: string,
): EarlyStatus {
  const own = signerBlocks(blocks, signerId);
  if (own.length === 0) return NO_EARLY;
  if (own.some((block) => block.appliesTo.some((docId) => !ctx.keys[docId]))) return NO_EARLY;

  const found = new Set<StaleReason>();
  for (const block of own) {
    if ((!block.signature && !block.initials) || blockStampsValid(block, ctx)) continue;
    for (const docId of block.appliesTo) {
      const key = ctx.keys[docId] as string;
      const stored = block.stamps[docId];
      if (!stored) {
        found.add("added");
        continue;
      }
      // Un documento cuyo sello sigue valiendo no es el motivo.
      const reason = staleReason(stored, captureStamp(key));
      if (reason) found.add(reason);
    }
  }
  const reason = REASON_PRIORITY.find((candidate) => found.has(candidate));
  if (reason) return { kind: "stale", reason };

  let signatures = 0;
  let initials = 0;
  for (const block of own) {
    if (visibleDraft(block, "signature", ctx)) signatures += 1;
    if (visibleDraft(block, "initials", ctx)) initials += 1;
  }
  return { kind: pairKind(signatures, initials, own.length), reason: null };
}

/**
 * Aplica una firma guardada a un grupo: sus dos imagenes de una vez y, con `applyToAll`, solo LO VACIO de los demas grupos del
 * firmante (lo que otro grupo ya tenia vigente nunca se pisa). A diferencia de `applySavedToBlocks`, no mira los huecos: se
 * recoge antes de que existan. El sello de cada documento del alcance se calcula aqui, en este momento.
 */
export function applySavedEarly(
  blocks: readonly SignerBlock[],
  blockId: string,
  saved: SavedDrafts,
  applyToAll: boolean,
  ctx: BlockContext,
): { blocks: SignerBlock[]; missing: SignatureFieldType[]; filledOthers: number } {
  const target = blocks.find((candidate) => candidate.id === blockId);
  if (!target) return { blocks: blocks as SignerBlock[], missing: [], filledOthers: 0 };
  const patch: DraftPatch = {};
  const missing: SignatureFieldType[] = [];
  for (const type of ["signature", "initials"] as const) {
    if (saved[type]) patch[type] = saved[type];
    else if (!visibleDraft(target, type, ctx)) missing.push(type);
  }
  let result = captureForBlock(blocks, blockId, patch, ctx);
  let filledOthers = 0;
  if (applyToAll) {
    for (const other of signerBlocks(blocks, target.signerId)) {
      if (other.id === blockId) continue;
      const fill: DraftPatch = {};
      for (const type of ["signature", "initials"] as const) {
        if (saved[type] && !visibleDraft(other, type, ctx)) fill[type] = saved[type];
      }
      if (Object.keys(fill).length === 0) continue;
      result = captureForBlock(result, other.id, fill, ctx);
      filledOthers += 1;
    }
  }
  return { blocks: result, missing, filledOthers };
}

/** Quita lo recogido en TODOS los grupos de un firmante (trazos y sellos); los demas firmantes no cambian. */
export function clearSignerBlocks(blocks: readonly SignerBlock[], signerId: string): SignerBlock[] {
  let result = blocks as SignerBlock[];
  for (const block of signerBlocks(blocks, signerId)) result = clearBlock(result, block.id);
  return result;
}

/** Lo que muestra una fila de grupo del panel: el trazo VIGENTE de cada tipo (`null` si falta o caduco). */
export type EarlyGroup = {
  id: string;
  /** «Firma A»; `null` con un solo grupo (no hace falta nombrarlo). */
  title: string | null;
  /** «Firma A — para: Contrato, Anexo»; `null` con un solo grupo. */
  label: string | null;
  signature: SignatureDraft | null;
  initials: SignatureDraft | null;
};

/* ------------------------------------------------------------------ *
 * Plantillas que REEMPLAZAN a los firmantes
 * ------------------------------------------------------------------ */

/**
 * Las plantillas guardadas («Plantillas» de las opciones) sustituyen a TODOS los firmantes por los suyos, con ids nuevos: sin mas,
 * lo ya recogido (atado al id del firmante) se perderia. Si alguien ya recogio su firma o sus iniciales, la plantilla se aplica a
 * los MISMOS firmantes, por orden: conservan su id, su nombre y lo recogido. Sin nadie con trazos no cambia nada (lista vacia).
 */
export function signersToReuse(signers: readonly Signer[], blocks: readonly SignerBlock[]): Signer[] {
  const collected = signers.some((signer) =>
    blocks.some((block) => block.signerId === signer.id && (block.signature !== null || block.initials !== null)),
  );
  return collected ? [...signers] : [];
}

/** Acunador de ids que reparte primero los de los firmantes a reutilizar (en orden) y despues los nuevos. */
export function reuseSignerIds(reuse: readonly Signer[], mint: () => string): () => string {
  let next = 0;
  return () => {
    const kept = reuse[next];
    next += 1;
    return kept ? kept.id : mint();
  };
}

/**
 * Los firmantes que dejo la plantilla, con el nombre de quien ya estaba (la plantilla solo pone el de los nuevos). Si la plantilla
 * trae MENOS firmantes que los que habia, los que sobran y ya recogieron algo se quedan (sin campos): lo recogido no se pierde.
 */
export function keepReusedNames(minted: readonly Signer[], reuse: readonly Signer[], collectedIds: ReadonlySet<string>): Signer[] {
  const named = minted.map((signer, index) => (reuse[index] ? { ...signer, name: reuse[index].name } : signer));
  return [...named, ...reuse.slice(minted.length).filter((signer) => collectedIds.has(signer.id))];
}

/** Ids de los firmantes con alguna firma o iniciales recogidas. */
export function collectedSignerIds(blocks: readonly SignerBlock[]): Set<string> {
  return new Set(blocks.filter((block) => block.signature !== null || block.initials !== null).map((block) => block.signerId));
}
