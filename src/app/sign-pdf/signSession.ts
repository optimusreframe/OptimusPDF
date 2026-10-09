import type { PlacementTool } from "@/app/sign-pdf/DocumentCanvas";
import type {
  MultiStep,
  SignMode as WhoSigns,
  SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import {
  EMPTY_DOC_STATE,
  applyCaptures,
  docStateOf,
  ensureBlocks,
  liveFields,
  migrateCaptures,
  nextActiveDoc,
  pruneDocs,
  projectCaptures,
  type DocId,
  type DocState,
  type SignMode,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import type { CaptureMap } from "@/app/sign-pdf/captures";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * Sesion de Sign PDF con varios documentos: el estado CANONICO que guarda
 * `ToolShell` como "opciones", y su traduccion de ida y vuelta con la VISTA
 * PLANA de un documento (`SignToolOptions`) que consumen `MultiFlow`,
 * `SoloFlow` y `useDocumentSession` sin saber que hay mas de un documento.
 *
 *   sesion (canonica)  --viewOf(docId)-->  SignToolOptions (plana)
 *   sesion (canonica)  <--applyViewPatch(docId, patch)--  setOptions(patch)
 *
 * Quien escribe lo hace SIEMPRE contra un `docId` concreto (el del flujo
 * montado con `key={docId}`), no contra "el documento activo de ahora": una
 * escritura tardia (huella, deteccion de campos) de un documento que ya no es
 * el activo, o que ya se quito, aterriza en SU sitio -- o se descarta -- y
 * nunca en el vecino. Eso cierra por construccion las carreras de quitar y
 * subir documentos.
 *
 * Funciones puras, sin React.
 */

export type SignSession = {
  /* --- Globales (no dependen del documento) --- */
  /** "Solo yo" o "Varios firmantes". */
  mode: WhoSigns;
  signaturePng: string;
  ratio: number;
  step: MultiStep;
  signers: Signer[];
  activeSignerId: string | null;
  selectedFieldId: string | null;
  placementTool: PlacementTool;
  selectedTextFieldId: string | null;
  editingTextFieldId: string | null;

  /* --- Por documento --- */
  /** Estado de cada documento, indexado por `DocId`. Sin entrada = documento en blanco. */
  docs: Record<DocId, DocState>;
  /** Cola de documentos tal y como la ve la sesion (se sincroniza con los archivos). */
  docOrder: DocId[];
  activeDocId: DocId | null;

  /* --- Firmas --- */
  /** "Mismas firmas" o "distintas por documento". */
  signMode: SignMode;
  blocks: SignerBlock[];
};

export const DEFAULT_SESSION: SignSession = {
  mode: "single",
  signaturePng: "",
  ratio: 0,
  step: "signers",
  signers: [],
  activeSignerId: null,
  selectedFieldId: null,
  placementTool: "select",
  selectedTextFieldId: null,
  editingTextFieldId: null,
  docs: {},
  docOrder: [],
  activeDocId: null,
  signMode: "same",
  blocks: [],
};

/** Lo que vuelve a su valor inicial cuando entra una ronda de documentos nueva. */
const FRESH_ROUND: Partial<SignSession> = {
  step: "signers",
  selectedFieldId: null,
  selectedTextFieldId: null,
  editingTextFieldId: null,
};

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Documento activo REAL: el guardado si sigue en la cola; si no, el vecino del que se quito. */
export function activeDocOf(
  session: Pick<SignSession, "docOrder" | "activeDocId">,
  order: readonly DocId[],
): DocId | null {
  return nextActiveDoc(session.docOrder, order, session.activeDocId);
}

/**
 * Vista plana de un documento: las opciones de siempre. `parts` permite al
 * componente aportar `fields` y `captures` memoizados (referencias estables
 * entre renders), que los flujos usan como dependencias de efectos.
 */
export function viewOf(
  session: SignSession,
  docId: DocId,
  parts?: { fields?: SignatureField[]; captures?: CaptureMap },
): SignToolOptions {
  const doc = docStateOf(session.docs, docId);
  return {
    mode: session.mode,
    signaturePng: session.signaturePng,
    ratio: session.ratio,
    pageIndex: doc.pageIndex,
    rect: doc.rect,
    signature: doc.sealedKey,
    step: session.step,
    signers: session.signers,
    fields: parts?.fields ?? liveFields(doc, session.signers),
    captures: parts?.captures ?? projectCaptures(session.blocks, docId),
    activeSignerId: session.activeSignerId,
    fieldPageIndex: doc.fieldPageIndex,
    selectedFieldId: session.selectedFieldId,
    placementTool: session.placementTool,
    textFields: doc.textFields,
    textValues: doc.textValues,
    selectedTextFieldId: session.selectedTextFieldId,
    editingTextFieldId: session.editingTextFieldId,
    textFieldsDetectedFor: doc.textFieldsDetectedFor,
  };
}

const GLOBAL_KEYS = [
  "mode",
  "signaturePng",
  "ratio",
  "step",
  "activeSignerId",
  "selectedFieldId",
  "placementTool",
  "selectedTextFieldId",
  "editingTextFieldId",
] as const satisfies readonly (keyof SignToolOptions & keyof SignSession)[];

/**
 * Traduce un patch de la vista plana de `docId` a un patch de la sesion.
 *  - Lo del documento (`fields`, `textFields`, `rect`, `signature`...) va a
 *    `docs[docId]`; `signature` es el sello (`sealedKey`) del documento.
 *  - `signers` cambia la lista global: los bloques se reajustan y los huecos
 *    de este documento que ya no tienen firmante se retiran. Los de los demas
 *    documentos quedan ocultos (no se ven ni cuentan) hasta que se vuelva a
 *    escribir en ellos: asi el "Deshacer" de un firmante borrado los recupera.
 *  - `captures` se vuelca en los bloques (ver `applyCaptures`).
 * `docOrder` es la cola REAL ahora mismo (los archivos), no la que la sesion
 * recuerde.
 */
export function applyViewPatch(
  session: SignSession,
  docId: DocId,
  patch: Partial<SignToolOptions>,
  docOrder: readonly DocId[],
): Partial<SignSession> {
  const out: Partial<SignSession> = {};

  for (const key of GLOBAL_KEYS) {
    const value = patch[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }

  let signers = session.signers;
  const signersChanged = patch.signers !== undefined && patch.signers !== signers;
  if (patch.signers !== undefined) {
    signers = patch.signers;
    out.signers = signers;
  }

  const doc = docStateOf(session.docs, docId);
  const docPatch: Partial<DocState> = {};
  if (patch.pageIndex !== undefined) docPatch.pageIndex = patch.pageIndex;
  if (patch.rect !== undefined) docPatch.rect = patch.rect;
  if (patch.signature !== undefined) docPatch.sealedKey = patch.signature;
  if (patch.fieldPageIndex !== undefined) {
    docPatch.fieldPageIndex = patch.fieldPageIndex;
  }
  if (patch.textFields !== undefined) docPatch.textFields = patch.textFields;
  if (patch.textValues !== undefined) docPatch.textValues = patch.textValues;
  if (patch.textFieldsDetectedFor !== undefined) {
    docPatch.textFieldsDetectedFor = patch.textFieldsDetectedFor;
  }
  if (patch.fields !== undefined || signersChanged) {
    const base = patch.fields ?? doc.fields;
    if (signersChanged) {
      const alive = new Set(signers.map((signer) => signer.id));
      docPatch.fields = base.filter((field) => alive.has(field.signerId));
    } else {
      docPatch.fields = base;
    }
  }
  if (Object.keys(docPatch).length > 0) {
    out.docs = { ...session.docs, [docId]: { ...doc, ...docPatch } };
  }

  let blocks = session.blocks;
  if (signersChanged) {
    blocks = ensureBlocks(signers, docOrder, session.signMode, blocks);
  }
  if (patch.captures !== undefined) {
    blocks = applyCaptures(blocks, docId, patch.captures);
  }
  if (blocks !== session.blocks) out.blocks = blocks;

  return out;
}

/**
 * Lo que hay que poner al dia cuando cambian los archivos: poda el estado de
 * los documentos que ya no estan, elige documento activo, recuerda la cola y
 * reajusta los bloques. Vacio si ya esta todo al dia (idempotente).
 *
 * Una ronda NUEVA (ninguno de los documentos de ahora estaba en la cola
 * anterior ni tiene estado) arranca desde el principio -- paso "Firmantes", sin seleccion --,
 * como antes hacia el reinicio al cambiar de archivo; los firmantes, el modo y
 * la herramienta sobreviven.
 */
export function syncSession(
  session: SignSession,
  docOrder: readonly DocId[],
): Partial<SignSession> {
  const out: Partial<SignSession> = {};
  if (docOrder.length === 0) return out;

  const docs = pruneDocs(session.docs, docOrder);
  if (docs !== session.docs) out.docs = docs;

  const fresh =
    !session.docOrder.some((id) => docOrder.includes(id)) &&
    docOrder.every((id) => !(id in session.docs));
  if (fresh) Object.assign(out, FRESH_ROUND);

  const active = activeDocOf(session, docOrder);
  if (active !== session.activeDocId) out.activeDocId = active;
  if (!sameList(docOrder, session.docOrder)) out.docOrder = [...docOrder];

  const blocks = ensureBlocks(
    session.signers,
    docOrder,
    session.signMode,
    session.blocks,
  );
  if (blocks !== session.blocks) out.blocks = blocks;

  return out;
}

/**
 * Sesion que arranca de un documento ya preparado (reanudar un borrador,
 * importar una configuracion): el patch de opciones planas que antes se
 * pasaba al cargar, traducido al modelo por documento. Los trazos de un
 * `CaptureMap` v1 pasan a un bloque automatico por firmante.
 */
export function sessionFromView(
  docId: DocId,
  view: Partial<SignToolOptions>,
): Partial<SignSession> {
  const doc: DocState = {
    ...EMPTY_DOC_STATE,
    fields: view.fields ?? [],
    textFields: view.textFields ?? [],
    textValues: view.textValues ?? {},
    textFieldsDetectedFor: view.textFieldsDetectedFor ?? null,
    rect: view.rect ?? EMPTY_DOC_STATE.rect,
    pageIndex: view.pageIndex ?? 0,
    fieldPageIndex: view.fieldPageIndex ?? 0,
    sealedKey: view.signature ?? "",
  };
  const signers = view.signers ?? [];
  const blocks = ensureBlocks(
    signers,
    [docId],
    "same",
    migrateCaptures(view.captures ?? {}, docId),
  );
  const out: Partial<SignSession> = {
    docs: { [docId]: doc },
    docOrder: [docId],
    activeDocId: docId,
    blocks,
    signers,
  };
  for (const key of GLOBAL_KEYS) {
    const value = view[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
