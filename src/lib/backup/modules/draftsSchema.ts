import { sanitizeCeremony } from "@/app/sign-pdf/blockModel";
import { isValidRect } from "@/app/sign-pdf/signConfig";
import { sanitizeTextEdits } from "@/app/sign-pdf/textEdits";
import { sanitizeTurnOrder } from "@/app/sign-pdf/turnOrder";
import { BIDI_CONTROLS, hasValidPngShape } from "@/lib/backup/modules/draftsPng";
import { normalizeCopies } from "@/lib/pdf/signCopies";
import { sanitizeTag } from "@/lib/fieldTags";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type { DocState, SignerBlock } from "@/app/sign-pdf/docSet";
import type { DetectedField, DetectedFieldType, FieldConfidence, FieldSource } from "@/lib/pdf/detectFields";
import type { SignatureField, SignatureFieldType, Signer } from "@/lib/pdf/sign";
import type { TextEdit } from "@/lib/pdf/editTypes";

/**
 * Validadores del modulo «Borradores» (U4.6): todo lo que llega de un paquete ajeno se reconstruye CAMPO A CAMPO a partir
 * de lo que se lee (nada de copiar objetos enteros: una clave `__proto__` o desconocida no llega al borrador), con tipos,
 * enumerados, rangos, longitudes y CANTIDADES acotadas. Un borrador que no pasa se aisla (`invalid`) sin tumbar el resto.
 * Puro (sin IndexedDB ni DOM).
 */

/* ------------------------------------------------------------------ *
 * Topes
 * ------------------------------------------------------------------ */

/** Firmantes por borrador (el alta de la app limita a 2, pero un borrador heredado puede traer mas: se conservan hasta 20). */
export const MAX_DRAFT_SIGNERS = 20;
export const MAX_DRAFT_DOCUMENTS = 10;
export const MAX_DRAFT_BLOCKS = 100;
export const MAX_DRAFT_FIELDS = 200;
export const MAX_DRAFT_TEXT_FIELDS = 500;
export const MAX_DRAFT_TEXT_VALUES = 500;
export const MAX_DRAFT_TEXT_VALUE_LENGTH = 5000;
export const MAX_DRAFT_STRINGS = 200;
export const MAX_DRAFT_STAMP_LENGTH = 20_000;
export const MAX_DRAFT_PAGE_INDEX = 100_000;
export const MAX_PRO_HISTORY_NOTES = 500;
/** Un trazo de firma (PNG) por encima de esto no es una firma. */
export const MAX_STROKE_BYTES = 1024 * 1024;
export const MAX_STROKE_DIMENSION = 4096;
/** Imagen anadida en un borrador del editor. */
export const MAX_EDIT_ASSET_BYTES = 25 * 1024 * 1024;
/** Elementos por tipo de borrador en el indice (los almacenes admiten 10: mas es un indice hostil). */
export const MAX_INDEX_ITEMS_PER_KIND = 30;

export const ID_DOCUMENT = /^[0-9a-f]{64}$/;
export const ID_SESSION = /^s-[a-z0-9]{1,16}-[a-z0-9]{1,24}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
export const REF_PATTERN = /^[a-z][0-9]{1,3}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const SIGN_STEPS: readonly string[] = ["signers", "document", "sign", "fields", "text"];
const SIGN_MODES: readonly string[] = ["single", "multi"];
const BLOCK_SIGN_MODES: readonly string[] = ["same", "independent"];
const FIELD_TYPES: readonly SignatureFieldType[] = ["signature", "initials"];
const DETECTED_TYPES: readonly DetectedFieldType[] = ["text", "checkbox", "date", "initials"];
const FIELD_SOURCES: readonly FieldSource[] = ["acroform", "heuristic-vector", "heuristic-raster", "manual"];
const FIELD_CONFIDENCES: readonly FieldConfidence[] = ["high", "medium", "low"];
const PRO_SOURCES: readonly string[] = ["open", "operation", "mode-apply"];

/* ------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Texto libre: sin controles ni marcas bidi, recortado y acotado. `null` si no es texto o es demasiado largo. */
export function cleanText(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > max * 2) return null;
  const clean = value.replace(CONTROLS, " ").replace(BIDI_CONTROLS, "").trim();
  if (clean.length > max) return null;
  return clean.length > 0 || allowEmpty ? clean : null;
}

/** Nombre de archivo: ademas, sin separadores de ruta; vacio -> `fallback`. */
export function cleanFileName(value: unknown, fallback = "documento.pdf"): string {
  const clean = cleanText(typeof value === "string" ? value.slice(0, 400) : value, 200, true) ?? "";
  const safe = clean.replace(/[\\/]/g, "_").replace(/^\.+$/, "").trim();
  return safe.length > 0 ? safe : fallback;
}

export function cleanIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function localId(value: unknown): string | null {
  return typeof value === "string" && LOCAL_ID.test(value) ? value : null;
}

/** Texto -> array (acotado) o `null` si no es una lista o pasa del tope. */
function list(value: unknown, max: number): unknown[] | null {
  return Array.isArray(value) && value.length <= max ? (value as unknown[]) : null;
}

/* ------------------------------------------------------------------ *
 * Trazos de firma
 * ------------------------------------------------------------------ */

/** Una referencia a un PNG del paquete. La ruta se DERIVA de `ref` y del orden: la del indice debe coincidir. */
export type StrokeRef = { png: string; ratio: number };

/** Lo que el validador necesita del exterior para resolver un trazo (la ruta ya validada -> sus bytes verificados). */
export type StrokeContext = {
  ref: string;
  /** Bytes verificados (SHA-256, tamano) del archivo del paquete, o `null` si falta/no esta `ok`. */
  file: (path: string) => Uint8Array | null;
  /** Rutas de trazo ya usadas en este borrador (un archivo no se comparte entre dos trazos). */
  used: Set<string>;
};

export type StrokeResult = { ok: true; draft: SignatureDraft | null; path?: string } | { ok: false; reason: "invalidEntry" | "integrity" | "invalidImage" };

/** `null` -> sin trazo; `{ png, ratio }` -> `{ dataUrl, ratio }` si el PNG existe, es estructuralmente valido y encaja. */
export function resolveStroke(value: unknown, ctx: StrokeContext, toDataUrl: (bytes: Uint8Array) => string): StrokeResult {
  if (value === null || value === undefined) return { ok: true, draft: null };
  if (!isRecord(value) || typeof value.png !== "string" || typeof value.ratio !== "number") {
    return { ok: false, reason: "invalidEntry" };
  }
  const match = new RegExp(`^drafts/${ctx.ref}-k([0-9]{1,3})\\.png$`).exec(value.png);
  if (!match || ctx.used.has(value.png) || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio > 20) {
    return { ok: false, reason: "invalidEntry" };
  }
  const bytes = ctx.file(value.png);
  if (!bytes) return { ok: false, reason: "integrity" };
  const shape = hasValidPngShape(bytes, MAX_STROKE_BYTES, MAX_STROKE_DIMENSION);
  if (!shape) return { ok: false, reason: "invalidImage" };
  const real = shape.height / shape.width;
  if (Math.abs(real - value.ratio) > 0.02 * Math.max(1, real)) return { ok: false, reason: "invalidImage" };
  ctx.used.add(value.png);
  return { ok: true, draft: { dataUrl: toDataUrl(bytes), ratio: value.ratio }, path: value.png };
}

/* ------------------------------------------------------------------ *
 * Piezas comunes de Firmar
 * ------------------------------------------------------------------ */

export function parseSigners(value: unknown): Signer[] | null {
  const rows = list(value, MAX_DRAFT_SIGNERS);
  if (!rows) return null;
  const out: Signer[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!isRecord(raw)) return null;
    const id = localId(raw.id);
    const name = cleanText(raw.name, 200, true);
    if (id === null || name === null || typeof raw.color !== "string" || !COLOR.test(raw.color) || seen.has(id)) return null;
    seen.add(id);
    out.push({ id, name, color: raw.color });
  }
  return out;
}

function parseFields(value: unknown): SignatureField[] | null {
  const rows = list(value, MAX_DRAFT_FIELDS);
  if (!rows) return null;
  const out: SignatureField[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!isRecord(raw)) return null;
    const id = localId(raw.id);
    const signerId = localId(raw.signerId);
    const pageIndex = int(raw.pageIndex, 0, MAX_DRAFT_PAGE_INDEX);
    if (
      id === null ||
      signerId === null ||
      pageIndex === null ||
      seen.has(id) ||
      typeof raw.type !== "string" ||
      !(FIELD_TYPES as readonly string[]).includes(raw.type) ||
      !isValidRect(raw.rect)
    ) {
      return null;
    }
    seen.add(id);
    const rect = raw.rect;
    out.push({
      id,
      signerId,
      pageIndex,
      type: raw.type as SignatureFieldType,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  return out;
}

function parseTextFields(value: unknown): DetectedField[] | null {
  const rows = list(value, MAX_DRAFT_TEXT_FIELDS);
  if (!rows) return null;
  const out: DetectedField[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!isRecord(raw)) return null;
    const id = localId(raw.id);
    const pageIndex = int(raw.pageIndex, 0, MAX_DRAFT_PAGE_INDEX);
    if (
      id === null ||
      pageIndex === null ||
      seen.has(id) ||
      !isValidRect(raw.rect) ||
      typeof raw.source !== "string" ||
      !(FIELD_SOURCES as readonly string[]).includes(raw.source) ||
      typeof raw.confidence !== "string" ||
      !(FIELD_CONFIDENCES as readonly string[]).includes(raw.confidence)
    ) {
      return null;
    }
    let type: DetectedFieldType | undefined;
    if (raw.type !== undefined) {
      if (typeof raw.type !== "string" || !(DETECTED_TYPES as readonly string[]).includes(raw.type)) return null;
      type = raw.type as DetectedFieldType;
    }
    let label: string | undefined;
    if (raw.label !== undefined) {
      const clean = cleanText(raw.label, 200, true);
      if (clean === null) return null;
      label = clean;
    }
    seen.add(id);
    const rect = raw.rect;
    // Etiqueta del campo (W3-A1): opcional; una que no tiene forma de clave se descarta sin tumbar el campo.
    const tag = sanitizeTag(raw.tag);
    out.push({
      id,
      pageIndex,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      source: raw.source as FieldSource,
      confidence: raw.confidence as FieldConfidence,
      ...(label !== undefined ? { label } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
  }
  return out;
}

function parseTextValues(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_DRAFT_TEXT_VALUES) return null;
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const entry = value[key];
    const cleanKey = typeof key === "string" && key.length > 0 && key.length <= 200 ? key : null;
    if (cleanKey === null || typeof entry !== "string" || entry.length > MAX_DRAFT_TEXT_VALUE_LENGTH) return null;
    out[cleanKey] = entry.replace(CONTROLS, (ch) => (ch === "\n" || ch === "\t" ? ch : " "));
  }
  return out;
}

function parseTextEdits(value: unknown): TextEdit[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) return null;
  return sanitizeTextEdits(value);
}

/* ------------------------------------------------------------------ *
 * Firmar: documento suelto
 * ------------------------------------------------------------------ */

export type ParsedSignDocument = {
  id: string;
  fingerprint: string;
  fileName: string;
  savedAt: string;
  expiresAt: string | null;
  signaturesOmitted: boolean;
  mode: "single" | "multi";
  step: string;
  signers: Signer[];
  fields: SignatureField[];
  textFields: DetectedField[];
  textValues: Record<string, string>;
  textFieldsDetectedFor: string | null;
  textEdits: TextEdit[];
  captures: Record<string, { signature: SignatureDraft | null; initials: SignatureDraft | null; stamp: string }>;
  strokePaths: string[];
};

export type ParseFailure = "invalidEntry" | "integrity" | "invalidImage" | "tooMany";

export function parseSignDocument(
  raw: unknown,
  ctx: StrokeContext,
  toDataUrl: (bytes: Uint8Array) => string,
): ParsedSignDocument | { failure: ParseFailure } {
  const fail = (failure: ParseFailure) => ({ failure });
  if (!isRecord(raw)) return fail("invalidEntry");
  const id = typeof raw.id === "string" && ID_DOCUMENT.test(raw.id) ? raw.id : null;
  const fingerprint = typeof raw.fingerprint === "string" && ID_DOCUMENT.test(raw.fingerprint) ? raw.fingerprint : null;
  const savedAt = cleanIso(raw.savedAt);
  const signers = parseSigners(raw.signers);
  const fields = parseFields(raw.fields);
  const textFields = parseTextFields(raw.textFields);
  const textValues = parseTextValues(raw.textValues);
  const textEdits = parseTextEdits(raw.textEdits);
  const detectedFor =
    raw.textFieldsDetectedFor === null || raw.textFieldsDetectedFor === undefined
      ? null
      : cleanText(raw.textFieldsDetectedFor, 200, true);
  const expiresAt = raw.expiresAt === undefined ? null : cleanIso(raw.expiresAt);
  if (
    id === null ||
    fingerprint === null ||
    savedAt === null ||
    signers === null ||
    fields === null ||
    textFields === null ||
    textValues === null ||
    textEdits === null ||
    typeof raw.mode !== "string" ||
    !SIGN_MODES.includes(raw.mode) ||
    typeof raw.step !== "string" ||
    !SIGN_STEPS.includes(raw.step) ||
    (raw.textFieldsDetectedFor !== null && raw.textFieldsDetectedFor !== undefined && detectedFor === null) ||
    (raw.expiresAt !== undefined && expiresAt === null) ||
    !isRecord(raw.captures)
  ) {
    return fail("invalidEntry");
  }
  const captureKeys = Object.keys(raw.captures);
  if (captureKeys.length > MAX_DRAFT_SIGNERS) return fail("tooMany");
  const captures: ParsedSignDocument["captures"] = {};
  const strokePaths: string[] = [];
  for (const key of captureKeys) {
    const signerId = localId(key);
    const capture = raw.captures[key];
    if (signerId === null || !isRecord(capture) || FORBIDDEN_KEYS.has(key)) return fail("invalidEntry");
    const stamp = typeof capture.stamp === "string" && capture.stamp.length <= MAX_DRAFT_STAMP_LENGTH ? capture.stamp : null;
    if (stamp === null) return fail("invalidEntry");
    const signature = resolveStroke(capture.signature, ctx, toDataUrl);
    if (!signature.ok) return fail(signature.reason);
    const initials = resolveStroke(capture.initials, ctx, toDataUrl);
    if (!initials.ok) return fail(initials.reason);
    if (signature.path) strokePaths.push(signature.path);
    if (initials.path) strokePaths.push(initials.path);
    captures[signerId] = { signature: signature.draft, initials: initials.draft, stamp };
  }
  return {
    id,
    fingerprint,
    fileName: cleanFileName(raw.fileName),
    savedAt,
    expiresAt,
    signaturesOmitted: raw.signaturesOmitted === true,
    mode: raw.mode as "single" | "multi",
    step: raw.step,
    signers,
    fields,
    textFields,
    textValues,
    textFieldsDetectedFor: detectedFor,
    textEdits,
    captures,
    strokePaths,
  };
}

/* ------------------------------------------------------------------ *
 * Firmar: sesion de varios documentos
 * ------------------------------------------------------------------ */

export type ParsedSignSession = {
  id: string;
  savedAt: string;
  expiresAt: string | null;
  signaturesOmitted: boolean;
  mode: "single" | "multi";
  signMode: "same" | "independent";
  step: string;
  signers: Signer[];
  blocks: SignerBlock[];
  documents: { id: string; fileName: string }[];
  docStates: Record<string, DocState>;
  activeDocId: string | null;
  ceremony: { signerId: string; stage: string } | null;
  turnOrder: string[] | null;
  strokePaths: string[];
};

function parseDocState(raw: unknown): DocState | null {
  if (!isRecord(raw)) return null;
  const fields = parseFields(raw.fields === undefined ? [] : raw.fields);
  const textFields = parseTextFields(raw.textFields === undefined ? [] : raw.textFields);
  const textValues = parseTextValues(raw.textValues === undefined ? {} : raw.textValues);
  const textEdits = parseTextEdits(raw.textEdits);
  const pageIndex = int(raw.pageIndex === undefined ? 0 : raw.pageIndex, 0, MAX_DRAFT_PAGE_INDEX);
  const fieldPageIndex = int(raw.fieldPageIndex === undefined ? 0 : raw.fieldPageIndex, 0, MAX_DRAFT_PAGE_INDEX);
  const sealedKey = raw.sealedKey === undefined ? "" : cleanText(raw.sealedKey, 600, true);
  const detectedFor =
    raw.textFieldsDetectedFor === null || raw.textFieldsDetectedFor === undefined
      ? null
      : cleanText(raw.textFieldsDetectedFor, 200, true);
  let rect = { x: 0, y: 0, width: 0, height: 0 };
  if (raw.rect !== undefined) {
    if (isValidRect(raw.rect)) {
      rect = { x: raw.rect.x, y: raw.rect.y, width: raw.rect.width, height: raw.rect.height };
    } else if (
      !isRecord(raw.rect) ||
      raw.rect.x !== 0 ||
      raw.rect.y !== 0 ||
      raw.rect.width !== 0 ||
      raw.rect.height !== 0
    ) {
      return null; // solo vale una zona valida o la «sin colocar» (todo 0)
    }
  }
  if (
    fields === null ||
    textFields === null ||
    textValues === null ||
    textEdits === null ||
    pageIndex === null ||
    fieldPageIndex === null ||
    sealedKey === null ||
    (raw.textFieldsDetectedFor !== null && raw.textFieldsDetectedFor !== undefined && detectedFor === null)
  ) {
    return null;
  }
  const copies = raw.copies === undefined ? 1 : normalizeCopies(raw.copies);
  return {
    fields,
    textFields,
    textValues,
    textFieldsDetectedFor: detectedFor,
    rect,
    pageIndex,
    fieldPageIndex,
    sealedKey,
    ...(textEdits.length > 0 ? { textEdits } : {}),
    ...(copies > 1 ? { copies } : {}),
  };
}

export function parseSignSession(
  raw: unknown,
  ctx: StrokeContext,
  toDataUrl: (bytes: Uint8Array) => string,
): ParsedSignSession | { failure: ParseFailure } {
  const fail = (failure: ParseFailure) => ({ failure });
  if (!isRecord(raw)) return fail("invalidEntry");
  // Cantidades PRIMERO: una sesion con miles de bloques se rechaza sin recorrerla.
  if (Array.isArray(raw.blocks) && raw.blocks.length > MAX_DRAFT_BLOCKS) return fail("tooMany");
  if (Array.isArray(raw.documents) && raw.documents.length > MAX_DRAFT_DOCUMENTS) return fail("tooMany");
  const id = typeof raw.id === "string" && ID_SESSION.test(raw.id) ? raw.id : null;
  const savedAt = cleanIso(raw.savedAt);
  const signers = parseSigners(raw.signers);
  const expiresAt = raw.expiresAt === undefined ? null : cleanIso(raw.expiresAt);
  const documentRows = list(raw.documents, MAX_DRAFT_DOCUMENTS);
  const blockRows = list(raw.blocks, MAX_DRAFT_BLOCKS);
  if (
    id === null ||
    savedAt === null ||
    signers === null ||
    documentRows === null ||
    documentRows.length === 0 ||
    blockRows === null ||
    typeof raw.mode !== "string" ||
    !SIGN_MODES.includes(raw.mode) ||
    typeof raw.signMode !== "string" ||
    !BLOCK_SIGN_MODES.includes(raw.signMode) ||
    typeof raw.step !== "string" ||
    !SIGN_STEPS.includes(raw.step) ||
    (raw.expiresAt !== undefined && expiresAt === null) ||
    !isRecord(raw.docStates)
  ) {
    return fail("invalidEntry");
  }
  const documents: { id: string; fileName: string }[] = [];
  const docIds = new Set<string>();
  for (const row of documentRows) {
    if (!isRecord(row)) return fail("invalidEntry");
    const docId = localId(row.id);
    if (docId === null || docIds.has(docId) || FORBIDDEN_KEYS.has(docId)) return fail("invalidEntry");
    docIds.add(docId);
    documents.push({ id: docId, fileName: cleanFileName(row.fileName) });
  }
  if (Object.keys(raw.docStates).length > MAX_DRAFT_DOCUMENTS) return fail("tooMany");
  const docStates: Record<string, DocState> = {};
  for (const docId of docIds) {
    const state = hasOwn(raw.docStates, docId) ? parseDocState(raw.docStates[docId]) : parseDocState({});
    if (!state) return fail("invalidEntry");
    docStates[docId] = state;
  }

  const signerIds = new Set(signers.map((signer) => signer.id));
  const blocks: SignerBlock[] = [];
  const blockIds = new Set<string>();
  const strokePaths: string[] = [];
  for (const row of blockRows) {
    if (!isRecord(row)) return fail("invalidEntry");
    const blockId = localId(row.id);
    const signerId = localId(row.signerId);
    const applies = list(row.appliesTo, MAX_DRAFT_DOCUMENTS);
    if (blockId === null || signerId === null || applies === null || blockIds.has(blockId) || !signerIds.has(signerId)) {
      return fail("invalidEntry");
    }
    blockIds.add(blockId);
    const appliesTo: string[] = [];
    for (const target of applies) {
      if (typeof target === "string" && docIds.has(target) && !appliesTo.includes(target)) appliesTo.push(target);
    }
    const stamps: Record<string, string> = {};
    if (row.stamps !== undefined) {
      if (!isRecord(row.stamps) || Object.keys(row.stamps).length > MAX_DRAFT_DOCUMENTS) return fail("invalidEntry");
      for (const [docId, stamp] of Object.entries(row.stamps)) {
        if (!docIds.has(docId)) continue;
        if (typeof stamp !== "string" || stamp.length > MAX_DRAFT_STAMP_LENGTH) return fail("invalidEntry");
        if (stamp) stamps[docId] = stamp;
      }
    }
    const signature = resolveStroke(row.signature, ctx, toDataUrl);
    if (!signature.ok) return fail(signature.reason);
    const initials = resolveStroke(row.initials, ctx, toDataUrl);
    if (!initials.ok) return fail(initials.reason);
    if (signature.path) strokePaths.push(signature.path);
    if (initials.path) strokePaths.push(initials.path);
    blocks.push({
      id: blockId,
      signerId,
      appliesTo,
      signature: signature.draft,
      initials: initials.draft,
      stamps,
      auto: row.auto === true,
    });
  }

  let activeDocId: string | null = null;
  if (raw.activeDocId !== null && raw.activeDocId !== undefined) {
    if (typeof raw.activeDocId !== "string" || !docIds.has(raw.activeDocId)) return fail("invalidEntry");
    activeDocId = raw.activeDocId;
  }
  const signerIdList = signers.map((signer) => signer.id);
  const ceremony = raw.ceremony === undefined ? null : sanitizeCeremony(raw.ceremony, signerIdList);
  const turnOrder = raw.turnOrder === undefined ? null : (sanitizeTurnOrder(raw.turnOrder, signerIdList) ?? null);
  return {
    id,
    savedAt,
    expiresAt,
    signaturesOmitted: raw.signaturesOmitted === true,
    mode: raw.mode as "single" | "multi",
    signMode: raw.signMode as "same" | "independent",
    step: raw.step,
    signers,
    blocks,
    documents,
    docStates,
    activeDocId,
    ceremony,
    turnOrder,
    strokePaths,
  };
}

/* ------------------------------------------------------------------ *
 * Editar y PDF Pro: lo que no es la sesion (la sesion de Editar la valida `editSessionFromJSON`)
 * ------------------------------------------------------------------ */

export type ParsedEditHeader = {
  id: string;
  fileName: string;
  savedAt: string;
  pageCount: number | null;
  currentPage: number;
  sessionPath: string;
  assets: { assetId: string; mime: "image/png" | "image/jpeg"; path: string }[];
};

export function parseEditHeader(raw: unknown, ref: string): ParsedEditHeader | { failure: ParseFailure } {
  const fail = (failure: ParseFailure) => ({ failure });
  if (!isRecord(raw)) return fail("invalidEntry");
  const id = typeof raw.id === "string" && ID_DOCUMENT.test(raw.id) ? raw.id : null;
  const savedAt = cleanIso(raw.savedAt);
  const pageCount = raw.pageCount === null || raw.pageCount === undefined ? null : int(raw.pageCount, 0, MAX_DRAFT_PAGE_INDEX);
  const currentPage = int(raw.currentPage === undefined ? 0 : raw.currentPage, 0, MAX_DRAFT_PAGE_INDEX);
  if (
    id === null ||
    savedAt === null ||
    currentPage === null ||
    (raw.pageCount !== null && raw.pageCount !== undefined && pageCount === null) ||
    raw.session !== `drafts/${ref}-session.json`
  ) {
    return fail("invalidEntry");
  }
  const assets: ParsedEditHeader["assets"] = [];
  if (raw.assets !== undefined) {
    const rows = list(raw.assets, 200);
    if (!rows) return fail("tooMany");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.assetId !== "string" || !/^[\w-]{1,64}$/.test(row.assetId) || seen.has(row.assetId)) {
        return fail("invalidEntry");
      }
      if (row.mime !== "image/png" && row.mime !== "image/jpeg") return fail("invalidEntry");
      const ext = row.mime === "image/png" ? "png" : "jpg";
      const match = new RegExp(`^drafts/${ref}-a([0-9]{1,3})\\.${ext}$`).exec(typeof row.path === "string" ? row.path : "");
      if (!match) return fail("invalidEntry");
      seen.add(row.assetId);
      assets.push({ assetId: row.assetId, mime: row.mime, path: row.path as string });
    }
  }
  return {
    id,
    fileName: cleanFileName(raw.fileName),
    savedAt,
    pageCount,
    currentPage,
    sessionPath: raw.session as string,
    assets,
  };
}

export type ParsedProDraft = {
  id: string;
  fileName: string;
  savedAt: string;
  pageCount: number | null;
  currentPage: number;
  history: { label: string; createdAt: number; source: "open" | "operation" | "mode-apply"; opId?: string }[];
};

export function parseProDraft(raw: unknown): ParsedProDraft | { failure: ParseFailure } {
  const fail = (failure: ParseFailure) => ({ failure });
  if (!isRecord(raw)) return fail("invalidEntry");
  const id = typeof raw.id === "string" && ID_DOCUMENT.test(raw.id) ? raw.id : null;
  const savedAt = cleanIso(raw.savedAt);
  const pageCount = raw.pageCount === null || raw.pageCount === undefined ? null : int(raw.pageCount, 0, MAX_DRAFT_PAGE_INDEX);
  const currentPage = int(raw.currentPage === undefined ? 0 : raw.currentPage, 0, MAX_DRAFT_PAGE_INDEX);
  const rows = list(raw.history, MAX_PRO_HISTORY_NOTES);
  if (
    id === null ||
    savedAt === null ||
    currentPage === null ||
    rows === null ||
    (raw.pageCount !== null && raw.pageCount !== undefined && pageCount === null)
  ) {
    return fail(rows === null && Array.isArray(raw.history) ? "tooMany" : "invalidEntry");
  }
  const history: ParsedProDraft["history"] = [];
  for (const row of rows) {
    if (!isRecord(row)) return fail("invalidEntry");
    const label = cleanText(row.label, 200, true);
    const opId = row.opId === undefined ? undefined : cleanText(row.opId, 100);
    if (
      label === null ||
      typeof row.createdAt !== "number" ||
      !Number.isFinite(row.createdAt) ||
      row.createdAt < 0 ||
      row.createdAt > 4e12 ||
      typeof row.source !== "string" ||
      !PRO_SOURCES.includes(row.source) ||
      opId === null
    ) {
      return fail("invalidEntry");
    }
    history.push({
      label,
      createdAt: row.createdAt,
      source: row.source as "open" | "operation" | "mode-apply",
      ...(opId ? { opId } : {}),
    });
  }
  return { id, fileName: cleanFileName(raw.fileName), savedAt, pageCount, currentPage, history };
}
