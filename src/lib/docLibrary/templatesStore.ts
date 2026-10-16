import { compareFingerprints, findBestMatch } from "./match";
import { ID_PATTERN, parseDocumentEntry } from "./schema";
import { STORE_NAMES, announceChange, getDocument, listDocuments, req, run } from "./store";
import { buildContent, parseStoredTemplate, parseTemplate, parseTemplateName, sameContent } from "./templateSchema";
import { reconcileSources } from "./templateAuto";
import { cloneTemplate } from "./templateApply";
import {
  TEMPLATE_LIMITS,
  TEMPLATE_SCHEMA_VERSION,
  type DocTemplate,
  type StoredTemplate,
  type TemplateContent,
  type TemplateDraft,
  type TemplateSnapshot,
  type TemplateOrigin,
} from "./templateTypes";
import { LIBRARY_LIMITS, LibraryError, type DocumentEntry, type Fingerprint, type MatchResult } from "./types";

/**
 * Almacén de plantillas de campos por documento (Fase 2, U2.2; el punto de entrada público es `templates.ts`) sobre el MISMO IndexedDB de la biblioteca (`store.ts`, almacén
 * `templates`, base v2). Reglas heredadas de U2.1:
 *  - LECTURAS no lanzan: lista vacía / `null` (con `available: false` si no hay IndexedDB). Una fila que no pasa la
 *    validación estricta se IGNORA y se cuenta en `skipped`.
 *  - ESCRITURAS lanzan `LibraryError` (`notFound`, `conflict`, `invalid`, `full`, `quota`, `unavailable`, `failed`) y cada
 *    una es UNA transacción: la plantilla y el `templateIds` del documento se escriben juntos o no se escribe nada.
 *  - Concurrencia optimista: cada plantilla lleva `rev`. Quien edita dice qué `rev` leyó; si lo guardado es otro,
 *    `conflict` y NO se pisa nada.
 *
 * Versiones: editar (`saveTemplateVersion`) crea `version + 1` y guarda la anterior (como mucho `maxVersions` = 5 en
 * total: la actual + 4 anteriores). `restoreVersion` NO borra nada: copia una versión anterior como versión nueva, así
 * que deshacer también se puede deshacer. Renombrar o reasignar no crean versión (cambian `rev`, no `version`).
 *
 * Al borrar un documento (`deleteDocument`) sus plantillas NO se borran: quedan «sin documento» (`documentId: null`) y se
 * pueden reasignar con `attachTemplate`. `clearLibrary` sí las borra.
 */

const { documents: DOCUMENTS, templates: TEMPLATES } = STORE_NAMES;

export type TemplateWriteOptions = {
  now?: () => Date;
  /** Para pruebas: genera el id de la plantilla nueva. */
  newId?: () => string;
};

function nowIso(options?: { now?: () => Date }): string {
  return (options?.now?.() ?? new Date()).toISOString();
}

function randomId(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let id = "tpl-";
  for (const byte of bytes) id += byte.toString(36).padStart(2, "0");
  return id;
}

function stripHistory(stored: StoredTemplate): DocTemplate {
  const { history, ...template } = stored;
  void history;
  return template;
}

function newerFirst(a: DocTemplate, b: DocTemplate): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1;
}

function snapshotOf(template: TemplateContent & { version: number; updatedAt: string }): TemplateSnapshot {
  return {
    version: template.version,
    updatedAt: template.updatedAt,
    name: template.name,
    roles: template.roles,
    variants: template.variants,
    ...(template.layout ? { layout: template.layout } : {}),
  };
}

function contentOf(source: TemplateContent): TemplateContent {
  return { name: source.name, roles: source.roles, variants: source.variants, ...(source.layout ? { layout: source.layout } : {}) };
}

/* ------------------------------------------------------------------ *
 * Lecturas
 * ------------------------------------------------------------------ */

export type TemplateListResult = {
  available: boolean;
  /** Más reciente primero. */
  templates: DocTemplate[];
  skipped: Array<{ id: string; reason: "invalid" }>;
};

function safeId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && ID_PATTERN.test(id) ? id : "?";
}

export async function listTemplates(): Promise<TemplateListResult> {
  try {
    const rows = await run([TEMPLATES], "readonly", (tx) => req(tx.objectStore(TEMPLATES).getAll() as IDBRequest<unknown[]>));
    const templates: DocTemplate[] = [];
    const skipped: TemplateListResult["skipped"] = [];
    for (const row of rows) {
      const stored = parseStoredTemplate(row);
      if (stored) templates.push(stripHistory(stored));
      else skipped.push({ id: safeId(row), reason: "invalid" });
    }
    templates.sort(newerFirst);
    return { available: true, templates, skipped };
  } catch {
    return { available: false, templates: [], skipped: [] };
  }
}

export async function getTemplate(id: string): Promise<DocTemplate | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const row = await run([TEMPLATES], "readonly", (tx) => req(tx.objectStore(TEMPLATES).get(id)));
    const stored = parseStoredTemplate(row);
    return stored ? stripHistory(stored) : null;
  } catch {
    return null;
  }
}

/** Todas las plantillas de un documento, la más reciente primero. */
export async function getTemplatesForDocument(documentId: string): Promise<DocTemplate[]> {
  if (!ID_PATTERN.test(documentId)) return [];
  try {
    const rows = await run([TEMPLATES], "readonly", (tx) => req(tx.objectStore(TEMPLATES).index("byDocument").getAll(documentId) as IDBRequest<unknown[]>));
    const templates: DocTemplate[] = [];
    for (const row of rows) {
      const stored = parseStoredTemplate(row);
      if (stored && stored.documentId === documentId) templates.push(stripHistory(stored));
    }
    return templates.sort(newerFirst);
  } catch {
    return [];
  }
}

/** La plantilla de un documento (si hay varias, la más reciente) o `null`. */
export async function getTemplateForDocument(documentId: string): Promise<DocTemplate | null> {
  return (await getTemplatesForDocument(documentId))[0] ?? null;
}

export type TemplateVersionInfo = { version: number; updatedAt: string; name: string; current: boolean; fieldCount: number };

function countFields(content: TemplateContent): number {
  return content.variants["1"].fields.length + content.variants["1"].textFields.length + content.variants["2"].fields.length + content.variants["2"].textFields.length;
}

/** Las versiones guardadas (la actual primero, luego las anteriores de más reciente a más antigua). */
export async function getTemplateVersions(id: string): Promise<TemplateVersionInfo[]> {
  if (!ID_PATTERN.test(id)) return [];
  try {
    const stored = parseStoredTemplate(await run([TEMPLATES], "readonly", (tx) => req(tx.objectStore(TEMPLATES).get(id))));
    if (!stored) return [];
    const current: TemplateVersionInfo = { version: stored.version, updatedAt: stored.updatedAt, name: stored.name, current: true, fieldCount: countFields(stored) };
    return [current, ...stored.history.map((snapshot) => ({ version: snapshot.version, updatedAt: snapshot.updatedAt, name: snapshot.name, current: false, fieldCount: countFields(snapshot) }))];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Estado para «Mis documentos»
 * ------------------------------------------------------------------ */

/** `ready`: ✓ 1 y 2 firmantes · `single`: solo 1 firmante · `none`: sin plantilla utilizable. */
export type TemplateState = "ready" | "single" | "none";

export type TemplateStatus = {
  state: TemplateState;
  /** La plantilla que cuenta (la más reciente del documento), o `null`. */
  templateId: string | null;
  /** Qué variantes tienen firmas o iniciales. */
  variants: { "1": boolean; "2": boolean };
  /** Con 1 firmante se usan los campos del firmante 1 de la variante de 2 (no hay variante propia de 1). */
  usesFallbackForOne: boolean;
};

export const TEMPLATE_STATUS_TEXT: Record<TemplateState, { es: string; en: string }> = {
  ready: { es: "✓ Plantilla lista (1 y 2 firmantes)", en: "✓ Template ready (1 and 2 signers)" },
  single: { es: "Solo 1 firmante", en: "1 signer only" },
  none: { es: "Sin plantilla", en: "No template" },
};

const NO_TEMPLATE: TemplateStatus = { state: "none", templateId: null, variants: { "1": false, "2": false }, usesFallbackForOne: false };

/**
 * Estado de una plantilla (función pura). `ready` = la variante de 2 firmantes tiene firmas Y hay forma de firmar con
 * uno (variante propia de 1 o, si no, el firmante 1 de la de 2). `single` = solo la variante de 1 firmante.
 */
export function statusOfTemplate(template: Pick<DocTemplate, "id" | "variants"> | null | undefined): TemplateStatus {
  if (!template) return NO_TEMPLATE;
  const has1 = template.variants["1"].fields.length > 0;
  const has2 = template.variants["2"].fields.length > 0;
  const fallback = !has1 && has2 && template.variants["2"].fields.some((field) => field.roleIndex === 0);
  const variants = { "1": has1, "2": has2 };
  if (has2 && (has1 || fallback)) return { state: "ready", templateId: template.id, variants, usesFallbackForOne: fallback };
  if (has1 && !has2) return { state: "single", templateId: template.id, variants, usesFallbackForOne: false };
  return { state: "none", templateId: template.id, variants, usesFallbackForOne: false };
}

export async function templateStatus(documentId: string): Promise<TemplateStatus> {
  return statusOfTemplate(await getTemplateForDocument(documentId));
}

/** El estado de todos los documentos que tienen plantilla (una sola lectura). Los que no están, no tienen plantilla. */
export async function templateStatuses(): Promise<Map<string, TemplateStatus>> {
  const { templates } = await listTemplates();
  const newest = new Map<string, DocTemplate>();
  for (const template of templates) {
    if (template.documentId !== null && !newest.has(template.documentId)) newest.set(template.documentId, template);
  }
  return new Map([...newest].map(([documentId, template]) => [documentId, statusOfTemplate(template)]));
}

/* ------------------------------------------------------------------ *
 * Escrituras
 * ------------------------------------------------------------------ */

type LinkMode = "add" | "remove";

/** Mantiene `templateIds` del documento en la MISMA transacción (sube su `rev`, no su `updatedAt`). */
async function linkDocument(tx: IDBTransaction, documentId: string, templateId: string, mode: LinkMode): Promise<void> {
  const documents = tx.objectStore(DOCUMENTS);
  const document = parseDocumentEntry(await req(documents.get(documentId)));
  if (!document) {
    if (mode === "add") throw new LibraryError("notFound");
    return;
  }
  const has = document.templateIds.includes(templateId);
  if (mode === "add" ? has : !has) return;
  if (mode === "add" && document.templateIds.length >= LIBRARY_LIMITS.maxTemplatesPerDocument) throw new LibraryError("full", "count");
  const templateIds = mode === "add" ? [...document.templateIds, templateId] : document.templateIds.filter((id) => id !== templateId);
  // Sin plantillas ya no hay nada «desactualizado» que avisar.
  const { templateStale, ...rest } = document;
  await req(documents.put({ ...rest, ...(templateIds.length > 0 && templateStale ? { templateStale } : {}), templateIds, rev: document.rev + 1 }));
}

function checkRoom(rows: unknown[], documentId: string | null, exceptId: string | null): void {
  let total = 0;
  let forDocument = 0;
  for (const row of rows as Array<{ id?: unknown; documentId?: unknown } | undefined>) {
    if (!row || row.id === exceptId) continue;
    total += 1;
    if (documentId !== null && row.documentId === documentId) forDocument += 1;
  }
  if (total >= TEMPLATE_LIMITS.maxTemplates || forDocument >= TEMPLATE_LIMITS.maxPerDocument) throw new LibraryError("full", "count");
}

/**
 * Crea una plantilla (versión 1, `rev` 1). Con `documentId`, el documento debe existir (si no, `notFound`) y se le añade
 * el id en `templateIds`. Un documento puede tener varias plantillas (la más reciente es la que cuenta; ver
 * `findDuplicateTemplates`).
 */
export async function createTemplate(draft: TemplateDraft, options: TemplateWriteOptions = {}): Promise<DocTemplate> {
  const content = buildContent(draft);
  if (!content) throw new LibraryError("invalid");
  const documentId = draft.documentId;
  if (documentId !== null && !(typeof documentId === "string" && ID_PATTERN.test(documentId))) throw new LibraryError("invalid");
  const id = (options.newId ?? randomId)();
  const now = nowIso(options);
  const template: StoredTemplate = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id,
    documentId,
    ...content,
    version: 1,
    createdAt: now,
    updatedAt: now,
    rev: 1,
    ...(draft.origin ? { origin: draft.origin as TemplateOrigin } : {}),
    history: [],
  };
  const checked = parseStoredTemplate(template);
  if (!checked) throw new LibraryError("invalid");

  await run([TEMPLATES, DOCUMENTS], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const rows = (await req(templates.getAll() as IDBRequest<unknown[]>)) as unknown[];
    if (rows.some((row) => (row as { id?: unknown } | undefined)?.id === id)) throw new LibraryError("conflict");
    checkRoom(rows, documentId, null);
    if (documentId !== null) await linkDocument(tx, documentId, id, "add");
    await req(templates.put(checked));
  });
  announceChange();
  return stripHistory(checked);
}

export type SaveVersionInput = Pick<TemplateDraft, "name" | "roles" | "variants" | "layout"> & {
  id: string;
  /** La `rev` que quien llama LEYÓ (una `DocTemplate` entera ya la trae). */
  rev?: number;
};

export type SaveVersionOptions = TemplateWriteOptions & { expectedRev?: number };

/**
 * Guarda una edición como VERSIÓN NUEVA (`version + 1`) y conserva la anterior para deshacer (máx. 5 en total). Exige
 * saber qué `rev` se leyó (`input.rev` o `options.expectedRev`): si lo guardado es otra, `conflict`. Si el contenido no
 * cambió, no escribe nada y devuelve la plantilla actual. `documentId` no se cambia aquí (usa `attachTemplate`). Los
 * campos `auto` que la persona movió pasan a `manual` (`reconcileSources`).
 */
export async function saveTemplateVersion(input: SaveVersionInput, options: SaveVersionOptions = {}): Promise<DocTemplate> {
  if (!ID_PATTERN.test(input.id)) throw new LibraryError("invalid");
  const expected = options.expectedRev ?? input.rev;
  if (expected === undefined || !Number.isInteger(expected) || expected < 1) throw new LibraryError("invalid");
  const content = buildContent(input);
  if (!content) throw new LibraryError("invalid");
  const now = nowIso(options);

  const result = await run([TEMPLATES], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const row = await req(templates.get(input.id));
    if (row === undefined) throw new LibraryError("notFound");
    const stored = parseStoredTemplate(row);
    if (!stored) throw new LibraryError("invalid");
    if (stored.rev !== expected) throw new LibraryError("conflict");
    const next: TemplateContent = { ...content, variants: reconcileSources(stored, content) };
    if (sameContent(contentOf(stored), contentOf(next))) return { stored, written: false };
    const history = [snapshotOf(stored), ...stored.history].slice(0, TEMPLATE_LIMITS.maxVersions - 1);
    const updated: StoredTemplate = { ...stored, ...next, version: stored.version + 1, updatedAt: now, rev: stored.rev + 1, history };
    if (!next.layout) delete updated.layout;
    const checked = parseStoredTemplate(updated);
    if (!checked) throw new LibraryError("invalid");
    await req(templates.put(checked));
    return { stored: checked, written: true };
  });
  if (result.written) announceChange();
  return stripHistory(result.stored);
}

/**
 * Vuelve al contenido de una versión anterior COMO VERSIÓN NUEVA (la que se deja atrás pasa al historial): deshacer se
 * puede deshacer. `invalid` si `version` es la actual; `notFound` si ya no se conserva.
 */
export async function restoreVersion(id: string, version: number, options: SaveVersionOptions = {}): Promise<DocTemplate> {
  if (!ID_PATTERN.test(id) || !Number.isInteger(version) || version < 1) throw new LibraryError("invalid");
  const now = nowIso(options);
  const stored = await run([TEMPLATES], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const row = await req(templates.get(id));
    if (row === undefined) throw new LibraryError("notFound");
    const current = parseStoredTemplate(row);
    if (!current) throw new LibraryError("invalid");
    if (options.expectedRev !== undefined && current.rev !== options.expectedRev) throw new LibraryError("conflict");
    if (version === current.version) throw new LibraryError("invalid");
    const target = current.history.find((snapshot) => snapshot.version === version);
    if (!target) throw new LibraryError("notFound");
    const history = [snapshotOf(current), ...current.history].slice(0, TEMPLATE_LIMITS.maxVersions - 1);
    const updated: StoredTemplate = { ...current, ...contentOf(target), version: current.version + 1, updatedAt: now, rev: current.rev + 1, history };
    if (!target.layout) delete updated.layout;
    const checked = parseStoredTemplate(updated);
    if (!checked) throw new LibraryError("invalid");
    await req(templates.put(checked));
    return checked;
  });
  announceChange();
  return stripHistory(stored);
}

/** Cambia el nombre (no crea versión). */
export async function renameTemplate(id: string, name: string, options: SaveVersionOptions = {}): Promise<DocTemplate> {
  const clean = parseTemplateName(typeof name === "string" ? name.trim() : name);
  if (!ID_PATTERN.test(id) || clean === null) throw new LibraryError("invalid");
  const now = nowIso(options);
  const stored = await run([TEMPLATES], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const row = await req(templates.get(id));
    if (row === undefined) throw new LibraryError("notFound");
    const current = parseStoredTemplate(row);
    if (!current) throw new LibraryError("invalid");
    if (options.expectedRev !== undefined && current.rev !== options.expectedRev) throw new LibraryError("conflict");
    const updated: StoredTemplate = { ...current, name: clean, updatedAt: now, rev: current.rev + 1 };
    const checked = parseStoredTemplate(updated);
    if (!checked) throw new LibraryError("invalid");
    await req(templates.put(checked));
    return checked;
  });
  announceChange();
  return stripHistory(stored);
}

/**
 * Reasigna una plantilla a otro documento (o la deja «sin documento» con `null`). Actualiza `templateIds` de los dos
 * documentos en la misma transacción. No crea versión.
 */
export async function attachTemplate(id: string, documentId: string | null, options: SaveVersionOptions = {}): Promise<DocTemplate> {
  if (!ID_PATTERN.test(id) || (documentId !== null && !ID_PATTERN.test(documentId))) throw new LibraryError("invalid");
  const now = nowIso(options);
  const stored = await run([TEMPLATES, DOCUMENTS], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const row = await req(templates.get(id));
    if (row === undefined) throw new LibraryError("notFound");
    const current = parseStoredTemplate(row);
    if (!current) throw new LibraryError("invalid");
    if (options.expectedRev !== undefined && current.rev !== options.expectedRev) throw new LibraryError("conflict");
    if (current.documentId === documentId) return current;
    if (documentId !== null) {
      const rows = (await req(templates.getAll() as IDBRequest<unknown[]>)) as unknown[];
      checkRoom(rows, documentId, id);
      await linkDocument(tx, documentId, id, "add");
    }
    if (current.documentId !== null) await linkDocument(tx, current.documentId, id, "remove");
    const updated: StoredTemplate = { ...current, documentId, updatedAt: now, rev: current.rev + 1 };
    const checked = parseStoredTemplate(updated);
    if (!checked) throw new LibraryError("invalid");
    await req(templates.put(checked));
    return checked;
  });
  announceChange();
  return stripHistory(stored);
}

/** Borra la plantilla (con sus versiones) y la quita de `templateIds` de su documento. Devuelve si existía. */
export async function deleteTemplate(id: string, options: { expectedRev?: number } = {}): Promise<boolean> {
  if (!ID_PATTERN.test(id)) throw new LibraryError("invalid");
  const existed = await run([TEMPLATES, DOCUMENTS], "readwrite", async (tx) => {
    const templates = tx.objectStore(TEMPLATES);
    const row = (await req(templates.get(id))) as { documentId?: unknown; rev?: unknown } | undefined;
    if (row === undefined) return false;
    const current = parseStoredTemplate(row);
    if (options.expectedRev !== undefined && current && current.rev !== options.expectedRev) throw new LibraryError("conflict");
    await req(templates.delete(id));
    const documentId = current?.documentId ?? row.documentId;
    if (typeof documentId === "string" && ID_PATTERN.test(documentId)) await linkDocument(tx, documentId, id, "remove");
    return true;
  });
  if (existed) announceChange();
  return existed;
}

/* ------------------------------------------------------------------ *
 * Duplicados y reconocimiento por huella
 * ------------------------------------------------------------------ */

export type DuplicateGroup = {
  /** `sameDocument`: un documento con varias plantillas · `sameFingerprint`: documentos distintos con la misma huella («Coincide» o idénticos). */
  kind: "sameDocument" | "sameFingerprint";
  documentIds: string[];
  /** Más reciente primero. */
  templateIds: string[];
  /** La que cuenta (la más reciente). */
  keepId: string;
};

/**
 * Busca plantillas duplicadas para la MISMA huella: varias plantillas de un documento, o documentos distintos cuya huella
 * es idéntica o «Coincide» (todas las páginas ≥ 0,90) con plantilla cada uno. Es un aviso: no borra nada.
 */
export async function findDuplicateTemplates(): Promise<DuplicateGroup[]> {
  const [{ templates }, documents] = await Promise.all([listTemplates(), listDocuments()]);
  const byDocument = new Map<string, DocTemplate[]>();
  for (const template of templates) {
    if (template.documentId === null) continue;
    byDocument.set(template.documentId, [...(byDocument.get(template.documentId) ?? []), template]);
  }
  const candidates = documents.documents.filter((document) => byDocument.has(document.id));
  const parent = new Map(candidates.map((document) => [document.id, document.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const same = a.fingerprint.exact === b.fingerprint.exact || ["exact", "match"].includes(compareFingerprints(a.fingerprint, b.fingerprint).level);
      if (same) parent.set(find(a.id), find(b.id));
    }
  }
  const clusters = new Map<string, DocumentEntry[]>();
  for (const document of candidates) clusters.set(find(document.id), [...(clusters.get(find(document.id)) ?? []), document]);
  const groups: DuplicateGroup[] = [];
  for (const members of clusters.values()) {
    const all = members.flatMap((document) => byDocument.get(document.id) ?? []).sort(newerFirst);
    if (all.length < 2) continue;
    groups.push({
      kind: members.length > 1 ? "sameFingerprint" : "sameDocument",
      documentIds: members.map((document) => document.id).sort(),
      templateIds: all.map((template) => template.id),
      keepId: all[0].id,
    });
  }
  return groups.sort((a, b) => (a.documentIds[0] < b.documentIds[0] ? -1 : 1));
}

export type TemplateLookup = {
  match: MatchResult;
  document: DocumentEntry;
  /** La plantilla que cuenta (la más reciente entre las de la misma huella). */
  template: DocTemplate;
  /** Otras plantillas de la misma huella (del mismo documento o de documentos equivalentes): hay que avisar. */
  duplicates: DocTemplate[];
};

/**
 * «Cargué un PDF: ¿tiene plantilla?» Compara su huella con la de los documentos que tienen plantilla y devuelve la mejor
 * coincidencia (`match.level`: `exact`/`match` → aplicar sola con aviso deshacible; `similar` → preguntar). Usa
 * `match.mappedPages`/`match.reviewPages` con `applyTemplate`. `null` si nada se parece.
 *
 * Misma huella = nivel `exact` o `match` (el mismo contrato reexportado): si varios documentos con plantilla la tienen,
 * manda la plantilla MÁS RECIENTE de todos (`match.ambiguous` = true, `match.alternatives` = los demás documentos) y las
 * otras plantillas van en `duplicates`. Con `similar` gana la de mayor parecido (empates dentro de 0,02 → `ambiguous`).
 */
export async function findTemplateForFingerprint(fingerprint: Fingerprint): Promise<TemplateLookup | null> {
  const [{ templates }, { documents }] = await Promise.all([listTemplates(), listDocuments()]);
  const byDocument = new Map<string, DocTemplate[]>();
  for (const template of templates) {
    if (template.documentId === null) continue;
    byDocument.set(template.documentId, [...(byDocument.get(template.documentId) ?? []), template]);
  }
  for (const list of byDocument.values()) list.sort(newerFirst);
  const withTemplates = documents.filter((document) => byDocument.has(document.id));
  // La plantilla vale para el PDF sobre el que se CONFIGURÓ: si se reemplazó el PDF del documento y ya no coincide
  // (`templateStale`), se compara con la huella de entonces, no con la del PDF nuevo (que es otro contrato).
  const basisOf = (document: DocumentEntry): Fingerprint => document.templateStale?.base ?? document.fingerprint;
  const candidates = withTemplates.map((document) => ({ id: document.id, fingerprint: basisOf(document), updatedAt: byDocument.get(document.id)![0].updatedAt }));
  const best = findBestMatch(fingerprint, candidates);
  if (!best || best.candidateId === undefined) return null;

  let chosenId = best.candidateId;
  let match: MatchResult = best;
  if (best.level === "exact" || best.level === "match") {
    // Todos los documentos con la misma huella; gana la plantilla más reciente.
    const same = withTemplates
      .map((document) => ({ document, result: compareFingerprints(fingerprint, basisOf(document)) }))
      .filter((entry) => entry.result.level === "exact" || entry.result.level === "match");
    same.sort((a, b) => newerFirst(byDocument.get(a.document.id)![0], byDocument.get(b.document.id)![0]));
    const winner = same[0];
    chosenId = winner.document.id;
    match = { ...winner.result, candidateId: chosenId, ambiguous: same.length > 1, alternatives: same.slice(1).map((entry) => entry.document.id) };
  }
  const document = documents.find((entry) => entry.id === chosenId);
  const own = byDocument.get(chosenId);
  if (!document || !own?.length) return null;
  const others = (match.alternatives ?? []).flatMap((id) => byDocument.get(id) ?? []);
  return { match, document, template: own[0], duplicates: [...own.slice(1), ...others].sort(newerFirst) };
}

export type CloneToDocumentResult =
  | { ok: true; template: DocTemplate; kept: number; flagged: number; dropped: number; droppedPages: number[]; match: MatchResult }
  | { ok: false; reason: "noSourceDocument" | "noTargetDocument" | "noMatch" | "notFound" };

/**
 * «Usar esta plantilla en otro documento»: compara la huella del destino con la del documento de la plantilla, recoloca
 * las páginas con `mappedPages`, marca para revisar las páginas «parecidas» y descarta las que no tienen
 * correspondencia. Crea la plantilla nueva en el destino (origen `clone`). `noMatch` si los documentos no se parecen.
 */
export async function cloneTemplateToDocument(templateId: string, targetDocumentId: string, options: TemplateWriteOptions & { name?: string } = {}): Promise<CloneToDocumentResult> {
  const template = await getTemplate(templateId);
  if (!template) return { ok: false, reason: "notFound" };
  if (template.documentId === null) return { ok: false, reason: "noSourceDocument" };
  const [source, target] = await Promise.all([getDocument(template.documentId), getDocument(targetDocumentId)]);
  if (!source) return { ok: false, reason: "noSourceDocument" };
  if (!target) return { ok: false, reason: "noTargetDocument" };
  const match = compareFingerprints(target.fingerprint, source.fingerprint);
  if (match.level === "none") return { ok: false, reason: "noMatch" };
  const cloned = cloneTemplate(template, {
    documentId: target.id,
    mappedPages: match.mappedPages,
    reviewPages: match.reviewPages,
    targetPageCount: target.pageCount,
    ...(options.name !== undefined ? { name: options.name } : {}),
  });
  const created = await createTemplate(cloned.draft, options);
  return { ok: true, template: created, kept: cloned.kept, flagged: cloned.flagged, dropped: cloned.dropped, droppedPages: cloned.droppedPages, match };
}

/* ------------------------------------------------------------------ *
 * Importar (restaurar desde un paquete)
 * ------------------------------------------------------------------ */

export type ImportTemplatesOptions = {
  /** Si ya existe una plantilla con ese id: `skip` (por defecto), `copy` (se guarda con id nuevo) o `replace` (versión nueva de la existente). */
  onConflict?: "skip" | "copy" | "replace";
} & TemplateWriteOptions;

export type ImportTemplatesResult = {
  imported: string[];
  skipped: string[];
  replaced: string[];
  /** Plantillas cuyo documento no está en la biblioteca: se guardaron «sin documento». */
  detached: string[];
};

/**
 * Guarda plantillas ya validadas (p. ej. de `deserializeLibrary`) en UNA sola transacción: o entran todas o ninguna. Las
 * que apuntan a un documento que no está en la biblioteca quedan «sin documento». Conserva `version`, `createdAt` y
 * `updatedAt` de lo importado (con `replace`, la existente pasa a una versión nueva).
 */
export async function importTemplates(templates: readonly DocTemplate[], options: ImportTemplatesOptions = {}): Promise<ImportTemplatesResult> {
  const mode = options.onConflict ?? "skip";
  const now = nowIso(options);
  const result: ImportTemplatesResult = { imported: [], skipped: [], replaced: [], detached: [] };
  const parsed: DocTemplate[] = [];
  for (const raw of templates) {
    const template = parseTemplate(raw);
    if (!template) throw new LibraryError("invalid");
    parsed.push(template);
  }
  if (parsed.length === 0) return result;

  await run([TEMPLATES, DOCUMENTS], "readwrite", async (tx) => {
    const store = tx.objectStore(TEMPLATES);
    const rows = (await req(store.getAll() as IDBRequest<unknown[]>)) as Array<{ id?: unknown; documentId?: unknown } | undefined>;
    const existing = new Map<string, unknown>();
    for (const row of rows) if (row && typeof row.id === "string") existing.set(row.id, row);
    let total = rows.length;
    const perDocument = new Map<string, number>();
    for (const row of rows) if (row && typeof row.documentId === "string") perDocument.set(row.documentId, (perDocument.get(row.documentId) ?? 0) + 1);

    for (const incoming of parsed) {
      let documentId = incoming.documentId;
      if (documentId !== null) {
        const document = parseDocumentEntry(await req(tx.objectStore(DOCUMENTS).get(documentId)));
        if (!document) {
          documentId = null;
          result.detached.push(incoming.id);
        }
      }
      const clash = existing.get(incoming.id);
      if (clash !== undefined && mode === "skip") {
        result.skipped.push(incoming.id);
        continue;
      }
      if (clash !== undefined && mode === "replace") {
        const current = parseStoredTemplate(clash);
        if (!current) throw new LibraryError("invalid");
        const history = [snapshotOf(current), ...current.history].slice(0, TEMPLATE_LIMITS.maxVersions - 1);
        const merged: StoredTemplate = { ...current, ...contentOf(incoming), version: current.version + 1, updatedAt: now, rev: current.rev + 1, history };
        if (!incoming.layout) delete merged.layout;
        const checked = parseStoredTemplate(merged);
        if (!checked) throw new LibraryError("invalid");
        await req(store.put(checked));
        result.replaced.push(incoming.id);
        continue;
      }
      const id = clash !== undefined ? (options.newId ?? randomId)() : incoming.id;
      if (existing.has(id)) throw new LibraryError("conflict");
      if (total >= TEMPLATE_LIMITS.maxTemplates || (documentId !== null && (perDocument.get(documentId) ?? 0) >= TEMPLATE_LIMITS.maxPerDocument)) {
        throw new LibraryError("full", "count");
      }
      const row: StoredTemplate = { ...incoming, id, documentId, rev: 1, history: [] };
      const checked = parseStoredTemplate(row);
      if (!checked) throw new LibraryError("invalid");
      if (documentId !== null) await linkDocument(tx, documentId, id, "add");
      await req(store.put(checked));
      existing.set(id, checked);
      total += 1;
      if (documentId !== null) perDocument.set(documentId, (perDocument.get(documentId) ?? 0) + 1);
      result.imported.push(id);
    }
  });
  if (result.imported.length > 0 || result.replaced.length > 0) announceChange();
  return result;
}
