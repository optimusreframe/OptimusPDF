import { parseDocumentEntry } from "@/lib/docLibrary/schema";
import { STORE_NAMES, announceChange, req, run } from "@/lib/docLibrary/store";
import { staleVerdict } from "@/lib/docLibrary/templateStale";
import { parseStoredTemplate } from "@/lib/docLibrary/templateSchema";
import {
  TEMPLATE_LIMITS,
  type DocTemplate,
  type StoredTemplate,
  type TemplateContent,
  type TemplateSnapshot,
} from "@/lib/docLibrary/templateTypes";
import { LIBRARY_LIMITS, LibraryError, type DocumentEntry, type TemplateStale } from "@/lib/docLibrary/types";

/**
 * Escritura ATÓMICA de la importación de «Plantillas + Documentos» (U4.5): UNA transacción de IndexedDB sobre
 * `documents`, `blobs` y `templates`. O entra todo o no entra nada: cualquier excepción (límite, cuota, conflicto) aborta la
 * transacción y la biblioteca queda como estaba. Es el equivalente de `commitVaultImport` del baúl de firmas.
 *
 * Qué resuelve aquí dentro (porque necesita el estado REAL de la base en el momento de escribir, no el de la vista previa):
 *  - ids ocupados: un documento o plantilla «nuevo» cuyo id ya existe recibe uno nuevo (y sus plantillas lo siguen);
 *  - lo que se iba a reemplazar tiene que seguir en la misma `rev` (`conflict` → «changed»);
 *  - un documento «nuevo» cuyo PDF ya está (apareció desde la vista previa) no se duplica (`conflict`);
 *  - límites finales (50 documentos, 400 MiB, 200 plantillas, 20 por documento);
 *  - vínculos documento↔plantilla (`templateIds`) reconstruidos desde `documentId` de las plantillas;
 *  - aviso «plantilla desactualizada» (`templateStale`) recalculado con `staleVerdict`, como `replaceDocumentBytes`.
 */

const { documents: DOCUMENTS, blobs: BLOBS, templates: TEMPLATES } = STORE_NAMES;

export type CommitTemplateReplace = {
  /** El contenido nuevo. */
  template: DocTemplate;
  /** La plantilla de la biblioteca que recibe una versión nueva. */
  targetId: string;
  /** La `rev` que tenía en la vista previa. */
  expectRev: number;
};

export type CommitDocOp =
  /** Documento nuevo (o copia: «conservar ambos») con sus plantillas. */
  | { kind: "create"; entry: DocumentEntry; pdf: Uint8Array; adds: DocTemplate[] }
  /** El documento de la biblioteca toma el PDF del paquete; sus plantillas se fusionan. */
  | { kind: "replace"; targetId: string; expectRev: number; entry: DocumentEntry; pdf: Uint8Array; adds: DocTemplate[]; replaces: CommitTemplateReplace[] }
  /** Mismo PDF: solo se añaden / reemplazan plantillas de un documento que ya tienes. */
  | { kind: "templates"; targetId: string; expectRev: number; adds: DocTemplate[]; replaces: CommitTemplateReplace[] }
  /** Plantillas «sin documento». */
  | { kind: "detached"; adds: DocTemplate[]; replaces: CommitTemplateReplace[] };

export type CommitResult =
  | {
      ok: true;
      documentsCreated: number;
      documentsReplaced: number;
      templatesAdded: number;
      templatesReplaced: number;
      reassigned: number;
    }
  | { ok: false; reason: "limit" | "quota" | "unavailable" | "invalid" | "changed" | "failed" };

function randomId(prefix: string): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let id = `${prefix}-`;
  for (const byte of bytes) id += byte.toString(36).padStart(2, "0");
  return id;
}

/** La clonación estructurada de una VISTA guardaría todo su buffer: se copia solo si la vista no es el buffer entero. */
function exactBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.buffer.byteLength === data.length ? data : data.slice();
}

function contentOf(source: TemplateContent): TemplateContent {
  return { name: source.name, roles: source.roles, variants: source.variants, ...(source.layout ? { layout: source.layout } : {}) };
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

type RawRow = { id?: unknown; byteLength?: unknown } | undefined;

function failureOf(error: unknown): CommitResult {
  const code = error instanceof LibraryError ? error.code : undefined;
  if (code === "conflict") return { ok: false, reason: "changed" };
  if (code === "full") return { ok: false, reason: "limit" };
  if (code === "quota") return { ok: false, reason: "quota" };
  if (code === "unavailable") return { ok: false, reason: "unavailable" };
  if (code === "invalid") return { ok: false, reason: "invalid" };
  return { ok: false, reason: "failed" };
}

export async function commitLibraryImport(ops: readonly CommitDocOp[], options: { now?: () => Date } = {}): Promise<CommitResult> {
  const now = (options.now?.() ?? new Date()).toISOString();
  const counters = { documentsCreated: 0, documentsReplaced: 0, templatesAdded: 0, templatesReplaced: 0, reassigned: 0 };
  try {
    await run([DOCUMENTS, BLOBS, TEMPLATES], "readwrite", async (tx) => {
      const documentStore = tx.objectStore(DOCUMENTS);
      const blobStore = tx.objectStore(BLOBS);
      const templateStore = tx.objectStore(TEMPLATES);
      const documentRows = (await req(documentStore.getAll() as IDBRequest<unknown[]>)) as RawRow[];
      const templateRows = (await req(templateStore.getAll() as IDBRequest<unknown[]>)) as RawRow[];

      const takenDocumentIds = new Set<string>();
      let bytesTotal = 0;
      const documents = new Map<string, DocumentEntry>();
      for (const row of documentRows) {
        if (row && typeof row.id === "string") takenDocumentIds.add(row.id);
        if (row && typeof row.byteLength === "number" && Number.isFinite(row.byteLength) && row.byteLength > 0) bytesTotal += row.byteLength;
        const parsed = parseDocumentEntry(row);
        if (parsed) documents.set(parsed.id, parsed);
      }
      const takenTemplateIds = new Set<string>();
      const templates = new Map<string, StoredTemplate>();
      for (const row of templateRows) {
        if (row && typeof row.id === "string") takenTemplateIds.add(row.id);
        const parsed = parseStoredTemplate(row);
        if (parsed) templates.set(parsed.id, parsed);
      }
      const documentCount = documentRows.length;
      const dirtyTemplates = new Set<string>();
      const dirtyDocuments = new Map<
        string,
        { mode: "create" | "replace" | "templates"; entry: DocumentEntry; pdf?: Uint8Array; previous?: DocumentEntry; pkgStale?: TemplateStale; retained?: number }
      >();

      const freshId = (prefix: string, taken: Set<string>): string => {
        let id = randomId(prefix);
        while (taken.has(id)) id = randomId(prefix);
        return id;
      };
      const addTemplate = (template: DocTemplate, documentId: string | null): string => {
        let id = template.id;
        if (takenTemplateIds.has(id)) {
          id = freshId("tpl", takenTemplateIds);
          counters.reassigned += 1;
        }
        takenTemplateIds.add(id);
        const stored = parseStoredTemplate({ ...template, id, documentId, rev: 1, history: [] });
        if (!stored) throw new LibraryError("invalid");
        templates.set(id, stored);
        dirtyTemplates.add(id);
        counters.templatesAdded += 1;
        return id;
      };
      const replaceTemplate = (change: CommitTemplateReplace, ownerId: string | null | undefined): string => {
        const current = templates.get(change.targetId);
        if (!current || current.rev !== change.expectRev) throw new LibraryError("conflict");
        // Una plantilla de otro documento no se toca desde este elemento.
        if (ownerId !== undefined && current.documentId !== ownerId) throw new LibraryError("conflict");
        const history = [snapshotOf(current), ...current.history].slice(0, TEMPLATE_LIMITS.maxVersions - 1);
        const merged: StoredTemplate = {
          ...current,
          ...contentOf(change.template),
          version: current.version + 1,
          updatedAt: now,
          rev: current.rev + 1,
          history,
        };
        if (!change.template.layout) delete merged.layout;
        const checked = parseStoredTemplate(merged);
        if (!checked) throw new LibraryError("invalid");
        templates.set(checked.id, checked);
        dirtyTemplates.add(checked.id);
        counters.templatesReplaced += 1;
        return checked.id;
      };

      for (const op of ops) {
        if (op.kind === "detached") {
          for (const change of op.replaces) replaceTemplate(change, null);
          for (const template of op.adds) addTemplate(template, null);
          continue;
        }
        if (op.kind === "create") {
          // Un PDF que ya está (apareció desde la vista previa) no se duplica.
          for (const existing of documents.values()) {
            if (existing.fingerprint.exact === op.entry.fingerprint.exact) throw new LibraryError("conflict");
          }
          let id = op.entry.id;
          if (takenDocumentIds.has(id)) {
            id = freshId("d", takenDocumentIds);
            counters.reassigned += 1;
          }
          takenDocumentIds.add(id);
          const entry: DocumentEntry = { ...op.entry, id, templateIds: [], byteLength: op.pdf.length, rev: 1 };
          documents.set(id, entry);
          dirtyDocuments.set(id, { mode: "create", entry, pdf: op.pdf, ...(op.entry.templateStale ? { pkgStale: op.entry.templateStale } : {}) });
          bytesTotal += op.pdf.length;
          counters.documentsCreated += 1;
          for (const template of op.adds) addTemplate(template, id);
          continue;
        }
        const target = documents.get(op.targetId);
        if (!target || target.rev !== op.expectRev) throw new LibraryError("conflict");
        if (op.kind === "replace") {
          const existingTemplateIds = [...templates.values()].filter((template) => template.documentId === target.id).map((template) => template.id);
          const replacedIds = new Set<string>();
          for (const change of op.replaces) replacedIds.add(replaceTemplate(change, target.id));
          for (const template of op.adds) addTemplate(template, target.id);
          const entry: DocumentEntry = {
            ...target,
            name: op.entry.name,
            docType: op.entry.docType,
            fileName: op.entry.fileName,
            pageCount: op.entry.pageCount,
            pageSizes: op.entry.pageSizes,
            fingerprint: op.entry.fingerprint,
            updatedAt: now,
            byteLength: op.pdf.length,
            rev: target.rev + 1,
          };
          bytesTotal += op.pdf.length - target.byteLength;
          documents.set(target.id, entry);
          dirtyDocuments.set(target.id, {
            mode: "replace",
            entry,
            pdf: op.pdf,
            previous: target,
            retained: existingTemplateIds.filter((id) => !replacedIds.has(id)).length,
            ...(op.entry.templateStale ? { pkgStale: op.entry.templateStale } : {}),
          });
          counters.documentsReplaced += 1;
          continue;
        }
        // kind === "templates"
        for (const change of op.replaces) replaceTemplate(change, target.id);
        for (const template of op.adds) addTemplate(template, target.id);
        const bumped: DocumentEntry = { ...target, rev: target.rev + 1 };
        documents.set(target.id, bumped);
        dirtyDocuments.set(target.id, { mode: "templates", entry: bumped, previous: target });
      }

      // Vínculos documento↔plantilla y aviso de «desactualizada» de cada documento tocado.
      for (const [id, info] of dirtyDocuments) {
        const owned = [...templates.values()].filter((template) => template.documentId === id);
        if (owned.length > TEMPLATE_LIMITS.maxPerDocument) throw new LibraryError("full", "count");
        const previousIds = info.previous?.templateIds ?? [];
        const ids = [...previousIds.filter((known) => owned.some((template) => template.id === known)), ...owned.map((template) => template.id).filter((known) => !previousIds.includes(known))];
        let templateStale: TemplateStale | undefined;
        const base = info.entry;
        if (info.mode === "templates") {
          // Mismo PDF: el aviso que hubiera sigue igual mientras haya plantillas.
          if (owned.length > 0) templateStale = info.previous?.templateStale;
        } else if (info.mode === "replace" && (info.retained ?? 0) > 0 && info.previous) {
          // Las plantillas que se conservan se configuraron sobre el PDF de ANTES: ¿siguen valiendo con el nuevo?
          const reference = info.previous.templateStale?.base ?? info.previous.fingerprint;
          const verdict = staleVerdict(reference, base.fingerprint);
          if (verdict.stale) templateStale = { since: info.previous.templateStale?.since ?? now, level: verdict.level, percent: verdict.percent, base: reference };
        } else if (info.pkgStale && owned.length > 0) {
          // El aviso del paquete se recalcula contra el PDF que de verdad queda.
          const verdict = staleVerdict(info.pkgStale.base, base.fingerprint);
          if (verdict.stale) templateStale = { since: info.pkgStale.since, level: verdict.level, percent: verdict.percent, base: info.pkgStale.base };
        }
        const { templateStale: _dropped, ...withoutStale } = base;
        void _dropped;
        const row: DocumentEntry = { ...withoutStale, templateIds: ids, ...(templateStale ? { templateStale } : {}) };
        if (!parseDocumentEntry(row)) throw new LibraryError("invalid");
        documents.set(id, row);
      }

      if (documentCount + counters.documentsCreated > LIBRARY_LIMITS.maxDocuments) throw new LibraryError("full", "count");
      if (bytesTotal > LIBRARY_LIMITS.maxTotalBytes) throw new LibraryError("full", "total");
      if (templateRows.length + counters.templatesAdded > TEMPLATE_LIMITS.maxTemplates) throw new LibraryError("full", "count");

      for (const [id, info] of dirtyDocuments) {
        await req(documentStore.put(documents.get(id)));
        if (info.pdf) await req(blobStore.put({ documentId: id, bytes: exactBytes(info.pdf), byteLength: info.pdf.length }));
      }
      for (const id of dirtyTemplates) await req(templateStore.put(templates.get(id)));
    });
  } catch (error) {
    return failureOf(error);
  }
  announceChange();
  return { ok: true, ...counters };
}
