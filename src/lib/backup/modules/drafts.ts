import {
  MAX_EDIT_DRAFT_BYTES,
  MAX_EDIT_DRAFTS,
  MAX_EDIT_DRAFTS_TOTAL_BYTES,
  commitEditDraftImport,
  listEditDrafts,
  loadEditDraft,
  type EditDraftMeta,
  type EditDraftSummary,
} from "@/app/edit-pdf/editDrafts";
import {
  detectImageMime,
  editSessionFromJSON,
  editSessionToJSON,
  pendingChangeCount,
  referencedAssets,
  EDIT_MAX_ITEMS,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import {
  MAX_PRO_DRAFT_BYTES,
  MAX_PRO_DRAFTS,
  MAX_PRO_DRAFTS_TOTAL_BYTES,
  commitProDraftImport,
  listProDrafts,
  loadProDraft,
  type ProDraftMeta,
  type ProDraftSummary,
} from "@/app/pdf-pro/proDrafts";
import {
  blocksHaveStrokes,
  capturesHaveStrokes,
  expiryFor,
  SIGNATURE_DRAFT_TTL_MS,
  isExpired,
  withoutBlockStrokes,
  withoutCaptureStrokes,
} from "@/app/sign-pdf/draftPrivacy";
import { newDocumentDraftId, newSessionCopyId } from "@/app/sign-pdf/draftIds";
import { readSignaturesInDraft } from "@/app/sign-pdf/signFeatureFlags";
import {
  MAX_DRAFTS,
  MAX_DRAFTS_TOTAL_BYTES,
  MAX_SESSION_DRAFT_BYTES,
  commitDraftImport,
  listDraftsForBackup,
  peekDocumentDraft,
  peekSessionDraft,
  type DraftImportDocument,
  type DraftImportExpectation,
  type DraftImportSession,
  type DraftMeta,
  type SessionDraftMeta,
} from "@/app/sign-pdf/signDrafts";
import { sha256Hex } from "@/lib/crypto/sha256";
import { browserInputGuard, type InputGuard } from "@/lib/pdf/inputGuard";
import { CURRENT_DRAFTS_SCHEMA, migrateDraftsIndex } from "@/lib/backup/migrations/drafts";
import {
  DRAFTS_MODULE,
  MAX_DRAFTS_JSON_BYTES,
  MAX_DRAFT_PDF_BYTES,
} from "@/lib/backup/modules/moduleSpecs";
import {
  MAX_EDIT_ASSET_BYTES,
  MAX_INDEX_ITEMS_PER_KIND,
  MAX_STROKE_BYTES,
  MAX_STROKE_DIMENSION,
  hasOwn,
  isRecord,
  parseEditHeader,
  parseProDraft,
  parseSignDocument,
  parseSignSession,
  type ParseFailure,
  type ParsedEditHeader,
  type ParsedSignDocument,
  type StrokeContext,
} from "@/lib/backup/modules/draftsSchema";
import { dataUrlFromPng, hasValidPngShape, pngBytesFromDataUrl } from "@/lib/backup/modules/draftsPng";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  PACKAGE_LIMITS,
  PackageError,
  type PackageFileInput,
  type PackageFileRead,
  type PackageModuleInput,
  type PackageReadResult,
} from "@/lib/backup/types";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { LegacyMultiStep } from "@/app/sign-pdf/SignToolClient";

/**
 * Modulo «Borradores» del respaldo (`docs/PLAN-FIRMA-AGIL.md` §9.3 y §10.2, U4.6): los trabajos sin terminar de
 * Firmar (documentos sueltos y sesiones de varios documentos), de Editar y de PDF Pro, CON sus PDF, para poder
 * continuarlos en otro dispositivo desde «Recientes -> Continuar».
 *
 * ```
 * drafts/index.json                 { sign: { documents: [..], sessions: [..] }, edit: [..], pro: [..] }
 * drafts/<ref>.pdf                  PDF del borrador (d1.. documento suelto, e1.. Editar, p1.. PDF Pro)
 * drafts/<ref>-<n>.pdf              n-esimo documento de la sesion s1..
 * drafts/<ref>-k<n>.png             trazos de firma / iniciales (PNG; en la base son data: URL)
 * drafts/<ref>-session.json         sesion de Editar (items; las imagenes aparte)
 * drafts/<ref>-a<n>.png|jpg         imagenes anadidas en un borrador de Editar
 * ```
 * La ruta de cada archivo se DERIVA de `ref` y del orden y debe coincidir con la que cita el indice: ni nombres ni
 * tipos MIME del zip se creen.
 *
 * Privacidad: el resumen previo (`summarizeDrafts`) cuenta cuantos borradores viajan, cuanto pesan y si incluyen trazos
 * de firma; el paquete SIEMPRE incluye los borradores que se pidan (decision del usuario, §10.2) pero se recomienda
 * cifrarlo (la interfaz lo ofrece, no es obligatorio). No se exporta un borrador CADUCADO (con firmas guardadas hace mas
 * de 7 dias). Con «Guardar tambien las firmas recogidas» (`signaturesInDraft`) apagado, los trazos NO viajan (el
 * borrador sale como se guardaria hoy: `signaturesOmitted`), y al IMPORTAR se descartan igual.
 *
 * Importar (`planDraftsImport` -> `applyDraftsImport`): cada borrador queda «Nuevo», «Ya lo tienes (idéntico)» (mismo
 * contenido en cualquier id local) o «Distinto» (mismo id, otro contenido) -> Reemplazar / Conservar ambos (solo Firmar:
 * id nuevo con nonce) / Omitir. NUNCA se expulsa un borrador local para hacer sitio y no se pisa uno MAS NUEVO sin que
 * la decision sea explicita (la sugerida es no hacerlo). Se escribe cada almacen en UNA transaccion y, si un almacen
 * falla, se deshacen los anteriores. Los PDF pasan `validatePdf` (la interfaz le pasa `inputGuard.ts`) y los trazos
 * `validateImage`; todo se revalida al aplicar.
 *
 * LIMITES: (1) Editar: el borrador se llama como la huella del PDF, asi que no hay «conservar ambos» (sustituir u
 * omitir). (2) PDF Pro: solo viaja el snapshot actual y las etiquetas del historial (como ya hace la app: el historial
 * de bytes no se guarda). (3) Un borrador de Firmar con un trazo que no sea un PNG canonico de <= 1 MiB no se exporta.
 * (4) El paquete no puede pasar de 250 MiB: con mas borradores de los que caben, el usuario debe elegir (`kinds`).
 */

export { DRAFTS_MODULE, DRAFTS_MODULE_SPEC, MAX_DRAFTS_JSON_BYTES, MAX_DRAFT_PDF_BYTES } from "@/lib/backup/modules/moduleSpecs";
const INDEX_PATH = "drafts/index.json";

/** Reserva para el manifiesto y los demas modulos del mismo paquete al comprobar que los borradores caben. */
const DEFAULT_PACKAGE_BYTES_BUDGET = PACKAGE_LIMITS.maxUncompressedBytes - 4 * 1024 * 1024;
let PACKAGE_BYTES_BUDGET = DEFAULT_PACKAGE_BYTES_BUDGET;

/** Solo para pruebas: acota el tope de bytes del paquete (evita reservar 250 MB); sin argumentos lo restaura. */
export function __setDraftsPackageBudgetForTests(bytes?: number): void {
  PACKAGE_BYTES_BUDGET = bytes ?? DEFAULT_PACKAGE_BYTES_BUDGET;
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  // copia al Uint8Array del dominio actual (en jsdom el de TextEncoder es ajeno)
  return new Uint8Array(encoder.encode(JSON.stringify(value)));
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .flatMap((key) => (record[key] === undefined ? [] : [`${JSON.stringify(key)}:${stableStringify(record[key])}`]));
  return `{${body.join(",")}}`;
}

/* ------------------------------------------------------------------ *
 * Forma portable de cada borrador (sirve para EXPORTAR y para COMPARAR)
 * ------------------------------------------------------------------ */

type Portable = { item: Record<string, unknown>; files: PackageFileInput[]; strokes: number };

class Unexportable extends Error {}

type ExportedStroke = { png: string; ratio: number };

function makeStrokeWriter(ref: string, files: PackageFileInput[]) {
  let next = 0;
  return (draft: SignatureDraft | null | undefined): ExportedStroke | null => {
    if (!draft) return null;
    const png = pngBytesFromDataUrl(draft.dataUrl);
    if (
      !png ||
      !hasValidPngShape(png, MAX_STROKE_BYTES, MAX_STROKE_DIMENSION) ||
      typeof draft.ratio !== "number" ||
      !Number.isFinite(draft.ratio) ||
      draft.ratio <= 0
    ) {
      throw new Unexportable("stroke");
    }
    const path = `drafts/${ref}-k${next}.png`;
    next += 1;
    files.push({ path, data: png, type: "image/png" });
    return { png: path, ratio: draft.ratio };
  };
}

/** Un borrador de UN documento (v1) en su forma portable. `keep = false` quita los trazos (como los guardaria el ajuste apagado). */
export function portableSignDocument(meta: DraftMeta, bytes: Uint8Array, ref: string, keep: boolean): Portable {
  const files: PackageFileInput[] = [{ path: `drafts/${ref}.pdf`, data: bytes, type: "application/pdf" }];
  const stroke = makeStrokeWriter(ref, files);
  const stripped = keep ? { captures: meta.captures, stripped: false } : withoutCaptureStrokes(meta.captures);
  const captures: Record<string, unknown> = {};
  for (const signerId of Object.keys(stripped.captures).sort()) {
    const capture = stripped.captures[signerId];
    captures[signerId] = {
      signature: stroke(capture.signature),
      initials: stroke(capture.initials),
      stamp: capture.stamp,
    };
  }
  const hasStrokes = keep && capturesHaveStrokes(meta.captures);
  const omitted = (meta.signaturesOmitted === true && !hasStrokes) || stripped.stripped;
  const item: Record<string, unknown> = {
    ref,
    id: meta.id,
    fingerprint: meta.fingerprint ?? meta.id,
    fileName: meta.fileName,
    savedAt: meta.savedAt,
    mode: meta.mode,
    step: meta.step,
    signers: meta.signers,
    fields: meta.fields,
    textFields: meta.textFields,
    textValues: meta.textValues,
    textFieldsDetectedFor: meta.textFieldsDetectedFor ?? null,
    ...(meta.textEdits && meta.textEdits.length > 0 ? { textEdits: meta.textEdits } : {}),
    captures,
    ...(hasStrokes ? { expiresAt: meta.expiresAt ?? expiryFor(meta.savedAt) } : {}),
    ...(omitted ? { signaturesOmitted: true } : {}),
  };
  return { item, files, strokes: files.length - 1 };
}

/** Una sesion de varios documentos en su forma portable. */
export function portableSignSession(
  meta: SessionDraftMeta,
  documents: ReadonlyArray<{ id: string; bytes: Uint8Array }>,
  ref: string,
  keep: boolean,
): Portable {
  const files: PackageFileInput[] = meta.documents.map((doc, index) => {
    const found = documents.find((d) => d.id === doc.id);
    if (!found) throw new Unexportable("document");
    return { path: `drafts/${ref}-${index}.pdf`, data: found.bytes, type: "application/pdf" };
  });
  const pdfCount = files.length;
  const stroke = makeStrokeWriter(ref, files);
  const stripped = keep ? { blocks: meta.blocks, stripped: false } : withoutBlockStrokes(meta.blocks ?? []);
  const blocks = (stripped.blocks ?? []).map((block) => ({
    id: block.id,
    signerId: block.signerId,
    appliesTo: block.appliesTo,
    signature: stroke(block.signature),
    initials: stroke(block.initials),
    stamps: block.stamps,
    auto: block.auto === true,
  }));
  const hasStrokes = keep && blocksHaveStrokes(meta.blocks);
  const omitted = (meta.signaturesOmitted === true && !hasStrokes) || stripped.stripped;
  const item: Record<string, unknown> = {
    ref,
    id: meta.id,
    savedAt: meta.savedAt,
    mode: meta.mode,
    signMode: meta.signMode,
    step: meta.step,
    signers: meta.signers,
    blocks,
    documents: meta.documents.map((doc) => ({ id: doc.id, fileName: doc.fileName })),
    docStates: meta.docStates,
    activeDocId: meta.activeDocId ?? null,
    ...(meta.ceremony && !stripped.stripped ? { ceremony: meta.ceremony } : {}),
    ...(meta.turnOrder && meta.turnOrder.length > 0 ? { turnOrder: meta.turnOrder } : {}),
    ...(hasStrokes ? { expiresAt: meta.expiresAt ?? expiryFor(meta.savedAt) } : {}),
    ...(omitted ? { signaturesOmitted: true } : {}),
  };
  return { item, files, strokes: files.length - pdfCount };
}

function portableEdit(summary: EditDraftSummary, pdf: Uint8Array, session: EditSession, ref: string): Portable {
  const files: PackageFileInput[] = [
    { path: `drafts/${ref}.pdf`, data: pdf, type: "application/pdf" },
    { path: `drafts/${ref}-session.json`, data: jsonBytes(editSessionToJSON(session, { inlineAssets: false })), type: "application/json" },
  ];
  const assets = referencedAssets(session).map((asset, index) => {
    const mime = detectImageMime(asset.bytes);
    if (!mime) throw new Unexportable("asset");
    const path = `drafts/${ref}-a${index}.${mime === "image/png" ? "png" : "jpg"}`;
    files.push({ path, data: asset.bytes, type: mime });
    return { assetId: asset.assetId, mime, path };
  });
  const item: Record<string, unknown> = {
    ref,
    id: summary.id,
    fileName: summary.fileName,
    savedAt: summary.savedAt,
    pageCount: summary.pageCount,
    currentPage: summary.currentPage,
    session: `drafts/${ref}-session.json`,
    assets,
  };
  return { item, files, strokes: 0 };
}

function portablePro(
  summary: Pick<ProDraftSummary, "id" | "fileName" | "savedAt" | "pageCount" | "currentPage">,
  pdf: Uint8Array,
  history: ProDraftMeta["history"],
  ref: string,
): Portable {
  return {
    item: {
      ref,
      id: summary.id,
      fileName: summary.fileName,
      savedAt: summary.savedAt,
      pageCount: summary.pageCount,
      currentPage: summary.currentPage,
      history: history.map((note) => ({
        label: note.label,
        createdAt: note.createdAt,
        source: note.source,
        ...(note.opId ? { opId: note.opId } : {}),
      })),
    },
    files: [{ path: `drafts/${ref}.pdf`, data: pdf, type: "application/pdf" }],
    strokes: 0,
  };
}

/** Claves que NO cuentan para decidir si dos borradores son el mismo contenido. */
const VOLATILE_ITEM_KEYS: ReadonlySet<string> = new Set(["ref", "id", "savedAt", "expiresAt"]);

/** Huella del CONTENIDO de un borrador (sin id, fecha ni caducidad): la misma para el local y para el del paquete. */
async function contentKeyOf(portable: Portable): Promise<string> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(portable.item)) {
    if (!VOLATILE_ITEM_KEYS.has(key)) content[key] = value;
  }
  const hashes: string[] = [];
  for (const file of [...portable.files].sort((a, b) => a.path.localeCompare(b.path))) {
    hashes.push(`${file.path}:${await sha256Hex(file.data)}`);
  }
  return `${stableStringify(content)}|${hashes.join(",")}`;
}

/* ------------------------------------------------------------------ *
 * Resumen previo a exportar
 * ------------------------------------------------------------------ */

export type DraftsSummary =
  | {
      ok: true;
      sign: { documents: number; sessions: number; count: number; bytes: number };
      edit: { count: number; bytes: number };
      pro: { count: number; bytes: number };
      total: { count: number; bytes: number };
      /** Borradores de Firmar con trazos de firma guardados hoy (aunque no viajen). */
      withSignatureStrokes: number;
      /** Los trazos VIAJARIAN (hay trazos y el ajuste «guardar las firmas» esta encendido). */
      includesSignatureStrokes: boolean;
      /** Hay trazos guardados, pero el ajuste esta apagado: no viajan. */
      strokesHeldBack: boolean;
      /** Borradores que no se ofrecen porque caducaron (aun no purgados) o no se pueden leer. */
      expiredSkipped: number;
      unreadable: number;
      /** Cualquier borrador lleva documentos y datos de clientes: se recomienda cifrar. */
      containsClientData: boolean;
      encryptionRecommended: boolean;
      /** El total cabe en un paquete (< 250 MiB). */
      fitsInPackage: boolean;
    }
  | { ok: false; reason: "unavailable" };

/**
 * «N borradores de Firmar, M de Editar, X MB; incluyen trazos de firma: sí/no». Solo lee metadatos (ni bytes ni
 * contenido) y no cambia nada. Sin IndexedDB, `{ ok: false }`.
 */
export async function summarizeDrafts(): Promise<DraftsSummary> {
  const sign = await listDraftsForBackup();
  if (!sign) return { ok: false, reason: "unavailable" };
  const [edit, pro] = await Promise.all([listEditDrafts(), listProDrafts()]);
  const keep = readSignaturesInDraft();
  const withStrokes =
    sign.documents.filter((meta) => capturesHaveStrokes(meta.captures)).length +
    sign.sessions.filter((meta) => blocksHaveStrokes(meta.blocks)).length;
  const signBytes =
    sign.documents.reduce((sum, meta) => sum + meta.fileSize, 0) +
    sign.sessions.reduce((sum, meta) => sum + meta.fileSize, 0);
  const editBytes = edit.reduce((sum, draft) => sum + draft.totalBytes, 0);
  const proBytes = pro.reduce((sum, draft) => sum + draft.fileSize, 0);
  const count = sign.documents.length + sign.sessions.length + edit.length + pro.length;
  const bytes = signBytes + editBytes + proBytes;
  return {
    ok: true,
    sign: {
      documents: sign.documents.length,
      sessions: sign.sessions.length,
      count: sign.documents.length + sign.sessions.length,
      bytes: signBytes,
    },
    edit: { count: edit.length, bytes: editBytes },
    pro: { count: pro.length, bytes: proBytes },
    total: { count, bytes },
    withSignatureStrokes: withStrokes,
    includesSignatureStrokes: withStrokes > 0 && keep,
    strokesHeldBack: withStrokes > 0 && !keep,
    expiredSkipped: sign.expired,
    unreadable: sign.unreadable,
    containsClientData: count > 0,
    encryptionRecommended: count > 0,
    fitsInPackage: bytes <= PACKAGE_BYTES_BUDGET,
  };
}

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

export type ExportDraftsOptions = {
  /** Que tipos de borrador viajan. Por defecto, todos. */
  kinds?: { sign?: boolean; edit?: boolean; pro?: boolean };
  /**
   * Incluir los trazos de firma. Solo puede QUITARLOS: con el ajuste «guardar las firmas» apagado nunca viajan, aunque
   * aqui se pida `true`.
   */
  includeStrokes?: boolean;
  /** Solo para pruebas: la fecha con la que se juzga la caducidad. */
  now?: number;
};

export type ExportDraftsReport = {
  signDocuments: number;
  signSessions: number;
  edit: number;
  pro: number;
  bytes: number;
  includesStrokes: boolean;
  /** Borradores que se quedaron fuera porque no se pudieron leer o no se pueden empaquetar. */
  skipped: number;
  /** Caducados (no se exportan). */
  expired: number;
};

/**
 * Modulo «Borradores» con lo que hay ahora en este navegador, mas un informe de lo que viajo y de lo que se quedo fuera.
 * Lee SIN efectos (no anota versiones en esta pestana, no purga, no restaura). Sin IndexedDB lanza
 * `PackageError("unavailable")`; si los borradores pasan del tope de un paquete, `PackageError("tooLarge")` (la interfaz
 * debe dejar elegir `kinds`).
 */
export async function exportDraftsDetailed(
  options: ExportDraftsOptions = {},
): Promise<{ module: PackageModuleInput; report: ExportDraftsReport }> {
  const wantSign = options.kinds?.sign !== false;
  const wantEdit = options.kinds?.edit !== false;
  const wantPro = options.kinds?.pro !== false;
  const keep = options.includeStrokes !== false && readSignaturesInDraft();
  const now = options.now ?? Date.now();

  const listing = wantSign ? await listDraftsForBackup(now) : { documents: [], sessions: [], unreadable: 0, expired: 0 };
  if (!listing) throw new PackageError("unavailable");

  const files: PackageFileInput[] = [];
  const signDocuments: Record<string, unknown>[] = [];
  const signSessions: Record<string, unknown>[] = [];
  const edit: Record<string, unknown>[] = [];
  const pro: Record<string, unknown>[] = [];
  let skipped = listing.unreadable;
  let strokes = 0;
  let bytes = 0;
  const take = (portable: Portable): void => {
    for (const file of portable.files) bytes += file.data.byteLength;
    if (bytes > PACKAGE_BYTES_BUDGET) throw new PackageError("tooLarge");
    files.push(...portable.files);
    strokes += portable.strokes;
  };

  for (const summary of [...listing.documents].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    const loaded = await peekDocumentDraft(summary.id, now);
    if (!loaded) {
      skipped += 1;
      continue;
    }
    try {
      const portable = portableSignDocument(loaded.meta, loaded.bytes, `d${signDocuments.length + 1}`, keep);
      take(portable);
      signDocuments.push(portable.item);
    } catch (error) {
      if (error instanceof PackageError) throw error;
      skipped += 1;
    }
  }
  for (const summary of [...listing.sessions].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    const loaded = await peekSessionDraft(summary.id, now);
    if (!loaded) {
      skipped += 1;
      continue;
    }
    try {
      const portable = portableSignSession(loaded.meta, loaded.files, `s${signSessions.length + 1}`, keep);
      take(portable);
      signSessions.push(portable.item);
    } catch (error) {
      if (error instanceof PackageError) throw error;
      skipped += 1;
    }
  }
  if (wantEdit) {
    for (const summary of [...(await listEditDrafts())].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
      const loaded = await loadEditDraft(summary.id);
      if (!loaded.ok) {
        skipped += 1;
        continue;
      }
      try {
        const portable = portableEdit(loaded.draft.meta, loaded.draft.bytes, loaded.draft.session, `e${edit.length + 1}`);
        take(portable);
        edit.push(portable.item);
      } catch (error) {
        if (error instanceof PackageError) throw error;
        skipped += 1;
      }
    }
  }
  if (wantPro) {
    for (const summary of [...(await listProDrafts())].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
      const loaded = await loadProDraft(summary.id);
      if (!loaded.ok) {
        skipped += 1;
        continue;
      }
      const portable = portablePro(loaded.draft.meta, loaded.draft.bytes, loaded.draft.history, `p${pro.length + 1}`);
      take(portable);
      pro.push(portable.item);
    }
  }

  const index = { sign: { documents: signDocuments, sessions: signSessions }, edit, pro };
  files.unshift({ path: INDEX_PATH, data: jsonBytes(index), type: "application/json" });
  return {
    module: {
      name: DRAFTS_MODULE,
      schemaVersion: CURRENT_DRAFTS_SCHEMA,
      meta: {
        signDocuments: signDocuments.length,
        signSessions: signSessions.length,
        editDrafts: edit.length,
        proDrafts: pro.length,
        includesStrokes: strokes > 0,
      },
      files,
    },
    report: {
      signDocuments: signDocuments.length,
      signSessions: signSessions.length,
      edit: edit.length,
      pro: pro.length,
      bytes,
      includesStrokes: strokes > 0,
      skipped,
      expired: listing.expired,
    },
  };
}

export async function exportDrafts(options: ExportDraftsOptions = {}): Promise<PackageModuleInput> {
  return (await exportDraftsDetailed(options)).module;
}

/* ------------------------------------------------------------------ *
 * Planificar la importacion
 * ------------------------------------------------------------------ */

export type DraftKind = "sign-document" | "sign-session" | "edit" | "pro";
export type DraftItemStatus = "new" | "identical" | "different" | "invalid";
export type DraftInvalidReason =
  | "integrity"
  | "invalidEntry"
  | "duplicateId"
  | "invalidPdf"
  | "invalidImage"
  | "fingerprint"
  | "expired"
  | "tooLarge"
  | "tooMany";
export type DraftDecision = "import" | "replace" | "keepBoth" | "omit";

type SignDocumentPayload = { kind: "sign-document"; meta: DraftImportDocument["meta"]; bytes: Uint8Array };
type SignSessionPayload = { kind: "sign-session"; meta: DraftImportSession["meta"]; files: { id: string; bytes: Uint8Array }[] };
type EditPayload = { kind: "edit"; meta: EditDraftMeta; files: { key: string; bytes: Uint8Array }[] };
type ProPayload = { kind: "pro"; meta: ProDraftMeta; bytes: Uint8Array };
export type DraftPayload = SignDocumentPayload | SignSessionPayload | EditPayload | ProPayload;

export type DraftImportItem = {
  /** Clave de la decision: `<tipo>:<id>`; los invalidos reciben `<tipo>:#invalid-N` (el `#` no puede estar en un id real). */
  key: string;
  kind: DraftKind;
  /** Id en el paquete (o el sintetico de un invalido). */
  id: string;
  status: DraftItemStatus;
  reason?: DraftInvalidReason;
  fileName: string;
  /** Firmar con varios documentos: cuantos (1 en el resto). */
  documents: number;
  savedAt: string;
  bytes: number;
  /** Lleva trazos de firma en el paquete. */
  hasStrokes: boolean;
  /** Los trazos se DESCARTARAN al importar (el ajuste «guardar las firmas» esta apagado). */
  strokesDropped: boolean;
  /** Editar: elementos de la sesion que no pasaron la validacion y se descartaron. */
  discarded?: number;
  /** `different`/`identical`: el borrador local con el que choca. */
  conflictWith?: { id: string; savedAt: string; rev: number; bytes: number; newer: boolean };
  /** Se puede «Conservar ambos» (solo Firmar: Editar y PDF Pro se llaman como la huella del PDF). */
  canKeepBoth: boolean;
  /** Lo que se escribiria (solo si `status !== "invalid"`). */
  payload?: DraftPayload;
};

export type DraftsPlanState = "ok" | "absent" | "newerVersion" | "damaged";

type StoreLoad = { count: number; bytes: number };

export type DraftsImportPlan = {
  module: typeof DRAFTS_MODULE;
  state: DraftsPlanState;
  message?: string;
  items: DraftImportItem[];
  counts: { new: number; identical: number; different: number; invalid: number };
  /** Lo que ya ocupa cada almacen local (para comprobar los limites ANTES de escribir). */
  local: { sign: StoreLoad; edit: StoreLoad; pro: StoreLoad };
  /** Politica de trazos con la que se planifico (el ajuste «guardar las firmas»). */
  keepStrokes: boolean;
  /** El paquete lleva trazos de firma. */
  includesStrokes: boolean;
};

export type PlanDraftsOptions = {
  /**
   * Comprobacion EXTRA de cada PDF (tras la forma `%PDF-`/`%%EOF`): `false` = no vale. La interfaz pasa
   * `inputGuardPdfValidator()` (`inputGuard.ts`: vacio, truncado, cifrado, danado); sin ella solo vale la forma.
   */
  validatePdf?: (bytes: Uint8Array, fileName: string) => Promise<boolean>;
  /** Comprobacion EXTRA de cada trazo PNG (`validatePngForImport`). */
  validateImage?: (png: Uint8Array) => Promise<boolean>;
  /** Conservar los trazos al importar. Por defecto, el ajuste «guardar las firmas» de este navegador. */
  keepStrokes?: boolean;
  /** Solo para pruebas: la fecha con la que se juzga la caducidad y la de «en el futuro». */
  now?: number;
};

const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Forma minima de un PDF: la cabecera `%PDF-` en el primer KiB. NO se exige `%%EOF` al final (muchos PDF reales llevan
 * datos tras el): lo que de verdad juzga si el archivo se abre es `validatePdf` (`inputGuardPdfValidator`).
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_DRAFT_PDF_BYTES) return false;
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  for (let i = 0; i + 4 < head.length; i += 1) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * La comprobacion de PDF de la interfaz: `inputGuard.ts` (vacio, no PDF, danado/truncado, cifrado). En el navegador abre
 * el documento con el mismo motor de lectura que las miniaturas. Solo `ok` pasa.
 */
export function inputGuardPdfValidator(guard: InputGuard = browserInputGuard): NonNullable<PlanDraftsOptions["validatePdf"]> {
  return async (bytes, fileName) => {
    try {
      const file = new File([bytes as unknown as BlobPart], fileName || "documento.pdf", { type: "application/pdf" });
      return (await guard(file)).status === "ok";
    } catch {
      return false;
    }
  };
}

function blankItem(kind: DraftKind, id: string, key: string): DraftImportItem {
  return {
    key,
    kind,
    id,
    status: "invalid",
    fileName: "",
    documents: 1,
    savedAt: "",
    bytes: 0,
    hasStrokes: false,
    strokesDropped: false,
    canKeepBoth: kind === "sign-document" || kind === "sign-session",
  };
}

function fileOk(read: PackageReadResult["modules"][number], path: string): PackageFileRead | null {
  const file = read.files.get(path);
  return file && file.status === "ok" && file.bytes ? file : null;
}

function fileFailure(read: PackageReadResult["modules"][number], path: string): DraftInvalidReason {
  const file = read.files.get(path);
  return file?.status === "tooLarge" ? "tooLarge" : "integrity";
}

/**
 * Caducidad de unos trazos importados: la del paquete, pero NUNCA mas alla de la regla de la app (7 dias desde el guardado,
 * y desde ahora como mucho): un paquete hostil no puede dejar unas firmas guardadas «para siempre» con un `expiresAt`
 * en el ano 2999. Sin caducidad en el paquete, `savedAt` + 7 dias.
 */
function boundedExpiry(declared: string | null, savedAt: string, now: number): string {
  const ceiling = Math.min(Date.parse(expiryFor(savedAt)), now + SIGNATURE_DRAFT_TTL_MS);
  const wanted = declared === null ? ceiling : Date.parse(declared);
  return new Date(Math.min(wanted, ceiling)).toISOString();
}

function cappedClock(savedAt: string, now: number): string {
  return Date.parse(savedAt) > now + FUTURE_SLACK_MS ? new Date(now).toISOString() : savedAt;
}

function emptyPlan(state: DraftsPlanState, message?: string): DraftsImportPlan {
  return {
    module: DRAFTS_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    local: { sign: { count: 0, bytes: 0 }, edit: { count: 0, bytes: 0 }, pro: { count: 0, bytes: 0 } },
    keepStrokes: true,
    includesStrokes: false,
  };
}

type Candidate = { item: DraftImportItem; portable: Portable };

type Common = {
  read: PackageReadResult["modules"][number];
  options: PlanDraftsOptions;
  now: number;
  keep: boolean;
};

async function pdfProblem(
  common: Common,
  bytes: Uint8Array,
  fileName: string,
): Promise<DraftInvalidReason | null> {
  if (bytes.byteLength > MAX_DRAFT_PDF_BYTES) return "tooLarge";
  if (!looksLikePdf(bytes)) return "invalidPdf";
  if (common.options.validatePdf && !(await common.options.validatePdf(bytes, fileName))) return "invalidPdf";
  return null;
}

async function strokesProblem(common: Common, paths: readonly string[]): Promise<DraftInvalidReason | null> {
  if (!common.options.validateImage) return null;
  for (const path of paths) {
    const file = fileOk(common.read, path);
    if (!file?.bytes || !(await common.options.validateImage(file.bytes))) return "invalidImage";
  }
  return null;
}

function strokeContext(common: Common, ref: string): StrokeContext {
  return {
    ref,
    file: (path) => fileOk(common.read, path)?.bytes ?? null,
    used: new Set<string>(),
  };
}

/** Quita los trazos de un borrador de documento segun la politica y fija su caducidad. */
function finishDocumentMeta(
  parsed: ParsedSignDocument,
  bytes: Uint8Array,
  common: Common,
): { meta: DraftImportDocument["meta"]; hasStrokes: boolean; dropped: boolean; expired: boolean } {
  const captures = parsed.captures;
  const hasStrokes = capturesHaveStrokes(captures);
  const dropped = hasStrokes && !common.keep;
  const final = dropped ? withoutCaptureStrokes(captures).captures : captures;
  const keeps = capturesHaveStrokes(final);
  const savedAt = cappedClock(parsed.savedAt, common.now);
  const expiresAt = keeps ? boundedExpiry(parsed.expiresAt, savedAt, common.now) : null;
  const expired = keeps && expiresAt !== null && isExpired({ expiresAt }, common.now);
  return {
    hasStrokes,
    dropped,
    expired,
    meta: {
      id: parsed.id,
      fingerprint: parsed.fingerprint,
      fileName: parsed.fileName,
      fileSize: bytes.byteLength,
      savedAt,
      mode: parsed.mode,
      signers: parsed.signers,
      fields: parsed.fields,
      textFields: parsed.textFields,
      textValues: parsed.textValues,
      step: parsed.step as LegacyMultiStep,
      captures: final,
      textFieldsDetectedFor: parsed.textFieldsDetectedFor,
      ...(parsed.textEdits.length > 0 ? { textEdits: parsed.textEdits } : {}),
      ...(keeps && expiresAt ? { expiresAt } : {}),
      ...(dropped || (parsed.signaturesOmitted && !keeps) ? { signaturesOmitted: true as const } : {}),
    },
  };
}

async function buildSignDocument(raw: unknown, position: number, common: Common): Promise<Candidate | DraftImportItem> {
  const key = `sign-document:#invalid-${position + 1}`;
  const invalid = (reason: DraftInvalidReason, id = `#invalid-${position + 1}`, name = ""): DraftImportItem => ({
    ...blankItem("sign-document", id, key),
    fileName: name,
    reason,
  });
  const ref = isRecord(raw) && typeof raw.ref === "string" ? raw.ref : "";
  if (!/^d[0-9]{1,3}$/.test(ref)) return invalid("invalidEntry");
  const parsed = parseSignDocument(raw, strokeContext(common, ref), dataUrlFromPng);
  if ("failure" in parsed) return invalid(parsed.failure as DraftInvalidReason);
  const pdf = fileOk(common.read, `drafts/${ref}.pdf`);
  if (!pdf?.bytes) return invalid(fileFailure(common.read, `drafts/${ref}.pdf`), parsed.id, parsed.fileName);
  // La huella de la que cuelga el borrador (oferta «Retomar lo que tenias») tiene que ser la del PDF que viaja.
  if (pdf.sha256 !== parsed.fingerprint) return invalid("fingerprint", parsed.id, parsed.fileName);
  const problem = (await pdfProblem(common, pdf.bytes, parsed.fileName)) ?? (await strokesProblem(common, parsed.strokePaths));
  if (problem) return invalid(problem, parsed.id, parsed.fileName);
  const finished = finishDocumentMeta(parsed, pdf.bytes, common);
  if (finished.expired) return invalid("expired", parsed.id, parsed.fileName);
  const item: DraftImportItem = {
    key: `sign-document:${parsed.id}`,
    kind: "sign-document",
    id: parsed.id,
    status: "new",
    fileName: parsed.fileName,
    documents: 1,
    savedAt: finished.meta.savedAt,
    bytes: pdf.bytes.byteLength,
    hasStrokes: finished.hasStrokes,
    strokesDropped: finished.dropped,
    canKeepBoth: true,
    payload: { kind: "sign-document", meta: finished.meta, bytes: pdf.bytes },
  };
  const portable = portableSignDocument(finished.meta as DraftMeta, pdf.bytes, "k", true);
  return { item, portable };
}

async function buildSignSession(raw: unknown, position: number, common: Common): Promise<Candidate | DraftImportItem> {
  const key = `sign-session:#invalid-${position + 1}`;
  const invalid = (reason: DraftInvalidReason, id = `#invalid-${position + 1}`, name = ""): DraftImportItem => ({
    ...blankItem("sign-session", id, key),
    fileName: name,
    reason,
  });
  const ref = isRecord(raw) && typeof raw.ref === "string" ? raw.ref : "";
  if (!/^s[0-9]{1,3}$/.test(ref)) return invalid("invalidEntry");
  const parsed = parseSignSession(raw, strokeContext(common, ref), dataUrlFromPng);
  if ("failure" in parsed) return invalid(parsed.failure as DraftInvalidReason);
  const files: { id: string; bytes: Uint8Array }[] = [];
  let total = 0;
  for (const [index, doc] of parsed.documents.entries()) {
    const path = `drafts/${ref}-${index}.pdf`;
    const pdf = fileOk(common.read, path);
    if (!pdf?.bytes) return invalid(fileFailure(common.read, path), parsed.id, doc.fileName);
    const problem = await pdfProblem(common, pdf.bytes, doc.fileName);
    if (problem) return invalid(problem, parsed.id, doc.fileName);
    total += pdf.bytes.byteLength;
    files.push({ id: doc.id, bytes: pdf.bytes });
  }
  if (total > MAX_SESSION_DRAFT_BYTES) return invalid("tooLarge", parsed.id, parsed.documents[0].fileName);
  const strokes = await strokesProblem(common, parsed.strokePaths);
  if (strokes) return invalid(strokes, parsed.id, parsed.documents[0].fileName);

  const hasStrokes = blocksHaveStrokes(parsed.blocks);
  const dropped = hasStrokes && !common.keep;
  const stripped = dropped ? withoutBlockStrokes(parsed.blocks) : { blocks: parsed.blocks, stripped: false };
  const keeps = blocksHaveStrokes(stripped.blocks);
  const savedAt = cappedClock(parsed.savedAt, common.now);
  const expiresAt = keeps ? boundedExpiry(parsed.expiresAt, savedAt, common.now) : null;
  if (keeps && expiresAt !== null && isExpired({ expiresAt }, common.now)) {
    return invalid("expired", parsed.id, parsed.documents[0].fileName);
  }
  const meta: DraftImportSession["meta"] = {
    kind: "session",
    id: parsed.id,
    savedAt,
    mode: parsed.mode,
    signMode: parsed.signMode,
    signers: parsed.signers,
    blocks: stripped.blocks,
    documents: parsed.documents.map((doc, index) => ({
      id: doc.id,
      fileName: doc.fileName,
      fileSize: files[index].bytes.byteLength,
    })),
    docStates: parsed.docStates,
    activeDocId: parsed.activeDocId,
    step: parsed.step as LegacyMultiStep,
    // El turno guardado describia un avance que, sin trazos, ya no existe (igual que al guardar con el ajuste apagado).
    ...(parsed.ceremony && !stripped.stripped
      ? { ceremony: parsed.ceremony as NonNullable<SessionDraftMeta["ceremony"]> }
      : {}),
    ...(parsed.turnOrder ? { turnOrder: parsed.turnOrder } : {}),
    fileSize: total,
    fileName: parsed.documents[0].fileName,
    documentCount: parsed.documents.length,
    ...(keeps && expiresAt ? { expiresAt } : {}),
    ...(dropped || (parsed.signaturesOmitted && !keeps) ? { signaturesOmitted: true as const } : {}),
  };
  const item: DraftImportItem = {
    key: `sign-session:${parsed.id}`,
    kind: "sign-session",
    id: parsed.id,
    status: "new",
    fileName: meta.fileName,
    documents: parsed.documents.length,
    savedAt,
    bytes: total,
    hasStrokes,
    strokesDropped: dropped,
    canKeepBoth: true,
    payload: { kind: "sign-session", meta, files },
  };
  const portable = portableSignSession(meta as SessionDraftMeta, files, "k", true);
  return { item, portable };
}

async function buildEdit(raw: unknown, position: number, common: Common): Promise<Candidate | DraftImportItem> {
  const key = `edit:#invalid-${position + 1}`;
  const invalid = (reason: DraftInvalidReason, id = `#invalid-${position + 1}`, name = ""): DraftImportItem => ({
    ...blankItem("edit", id, key),
    fileName: name,
    reason,
    canKeepBoth: false,
  });
  const ref = isRecord(raw) && typeof raw.ref === "string" ? raw.ref : "";
  if (!/^e[0-9]{1,3}$/.test(ref)) return invalid("invalidEntry");
  const header: ParsedEditHeader | { failure: ParseFailure } = parseEditHeader(raw, ref);
  if ("failure" in header) return invalid(header.failure as DraftInvalidReason);
  const pdf = fileOk(common.read, `drafts/${ref}.pdf`);
  if (!pdf?.bytes) return invalid(fileFailure(common.read, `drafts/${ref}.pdf`), header.id, header.fileName);
  // El borrador del editor se llama como la huella del PDF: tiene que ser la de ESTE PDF.
  if (pdf.sha256 !== header.id) return invalid("fingerprint", header.id, header.fileName);
  const problem = await pdfProblem(common, pdf.bytes, header.fileName);
  if (problem) return invalid(problem, header.id, header.fileName);

  const sessionFile = fileOk(common.read, header.sessionPath);
  if (!sessionFile?.bytes) return invalid(fileFailure(common.read, header.sessionPath), header.id, header.fileName);
  let sessionJson: unknown;
  try {
    sessionJson = parseStrictJson(sessionFile.bytes, MAX_DRAFTS_JSON_BYTES);
  } catch {
    return invalid("invalidEntry", header.id, header.fileName);
  }
  if (!isRecord(sessionJson) || sessionJson.schema !== 1 || !Array.isArray(sessionJson.items)) {
    return invalid("invalidEntry", header.id, header.fileName);
  }
  if (sessionJson.items.length > EDIT_MAX_ITEMS) return invalid("tooMany", header.id, header.fileName);
  // Las imagenes vienen de los ARCHIVOS del paquete (nunca en linea: un `data` en el JSON no se lee) y se verifican.
  const assetsMap: Record<string, { mime: "image/png" | "image/jpeg"; size: number }> = {};
  const assetBytes: Record<string, Uint8Array> = {};
  for (const asset of header.assets) {
    const file = fileOk(common.read, asset.path);
    if (!file?.bytes) return invalid(fileFailure(common.read, asset.path), header.id, header.fileName);
    if (file.bytes.byteLength > MAX_EDIT_ASSET_BYTES || detectImageMime(file.bytes) !== asset.mime) {
      return invalid("invalidImage", header.id, header.fileName);
    }
    if (common.options.validateImage && asset.mime === "image/png" && !(await common.options.validateImage(file.bytes))) {
      return invalid("invalidImage", header.id, header.fileName);
    }
    assetsMap[asset.assetId] = { mime: asset.mime, size: file.bytes.byteLength };
    assetBytes[asset.assetId] = file.bytes;
  }
  const restored = editSessionFromJSON(
    { schema: 1, items: sessionJson.items, assets: assetsMap },
    { pageCount: header.pageCount ?? undefined, assetBytes },
  );
  if (restored.status === "invalid" || restored.status === "unsupported") return invalid("invalidEntry", header.id, header.fileName);
  const used = referencedAssets(restored.session);
  const totalBytes = pdf.bytes.byteLength + used.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
  if (totalBytes > MAX_EDIT_DRAFT_BYTES) return invalid("tooLarge", header.id, header.fileName);

  const savedAt = cappedClock(header.savedAt, common.now);
  const meta: EditDraftMeta = {
    schema: 1,
    id: header.id,
    fileName: header.fileName,
    fileSize: pdf.bytes.byteLength,
    totalBytes,
    savedAt,
    pageCount: header.pageCount,
    currentPage: header.currentPage,
    pendingCount: pendingChangeCount(restored.session),
    session: editSessionToJSON(restored.session, { inlineAssets: false }),
  };
  const item: DraftImportItem = {
    key: `edit:${header.id}`,
    kind: "edit",
    id: header.id,
    status: "new",
    fileName: header.fileName,
    documents: 1,
    savedAt,
    bytes: totalBytes,
    hasStrokes: false,
    strokesDropped: false,
    discarded: restored.discarded,
    canKeepBoth: false,
    payload: {
      kind: "edit",
      meta,
      files: [
        { key: header.id, bytes: pdf.bytes },
        ...used.map((asset) => ({ key: `${header.id}/${asset.assetId}`, bytes: asset.bytes })),
      ],
    },
  };
  const portable = portableEdit(meta, pdf.bytes, restored.session, "k");
  return { item, portable };
}

async function buildPro(raw: unknown, position: number, common: Common): Promise<Candidate | DraftImportItem> {
  const key = `pro:#invalid-${position + 1}`;
  const invalid = (reason: DraftInvalidReason, id = `#invalid-${position + 1}`, name = ""): DraftImportItem => ({
    ...blankItem("pro", id, key),
    fileName: name,
    reason,
    canKeepBoth: false,
  });
  const ref = isRecord(raw) && typeof raw.ref === "string" ? raw.ref : "";
  if (!/^p[0-9]{1,3}$/.test(ref)) return invalid("invalidEntry");
  const parsed = parseProDraft(raw);
  if ("failure" in parsed) return invalid(parsed.failure as DraftInvalidReason);
  const pdf = fileOk(common.read, `drafts/${ref}.pdf`);
  if (!pdf?.bytes) return invalid(fileFailure(common.read, `drafts/${ref}.pdf`), parsed.id, parsed.fileName);
  if (pdf.bytes.byteLength > MAX_PRO_DRAFT_BYTES) return invalid("tooLarge", parsed.id, parsed.fileName);
  const problem = await pdfProblem(common, pdf.bytes, parsed.fileName);
  if (problem) return invalid(problem, parsed.id, parsed.fileName);
  const savedAt = cappedClock(parsed.savedAt, common.now);
  const meta: ProDraftMeta = {
    schema: 1,
    id: parsed.id,
    fileName: parsed.fileName,
    fileSize: pdf.bytes.byteLength,
    savedAt,
    pageCount: parsed.pageCount,
    currentPage: parsed.currentPage,
    steps: Math.max(0, parsed.history.length - 1),
    history: parsed.history,
  };
  const item: DraftImportItem = {
    key: `pro:${parsed.id}`,
    kind: "pro",
    id: parsed.id,
    status: "new",
    fileName: parsed.fileName,
    documents: 1,
    savedAt,
    bytes: pdf.bytes.byteLength,
    hasStrokes: false,
    strokesDropped: false,
    canKeepBoth: false,
    payload: { kind: "pro", meta, bytes: pdf.bytes },
  };
  return { item, portable: portablePro(meta, pdf.bytes, meta.history, "k") };
}

function isCandidate(value: Candidate | DraftImportItem): value is Candidate {
  return "portable" in value;
}

type LocalSnapshot = {
  signDocuments: DraftMeta[];
  signSessions: SessionDraftMeta[];
  signExtraRows: number;
  edit: EditDraftSummary[];
  pro: ProDraftSummary[];
};

async function readLocal(now: number): Promise<LocalSnapshot | null> {
  const sign = await listDraftsForBackup(now);
  if (!sign) return null;
  const [edit, pro] = await Promise.all([listEditDrafts(), listProDrafts()]);
  return {
    signDocuments: sign.documents,
    signSessions: sign.sessions,
    signExtraRows: sign.expired,
    edit,
    pro,
  };
}

/** Compara el candidato con lo local: `identical`/`different` con su conflicto, o `new`. */
async function classify(candidate: Candidate, local: LocalSnapshot, now: number): Promise<void> {
  const { item, portable } = candidate;
  // La huella del contenido (hashea todos los archivos) solo se calcula si hay algo local con lo que compararlo.
  let cached: Promise<string> | null = null;
  const contentKey = (): Promise<string> => (cached ??= contentKeyOf(portable));
  const conflict = (id: string, savedAt: string, rev: number, bytes: number) => ({
    id,
    savedAt,
    rev,
    bytes,
    newer: Date.parse(savedAt) > Date.parse(item.savedAt),
  });

  if (item.kind === "sign-document") {
    const payload = item.payload as SignDocumentPayload;
    const byId = local.signDocuments.find((meta) => meta.id === item.id);
    const sameContent = async (meta: DraftMeta): Promise<boolean> => {
      const loaded = await peekDocumentDraft(meta.id, now);
      if (!loaded) return false;
      try {
        return (await contentKeyOf(portableSignDocument(loaded.meta, loaded.bytes, "k", true))) === (await contentKey());
      } catch {
        return false;
      }
    };
    if (byId && (await sameContent(byId))) {
      item.status = "identical";
      item.conflictWith = conflict(byId.id, byId.savedAt, byId.rev ?? 0, byId.fileSize);
      return;
    }
    // El mismo contenido bajo OTRO id (p. ej. un «conservar ambos» anterior): ya lo tienes.
    const sameFingerprint = local.signDocuments.filter(
      (meta) =>
        meta.id !== item.id && (meta.fingerprint ?? meta.id) === payload.meta.fingerprint && meta.fileSize === payload.meta.fileSize,
    );
    for (const meta of sameFingerprint) {
      if (await sameContent(meta)) {
        item.status = "identical";
        item.conflictWith = conflict(meta.id, meta.savedAt, meta.rev ?? 0, meta.fileSize);
        return;
      }
    }
    if (byId) {
      item.status = "different";
      item.conflictWith = conflict(byId.id, byId.savedAt, byId.rev ?? 0, byId.fileSize);
    }
    return;
  }

  if (item.kind === "sign-session") {
    const payload = item.payload as SignSessionPayload;
    const sameContent = async (meta: SessionDraftMeta): Promise<boolean> => {
      const loaded = await peekSessionDraft(meta.id, now);
      if (!loaded) return false;
      try {
        return (await contentKeyOf(portableSignSession(loaded.meta, loaded.files, "k", true))) === (await contentKey());
      } catch {
        return false;
      }
    };
    const byId = local.signSessions.find((meta) => meta.id === item.id);
    if (byId && (await sameContent(byId))) {
      item.status = "identical";
      item.conflictWith = conflict(byId.id, byId.savedAt, byId.rev ?? 0, byId.fileSize);
      return;
    }
    const names = payload.meta.documents.map((doc) => `${doc.fileName}:${doc.fileSize}`).join("|");
    for (const meta of local.signSessions) {
      if (meta.id === item.id) continue;
      if (meta.documents.map((doc) => `${doc.fileName}:${doc.fileSize}`).join("|") !== names) continue;
      if (await sameContent(meta)) {
        item.status = "identical";
        item.conflictWith = conflict(meta.id, meta.savedAt, meta.rev ?? 0, meta.fileSize);
        return;
      }
    }
    if (byId) {
      item.status = "different";
      item.conflictWith = conflict(byId.id, byId.savedAt, byId.rev ?? 0, byId.fileSize);
    }
    return;
  }

  if (item.kind === "edit") {
    const byId = local.edit.find((draft) => draft.id === item.id);
    if (!byId) return;
    item.conflictWith = conflict(byId.id, byId.savedAt, 0, byId.totalBytes);
    const loaded = await loadEditDraft(byId.id);
    let same = false;
    if (loaded.ok) {
      try {
        same = (await contentKeyOf(portableEdit(loaded.draft.meta, loaded.draft.bytes, loaded.draft.session, "k"))) === (await contentKey());
      } catch {
        same = false;
      }
    }
    item.status = same ? "identical" : "different";
    return;
  }

  const byId = local.pro.find((draft) => draft.id === item.id);
  if (!byId) return;
  item.conflictWith = conflict(byId.id, byId.savedAt, 0, byId.fileSize);
  const loaded = await loadProDraft(byId.id);
  item.status =
    loaded.ok && (await contentKeyOf(portablePro(loaded.draft.meta, loaded.draft.bytes, loaded.draft.history, "k"))) === (await contentKey())
      ? "identical"
      : "different";
}

/**
 * Vista previa de importar el modulo «Borradores» de un paquete ya leido (`readPackage`). No escribe nada. Lee los
 * borradores locales solo para comparar (sin efectos). Un borrador corrupto se aisla (`invalid` + motivo) sin tumbar el
 * resto; un indice ilegible o con demasiadas entradas deja el modulo `damaged`.
 */
export async function planDraftsImport(
  read: PackageReadResult,
  options: PlanDraftsOptions = {},
): Promise<DraftsImportPlan> {
  const data = read.modules.find((m) => m.name === DRAFTS_MODULE);
  if (!data) return emptyPlan("absent");
  if (data.status === "newerVersion") return emptyPlan("newerVersion", data.message ?? NEWER_VERSION_MESSAGE);

  const indexFile = fileOk(data, INDEX_PATH);
  let index: Record<string, unknown>;
  try {
    if (!indexFile?.bytes) throw new PackageError("invalidJson");
    const migrated = migrateDraftsIndex(parseStrictJson(indexFile.bytes, MAX_DRAFTS_JSON_BYTES), data.declaredSchemaVersion);
    if (!isRecord(migrated)) throw new PackageError("invalidJson");
    index = migrated;
  } catch {
    return emptyPlan("damaged");
  }
  const signPart = isRecord(index.sign) ? index.sign : {};
  const lists = {
    documents: signPart.documents === undefined ? [] : signPart.documents,
    sessions: signPart.sessions === undefined ? [] : signPart.sessions,
    edit: index.edit === undefined ? [] : index.edit,
    pro: index.pro === undefined ? [] : index.pro,
  };
  for (const value of Object.values(lists)) {
    if (!Array.isArray(value) || value.length > MAX_INDEX_ITEMS_PER_KIND) return emptyPlan("damaged");
  }

  const now = options.now ?? Date.now();
  const keep = options.keepStrokes ?? readSignaturesInDraft();
  const common: Common = { read: data, options, now, keep };
  const plan = emptyPlan("ok");
  plan.keepStrokes = keep;

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const builders: Array<[unknown[], (raw: unknown, position: number, common: Common) => Promise<Candidate | DraftImportItem>]> = [
    [lists.documents as unknown[], buildSignDocument],
    [lists.sessions as unknown[], buildSignSession],
    [lists.edit as unknown[], buildEdit],
    [lists.pro as unknown[], buildPro],
  ];
  for (const [rows, build] of builders) {
    for (const [position, raw] of rows.entries()) {
      const built = await build(raw, position, common);
      const item = isCandidate(built) ? built.item : built;
      if (!isCandidate(built)) {
        plan.items.push(item);
        continue;
      }
      if (seen.has(item.key)) {
        // Mismo id dos veces en el indice: el segundo se aisla (no pisa al primero).
        plan.items.push({
          ...blankItem(item.kind, `${item.id}#${position + 1}`, `${item.kind}:#invalid-${position + 1}`),
          fileName: item.fileName,
          reason: "duplicateId",
          canKeepBoth: item.canKeepBoth,
        });
        continue;
      }
      seen.add(item.key);
      plan.items.push(item);
      candidates.push(built);
    }
  }

  const local = await readLocal(now);
  if (local) {
    plan.local = {
      sign: {
        count: local.signDocuments.length + local.signSessions.length + local.signExtraRows,
        bytes:
          local.signDocuments.reduce((sum, meta) => sum + meta.fileSize, 0) +
          local.signSessions.reduce((sum, meta) => sum + meta.fileSize, 0),
      },
      edit: { count: local.edit.length, bytes: local.edit.reduce((sum, draft) => sum + draft.totalBytes, 0) },
      pro: { count: local.pro.length, bytes: local.pro.reduce((sum, draft) => sum + draft.fileSize, 0) },
    };
    for (const candidate of candidates) await classify(candidate, local, now);
  }
  for (const item of plan.items) plan.counts[item.status] += 1;
  plan.includesStrokes = plan.items.some((item) => item.status !== "invalid" && item.hasStrokes);
  return plan;
}

/* ------------------------------------------------------------------ *
 * Decisiones y limites
 * ------------------------------------------------------------------ */

/**
 * Decision sugerida: lo nuevo se importa; lo idéntico y lo invalido se omiten; lo distinto se REEMPLAZA solo si el del
 * paquete es MAS NUEVO que el local, y si el local es igual de nuevo o mas se CONSERVAN AMBOS (Firmar) u OMITE
 * (Editar y PDF Pro, que no pueden convivir). Jamas se pisa un borrador mas nuevo sin una decision explicita.
 */
export function defaultDraftDecisions(plan: DraftsImportPlan): Record<string, DraftDecision> {
  const out: Record<string, DraftDecision> = {};
  for (const item of plan.items) {
    if (item.status === "new") out[item.key] = "import";
    else if (item.status === "different") {
      out[item.key] = item.conflictWith && !item.conflictWith.newer ? "replace" : item.canKeepBoth ? "keepBoth" : "omit";
    } else out[item.key] = "omit";
  }
  return out;
}

type Approved = { item: DraftImportItem; decision: "import" | "replace" | "keepBoth" };

function approvedItems(plan: DraftsImportPlan, decisions: Record<string, DraftDecision | undefined>): Approved[] {
  const out: Approved[] = [];
  for (const item of plan.items) {
    if (!item.payload) continue;
    const decision = hasOwn(decisions, item.key) ? decisions[item.key] : undefined;
    if (item.status === "new" && decision === "import") out.push({ item, decision });
    else if (item.status === "different" && item.conflictWith) {
      if (decision === "replace") out.push({ item, decision });
      else if (decision === "keepBoth" && item.canKeepBoth) out.push({ item, decision });
    }
  }
  return out;
}

export type DraftsStoreLimit = {
  count: number;
  bytes: number;
  maxCount: number;
  maxBytes: number;
  ok: boolean;
};

export type DraftsLimitCheck = {
  /** Borradores aprobados que se escribirian. */
  wanted: number;
  ok: boolean;
  sign: DraftsStoreLimit;
  edit: DraftsStoreLimit;
  pro: DraftsStoreLimit;
};

/**
 * ¿Caben los aprobados SIN expulsar ninguno de los locales? (10 borradores y 300 MiB por almacen.) Se comprueba ANTES de
 * escribir; la propia escritura lo vuelve a comprobar dentro de su transaccion.
 */
export function checkDraftsLimits(
  plan: DraftsImportPlan,
  decisions: Record<string, DraftDecision | undefined>,
): DraftsLimitCheck {
  const stores = {
    sign: { count: plan.local.sign.count, bytes: plan.local.sign.bytes },
    edit: { count: plan.local.edit.count, bytes: plan.local.edit.bytes },
    pro: { count: plan.local.pro.count, bytes: plan.local.pro.bytes },
  };
  const approved = approvedItems(plan, decisions);
  for (const { item, decision } of approved) {
    const store = item.kind === "edit" ? stores.edit : item.kind === "pro" ? stores.pro : stores.sign;
    if (decision === "replace") {
      store.bytes -= item.conflictWith?.bytes ?? 0;
    } else {
      store.count += 1;
    }
    store.bytes += item.bytes;
  }
  const build = (store: { count: number; bytes: number }, maxCount: number, maxBytes: number): DraftsStoreLimit => ({
    ...store,
    maxCount,
    maxBytes,
    ok: store.count <= maxCount && store.bytes <= maxBytes,
  });
  const sign = build(stores.sign, MAX_DRAFTS, MAX_DRAFTS_TOTAL_BYTES);
  const edit = build(stores.edit, MAX_EDIT_DRAFTS, MAX_EDIT_DRAFTS_TOTAL_BYTES);
  const pro = build(stores.pro, MAX_PRO_DRAFTS, MAX_PRO_DRAFTS_TOTAL_BYTES);
  return { wanted: approved.length, ok: sign.ok && edit.ok && pro.ok, sign, edit, pro };
}

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

export type ApplyDraftsResult =
  | {
      ok: true;
      /** Borradores escritos (nuevos, sustituidos y conservados aparte). */
      written: number;
      replaced: number;
      keptBoth: number;
      /** Elementos del plan que no se escribieron. */
      skipped: number;
      /** Escritos con los trazos descartados por el ajuste «guardar las firmas». */
      strokesDropped: number;
      /** Ids con los que quedaron guardados (para `?resume=`): tipo + id. */
      saved: { kind: DraftKind; id: string }[];
    }
  | {
      ok: false;
      reason: "blocked" | "invalid" | "limit" | "changed" | "unavailable";
      limits?: DraftsLimitCheck;
      /** Ya se habian escrito otros almacenes y NO se pudieron deshacer del todo. */
      partial?: boolean;
    };

export type ApplyDraftsOptions = {
  keepStrokes?: boolean;
  now?: number;
  /** Solo para pruebas: ocurre justo antes de escribir el almacen `store` (para provocar fallos intermedios). */
  beforeCommit?: (store: "sign" | "edit" | "pro") => void | Promise<void>;
};

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Revalida el contenido de un payload (la vista previa puede venir de la interfaz): ids, tamanos, PDF y trazos. */
async function revalidate(payload: DraftPayload, now: number): Promise<boolean> {
  const strokesOk = (dataUrls: Array<string | undefined>): boolean =>
    dataUrls.every((url) => {
      if (url === undefined) return true;
      const png = pngBytesFromDataUrl(url);
      return png !== null && hasValidPngShape(png, MAX_STROKE_BYTES, MAX_STROKE_DIMENSION) !== null;
    });
  if (payload.kind === "sign-document") {
    const { meta, bytes } = payload;
    if (!(bytes instanceof Uint8Array) || !looksLikePdf(bytes) || !/^[0-9a-f]{64}$/.test(meta.id) || !isSha256(meta.fingerprint)) return false;
    if (meta.fingerprint !== (await sha256Hex(bytes)) || meta.fileSize !== bytes.byteLength) return false;
    const urls = Object.values(meta.captures ?? {}).flatMap((c) => [c.signature?.dataUrl, c.initials?.dataUrl]);
    return strokesOk(urls) && (meta.expiresAt === undefined || !isExpired(meta, now));
  }
  if (payload.kind === "sign-session") {
    const { meta, files } = payload;
    if (!/^s-[a-z0-9]{1,16}-[a-z0-9]{1,24}$/.test(meta.id) || files.length !== meta.documents.length) return false;
    if (!files.every((file, index) => file.bytes instanceof Uint8Array && looksLikePdf(file.bytes) && meta.documents[index].id === file.id)) return false;
    if (meta.blocks && meta.blocks.length > 100) return false;
    const urls = (meta.blocks ?? []).flatMap((b) => [b.signature?.dataUrl, b.initials?.dataUrl]);
    return strokesOk(urls) && (meta.expiresAt === undefined || !isExpired(meta, now));
  }
  if (payload.kind === "edit") {
    const pdf = payload.files.find((file) => file.key === payload.meta.id);
    return !!pdf && looksLikePdf(pdf.bytes) && (await sha256Hex(pdf.bytes)) === payload.meta.id;
  }
  return looksLikePdf(payload.bytes) && /^[0-9a-f]{64}$/.test(payload.meta.id);
}

/** El payload sin trazos si la politica de ESTE momento lo pide (puede haber cambiado desde la vista previa). */
function applyStrokePolicy(payload: DraftPayload, keep: boolean): { payload: DraftPayload; dropped: boolean } {
  if (keep) return { payload, dropped: false };
  if (payload.kind === "sign-document" && capturesHaveStrokes(payload.meta.captures)) {
    const { expiresAt: _expires, ...rest } = payload.meta;
    void _expires;
    return {
      payload: { ...payload, meta: { ...rest, captures: withoutCaptureStrokes(payload.meta.captures).captures, signaturesOmitted: true } },
      dropped: true,
    };
  }
  if (payload.kind === "sign-session" && blocksHaveStrokes(payload.meta.blocks)) {
    const { expiresAt: _expires, ceremony: _ceremony, ...rest } = payload.meta;
    void [_expires, _ceremony];
    return {
      payload: { ...payload, meta: { ...rest, blocks: withoutBlockStrokes(payload.meta.blocks).blocks, signaturesOmitted: true } },
      dropped: true,
    };
  }
  return { payload, dropped: false };
}

type Undo = () => Promise<void>;

/**
 * Escribe SOLO lo que `decisions` aprueba (`import` para lo nuevo; `replace` / `keepBoth` para lo distinto; cualquier
 * otra cosa u omision = no se toca). Todo se REVALIDA aqui; si no caben todos los aprobados no se escribe NINGUNO
 * (`limit`); cada almacen se escribe en una sola transaccion y, si uno falla, los anteriores se deshacen. Los trazos
 * se descartan si el ajuste «guardar las firmas» esta apagado EN ESTE MOMENTO.
 */
export async function applyDraftsImport(
  plan: DraftsImportPlan,
  decisions: Record<string, DraftDecision | undefined>,
  options: ApplyDraftsOptions = {},
): Promise<ApplyDraftsResult> {
  if (!plan || plan.state !== "ok" || !Array.isArray(plan.items)) return { ok: false, reason: "blocked" };
  const now = options.now ?? Date.now();
  const keep = options.keepStrokes ?? readSignaturesInDraft();
  const approved = approvedItems(plan, decisions ?? {});
  if (approved.length === 0) {
    return { ok: true, written: 0, replaced: 0, keptBoth: 0, skipped: plan.items.length, strokesDropped: 0, saved: [] };
  }
  const limits = checkDraftsLimits(plan, decisions ?? {});
  if (!limits.ok) return { ok: false, reason: "limit", limits };

  const signDocuments: DraftImportDocument[] = [];
  const signSessions: DraftImportSession[] = [];
  const signReplace: DraftImportExpectation[] = [];
  const edits: Array<{ meta: EditDraftMeta; files: { key: string; bytes: Uint8Array }[] }> = [];
  const editReplace: { id: string; savedAt: string }[] = [];
  const pros: Array<{ meta: ProDraftMeta; bytes: Uint8Array }> = [];
  const proReplace: { id: string; savedAt: string }[] = [];
  const saved: { kind: DraftKind; id: string }[] = [];
  let strokesDropped = 0;
  let replaced = 0;
  let keptBoth = 0;

  for (const { item, decision } of approved) {
    const original = item.payload as DraftPayload;
    if (!(await revalidate(original, now))) return { ok: false, reason: "invalid" };
    const policy = applyStrokePolicy(original, keep);
    if (policy.dropped || item.strokesDropped) strokesDropped += 1;
    const payload = policy.payload;
    if (decision === "replace") replaced += 1;
    if (decision === "keepBoth") keptBoth += 1;
    const conflict = item.conflictWith;

    if (payload.kind === "sign-document") {
      const id = decision === "keepBoth" ? newDocumentDraftId(payload.meta.fingerprint ?? payload.meta.id) : payload.meta.id;
      const meta = {
        ...payload.meta,
        id,
        ...(decision === "keepBoth" && conflict ? { copyOf: conflict.id } : {}),
      };
      signDocuments.push({ meta, bytes: payload.bytes });
      if (decision === "replace" && conflict) {
        signReplace.push({ kind: "document", id: conflict.id, savedAt: conflict.savedAt, rev: conflict.rev });
      }
      saved.push({ kind: item.kind, id });
    } else if (payload.kind === "sign-session") {
      const id = decision === "keepBoth" ? newSessionCopyId() : payload.meta.id;
      const meta = { ...payload.meta, id, ...(decision === "keepBoth" && conflict ? { copyOf: conflict.id } : {}) };
      signSessions.push({ meta, files: payload.files });
      if (decision === "replace" && conflict) {
        signReplace.push({ kind: "session", id: conflict.id, savedAt: conflict.savedAt, rev: conflict.rev });
      }
      saved.push({ kind: item.kind, id });
    } else if (payload.kind === "edit") {
      edits.push({ meta: payload.meta, files: payload.files });
      if (decision === "replace" && conflict) editReplace.push({ id: conflict.id, savedAt: conflict.savedAt });
      saved.push({ kind: item.kind, id: payload.meta.id });
    } else {
      pros.push({ meta: payload.meta, bytes: payload.bytes });
      if (decision === "replace" && conflict) proReplace.push({ id: conflict.id, savedAt: conflict.savedAt });
      saved.push({ kind: item.kind, id: payload.meta.id });
    }
  }

  const undos: Undo[] = [];
  const finalizers: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<boolean> => {
    let clean = true;
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch {
        clean = false;
      }
    }
    return clean;
  };
  const fail = async (reason: "limit" | "changed" | "unavailable" | "invalid"): Promise<ApplyDraftsResult> => {
    const clean = await rollback();
    return { ok: false, reason, ...(clean ? {} : { partial: true }), ...(reason === "limit" ? { limits } : {}) };
  };

  try {
    if (signDocuments.length + signSessions.length > 0) {
      await options.beforeCommit?.("sign");
      const result = await commitDraftImport({ documents: signDocuments, sessions: signSessions, replace: signReplace });
      if (!result.ok) return await fail(result.reason);
      undos.push(result.undo);
    }
    if (edits.length > 0) {
      await options.beforeCommit?.("edit");
      const result = await commitEditDraftImport({ puts: edits, replace: editReplace });
      if (!result.ok) return await fail(result.reason);
      undos.push(result.undo);
    }
    if (pros.length > 0) {
      await options.beforeCommit?.("pro");
      const result = await commitProDraftImport({ puts: pros, replace: proReplace });
      if (!result.ok) return await fail(result.reason);
      undos.push(result.undo);
      finalizers.push(result.finalize);
    }
  } catch {
    return await fail("unavailable");
  }
  for (const finalize of finalizers) await finalize();
  return {
    ok: true,
    written: approved.length,
    replaced,
    keptBoth,
    skipped: plan.items.length - approved.length,
    strokesDropped,
    saved,
  };
}
