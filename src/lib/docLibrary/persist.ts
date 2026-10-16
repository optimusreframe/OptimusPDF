import { MINHASH_SIZE } from "./fingerprintCore";
import { isRecord, parseDocumentEntry } from "./schema";
import type { DocumentInput } from "./store";
import { own, parseTemplate } from "./templateSchema";
import { TEMPLATE_LIMITS, type DocTemplate } from "./templateTypes";
import { LIBRARY_LIMITS, type DocumentEntry, type Fingerprint, type PageFingerprint } from "./types";

/**
 * Módulo «Plantillas + Documentos» del OptimusPDF Package, parte de DATOS (U2.1). Funciones PURAS (sin IndexedDB, sin
 * zip): el contenedor lo hace U4.5. Aquí solo se decide QUÉ viaja y se VALIDA lo que vuelve.
 *
 * Qué viaja por documento: id, nombre, tipo, archivo, páginas, tamaños, huella (el MinHash va en base64: 684
 * caracteres en vez de ~1 300), fechas, ids de plantillas y `byteLength` (0 = no hay copia del PDF; la copia, si la
 * hay, viaja como archivo aparte del paquete y U4.5 la pasa a `putDocument`). `rev` NO viaja: es de cada navegador.
 *
 * Límites de lectura: texto de entrada ≤ 32 MiB, ≤ 50 documentos, ids únicos, cada documento pasa la MISMA validación
 * estricta que las lecturas de IndexedDB. Un documento inválido NO invalida el resto: se omite con un aviso.
 *
 * PLANTILLAS (U2.2). El formato sigue siendo el `schemaVersion: 1` de U2.1: las plantillas viajan en una clave
 * OPCIONAL nueva `templates` (con su propio `templatesSchemaVersion: 1`). Así un paquete de U2.1 (sin esa clave) se
 * lee idéntico, y un lector de U2.1 que reciba un paquete con plantillas lee los documentos e ignora la clave. Sin
 * plantillas, `serializeLibrary` produce EXACTAMENTE los mismos bytes que antes. Cada plantilla (sin `rev` ni historial)
 * pasa `parseTemplate` (listas blancas, longitudes, rectángulos dentro de 0..1, ≤ 500 campos por variante, `Object.hasOwn`);
 * una plantilla inválida se omite con aviso y el resto sigue; ≤ 200 plantillas.
 */

export const LIBRARY_EXPORT_SCHEMA = 1;
/** Versión del bloque `templates` del paquete. */
export const TEMPLATES_EXPORT_SCHEMA = 1;
/** Tamaño máximo del JSON de la biblioteca al importar (documentos ≈ 7 MB en el peor caso + plantillas; 32 MiB deja holgura). */
export const MAX_LIBRARY_JSON_BYTES = 32 * 1024 * 1024;

export type SerializedPage = { textHash: string; minhash: string; dhash?: string };
export type SerializedFingerprint = Omit<Fingerprint, "pages"> & { pages: SerializedPage[] };
export type SerializedDocument = Omit<DocumentEntry, "fingerprint" | "rev"> & { fingerprint: SerializedFingerprint };
/** Una plantilla exportada: todo menos `rev` (propio de cada navegador) y el historial de versiones. */
export type SerializedTemplate = Omit<DocTemplate, "rev">;
export type SerializedLibrary = {
  schemaVersion: typeof LIBRARY_EXPORT_SCHEMA;
  documents: SerializedDocument[];
  /** Solo si se exportaron plantillas. */
  templatesSchemaVersion?: typeof TEMPLATES_EXPORT_SCHEMA;
  templates?: SerializedTemplate[];
};

export type ImportWarning =
  | { code: "invalidDocument"; index: number }
  | { code: "duplicateId"; index: number }
  | { code: "tooManyDocuments"; kept: number }
  | { code: "invalidTemplate"; index: number }
  | { code: "duplicateTemplateId"; index: number }
  | { code: "tooManyTemplates"; kept: number }
  /** El paquete trae plantillas de un formato más nuevo que este lector: se ignoran. */
  | { code: "newerTemplatesVersion" };

export type DeserializeResult =
  | { ok: true; documents: DocumentEntry[]; warnings: ImportWarning[]; templates: DocTemplate[] }
  | { ok: false; reason: "tooLarge" | "invalidJson" | "invalidFormat" | "newerVersion" };

function toBase64(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x2000));
  }
  return btoa(binary);
}

function fromBase64(text: string): number[] | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length > 4 * Math.ceil((MINHASH_SIZE * 4) / 3) + 4) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  if (binary.length !== MINHASH_SIZE * 4) return null;
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) view.setUint8(index, binary.charCodeAt(index));
  const out: number[] = [];
  for (let index = 0; index < MINHASH_SIZE; index += 1) out.push(view.getUint32(index * 4, true));
  return out;
}

function serializePage(page: PageFingerprint): SerializedPage {
  const out: SerializedPage = { textHash: page.textHash, minhash: page.minhash.length === 0 ? "" : toBase64(page.minhash) };
  if (page.dhash !== undefined) out.dhash = page.dhash;
  return out;
}

/** Una plantilla como dato JSON-seguro: sin `rev` y sin historial (aunque llegue con él). */
export function serializeTemplate(template: DocTemplate): SerializedTemplate {
  const { rev, ...rest } = template;
  void rev;
  const { history, ...clean } = rest as typeof rest & { history?: unknown };
  void history;
  return clean;
}

/**
 * Los documentos de la biblioteca como datos JSON-seguros (sin `rev`, sin bytes). Mantiene el orden dado. Con `templates`
 * (no vacías) añade el bloque `templates`; sin ellas el resultado es el de siempre.
 */
export function serializeLibrary(entries: readonly DocumentEntry[], templates?: readonly DocTemplate[]): SerializedLibrary {
  const out: SerializedLibrary = {
    schemaVersion: LIBRARY_EXPORT_SCHEMA,
    documents: entries.map((entry) => {
      const { fingerprint, ...rest } = entry;
      const withoutRev: Omit<DocumentEntry, "fingerprint" | "rev"> & { rev?: number } = rest;
      delete withoutRev.rev;
      return { ...withoutRev, fingerprint: { ...fingerprint, pages: fingerprint.pages.map(serializePage) } };
    }),
  };
  if (templates && templates.length > 0) {
    out.templatesSchemaVersion = TEMPLATES_EXPORT_SCHEMA;
    out.templates = templates.map(serializeTemplate);
  }
  return out;
}

/** `serializeLibrary` ya convertido a texto JSON. */
export function serializeLibraryJson(entries: readonly DocumentEntry[], templates?: readonly DocTemplate[]): string {
  return JSON.stringify(serializeLibrary(entries, templates));
}

function reviveTemplates(data: Record<string, unknown>, warnings: ImportWarning[]): DocTemplate[] {
  const raw = own(data, "templates");
  if (raw === undefined) return [];
  const version = own(data, "templatesSchemaVersion");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    warnings.push({ code: "invalidTemplate", index: -1 });
    return [];
  }
  if (version > TEMPLATES_EXPORT_SCHEMA) {
    warnings.push({ code: "newerTemplatesVersion" });
    return [];
  }
  if (!Array.isArray(raw)) {
    warnings.push({ code: "invalidTemplate", index: -1 });
    return [];
  }
  const templates: DocTemplate[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index: number) => {
    if (templates.length >= TEMPLATE_LIMITS.maxTemplates) return;
    // `rev` no viaja: se le da 1 solo para pasar la validación; al guardar, el almacén pone la suya. El historial no se importa.
    const template = isRecord(item) ? parseTemplate({ ...item, rev: 1 }) : null;
    if (!template) {
      warnings.push({ code: "invalidTemplate", index });
      return;
    }
    if (seen.has(template.id)) {
      warnings.push({ code: "duplicateTemplateId", index });
      return;
    }
    seen.add(template.id);
    templates.push(template);
  });
  if (raw.length > TEMPLATE_LIMITS.maxTemplates) warnings.push({ code: "tooManyTemplates", kept: templates.length });
  return templates;
}

function revive(raw: unknown): DocumentEntry | null {
  if (!isRecord(raw) || !isRecord(raw.fingerprint) || !Array.isArray(raw.fingerprint.pages)) return null;
  const pages: unknown[] = [];
  for (const page of raw.fingerprint.pages) {
    if (!isRecord(page) || typeof page.minhash !== "string") return null;
    const minhash = page.minhash === "" ? [] : fromBase64(page.minhash);
    if (!minhash) return null;
    pages.push({ textHash: page.textHash, minhash, ...(page.dhash === undefined ? {} : { dhash: page.dhash }) });
  }
  // `rev` no viaja: se le da 1 solo para pasar la validación; al guardar, el almacén pone la suya.
  return parseDocumentEntry({ ...raw, rev: 1, fingerprint: { ...raw.fingerprint, pages } });
}

/**
 * Valida y reconstruye los documentos de un módulo importado (objeto ya parseado o texto JSON). Nunca lanza.
 * `ok: false` solo si TODO el módulo es inservible; un documento malo se omite con un aviso.
 */
export function deserializeLibrary(input: unknown): DeserializeResult {
  let data = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > MAX_LIBRARY_JSON_BYTES) return { ok: false, reason: "tooLarge" };
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, reason: "invalidJson" };
    }
  }
  if (!isRecord(data)) return { ok: false, reason: "invalidFormat" };
  if (typeof data.schemaVersion !== "number" || !Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
    return { ok: false, reason: "invalidFormat" };
  }
  if (data.schemaVersion > LIBRARY_EXPORT_SCHEMA) return { ok: false, reason: "newerVersion" };
  if (!Array.isArray(data.documents)) return { ok: false, reason: "invalidFormat" };

  const warnings: ImportWarning[] = [];
  const documents: DocumentEntry[] = [];
  const seen = new Set<string>();
  data.documents.forEach((raw: unknown, index: number) => {
    if (documents.length >= LIBRARY_LIMITS.maxDocuments) return;
    const entry = revive(raw);
    if (!entry) {
      warnings.push({ code: "invalidDocument", index });
      return;
    }
    if (seen.has(entry.id)) {
      warnings.push({ code: "duplicateId", index });
      return;
    }
    seen.add(entry.id);
    documents.push(entry);
  });
  if (data.documents.length > LIBRARY_LIMITS.maxDocuments) {
    warnings.push({ code: "tooManyDocuments", kept: documents.length });
  }
  const templates = reviveTemplates(data, warnings);
  return { ok: true, documents, warnings, templates };
}

/** Lo que hay que pasar a `putDocument` para restaurar un documento importado (conserva `createdAt`; usar `updatedAt` de la entrada). */
export function toDocumentInput(entry: DocumentEntry): DocumentInput {
  return {
    id: entry.id,
    name: entry.name,
    docType: entry.docType,
    fileName: entry.fileName,
    pageCount: entry.pageCount,
    pageSizes: entry.pageSizes,
    fingerprint: entry.fingerprint,
    templateIds: entry.templateIds,
    ...(entry.templateStale ? { templateStale: entry.templateStale } : {}),
    createdAt: entry.createdAt,
  };
}
