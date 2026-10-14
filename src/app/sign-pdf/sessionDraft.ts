import {
  EMPTY_DOC_STATE,
  docIdOf,
  docIdsOf,
  docStateOf,
  ensureBlocks,
  liveFields,
  migrateCaptures,
  normalizeBlocks,
  reserveBlockIds,
  type DocId,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import type { CaptureMap } from "@/app/sign-pdf/captures";
import { sanitizeCeremony } from "@/app/sign-pdf/blockModel";
import { activeDocOf, type SignSession } from "@/app/sign-pdf/signSession";
import { migrateStep } from "@/app/sign-pdf/signSteps";
import type {
  SaveSessionParams,
  SessionDraftMeta,
} from "@/app/sign-pdf/signDrafts";
import type { SignatureField } from "@/lib/pdf/sign";
import { sanitizeTextEdits } from "@/app/sign-pdf/textEdits";

/*
 * Borrador de SESION (varios documentos): traduccion pura entre la sesion viva
 * de `SignToolClient` y lo que se guarda en IndexedDB (`signDrafts.ts`). Sin
 * React ni IndexedDB, para poder probarla a fondo.
 *
 * Los `DocId` vivos (`doc-N`) los reparte un contador de modulo: al recargar la
 * pestana cambian. Por eso lo guardado usa ids PROPIOS de la sesion guardada
 * (`SessionIdentity.stored`), estables entre guardados, y al restaurar se
 * reasignan a los `DocId` de los archivos recien creados. Mantener la tabla
 * viva->guardado tras retomar evita reescribir los PDF en el siguiente guardado.
 */

export type SessionIdentity = {
  /** Id de la sesion guardada (`s-...`). */
  id: string;
  /** `DocId` vivo -> id del documento dentro de la sesion guardada. */
  stored: Map<DocId, string>;
  /** Ya hay (o hay a punto de haber) un borrador de esta sesion en la base: un borrado posterior hace falta. */
  saved: boolean;
};

let sessionCounter = 0;

/** Id nuevo de sesion: legible, con marca de tiempo y azar para no chocar entre pestanas. */
export function newSessionId(): string {
  sessionCounter += 1;
  const random = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0");
  return `s-${Date.now().toString(36)}-${sessionCounter.toString(36)}${random}`;
}

export function createSessionIdentity(): SessionIdentity {
  return { id: newSessionId(), stored: new Map(), saved: false };
}

/**
 * La identidad que corresponde a los documentos de ahora: la actual si al
 * menos uno de ellos ya pertenece a la sesion guardada (misma ronda, aunque se
 * hayan quitado o anadido otros) y, si no (una ronda NUEVA con otros archivos),
 * una nueva -- asi una ronda nueva nunca pisa el borrador de la anterior.
 */
export function identityFor(
  current: SessionIdentity | null,
  liveDocIds: readonly DocId[],
): SessionIdentity {
  if (current && liveDocIds.some((id) => current.stored.has(id))) return current;
  if (current && current.stored.size === 0) return current;
  return createSessionIdentity();
}

/** Id guardado de un documento vivo: el que ya tenia o uno nuevo, sin repetir ninguno de la sesion. */
export function storedIdOf(identity: SessionIdentity, docId: DocId): string {
  const known = identity.stored.get(docId);
  if (known !== undefined) return known;
  const used = new Set(identity.stored.values());
  let candidate = docId;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${docId}-${n}`;
  identity.stored.set(docId, candidate);
  return candidate;
}

/**
 * Hay algo que merezca guardarse: algun firmante, hueco, campo de texto o
 * valor escrito, en cualquiera de los documentos. Misma regla que el
 * autoguardado de un solo documento.
 */
export function hasSessionProgress(
  session: Pick<SignSession, "signers" | "docs">,
  docOrder: readonly DocId[],
): boolean {
  if (session.signers.length > 0) return true;
  return docOrder.some((id) => {
    const doc = docStateOf(session.docs, id);
    return (
      liveFields(doc, session.signers).length > 0 ||
      doc.textFields.length > 0 ||
      Object.keys(doc.textValues).length > 0 ||
      (doc.textEdits?.length ?? 0) > 0
    );
  });
}

function mapBlock(
  block: SignerBlock,
  toStored: (docId: DocId) => string | undefined,
): SignerBlock {
  const appliesTo: string[] = [];
  for (const id of block.appliesTo) {
    const mapped = toStored(id);
    if (mapped !== undefined) appliesTo.push(mapped);
  }
  const stamps: Record<string, string> = {};
  for (const [id, stamp] of Object.entries(block.stamps)) {
    const mapped = toStored(id);
    if (mapped !== undefined && stamp) stamps[mapped] = stamp;
  }
  return { ...block, appliesTo, stamps };
}

/**
 * Lo que se guarda de la sesion de ahora. Los huecos de firmantes ya quitados
 * NO se guardan (un firmante borrado no resucita al retomar); los bloques
 * salen ya ajustados a firmantes y documentos vivos, con sus trazos y sellos.
 * Los bytes se piden con `getBytes` solo si la base aun no los tiene.
 */
export type SessionSource = Pick<
  SignSession,
  "mode" | "signMode" | "signers" | "blocks" | "docs" | "step" | "activeDocId" | "docOrder"
> &
  Partial<Pick<SignSession, "ceremony">>;

export function snapshotSession(args: {
  identity: SessionIdentity;
  session: SessionSource;
  files: readonly File[];
  getBytes: (file: File) => Promise<Uint8Array>;
}): SaveSessionParams {
  const { identity, session, files, getBytes } = args;
  const docOrder = docIdsOf(files);

  // Fuera de la tabla los documentos que ya no estan (su archivo se borra al guardar).
  for (const id of [...identity.stored.keys()]) {
    if (!docOrder.includes(id)) identity.stored.delete(id);
  }
  for (const id of docOrder) storedIdOf(identity, id);

  const blocks = ensureBlocks(session.signers, docOrder, session.signMode, session.blocks);
  const toStored = (docId: DocId) => identity.stored.get(docId);
  const active = activeDocOf(session, docOrder);
  // El turno solo se guarda si su firmante sigue en la sesion (no hay turnos huerfanos).
  const ceremony = sanitizeCeremony(
    session.ceremony,
    session.signers.map((signer) => signer.id),
  );

  return {
    id: identity.id,
    mode: session.mode,
    signMode: session.signMode,
    signers: session.signers,
    blocks: blocks.map((block) => mapBlock(block, toStored)),
    documents: files.map((file) => {
      const docId = docIdOf(file);
      const state = docStateOf(session.docs, docId);
      return {
        id: identity.stored.get(docId) as string,
        fileName: file.name,
        size: file.size,
        state: { ...state, fields: liveFields(state, session.signers) },
        getBytes: () => getBytes(file),
      };
    }),
    activeDocId: active ? (identity.stored.get(active) ?? null) : null,
    step: session.step,
    ...(ceremony ? { ceremony } : {}),
  };
}

export type RestoredSession = {
  /** Lo que hay que poner en la sesion del shell. */
  patch: Partial<SignSession>;
  /** Para seguir guardando sobre la MISMA sesion sin reescribir los PDF. */
  identity: SessionIdentity;
  /** Bloques que reclamaban un mismo documento a la vez (borrador corrupto): se normalizo, gana el primero. */
  normalized: number;
  /** Documentos cuya huella ya no coincide con la guardada: sus sellos se descartaron. */
  staleDocs: number;
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function restoreDocState(
  stored: Partial<DocState> | undefined,
  key: string | null,
): { state: DocState; stale: boolean } {
  const base = stored ?? {};
  const savedSeal = typeof base.sealedKey === "string" ? base.sealedKey : "";
  const stale = key !== null && savedSeal !== "" && savedSeal !== key;
  const rect = base.rect;
  // Las ediciones de texto describen los bytes originales: si la huella cambio ya no valen.
  const textEdits = stale ? [] : sanitizeTextEdits(base.textEdits);
  return {
    stale,
    state: {
      ...EMPTY_DOC_STATE,
      fields: asArray<SignatureField>(base.fields),
      textFields: asArray(base.textFields),
      textValues:
        typeof base.textValues === "object" && base.textValues !== null
          ? base.textValues
          : {},
      // Si la huella cambio, el contenido de los campos detectados ya no es fiable.
      textFieldsDetectedFor: stale ? null : (base.textFieldsDetectedFor ?? null),
      rect: rect ?? EMPTY_DOC_STATE.rect,
      pageIndex: typeof base.pageIndex === "number" ? base.pageIndex : 0,
      fieldPageIndex:
        typeof base.fieldPageIndex === "number" ? base.fieldPageIndex : 0,
      // Vuelve a sellar con la huella RECALCULADA de los bytes recuperados.
      sealedKey: key ?? "",
      ...(textEdits.length > 0 ? { textEdits } : {}),
    },
  };
}

/**
 * Recompone la sesion guardada sobre los archivos recien creados.
 *
 * - `files[i]` y `keys[i]` corresponden a `meta.documents[i]`; `keys` son las
 *   huellas recalculadas de los bytes (o `null` si no se pudieron calcular).
 * - El sello de un bloque (`stamps`) solo vale si coincide con la huella del
 *   documento: aqui se descartan los de un documento cuya huella cambio, y
 *   `validCapture` vuelve a comprobarlos con la huella viva al usarlos.
 * - Un borrador sin `blocks` pero con `captures` (anterior al modelo de bloques)
 *   migra con `migrateCaptures` sobre su primer documento.
 * - El paso se normaliza con `migrateStep`.
 */
export function restoreSession(
  meta: SessionDraftMeta,
  files: readonly File[],
  keys: readonly (string | null)[],
): RestoredSession {
  const liveIds = files.map(docIdOf);
  const toLive = new Map<string, DocId>();
  meta.documents.forEach((doc, index) => {
    if (liveIds[index] !== undefined) toLive.set(doc.id, liveIds[index]);
  });

  const docs: Record<DocId, DocState> = {};
  const staleLive = new Set<DocId>();
  meta.documents.forEach((doc, index) => {
    const live = liveIds[index];
    if (live === undefined) return;
    const restored = restoreDocState(meta.docStates[doc.id], keys[index] ?? null);
    docs[live] = restored.state;
    if (restored.stale) staleLive.add(live);
  });

  const legacyCaptures = (meta as unknown as { captures?: CaptureMap }).captures;
  const rawBlocks: SignerBlock[] =
    meta.blocks !== undefined
      ? meta.blocks
      : legacyCaptures && liveIds[0] !== undefined
        ? migrateCaptures(legacyCaptures, meta.documents[0]?.id ?? liveIds[0])
        : [];

  const mapped: SignerBlock[] = rawBlocks
    .map((block) => {
      const appliesTo: DocId[] = [];
      for (const id of asArray<string>(block.appliesTo)) {
        const live = toLive.get(id);
        if (live !== undefined) appliesTo.push(live);
      }
      const stamps: Record<DocId, string> = {};
      for (const [id, stamp] of Object.entries(block.stamps ?? {})) {
        const live = toLive.get(id);
        if (live !== undefined && stamp && !staleLive.has(live)) stamps[live] = stamp;
      }
      return {
        ...block,
        appliesTo,
        stamps,
        signature: block.signature ?? null,
        initials: block.initials ?? null,
        auto: block.auto === true,
      };
    })
    .filter((block) => block.appliesTo.length > 0);
  reserveBlockIds(mapped.map((block) => block.id));

  const normalized = normalizeBlocks(mapped, liveIds);
  const blocks = ensureBlocks(
    meta.signers,
    liveIds,
    meta.signMode,
    normalized.blocks,
  );

  const activeDocId =
    (meta.activeDocId ? toLive.get(meta.activeDocId) : undefined) ?? liveIds[0] ?? null;

  // Un borrador anterior no trae turno (se deriva de lo que falta); uno raro o manipulado, tampoco.
  const ceremony = sanitizeCeremony(
    meta.ceremony,
    meta.signers.map((signer) => signer.id),
  );

  const identity: SessionIdentity = {
    id: meta.id,
    stored: new Map(
      meta.documents.flatMap((doc, index) =>
        liveIds[index] !== undefined ? [[liveIds[index], doc.id] as const] : [],
      ),
    ),
    saved: true,
  };

  return {
    patch: {
      mode: meta.mode,
      signMode: meta.signMode,
      signers: meta.signers,
      blocks,
      docs,
      docOrder: liveIds,
      activeDocId,
      step: migrateStep(meta.step),
      ...(ceremony ? { ceremony } : {}),
    },
    identity,
    normalized: normalized.warnings.length,
    staleDocs: staleLive.size,
  };
}
