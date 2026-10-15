import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import {
  captureStamp,
  isSignerComplete,
  requiredCaptureTypes,
  staleReason,
  type CaptureMap,
  type StaleReason,
} from "@/app/sign-pdf/captures";
import {
  applyCaptures,
  docStateOf,
  liveFields,
  nextBlockId,
  projectCaptures,
  setBlockScope,
  type DocId,
  type DocState,
  type ScopeChange,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type {
  SignatureField,
  SignatureFieldType,
  Signer,
} from "@/lib/pdf/sign";

/*
 * Logica pura de la ceremonia por BLOQUES (Wave 4 · U3): que exige cada
 * bloque de un firmante, cuando esta completo, como se escribe lo que el
 * firmante crea (trazos + SELLO POR DOCUMENTO, calculado en el momento de
 * crearlo), como se aplica una firma guardada a uno o a todos sus bloques y
 * como se anade o se quita un bloque sin romper el invariante de `docSet`
 * («un documento, como mucho un bloque por firmante»).
 *
 * Sin React ni pdf.js: lo usan `BlockCeremony`, `SignerBlocks` y los tests.
 */

/** Lo que estas funciones necesitan saber de la sesion. */
export type BlockContext = {
  signers: readonly Signer[];
  docs: Readonly<Record<DocId, DocState>>;
  /** Huella de cada documento; `null` = aun calculandose o imposible. */
  keys: Readonly<Record<DocId, string | null>>;
};

export type DocRef = { id: DocId; name: string };

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

/** Huecos vivos del documento (los de firmantes quitados quedan fuera). */
export function fieldsOfDoc(ctx: BlockContext, docId: DocId): SignatureField[] {
  return liveFields(docStateOf(ctx.docs, docId), ctx.signers);
}

/** Documentos del alcance del bloque en los que su firmante tiene huecos. */
export function blockSlotDocs(block: SignerBlock, ctx: BlockContext): DocId[] {
  return block.appliesTo.filter((docId) =>
    fieldsOfDoc(ctx, docId).some((field) => field.signerId === block.signerId),
  );
}

/**
 * Tipos de trazo que el bloque exige: la union, por documento del alcance,
 * de los tipos de hueco de SU firmante. Firma antes que iniciales.
 */
export function blockRequiredTypes(
  block: SignerBlock,
  ctx: BlockContext,
): SignatureFieldType[] {
  const found = new Set<SignatureFieldType>();
  for (const docId of block.appliesTo) {
    for (const type of requiredCaptureTypes(fieldsOfDoc(ctx, docId), block.signerId)) {
      found.add(type);
    }
  }
  return (["signature", "initials"] as const).filter((type) => found.has(type));
}

/**
 * Los sellos del bloque siguen describiendo lo que su firmante vio: cada
 * documento del alcance tiene el sello de AHORA (huella + huecos propios).
 * Sin huella de algun documento no se da por buena ninguna.
 */
export function blockStampsValid(block: SignerBlock, ctx: BlockContext): boolean {
  if (block.appliesTo.length === 0) return false;
  return block.appliesTo.every((docId) => {
    const key = ctx.keys[docId];
    if (!key) return false;
    return (
      block.stamps[docId] ===
      captureStamp(key, fieldsOfDoc(ctx, docId), block.signerId)
    );
  });
}

/** El trazo que el bloque tiene VIGENTE de un tipo (`null` si caduco o no existe). */
export function visibleDraft(
  block: SignerBlock,
  type: SignatureFieldType,
  ctx: BlockContext,
): SignatureDraft | null {
  const draft = block[type];
  if (!draft) return null;
  return blockStampsValid(block, ctx) ? draft : null;
}

/** Bloque sin nada que firmar (su firmante no tiene huecos en sus documentos): vale tal cual. */
export function blockNeedsNothing(block: SignerBlock, ctx: BlockContext): boolean {
  return blockRequiredTypes(block, ctx).length === 0;
}

export function isBlockComplete(block: SignerBlock, ctx: BlockContext): boolean {
  const required = blockRequiredTypes(block, ctx);
  if (required.length === 0) return true;
  return required.every((type) => visibleDraft(block, type, ctx) !== null);
}

export function signerBlocks(
  blocks: readonly SignerBlock[],
  signerId: string,
): SignerBlock[] {
  return blocks.filter((block) => block.signerId === signerId);
}

/** El firmante tiene huecos en algun documento. */
export function signerHasSlots(ctx: BlockContext, docIds: readonly DocId[], signerId: string): boolean {
  return docIds.some((docId) =>
    fieldsOfDoc(ctx, docId).some((field) => field.signerId === signerId),
  );
}

/** Firmantes con huecos en algun documento, en el orden en que les toca. */
export function ceremonyQueue(ctx: BlockContext, docIds: readonly DocId[]): Signer[] {
  return ctx.signers.filter((signer) => signerHasSlots(ctx, docIds, signer.id));
}

/** El firmante tiene todos sus bloques (con algo que firmar) completos. */
export function isSignerDone(
  blocks: readonly SignerBlock[],
  signerId: string,
  ctx: BlockContext,
): boolean {
  return signerBlocks(blocks, signerId).every((block) => isBlockComplete(block, ctx));
}

/** Cuantos bloques del firmante con algo que firmar siguen sin completar. */
export function pendingBlockCount(
  blocks: readonly SignerBlock[],
  signerId: string,
  ctx: BlockContext,
): number {
  return signerBlocks(blocks, signerId).filter(
    (block) => !isBlockComplete(block, ctx),
  ).length;
}

/** Un firmante cuya firma YA estaba hecha y dejo de valer, y por que (F0-fix, D7). */
export type StaleSigner = { signerId: string; reason: StaleReason };

/** Con varios motivos a la vez, el que se dice: lo que la persona acaba de hacer (el texto) antes que lo demas. */
const STALE_PRIORITY: readonly StaleReason[] = ["text", "fields", "document"];

/**
 * Firmantes de la cola cuyo trazo ya estaba hecho pero su SELLO por documento dejo de valer (se edito el texto del
 * documento, cambiaron los huecos o el archivo) y por eso vuelven a estar pendientes: sin esto la pantalla solo los ve
 * «sin firmar» y nadie sabe que paso. En el orden de la cola. Sin huella de algun documento (aun calculandose) no se
 * dice nada; un firmante que nunca firmo (o ya volvio a firmar) no cuenta.
 */
export function staleSigners(
  blocks: readonly SignerBlock[],
  ctx: BlockContext,
  docIds: readonly DocId[],
): StaleSigner[] {
  const result: StaleSigner[] = [];
  for (const signer of ceremonyQueue(ctx, docIds)) {
    if (isSignerDone(blocks, signer.id, ctx)) continue;
    const found = new Set<StaleReason>();
    for (const block of signerBlocks(blocks, signer.id)) {
      if (!block.signature && !block.initials) continue;
      for (const docId of block.appliesTo) {
        const stored = block.stamps[docId];
        const key = ctx.keys[docId];
        if (!stored || !key) continue;
        const reason = staleReason(stored, captureStamp(key, fieldsOfDoc(ctx, docId), signer.id));
        if (reason) found.add(reason);
      }
    }
    const reason = STALE_PRIORITY.find((candidate) => found.has(candidate));
    if (reason) result.push({ signerId: signer.id, reason });
  }
  return result;
}

/** Firmantes de la cola que aun no han terminado todos sus bloques. */
export function pendingBlockSigners(
  blocks: readonly SignerBlock[],
  ctx: BlockContext,
  docIds: readonly DocId[],
): Signer[] {
  return ceremonyQueue(ctx, docIds).filter(
    (signer) => !isSignerDone(blocks, signer.id, ctx),
  );
}

/**
 * La misma pregunta, documento a documento y con la maquinaria de siempre
 * (`isSignerComplete` sobre el `CaptureMap` proyectado): lo que decide la
 * entrega. Coincide con `isBlockComplete`; los tests lo comprueban.
 */
export function isSignerCompleteEverywhere(
  blocks: readonly SignerBlock[],
  ctx: BlockContext,
  docIds: readonly DocId[],
  signerId: string,
): boolean {
  return docIds.every((docId) => {
    const captures: CaptureMap = projectCaptures(blocks, docId);
    return isSignerComplete(
      fieldsOfDoc(ctx, docId),
      captures,
      signerId,
      ctx.keys[docId] ?? null,
    );
  });
}

/* ------------------------------------------------------------------ *
 * Escritura de lo que el firmante crea
 * ------------------------------------------------------------------ */

export type DraftPatch = {
  signature?: SignatureDraft | null;
  initials?: SignatureDraft | null;
};

/**
 * Guarda un trazo (o varios) en un bloque y recalcula el SELLO de cada
 * documento de su alcance en este mismo momento, con la huella y los huecos
 * de AHORA. Lo que el bloque ya tenia solo se conserva si seguia vigente
 * (si los huecos cambiaron, el trazo viejo no se reaplica: nadie lo vio sobre
 * esa disposicion). Cada documento se escribe por `applyCaptures`, la misma
 * puerta que usan los flujos de un documento.
 */
export function captureForBlock(
  blocks: readonly SignerBlock[],
  blockId: string,
  patch: DraftPatch,
  ctx: BlockContext,
): SignerBlock[] {
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (!block) return blocks as SignerBlock[];
  const signature =
    patch.signature !== undefined
      ? patch.signature
      : visibleDraft(block, "signature", ctx);
  const initials =
    patch.initials !== undefined
      ? patch.initials
      : visibleDraft(block, "initials", ctx);

  let result = blocks as SignerBlock[];
  for (const docId of block.appliesTo) {
    const key = ctx.keys[docId];
    const stamp = key ? captureStamp(key, fieldsOfDoc(ctx, docId), block.signerId) : "";
    result = applyCaptures(result, docId, {
      ...projectCaptures(result, docId),
      [block.signerId]: { signature, initials, stamp },
    });
  }
  return result;
}

/** Vacia el bloque (trazos y sellos): «Rehacer todo». */
export function clearBlock(
  blocks: readonly SignerBlock[],
  blockId: string,
): SignerBlock[] {
  return blocks.map((block) =>
    block.id === blockId
      ? { ...block, signature: null, initials: null, stamps: {} }
      : block,
  );
}

/** Lo que una firma guardada trae (las dos imagenes ya como borrador). */
export type SavedDrafts = {
  signature: SignatureDraft | null;
  initials: SignatureDraft | null;
};

export type ApplySavedResult = {
  blocks: SignerBlock[];
  /** Bloques en los que se escribio algo (el elegido primero). */
  appliedBlockIds: string[];
  /** Tipos que el bloque elegido exigia y la entrada no trae ni el bloque tenia. */
  missing: SignatureFieldType[];
  /** Cuantos OTROS bloques se rellenaron (solo con `applyToAll`). */
  filledOthers: number;
};

/**
 * Aplica una firma guardada al bloque elegido: sus dos imagenes a la vez
 * (lo que la entrada no trae NO se inventa; queda como captura parcial y se
 * avisa). Con `applyToAll`, ademas rellena SOLO LO VACIO de los demas bloques
 * del mismo firmante: un tipo que el bloque exige y aun no tiene vigente. Lo
 * que el bloque ya tenia nunca se pisa en los otros.
 */
export function applySavedToBlocks(
  blocks: readonly SignerBlock[],
  blockId: string,
  saved: SavedDrafts,
  applyToAll: boolean,
  ctx: BlockContext,
): ApplySavedResult {
  const target = blocks.find((candidate) => candidate.id === blockId);
  if (!target) {
    return { blocks: blocks as SignerBlock[], appliedBlockIds: [], missing: [], filledOthers: 0 };
  }
  const required = blockRequiredTypes(target, ctx);
  const patch: DraftPatch = {};
  const missing: SignatureFieldType[] = [];
  for (const type of required) {
    const image = saved[type];
    if (image) patch[type] = image;
    else if (!visibleDraft(target, type, ctx)) missing.push(type);
  }
  let result = captureForBlock(blocks, blockId, patch, ctx);
  const appliedBlockIds = [blockId];
  let filledOthers = 0;

  if (applyToAll) {
    for (const other of signerBlocks(blocks, target.signerId)) {
      if (other.id === blockId) continue;
      const otherRequired = blockRequiredTypes(other, ctx);
      const fill: DraftPatch = {};
      for (const type of otherRequired) {
        if (saved[type] && !visibleDraft(other, type, ctx)) fill[type] = saved[type];
      }
      if (Object.keys(fill).length === 0) continue;
      result = captureForBlock(result, other.id, fill, ctx);
      appliedBlockIds.push(other.id);
      filledOthers += 1;
    }
  }
  return { blocks: result, appliedBlockIds, missing, filledOthers };
}

/* ------------------------------------------------------------------ *
 * Anadir y quitar bloques
 * ------------------------------------------------------------------ */

export type AddBlockResult = ScopeChange & {
  /** Bloque nuevo; `null` = no se pudo (cada documento ya tiene el suyo). */
  addedBlockId: string | null;
};

/**
 * Anade un bloque al firmante. Un bloque sin documentos no existe, asi que
 * el nuevo se queda con UN documento: `preferDocId` si se pide (el que
 * `coverageIssues` echa en falta; si otro bloque del firmante lo tenia, se lo
 * lleva) o, sin preferencia, el ultimo documento del bloque con mas
 * documentos (solo se parte un bloque que tenga al menos dos).
 */
export function addBlock(
  blocks: readonly SignerBlock[],
  signerId: string,
  docOrder: readonly DocId[],
  preferDocId?: DocId,
  mint: () => string = nextBlockId,
): AddBlockResult {
  const own = signerBlocks(blocks, signerId);
  let docId = preferDocId;
  if (!docId) {
    const widest = own.reduce<SignerBlock | null>(
      (best, block) => (!best || block.appliesTo.length > best.appliesTo.length ? block : best),
      null,
    );
    if (!widest || widest.appliesTo.length < 2) {
      return { blocks: blocks as SignerBlock[], moved: [], removed: [], addedBlockId: null };
    }
    docId = [...widest.appliesTo].sort(
      (a, b) => docOrder.indexOf(a) - docOrder.indexOf(b),
    )[widest.appliesTo.length - 1];
  }
  const fresh: SignerBlock = {
    id: mint(),
    signerId,
    appliesTo: [docId],
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
  };
  // El nuevo nace con `appliesTo` ya fijado: `setBlockScope` solo tiene que
  // quitar ese documento al bloque que lo tuviera (y anotar el movimiento).
  const placeholder: SignerBlock = { ...fresh, appliesTo: [] };
  const withFresh = [...blocks, placeholder];
  const change = setBlockScope(withFresh, fresh.id, [docId], docOrder);
  return { ...change, addedBlockId: fresh.id };
}

export type RemoveBlockResult = {
  blocks: SignerBlock[];
  /** Bloque que se quedo con los documentos del quitado; `null` = no se quito. */
  receiverId: string | null;
  /** Documentos que cambiaron de bloque. */
  movedDocs: DocId[];
};

/**
 * Quita un bloque. Sus documentos pasan al bloque anterior del mismo firmante
 * (o al siguiente si era el primero): ningun documento queda sin cubrir. Con
 * un solo bloque no se puede quitar. Los documentos que llegan no traen
 * sello (el bloque que los recibe no los habia visto): hay que confirmarlos.
 */
export function removeBlock(
  blocks: readonly SignerBlock[],
  blockId: string,
  docOrder: readonly DocId[],
): RemoveBlockResult {
  const target = blocks.find((candidate) => candidate.id === blockId);
  if (!target) return { blocks: blocks as SignerBlock[], receiverId: null, movedDocs: [] };
  const own = signerBlocks(blocks, target.signerId);
  if (own.length < 2) return { blocks: blocks as SignerBlock[], receiverId: null, movedDocs: [] };
  const index = own.findIndex((block) => block.id === blockId);
  const receiver = own[index > 0 ? index - 1 : 1];
  const appliesTo = [...new Set([...receiver.appliesTo, ...target.appliesTo])].sort(
    (a, b) => docOrder.indexOf(a) - docOrder.indexOf(b),
  );
  const next = blocks
    .filter((block) => block.id !== blockId)
    .map((block) => (block.id === receiver.id ? { ...block, appliesTo } : block));
  return { blocks: next, receiverId: receiver.id, movedDocs: [...target.appliesTo] };
}

/* ------------------------------------------------------------------ *
 * Turno de la ceremonia (Fase 0 «Firma agil», U0.2)
 * ------------------------------------------------------------------ */

/** Etapas de un turno: traspaso del dispositivo, captura de los trazos y revision. */
export type CeremonyStage = "handoff" | "capture" | "review";

const CEREMONY_STAGES: readonly CeremonyStage[] = ["handoff", "capture", "review"];

/**
 * Donde esta la ronda: de quien es el turno y en que etapa. Vive en la SESION
 * (no en el estado local de la ceremonia): tocar la pestana de otro documento,
 * «Atras» -> «Continuar» o recargar vuelven a montar la ceremonia, y el turno
 * tiene que seguir donde estaba. Se identifica por el id del firmante (estable
 * entre guardados), no por la posicion en la cola (que cambia con los huecos).
 */
export type CeremonyState = { signerId: string; stage: CeremonyStage };

/** El estado resuelto contra la cola de ahora: `index === queue.length` = ya no hay turno. */
export type CeremonyPosition = { index: number; stage: CeremonyStage };

/**
 * Posicion (en la cola) del PRIMER firmante que aun no ha terminado; `queue.length`
 * si todos terminaron (o la cola esta vacia). Es lo que decide a quien se le pasa
 * el dispositivo al arrancar y al acabar un turno: nunca a quien ya firmo.
 */
export function firstPendingTurn(
  queue: readonly { id: string }[],
  isDone: (signerId: string) => boolean,
): number {
  const index = queue.findIndex((signer) => !isDone(signer.id));
  return index === -1 ? queue.length : index;
}

/**
 * El turno que se muestra: lo guardado si sigue valiendo y, si no (no hay nada
 * guardado, el firmante ya no esta en la cola, un borrador anterior o a mano),
 * el del primer firmante pendiente, en el traspaso.
 *
 * Una revision solo existe con el firmante completo: si dejo de estarlo (los
 * huecos cambiaron) se vuelve a la captura en vez de ensenar una revision vacia.
 */
export function resolveCeremony(
  stored: CeremonyState | null | undefined,
  queue: readonly { id: string }[],
  isDone: (signerId: string) => boolean,
  /**
   * Un firmante cuya firma YA hecha dejo de valer (se cambio el texto del documento, F0-fix D7): el turno vuelve a el, en el
   * traspaso, aunque el guardado fuera de otro. Es derivado, no se guarda: en cuanto vuelve a firmar, el turno guardado manda.
   */
  redirectTo?: string | null,
): CeremonyPosition {
  if (redirectTo && stored?.signerId !== redirectTo) {
    const index = queue.findIndex((signer) => signer.id === redirectTo);
    if (index !== -1) return { index, stage: "handoff" };
  }
  if (stored && CEREMONY_STAGES.includes(stored.stage)) {
    const index = queue.findIndex((signer) => signer.id === stored.signerId);
    if (index !== -1) {
      const stage =
        stored.stage === "review" && !isDone(stored.signerId) ? "capture" : stored.stage;
      return { index, stage };
    }
  }
  return { index: firstPendingTurn(queue, isDone), stage: "handoff" };
}

/** Lo que se guarda para un turno de la cola; `null` si ya no hay turno (todos terminaron). */
export function ceremonyAt(
  queue: readonly { id: string }[],
  index: number,
  stage: CeremonyStage,
): CeremonyState | null {
  const signer = queue[index];
  return signer ? { signerId: signer.id, stage } : null;
}

/**
 * Lo que viene de fuera (un borrador de IndexedDB, de una version anterior o
 * manipulado) no se da por bueno: forma exacta, etapa conocida y un firmante que
 * existe. Todo lo demas es «sin turno guardado» y se deriva de lo que falta.
 */
export function sanitizeCeremony(
  raw: unknown,
  signerIds: readonly string[],
): CeremonyState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { signerId, stage } = raw as { signerId?: unknown; stage?: unknown };
  if (typeof signerId !== "string" || !signerIds.includes(signerId)) return null;
  if (!CEREMONY_STAGES.includes(stage as CeremonyStage)) return null;
  return { signerId, stage: stage as CeremonyStage };
}

/** Un trazo que el turno exige (firma o iniciales de un bloque) y si ya esta hecho. */
export type TurnItem = { blockId: string; type: SignatureFieldType; done: boolean };

/**
 * Lo que le falta a un firmante, bloque a bloque y en el orden en que se le
 * muestra (firma antes que iniciales). `done` = el trazo vigente existe.
 */
export function turnProgress(
  blocks: readonly SignerBlock[],
  signerId: string,
  ctx: BlockContext,
): TurnItem[] {
  return signerBlocks(blocks, signerId).flatMap((block) =>
    blockRequiredTypes(block, ctx).map((type) => ({
      blockId: block.id,
      type,
      done: visibleDraft(block, type, ctx) !== null,
    })),
  );
}

/** «Firma» / «Iniciales». */
export function captureTypeLabel(type: SignatureFieldType, strings: SignStrings): string {
  return type === "signature" ? strings.fieldSignature : strings.fieldInitials;
}

/* ------------------------------------------------------------------ *
 * Textos de alcance
 * ------------------------------------------------------------------ */

/** Nombre corto de un documento para listas y resumenes: sin `.pdf`. */
export function docLabel(name: string): string {
  const trimmed = name.trim().replace(/\.pdf$/i, "");
  return trimmed === "" ? name : trimmed;
}

/** Documentos que se nombran antes de resumir el resto como «+N». */
const SUMMARY_NAMES = 3;

/**
 * «Todos (4)» / «Contrato A, Anexo» / «Contrato A, Anexo, Acta +2».
 */
export function scopeSummary(
  block: Pick<SignerBlock, "appliesTo">,
  docs: readonly DocRef[],
  strings: SignStrings,
): string {
  const inScope = docs.filter((doc) => block.appliesTo.includes(doc.id));
  if (docs.length > 1 && inScope.length === docs.length) {
    return strings.blockScopeAll(docs.length);
  }
  return strings.blockScopeSome(
    inScope.slice(0, SUMMARY_NAMES).map((doc) => docLabel(doc.name)),
    Math.max(0, inScope.length - SUMMARY_NAMES),
  );
}

/**
 * Como se nombra un trazo del turno: «Firma» y, cuando el turno tiene varios
 * bloques (cada uno con SUS documentos), «Firma · Anexo B» -- el documento es lo
 * que la persona reconoce, no el numero de bloque.
 */
export function turnItemLabel(
  item: TurnItem,
  blocks: readonly SignerBlock[],
  docs: readonly DocRef[],
  strings: SignStrings,
  withScope: boolean,
): string {
  const label = captureTypeLabel(item.type, strings);
  const block = blocks.find((candidate) => candidate.id === item.blockId);
  return withScope && block ? `${label} · ${scopeSummary(block, docs, strings)}` : label;
}

/** Nombre de un firmante con el mismo respaldo numerado que `SignerManager`. */
export function signerLabel(
  signers: readonly Signer[],
  signerId: string,
  strings: SignStrings,
): string {
  const index = signers.findIndex((signer) => signer.id === signerId);
  const signer = signers[index];
  const name = signer?.name.trim() ?? "";
  return name !== "" ? name : strings.defaultSignerName(index >= 0 ? index + 1 : 1);
}

/** Posicion (1..n) de un bloque entre los de su firmante. */
export function blockNumber(
  blocks: readonly SignerBlock[],
  blockId: string,
): number {
  const target = blocks.find((block) => block.id === blockId);
  if (!target) return 1;
  return signerBlocks(blocks, target.signerId).findIndex((block) => block.id === blockId) + 1;
}

/**
 * Frase del anuncio tras fijar un alcance: lo que cambio de bloque para
 * cumplir el invariante («Anexo pasa del bloque 2 al bloque 1.»).
 */
export function scopeMoveAnnouncement(
  change: ScopeChange,
  before: readonly SignerBlock[],
  after: readonly SignerBlock[],
  docs: readonly DocRef[],
  strings: SignStrings,
): string {
  if (change.moved.length === 0) return "";
  return change.moved
    .map((move) => {
      const name = docLabel(docs.find((doc) => doc.id === move.docId)?.name ?? move.docId);
      return strings.blockScopeMoved(
        name,
        blockNumber(before, move.fromBlockId),
        blockNumber(after, move.toBlockId),
      );
    })
    .join(" ");
}

/** `sourceDocument` de «Recordar»: el primer documento del alcance o «N documentos». */
export function rememberSource(
  block: Pick<SignerBlock, "appliesTo">,
  docs: readonly DocRef[],
  strings: SignStrings,
): string {
  const inScope = docs.filter((doc) => block.appliesTo.includes(doc.id));
  if (inScope.length === 0) return "";
  if (inScope.length === 1) return inScope[0].name;
  return strings.vaultSourceMany(inScope.length);
}

export type ScopeEdit = {
  blocks: SignerBlock[];
  /** Frase para la region viva: alcance nuevo + lo que cambio de bloque. */
  message: string;
};

/**
 * Fija el alcance de un bloque (`setBlockScope`) y redacta el anuncio. Si el
 * alcance es vacio o el bloque no existe, no cambia nada ni anuncia nada.
 */
export function changeBlockScope(
  blocks: readonly SignerBlock[],
  blockId: string,
  docIds: readonly DocId[],
  docs: readonly DocRef[],
  strings: SignStrings,
): ScopeEdit {
  const change = setBlockScope(
    blocks,
    blockId,
    docIds,
    docs.map((doc) => doc.id),
  );
  if (change.blocks === blocks) return { blocks: change.blocks, message: "" };
  const edited = change.blocks.find((block) => block.id === blockId);
  const head = edited
    ? strings.blockScopeUpdated(
        strings.blockName(blockNumber(change.blocks, blockId)),
        scopeSummary(edited, docs, strings),
      )
    : "";
  const moves = scopeMoveAnnouncement(change, blocks, change.blocks, docs, strings);
  return { blocks: change.blocks, message: [head, moves].filter(Boolean).join(" ") };
}
