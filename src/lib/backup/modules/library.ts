import { sha256Hex } from "@/lib/crypto/sha256";
import { deserializeLibrary, serializeLibrary, serializeTemplate } from "@/lib/docLibrary/persist";
import { estimateUsage, getDocumentBytes, listBlobIds, listDocuments } from "@/lib/docLibrary/store";
import { parseTemplate, sameContent } from "@/lib/docLibrary/templateSchema";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { TEMPLATE_LIMITS, type DocTemplate, type TemplateContent } from "@/lib/docLibrary/templateTypes";
import { LIBRARY_LIMITS, LibraryError, type DocumentEntry } from "@/lib/docLibrary/types";
import { CURRENT_LIBRARY_SCHEMA, migrateLibrary, type LibraryRaw } from "@/lib/backup/migrations/library";
import { LIBRARY_MODULE, LIBRARY_MODULE_SPEC, MAX_LIBRARY_JSON_BYTES } from "@/lib/backup/modules/libraryModuleSpec";
import { commitLibraryImport, type CommitDocOp, type CommitTemplateReplace } from "@/lib/backup/modules/libraryCommit";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  type PackageFileInput,
  type PackageFileRead,
  type PackageModuleData,
  type PackageModuleInput,
  type PackageReadResult,
} from "@/lib/backup/types";

/**
 * Módulo «Plantillas + Documentos» del respaldo (`docs/PLAN-FIRMA-AGIL.md` §9.3, U4.5): exporta la biblioteca de
 * «Mis documentos» (PDF base en blanco, su huella y las plantillas de campos) a un módulo del paquete y planifica y
 * aplica su importación fusionando, sin pisar nada que la persona no apruebe.
 *
 * ```
 * documents/index.json        [{ id, name, docType, fileName, pageCount, pageSizes, fingerprint, createdAt, updatedAt,
 *                               byteLength, templateStale?, file: "documents/<archivo>.pdf" }]
 * documents/<archivo>.pdf     el PDF base
 * templates/index.json        [{ id, file: "templates/<archivo>.json" }]
 * templates/<archivo>.json    una plantilla (DocTemplate sin `rev` ni historial; `documentId` la vincula a un documento)
 * ```
 * Lo que NUNCA viaja: firmas, borradores, valores de clientes, `rev` (es de cada navegador) ni el historial de versiones.
 * `templateIds` de cada documento tampoco viaja: los vínculos documento↔plantilla se RECONSTRUYEN al importar desde
 * `documentId` de cada plantilla.
 *
 * Seguridad de la importación: nada se ejecuta; los nombres de archivo y los tipos MIME del zip no se creen (cada ruta
 * debe casar con una lista blanca y existir con SHA-256 correcto); la huella de cada documento debe declarar el SHA-256
 * del PDF que la acompaña; el PDF pasa por la puerta de entrada que le pasa la interfaz (`inputGuard`); la plantilla
 * pasa por `parseTemplate` (listas blancas, rangos); los campos desconocidos se ignoran; un elemento dañado se aísla
 * (`invalid`) sin tumbar el resto; y el plan se REVALIDA al aplicar (la interfaz no puede colar entradas).
 */

const DOCS_INDEX = "documents/index.json";
const TEMPLATES_INDEX = "templates/index.json";
/** Nombres de `templates/` que NO son una plantilla (reservados por el formato; `kits.json` y perfiles son de otras unidades). */
const RESERVED_TEMPLATE_FILES = new Set(["index.json", "kits.json", "insurer-profiles.json"]);
const DOC_FILE = /^documents\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pdf$/;
const TEMPLATE_FILE = /^templates\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json)$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Elementos que se aceptan leer de cada índice (la biblioteca admite 50 documentos y 200 plantillas: el resto es hostil). */
const MAX_DOC_ITEMS = 200;
const MAX_TEMPLATE_ITEMS = 400;
const MAX_JSON_BYTES = MAX_LIBRARY_JSON_BYTES;

export { LIBRARY_MODULE, LIBRARY_MODULE_SPEC };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

const encoder = new TextEncoder();

/** `%PDF-` en el primer KB, como pide `inputGuard`. */
function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024) - 4;
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

function contentOf(template: TemplateContent): TemplateContent {
  return {
    name: template.name,
    roles: template.roles,
    variants: template.variants,
    ...(template.layout ? { layout: template.layout } : {}),
  };
}

/** Misma plantilla = mismo contenido (nombre, roles, variantes y diseño); el id, las fechas y la versión no cuentan. */
export function sameTemplateContent(a: DocTemplate, b: DocTemplate): boolean {
  return sameContent(contentOf(a), contentOf(b));
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

function uniquePath(folder: string, base: string, extension: string, used: Set<string>, reserved?: ReadonlySet<string>): string {
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "x";
  let candidate = `${folder}/${clean}${extension}`;
  let counter = 1;
  while (used.has(candidate.toLowerCase()) || reserved?.has(candidate.slice(folder.length + 1).toLowerCase())) {
    counter += 1;
    candidate = `${folder}/${clean}-${counter}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export type LibraryExportReport = {
  documents: number;
  templates: number;
  /** Bytes de PDF que llevan los documentos exportados. */
  bytes: number;
  /** Documentos que NO se exportaron porque su copia del PDF falta o está dañada. */
  skippedDocuments: number;
};

export type LibraryExportSummary = {
  available: boolean;
  documents: number;
  templates: number;
  bytes: number;
  /** Documentos sin copia del PDF: no se pueden respaldar. */
  withoutCopy: number;
};

/**
 * Subconjunto a exportar: solo esos documentos y las plantillas que cuelgan de ellos (`documentId` dentro del conjunto).
 * Sin él viaja TODA la biblioteca (el respaldo de siempre).
 */
export type LibraryExportOptions = { documentIds?: readonly string[] };

/** Cuánto llevaría el respaldo (sin leer los PDF): «N documentos, M plantillas, X MB». Nunca lanza. */
export async function summarizeLibraryExport(options: LibraryExportOptions = {}): Promise<LibraryExportSummary> {
  const everything = await listDocuments();
  if (!everything.available) return { available: false, documents: 0, templates: 0, bytes: 0, withoutCopy: 0 };
  const only = options.documentIds ? new Set(options.documentIds) : null;
  const listed = only ? { ...everything, documents: everything.documents.filter((doc) => only.has(doc.id)) } : everything;
  const allTemplates = await listTemplates();
  const templates = only
    ? { ...allTemplates, templates: allTemplates.templates.filter((template) => template.documentId !== null && only.has(template.documentId)) }
    : allTemplates;
  // «Con copia» = la fila dice que tiene PDF Y la copia existe de verdad: un documento cuyo PDF se perdio no viajaria y no
  // se cuenta (antes se contaba y el respaldo lo omitia en silencio).
  const blobIds = await listBlobIds();
  const withCopy = listed.documents.filter((doc) => doc.byteLength > 0 && (blobIds === null || blobIds.has(doc.id)));
  return {
    available: true,
    documents: withCopy.length,
    templates: templates.templates.length,
    bytes: withCopy.reduce((sum, doc) => sum + doc.byteLength, 0),
    withoutCopy: listed.documents.length - withCopy.length,
  };
}

/**
 * Módulo «library» con TODO lo que hay ahora en la biblioteca, más un informe. Un documento cuya copia falta o no
 * corresponde a su huella se OMITE (un respaldo que no se podría importar es peor que ninguno) y se cuenta.
 * Sin IndexedDB lanza `LibraryError("unavailable")`.
 */
export async function exportLibraryWithReport(
  options: LibraryExportOptions = {},
): Promise<{ module: PackageModuleInput; report: LibraryExportReport }> {
  const everything = await listDocuments();
  const allTemplates = await listTemplates();
  if (!everything.available || !allTemplates.available) throw new LibraryError("unavailable");
  // Un subconjunto lleva solo esos documentos y las plantillas que cuelgan de ellos.
  const only = options.documentIds ? new Set(options.documentIds) : null;
  const listed = only ? { ...everything, documents: everything.documents.filter((doc) => only.has(doc.id)) } : everything;
  const templateList = only
    ? { ...allTemplates, templates: allTemplates.templates.filter((template) => template.documentId !== null && only.has(template.documentId)) }
    : allTemplates;

  const used = new Set<string>([DOCS_INDEX, TEMPLATES_INDEX]);
  const files: PackageFileInput[] = [];
  const entries: DocumentEntry[] = [];
  const fileOf = new Map<string, string>();
  let bytes = 0;
  let skipped = 0;
  const sortedDocs = listed.documents
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const doc of sortedDocs) {
    const pdf = await getDocumentBytes(doc.id);
    if (!pdf || pdf.length === 0 || (await sha256Hex(pdf)) !== doc.fingerprint.exact) {
      skipped += 1;
      continue;
    }
    const path = uniquePath("documents", doc.id, ".pdf", used);
    fileOf.set(doc.id, path);
    // Copia al Uint8Array del dominio actual (en jsdom el de IndexedDB es ajeno).
    files.push({ path, data: new Uint8Array(pdf), type: "application/pdf" });
    entries.push(doc);
    bytes += pdf.length;
  }
  const serialized = serializeLibrary(entries).documents.map((doc, index) => {
    const { templateIds, ...rest } = doc;
    void templateIds;
    return { ...rest, byteLength: files[index].data.length, file: files[index].path };
  });

  const templates = templateList.templates
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const templateIndex: Array<{ id: string; file: string }> = [];
  const templateFiles: PackageFileInput[] = [];
  for (const template of templates) {
    const path = uniquePath("templates", template.id, ".json", used, RESERVED_TEMPLATE_FILES);
    // Una plantilla de un documento que no viaja queda «sin documento» en el paquete.
    const documentId = template.documentId !== null && fileOf.has(template.documentId) ? template.documentId : null;
    const body = { ...serializeTemplate(template), documentId };
    templateFiles.push({ path, data: new Uint8Array(encoder.encode(JSON.stringify(body))), type: "application/json" });
    templateIndex.push({ id: template.id, file: path });
  }

  const json = (value: unknown): Uint8Array => new Uint8Array(encoder.encode(JSON.stringify(value)));
  const mod: PackageModuleInput = {
    name: LIBRARY_MODULE,
    schemaVersion: CURRENT_LIBRARY_SCHEMA,
    meta: { documents: serialized.length, templates: templateIndex.length },
    files: [
      { path: DOCS_INDEX, data: json(serialized), type: "application/json" },
      { path: TEMPLATES_INDEX, data: json(templateIndex), type: "application/json" },
      ...files,
      ...templateFiles,
    ],
  };
  return { module: mod, report: { documents: serialized.length, templates: templateIndex.length, bytes, skippedDocuments: skipped } };
}

/** Módulo «library» con todo lo que hay ahora en la biblioteca. */
export async function exportLibrary(): Promise<PackageModuleInput> {
  return (await exportLibraryWithReport()).module;
}

// ---------------------------------------------------------------------------
// Planificar la importación
// ---------------------------------------------------------------------------

export type LibraryItemStatus = "new" | "identical" | "different" | "invalid";
export type LibraryInvalidReason =
  | "integrity"
  | "tooLarge"
  | "invalidEntry"
  | "invalidPdf"
  /** La huella declara un SHA-256 distinto del PDF que la acompaña. */
  | "fingerprint"
  | "duplicateId"
  | "noPdf"
  /** La plantilla apunta a un documento que no viene en el paquete. */
  | "noDocument"
  /** El documento de la plantilla no se puede importar. */
  | "documentInvalid";
export type LibraryDecision = "import" | "replace" | "keepBoth" | "omit";

export type LibraryTemplateRow = {
  id: string;
  name: string;
  status: LibraryItemStatus;
  reason?: LibraryInvalidReason;
  /** Lo que se escribiría (solo si `status !== "invalid"`). */
  template?: DocTemplate;
  /** `different`: la plantilla de esta biblioteca con el mismo id (a la que «Reemplazar» daría una versión nueva). */
  conflict?: { id: string; rev: number };
};

export type LibraryImportItem = {
  /** Clave única dentro del plan (los ids repetidos o ausentes reciben `#N`: el `#` no puede aparecer en un id real). */
  key: string;
  /** `document`: un documento con sus plantillas. `template`: una plantilla «sin documento». */
  kind: "document" | "template";
  status: LibraryItemStatus;
  reason?: LibraryInvalidReason;
  id: string;
  name: string;
  docType: string;
  pageCount: number;
  /** Bytes del PDF (0 en una plantilla suelta). */
  bytes: number;
  /** Las plantillas del documento (o la propia plantilla). */
  templates: LibraryTemplateRow[];
  /**
   * `different`: `pdf` = hay un documento con el mismo id y otro PDF; `templates` = el mismo PDF ya está, pero las
   * plantillas del paquete difieren de las que tienes (nuevas o cambiadas). En una plantilla suelta: `templates`.
   */
  difference?: "pdf" | "templates";
  /** `difference === "templates"`: alguna plantilla del paquete tiene el id de una tuya con otro contenido. */
  changesTemplates?: boolean;
  /**
   * Este documento trae el MISMO PDF (mismo SHA-256) que otro del propio paquete, bajo otro id: se importa una sola vez
   * (el otro) y las plantillas de este se vinculan a aquel. `status` es `identical` y no se ofrece decisión.
   */
  duplicateOf?: { key: string; name: string };
  /** `different`: lo que ya tienes y sería el destino de «Reemplazar». `rev` se comprueba al escribir. */
  conflictWith?: { id: string; name: string; rev: number; bytes: number; templates: number };
  /** Lo que se escribiría (solo documentos no inválidos). */
  document?: DocumentEntry;
  pdf?: Uint8Array;
};

export type LibraryPlanState = "ok" | "absent" | "newerVersion" | "damaged";

export type LibraryPlan = {
  module: typeof LIBRARY_MODULE;
  state: LibraryPlanState;
  message?: string;
  items: LibraryImportItem[];
  counts: { new: number; identical: number; different: number; invalid: number };
  limits: {
    maxDocuments: number;
    maxTotalBytes: number;
    maxTemplates: number;
    maxTemplatesPerDocument: number;
    currentDocuments: number;
    currentBytes: number;
    currentTemplates: number;
    /** Plantillas que ya tiene cada documento de la biblioteca. */
    templatesByDocument: Record<string, number>;
    /** Estimación del navegador (todo el origen), si la dio. */
    browser?: { usage: number; quota: number };
  };
};

export type LibraryExisting = {
  documents: readonly DocumentEntry[];
  templates: readonly DocTemplate[];
  browser?: { usage: number; quota: number };
};

/** Lo que hay ahora en la biblioteca, listo para `planLibraryImport`. Sin IndexedDB lanza `LibraryError("unavailable")`. */
export async function loadLibraryExisting(): Promise<LibraryExisting> {
  const [docs, templates, usage] = await Promise.all([listDocuments(), listTemplates(), estimateUsage().catch(() => null)]);
  if (!docs.available || !templates.available) throw new LibraryError("unavailable");
  return {
    documents: docs.documents,
    templates: templates.templates,
    ...(usage?.browser ? { browser: usage.browser } : {}),
  };
}

export type LibraryPlanOptions = {
  /**
   * Puerta de entrada de CADA PDF que se importaría (no de los idénticos a los que ya tienes): `false` = no vale.
   * La interfaz pasa `browserInputGuard` (abre el PDF con pdf.js); sin ella solo valen el encabezado `%PDF-`, el
   * SHA-256 y el tamaño (las pruebas con PDF "de mentira").
   */
  validatePdf?: (bytes: Uint8Array) => Promise<boolean>;
};

/** Planes emitidos por `planLibraryImport`: `applyLibraryImport` no acepta ningún otro objeto. */
const issuedPlans = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function emptyLimits(existing: LibraryExisting): LibraryPlan["limits"] {
  const templatesByDocument: Record<string, number> = Object.create(null);
  for (const template of existing.templates) {
    if (template.documentId !== null) templatesByDocument[template.documentId] = (templatesByDocument[template.documentId] ?? 0) + 1;
  }
  return {
    maxDocuments: LIBRARY_LIMITS.maxDocuments,
    maxTotalBytes: LIBRARY_LIMITS.maxTotalBytes,
    maxTemplates: TEMPLATE_LIMITS.maxTemplates,
    maxTemplatesPerDocument: TEMPLATE_LIMITS.maxPerDocument,
    currentDocuments: existing.documents.length,
    currentBytes: existing.documents.reduce((sum, doc) => sum + doc.byteLength, 0),
    currentTemplates: existing.templates.length,
    templatesByDocument,
    ...(existing.browser ? { browser: { usage: existing.browser.usage, quota: existing.browser.quota } } : {}),
  };
}

function emptyPlan(state: LibraryPlanState, existing: LibraryExisting, message?: string): LibraryPlan {
  const plan: LibraryPlan = {
    module: LIBRARY_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    limits: emptyLimits(existing),
  };
  issuedPlans.add(plan);
  return deepFreeze(plan);
}

function fileOk(data: PackageModuleData, path: string): PackageFileRead | null {
  const file = data.files.get(path);
  return file && file.status === "ok" && file.bytes ? file : null;
}

type FileProblem = "integrity" | "tooLarge";
function fileProblem(data: PackageModuleData, path: string): FileProblem | null {
  const file = data.files.get(path);
  if (!file) return "integrity";
  if (file.status === "tooLarge") return "tooLarge";
  return file.status === "ok" && file.bytes ? null : "integrity";
}

/**
 * Vista previa de importar el módulo «library» de un paquete ya leído (`readPackage`) sobre lo que hay ahora
 * (`loadLibraryExisting`). No escribe nada. Cada documento (con sus plantillas) o plantilla suelta queda «Nuevo»,
 * «Ya lo tienes (idéntico)» (mismo SHA-256 del PDF y las mismas plantillas), «Distinto» (mismo id con otro PDF, o el
 * mismo PDF con plantillas distintas) o `invalid` (aislado, con su motivo).
 */
export async function planLibraryImport(
  read: PackageReadResult,
  existing: LibraryExisting,
  options: LibraryPlanOptions = {},
): Promise<LibraryPlan> {
  const data = read.modules.find((mod) => mod.name === LIBRARY_MODULE);
  if (!data) return emptyPlan("absent", existing);
  if (data.status === "newerVersion") return emptyPlan("newerVersion", existing, data.message ?? NEWER_VERSION_MESSAGE);

  // --- Índices -------------------------------------------------------------------------------------------------
  let docsIndex: unknown;
  let templatesIndex: unknown;
  const parsedTemplates = new Map<string, unknown>();
  let migratedTemplates: Map<string, unknown> = parsedTemplates;
  const templateProblem = new Map<string, FileProblem | "json">();
  let rawIndexTemplates: unknown[] = [];
  try {
    const docsFile = data.files.has(DOCS_INDEX) ? fileOk(data, DOCS_INDEX) : null;
    const tplFile = data.files.has(TEMPLATES_INDEX) ? fileOk(data, TEMPLATES_INDEX) : null;
    if ((data.files.has(DOCS_INDEX) && !docsFile) || (data.files.has(TEMPLATES_INDEX) && !tplFile)) return emptyPlan("damaged", existing);
    if (!docsFile && !tplFile) return emptyPlan("damaged", existing);
    docsIndex = docsFile?.bytes ? parseStrictJson(docsFile.bytes, MAX_JSON_BYTES) : [];
    templatesIndex = tplFile?.bytes ? parseStrictJson(tplFile.bytes, MAX_JSON_BYTES) : [];
    if (!Array.isArray(docsIndex) || docsIndex.length > MAX_DOC_ITEMS) return emptyPlan("damaged", existing);
    if (!Array.isArray(templatesIndex) || templatesIndex.length > MAX_TEMPLATE_ITEMS) return emptyPlan("damaged", existing);
    rawIndexTemplates = templatesIndex;
    for (const item of templatesIndex) {
      const file = isRecord(item) ? own(item, "file") : undefined;
      if (typeof file !== "string" || !isTemplateFile(file) || parsedTemplates.has(file) || templateProblem.has(file)) continue;
      const problem = fileProblem(data, file);
      if (problem) {
        templateProblem.set(file, problem);
        continue;
      }
      try {
        parsedTemplates.set(file, parseStrictJson((data.files.get(file) as PackageFileRead).bytes as Uint8Array, MAX_JSON_BYTES));
      } catch {
        templateProblem.set(file, "json");
      }
    }
    const migrated: LibraryRaw = migrateLibrary(
      { documents: docsIndex, templateIndex: templatesIndex, templates: parsedTemplates },
      data.declaredSchemaVersion,
    );
    docsIndex = migrated.documents;
    templatesIndex = migrated.templateIndex;
    migratedTemplates = new Map(migrated.templates);
    if (!Array.isArray(docsIndex) || !Array.isArray(templatesIndex)) return emptyPlan("damaged", existing);
    rawIndexTemplates = templatesIndex;
  } catch {
    return emptyPlan("damaged", existing);
  }

  const plan: LibraryPlan = {
    module: LIBRARY_MODULE,
    state: "ok",
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    limits: emptyLimits(existing),
  };

  // --- Biblioteca actual ---------------------------------------------------------------------------------------
  const existingById = new Map(existing.documents.map((doc) => [doc.id, doc]));
  const existingByHash = new Map<string, DocumentEntry>();
  for (const doc of existing.documents) if (!existingByHash.has(doc.fingerprint.exact)) existingByHash.set(doc.fingerprint.exact, doc);
  const existingTemplateById = new Map(existing.templates.map((template) => [template.id, template]));
  const templatesOfDoc = (documentId: string): DocTemplate[] => existing.templates.filter((template) => template.documentId === documentId);
  const detachedTemplates = existing.templates.filter((template) => template.documentId === null);

  // --- Documentos (sin la puerta del PDF todavía) ---------------------------------------------------------------
  const docItems: LibraryImportItem[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const blankDoc = (key: string, id: string, name: string, reason: LibraryInvalidReason): LibraryImportItem => ({
    key,
    kind: "document",
    status: "invalid",
    reason,
    id,
    name,
    docType: "",
    pageCount: 0,
    bytes: 0,
    templates: [],
  });
  for (const [position, raw] of (docsIndex as unknown[]).entries()) {
    const placeholder = `#invalid-${position + 1}`;
    if (!isRecord(raw)) {
      docItems.push(blankDoc(placeholder, placeholder, "", "invalidEntry"));
      continue;
    }
    const rawId = own(raw, "id");
    const rawName = own(raw, "name");
    const label = typeof rawName === "string" && rawName.length <= LIBRARY_LIMITS.maxNameLength ? rawName : "";
    if (typeof rawId !== "string" || !ID_PATTERN.test(rawId)) {
      docItems.push(blankDoc(placeholder, placeholder, label, "invalidEntry"));
      continue;
    }
    if (seenIds.has(rawId)) {
      docItems.push(blankDoc(`${rawId}#${position + 1}`, rawId, label, "duplicateId"));
      continue;
    }
    seenIds.add(rawId);
    const file = own(raw, "file");
    if (typeof file !== "string") {
      docItems.push(blankDoc(rawId, rawId, label, "noPdf"));
      continue;
    }
    if (!DOC_FILE.test(file) || seenFiles.has(file.toLowerCase())) {
      docItems.push(blankDoc(rawId, rawId, label, "invalidEntry"));
      continue;
    }
    seenFiles.add(file.toLowerCase());
    // El documento se revive con la MISMA validación que las lecturas de IndexedDB (`persist.ts`).
    const { file: _file, templateIds: _ids, ...rest } = raw;
    void _file;
    void _ids;
    const revived = deserializeLibrary({ schemaVersion: 1, documents: [{ ...rest, templateIds: [] }] });
    const entry = revived.ok ? revived.documents[0] : undefined;
    if (!entry) {
      docItems.push(blankDoc(rawId, rawId, label, "invalidEntry"));
      continue;
    }
    const problem = fileProblem(data, file);
    if (problem) {
      docItems.push(blankDoc(rawId, rawId, entry.name, problem));
      continue;
    }
    const pdf = (data.files.get(file) as PackageFileRead).bytes as Uint8Array;
    const sha = (data.files.get(file) as PackageFileRead).sha256;
    if (pdf.length === 0 || pdf.length > LIBRARY_LIMITS.maxDocumentBytes || !hasPdfHeader(pdf)) {
      docItems.push(blankDoc(rawId, rawId, entry.name, pdf.length > LIBRARY_LIMITS.maxDocumentBytes ? "tooLarge" : "invalidPdf"));
      continue;
    }
    if (entry.fingerprint.exact !== sha || (await sha256Hex(pdf)) !== sha) {
      docItems.push(blankDoc(rawId, rawId, entry.name, "fingerprint"));
      continue;
    }
    const document: DocumentEntry = { ...entry, templateIds: [], byteLength: pdf.length };
    docItems.push({
      key: rawId,
      kind: "document",
      status: "new",
      id: rawId,
      name: document.name,
      docType: document.docType,
      pageCount: document.pageCount,
      bytes: pdf.length,
      templates: [],
      document,
      pdf,
    });
  }
  const docItemById = new Map(docItems.filter((item) => item.status !== "invalid").map((item) => [item.id, item]));
  const invalidDocById = new Map(docItems.filter((item) => item.status === "invalid" && ID_PATTERN.test(item.id) && !item.key.includes("#")).map((item) => [item.id, item]));

  // --- Plantillas ------------------------------------------------------------------------------------------------
  const seenTemplateIds = new Set<string>();
  const seenTemplateFiles = new Set<string>();
  const standalone: LibraryImportItem[] = [];
  const templateRowsOfDoc = new Map<string, LibraryTemplateRow[]>();
  const blankRow = (id: string, name: string, reason: LibraryInvalidReason): LibraryTemplateRow => ({ id, name, status: "invalid", reason });
  const standaloneItem = (key: string, row: LibraryTemplateRow): LibraryImportItem => ({
    key,
    kind: "template",
    status: "new",
    id: row.id,
    name: row.name,
    docType: "",
    pageCount: 0,
    bytes: 0,
    templates: [row],
  });
  for (const [position, raw] of (rawIndexTemplates as unknown[]).entries()) {
    const placeholder = `#invalid-t${position + 1}`;
    const invalid = (key: string, id: string, name: string, reason: LibraryInvalidReason) => {
      const item = standaloneItem(key, blankRow(id, name, reason));
      standalone.push({ ...item, status: "invalid", reason });
    };
    if (!isRecord(raw)) {
      invalid(placeholder, placeholder, "", "invalidEntry");
      continue;
    }
    const rawId = own(raw, "id");
    const file = own(raw, "file");
    if (typeof rawId !== "string" || !ID_PATTERN.test(rawId)) {
      invalid(placeholder, placeholder, "", "invalidEntry");
      continue;
    }
    if (seenTemplateIds.has(rawId)) {
      invalid(`${rawId}#t${position + 1}`, rawId, "", "duplicateId");
      continue;
    }
    seenTemplateIds.add(rawId);
    if (typeof file !== "string" || !isTemplateFile(file) || seenTemplateFiles.has(file.toLowerCase())) {
      invalid(rawId, rawId, "", "invalidEntry");
      continue;
    }
    seenTemplateFiles.add(file.toLowerCase());
    const problem = templateProblem.get(file);
    if (problem) {
      invalid(rawId, rawId, "", problem === "json" ? "invalidEntry" : problem);
      continue;
    }
    const body = migratedTemplates.get(file);
    // `rev` no viaja: se le da 1 solo para pasar la validación (al guardar, el almacén pone la suya).
    const template = isRecord(body) ? parseTemplate({ ...body, rev: 1 }) : null;
    if (!template || template.id !== rawId) {
      invalid(rawId, rawId, "", "invalidEntry");
      continue;
    }
    const row: LibraryTemplateRow = { id: template.id, name: template.name, status: "new", template };
    if (template.documentId === null) {
      standalone.push(standaloneItem(rawId, row));
      continue;
    }
    const owner = docItemById.get(template.documentId);
    const ownerInPackage = seenIds.has(template.documentId);
    if (!owner) {
      // Referencia a un documento que no viene o que no se puede importar: no se guarda una plantilla huérfana.
      const brokenOwner = invalidDocById.get(template.documentId);
      if (brokenOwner) brokenOwner.templates.push(blankRow(rawId, template.name, "documentInvalid"));
      else invalid(rawId, rawId, template.name, ownerInPackage ? "documentInvalid" : "noDocument");
      continue;
    }
    const rows = templateRowsOfDoc.get(owner.id) ?? [];
    rows.push(row);
    templateRowsOfDoc.set(owner.id, rows);
  }
  // El mismo PDF bajo dos ids del paquete (p. ej. un contrato respaldado dos veces): se importa UNA vez. Los demas quedan
  // como «idénticos» (repetidos dentro del paquete) y sus plantillas pasan al primero. Sin esto, la escritura chocaba con
  // el PDF que acababa de crear (`conflict`) y TODO el modulo fallaba con «tus datos cambiaron».
  const firstWithPdf = new Map<string, LibraryImportItem>();
  for (const item of docItems) {
    if (item.status === "invalid") continue;
    const sha = (item.document as DocumentEntry).fingerprint.exact;
    const first = firstWithPdf.get(sha);
    if (!first) {
      firstWithPdf.set(sha, item);
      continue;
    }
    templateRowsOfDoc.set(first.id, [...(templateRowsOfDoc.get(first.id) ?? []), ...(templateRowsOfDoc.get(item.id) ?? [])]);
    templateRowsOfDoc.set(item.id, []);
    item.status = "identical";
    item.duplicateOf = { key: first.key, name: first.name };
  }
  for (const item of docItems) {
    if (item.status !== "invalid") item.templates = templateRowsOfDoc.get(item.id) ?? [];
  }

  // --- Clasificar contra la biblioteca actual ---------------------------------------------------------------------
  for (const item of docItems) {
    if (item.status === "invalid" || item.duplicateOf) continue;
    const document = item.document as DocumentEntry;
    const byHash = existingByHash.get(document.fingerprint.exact);
    const byId = existingById.get(document.id);
    const target = byHash ?? byId;
    if (!target) continue; // Nuevo
    const targetTemplates = templatesOfDoc(target.id);
    item.conflictWith = { id: target.id, name: target.name, rev: target.rev, bytes: target.byteLength, templates: targetTemplates.length };
    let changes = false;
    let additions = false;
    item.templates = item.templates.map((row): LibraryTemplateRow => {
      const template = row.template as DocTemplate;
      if (targetTemplates.some((owned) => sameTemplateContent(owned, template))) return { ...row, status: "identical" };
      const sameId = existingTemplateById.get(template.id);
      if (sameId && sameId.documentId === target.id) {
        changes = true;
        return { ...row, status: "different", conflict: { id: sameId.id, rev: sameId.rev } };
      }
      additions = true;
      return row;
    });
    if (byHash) {
      if (!changes && !additions) item.status = "identical";
      else {
        item.status = "different";
        item.difference = "templates";
        item.changesTemplates = changes;
      }
    } else {
      item.status = "different";
      item.difference = "pdf";
    }
  }
  for (const item of standalone) {
    if (item.status === "invalid") continue;
    const row = item.templates[0];
    const template = row.template as DocTemplate;
    const sameId = existingTemplateById.get(template.id);
    if (detachedTemplates.some((owned) => sameTemplateContent(owned, template)) || (sameId && sameId.documentId === null && sameTemplateContent(sameId, template))) {
      item.status = "identical";
      row.status = "identical";
    } else if (sameId && sameId.documentId === null) {
      item.status = "different";
      item.difference = "templates";
      item.changesTemplates = true;
      row.status = "different";
      row.conflict = { id: sameId.id, rev: sameId.rev };
    }
  }

  // --- Puerta de entrada de cada PDF que se importaría -----------------------------------------------------------
  if (options.validatePdf) {
    for (const item of docItems) {
      if (item.status === "invalid" || item.status === "identical") continue;
      let ok = false;
      try {
        ok = await options.validatePdf(item.pdf as Uint8Array);
      } catch {
        ok = false;
      }
      if (!ok) {
        item.status = "invalid";
        item.reason = "invalidPdf";
        delete item.difference;
        delete item.conflictWith;
        delete item.document;
        delete item.pdf;
        item.templates = (templateRowsOfDoc.get(item.id) ?? []).map((row) => blankRow(row.id, row.name, "documentInvalid"));
      }
    }
  }
  // Si el PDF que se importaria no pasa la puerta, su copia repetida tampoco.
  for (const item of docItems) {
    if (!item.duplicateOf) continue;
    const first = docItems.find((candidate) => candidate.key === item.duplicateOf?.key);
    if (first?.status === "invalid") {
      item.status = "invalid";
      item.reason = first.reason ?? "invalidPdf";
      delete item.duplicateOf;
      delete item.document;
      delete item.pdf;
    }
  }
  plan.items = [...docItems, ...standalone];
  // Un PDF repetido dentro del paquete no es otro elemento («ya lo tienes» seria falso): no suma a ningun recuento.
  for (const item of plan.items) if (!item.duplicateOf) plan.counts[item.status] += 1;
  issuedPlans.add(plan);
  return deepFreeze(plan);
}

function isTemplateFile(path: string): boolean {
  const match = TEMPLATE_FILE.exec(path);
  return match !== null && !RESERVED_TEMPLATE_FILES.has(match[1].toLowerCase());
}

// ---------------------------------------------------------------------------
// Decisiones
// ---------------------------------------------------------------------------

/**
 * Lo que la interfaz puede ofrecer para un elemento según su estado: lo nuevo se importa; lo idéntico y lo inválido no
 * ofrecen nada (se omiten); lo distinto de PDF permite reemplazar / conservar ambos; el mismo PDF con plantillas
 * distintas permite «Añadir» si solo trae plantillas nuevas, o reemplazar / conservar ambas si alguna cambia.
 */
export function libraryDecisionOptions(item: Pick<LibraryImportItem, "status" | "difference" | "changesTemplates">): LibraryDecision[] {
  if (item.status === "new") return ["import", "omit"];
  if (item.status !== "different") return [];
  if (item.difference === "templates" && item.changesTemplates !== true) return ["import", "omit"];
  return ["replace", "keepBoth", "omit"];
}

/**
 * Decisión sugerida: lo nuevo se importa; lo distinto NUNCA pierde nada por defecto (otro PDF con el mismo id → conservar
 * ambos; plantillas nuevas de un PDF que ya tienes → añadirlas; plantillas cambiadas → dejar las tuyas); lo idéntico y lo
 * inválido se omiten.
 */
export function defaultLibraryDecisions(plan: LibraryPlan): Record<string, LibraryDecision> {
  const out: Record<string, LibraryDecision> = {};
  for (const item of plan.items) {
    if (item.status === "new") out[item.key] = "import";
    else if (item.status === "different") {
      out[item.key] =
        item.difference === "pdf" ? "keepBoth" : item.changesTemplates === true ? "omit" : "import";
    } else out[item.key] = "omit";
  }
  return out;
}

type Decisions = Record<string, LibraryDecision | undefined>;
type Approved = { item: LibraryImportItem; decision: "import" | "replace" | "keepBoth" };

/** Solo cuenta lo APROBADO explícitamente y coherente con el estado del elemento. */
function approvedItems(plan: LibraryPlan, decisions: Decisions): Approved[] {
  const out: Approved[] = [];
  const claimedTargets = new Set<string>();
  for (const item of plan.items) {
    const decision = Object.hasOwn(decisions, item.key) ? decisions[item.key] : undefined;
    if (decision === undefined || decision === "omit") continue;
    if (!libraryDecisionOptions(item).includes(decision)) continue;
    if (item.status === "invalid" || item.status === "identical") continue;
    // Un destino solo se toca una vez: el segundo elemento que lo reclama se queda sin aprobar.
    if (decision === "replace" && item.conflictWith) {
      const target = `${item.kind}:${item.conflictWith.id}`;
      if (claimedTargets.has(target)) continue;
      claimedTargets.add(target);
    }
    out.push({ item, decision });
  }
  return out;
}

type Writes = {
  createsDocument: boolean;
  replacesPdf: boolean;
  pdfBytes: number;
  adds: LibraryTemplateRow[];
  replaces: LibraryTemplateRow[];
  /** Documento existente al que se añaden plantillas (id) o `null`. */
  intoDocument: string | null;
};

/** Qué escribiría un elemento aprobado (única fuente para los límites y para aplicar). */
function writesOf({ item, decision }: Approved): Writes {
  const valid = item.templates.filter((row) => row.status !== "invalid" && row.template);
  if (item.kind === "template") {
    const row = item.templates[0];
    return decision === "replace"
      ? { createsDocument: false, replacesPdf: false, pdfBytes: 0, adds: [], replaces: [row], intoDocument: null }
      : { createsDocument: false, replacesPdf: false, pdfBytes: 0, adds: [row], replaces: [], intoDocument: null };
  }
  if (item.status === "new" || (item.difference === "pdf" && decision === "keepBoth")) {
    return { createsDocument: true, replacesPdf: false, pdfBytes: item.bytes, adds: valid, replaces: [], intoDocument: null };
  }
  if (item.difference === "pdf") {
    // Reemplazar: el documento tuyo toma el PDF del paquete; sus plantillas se fusionan.
    return {
      createsDocument: false,
      replacesPdf: true,
      pdfBytes: item.bytes - (item.conflictWith?.bytes ?? 0),
      adds: valid.filter((row) => row.status === "new"),
      replaces: valid.filter((row) => row.status === "different"),
      intoDocument: item.conflictWith?.id ?? null,
    };
  }
  // Mismo PDF, plantillas distintas.
  const pending = valid.filter((row) => row.status !== "identical");
  if (decision === "replace") {
    return {
      createsDocument: false,
      replacesPdf: false,
      pdfBytes: 0,
      adds: pending.filter((row) => row.status === "new"),
      replaces: pending.filter((row) => row.status === "different"),
      intoDocument: item.conflictWith?.id ?? null,
    };
  }
  return { createsDocument: false, replacesPdf: false, pdfBytes: 0, adds: pending, replaces: [], intoDocument: item.conflictWith?.id ?? null };
}

// ---------------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------------

export type LibraryLimitBlock = "documents" | "bytes" | "templates" | "perDocument" | "quota";

export type LibraryLimitCheck = {
  /** Elementos aprobados que escriben algo. */
  wanted: number;
  /** Cuántos de ellos caben (en orden) en los límites de la biblioteca y en el espacio del navegador. */
  fits: number;
  ok: boolean;
  documentsAfter: number;
  bytesAfter: number;
  templatesAfter: number;
  /** Qué límite frena al primer elemento que no cabe. */
  blockedBy?: LibraryLimitBlock;
  /** Documentos / plantillas / bytes que se añadirían (de los que caben). */
  addedDocuments: number;
  addedTemplates: number;
  addedBytes: number;
};

/**
 * Cuántos de los elementos aprobados caben (50 documentos, 400 MB, 200 plantillas, 20 por documento y el espacio libre
 * que dice el navegador) ANTES de escribir nada. `ok` solo si caben todos.
 */
export function checkLibraryLimits(plan: LibraryPlan, decisions: Decisions): LibraryLimitCheck {
  const { limits } = plan;
  let documents = limits.currentDocuments;
  let bytes = limits.currentBytes;
  let templates = limits.currentTemplates;
  let addedBytes = 0;
  let addedDocuments = 0;
  let addedTemplates = 0;
  const perDocument: Record<string, number> = { ...limits.templatesByDocument };
  const room = limits.browser ? Math.max(0, limits.browser.quota - limits.browser.usage) : Infinity;
  let fits = 0;
  let blockedBy: LibraryLimitBlock | undefined;
  const approved = approvedItems(plan, decisions);
  for (const entry of approved) {
    const writes = writesOf(entry);
    const nextDocuments = documents + (writes.createsDocument ? 1 : 0);
    const nextBytes = bytes + writes.pdfBytes;
    const nextTemplates = templates + writes.adds.length;
    const into = writes.intoDocument;
    const nextPerDocument = writes.createsDocument ? writes.adds.length : into !== null ? (perDocument[into] ?? 0) + writes.adds.length : 0;
    let blocked: LibraryLimitBlock | undefined;
    if (nextDocuments > limits.maxDocuments) blocked = "documents";
    else if (nextBytes > limits.maxTotalBytes) blocked = "bytes";
    else if (nextTemplates > limits.maxTemplates) blocked = "templates";
    else if (writes.adds.length > 0 && nextPerDocument > limits.maxTemplatesPerDocument && (writes.createsDocument || into !== null)) blocked = "perDocument";
    else if (addedBytes + Math.max(0, writes.pdfBytes) > room) blocked = "quota";
    if (blocked) {
      blockedBy = blockedBy ?? blocked;
      continue;
    }
    documents = nextDocuments;
    bytes = nextBytes;
    templates = nextTemplates;
    if (into !== null) perDocument[into] = nextPerDocument;
    addedBytes += Math.max(0, writes.pdfBytes);
    addedDocuments += writes.createsDocument ? 1 : 0;
    addedTemplates += writes.adds.length;
    fits += 1;
  }
  return {
    wanted: approved.length,
    fits,
    ok: fits === approved.length,
    documentsAfter: documents,
    bytesAfter: bytes,
    templatesAfter: templates,
    ...(blockedBy ? { blockedBy } : {}),
    addedDocuments,
    addedTemplates,
    addedBytes,
  };
}

// ---------------------------------------------------------------------------
// Aplicar
// ---------------------------------------------------------------------------

export type ApplyLibraryResult =
  | {
      ok: true;
      documents: number;
      documentsReplaced: number;
      templates: number;
      templatesReplaced: number;
      /** Elementos del plan que no se tocaron (omitidos, idénticos o inválidos). */
      skipped: number;
      /** Ids ocupados que se reasignaron. */
      reassigned: number;
    }
  | {
      ok: false;
      reason: "limit" | "quota" | "unavailable" | "invalid" | "blocked" | "changed" | "failed";
      fits?: number;
      wanted?: number;
    };

/** Revalida lo que el plan dice que se escribiría (el plan puede venir de la interfaz): esquema, PDF, huella. */
async function revalidate({ item }: Approved): Promise<boolean> {
  if (item.kind === "document") {
    const document = item.document;
    const pdf = item.pdf;
    if (!document || !isBytes(pdf)) return false;
    const revived = deserializeLibrary({ schemaVersion: 1, documents: [{ ...serializeLibrary([{ ...document, rev: 1 }]).documents[0], templateIds: [] }] });
    if (!revived.ok || revived.documents.length !== 1) return false;
    if (pdf.length === 0 || pdf.length > LIBRARY_LIMITS.maxDocumentBytes || pdf.length !== item.bytes || !hasPdfHeader(pdf)) return false;
    if ((await sha256Hex(pdf)) !== document.fingerprint.exact) return false;
  }
  for (const row of item.templates) {
    if (row.status === "invalid") continue;
    if (!row.template || parseTemplate(row.template) === null) return false;
  }
  return item.kind !== "template" || (item.templates.length === 1 && item.templates[0].template !== undefined);
}

function replaceOf(row: LibraryTemplateRow): CommitTemplateReplace {
  return { template: row.template as DocTemplate, targetId: (row.conflict as { id: string }).id, expectRev: (row.conflict as { rev: number }).rev };
}

/**
 * Escribe en la biblioteca SOLO lo que `decisions` aprueba y de forma ATÓMICA (una transacción de IndexedDB: todo o
 * nada). Si no caben todos los aprobados no se escribe NINGUNO y se informa de cuántos caben; un fallo de cuota o de
 * IndexedDB deja la biblioteca como estaba; si lo que se iba a reemplazar cambió desde la vista previa (otra pestaña),
 * `changed` y tampoco se escribe nada. Los ids ocupados se reasignan; los vínculos documento↔plantilla y el aviso de
 * «plantilla desactualizada» se recalculan.
 */
export async function applyLibraryImport(plan: LibraryPlan, decisions: Decisions): Promise<ApplyLibraryResult> {
  if (typeof plan !== "object" || plan === null || !issuedPlans.has(plan)) return { ok: false, reason: "invalid" };
  if (plan.state !== "ok") return { ok: false, reason: "blocked" };
  const approved = approvedItems(plan, decisions);
  if (approved.length === 0) {
    return { ok: true, documents: 0, documentsReplaced: 0, templates: 0, templatesReplaced: 0, skipped: plan.items.length, reassigned: 0 };
  }
  for (const entry of approved) {
    if (!(await revalidate(entry))) return { ok: false, reason: "invalid" };
  }
  const check = checkLibraryLimits(plan, decisions);
  if (!check.ok) {
    return { ok: false, reason: check.blockedBy === "quota" ? "quota" : "limit", fits: check.fits, wanted: check.wanted };
  }

  const ops: CommitDocOp[] = approved.map((entry): CommitDocOp => {
    const { item } = entry;
    const writes = writesOf(entry);
    const adds = writes.adds.map((row) => row.template as DocTemplate);
    const replaces = writes.replaces.map(replaceOf);
    if (item.kind === "template") return { kind: "detached", adds, replaces };
    if (writes.createsDocument) {
      return { kind: "create", entry: item.document as DocumentEntry, pdf: item.pdf as Uint8Array, adds };
    }
    const target = item.conflictWith as NonNullable<LibraryImportItem["conflictWith"]>;
    if (writes.replacesPdf) {
      return {
        kind: "replace",
        targetId: target.id,
        expectRev: target.rev,
        entry: item.document as DocumentEntry,
        pdf: item.pdf as Uint8Array,
        adds,
        replaces,
      };
    }
    return { kind: "templates", targetId: target.id, expectRev: target.rev, adds, replaces };
  });

  const result = await commitLibraryImport(ops);
  if (!result.ok) return { ok: false, reason: result.reason, ...(result.reason === "limit" ? { fits: 0, wanted: check.wanted } : {}) };
  return {
    ok: true,
    documents: result.documentsCreated,
    documentsReplaced: result.documentsReplaced,
    templates: result.templatesAdded,
    templatesReplaced: result.templatesReplaced,
    skipped: plan.items.length - approved.length,
    reassigned: result.reassigned,
  };
}
