import { IDBFactory } from "fake-indexeddb";
import { sha256Hex } from "@/lib/crypto/sha256";
import { __resetLibraryForTests, getDocumentBytes, listDocuments, putDocument } from "@/lib/docLibrary/store";
import { listTemplates, createTemplate } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { sampleDraft, signField, variantOf } from "@/lib/docLibrary/testing/templateSamples";
import type { TemplateDraft } from "@/lib/docLibrary/templateTypes";
import type { DocumentEntry, Fingerprint } from "@/lib/docLibrary/types";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  type LibraryPlan,
  type LibraryPlanOptions,
} from "@/lib/backup/modules/library";

/**
 * Utilidades SOLO de pruebas del módulo «library»: biblioteca falsa nueva, PDF «de mentira» con encabezado `%PDF-` y la
 * huella que dice el SHA-256 de sus bytes, y atajos para exportar, leer y planificar.
 */

/*
 * jsdom + fake-indexeddb: el clon estructurado devuelve un `Uint8Array` del dominio de Node. Solo para estas pruebas,
 * `instanceof` reconoce cualquier `Uint8Array` por su etiqueta (mismo ajuste que `documents.testkit.ts`).
 */
if (typeof window !== "undefined") {
  Object.defineProperty(Uint8Array, Symbol.hasInstance, {
    configurable: true,
    value: (value: unknown) => Object.prototype.toString.call(value) === "[object Uint8Array]",
  });
}

export function freshLibrary(): void {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
}

/** Bytes que parecen un PDF (la prueba usa una puerta falsa; el SHA-256 sí es el de verdad). */
export function fakePdf(seed: number, size = 200): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  bytes.set(new TextEncoder().encode(`%PDF-1.7\n% fake seed=${seed}\n`), 0);
  return bytes;
}

export async function fingerprintOf(bytes: Uint8Array, pages = 3, seed = 1): Promise<Fingerprint> {
  return { ...sampleFingerprint(pages, seed), exact: await sha256Hex(bytes) };
}

export type SeedDoc = { entry: DocumentEntry; bytes: Uint8Array };

/** Guarda un documento con su PDF y una huella coherente. */
export async function seedDoc(
  id: string,
  seed: number,
  options: { name?: string; size?: number; pages?: number; now?: () => Date } = {},
): Promise<SeedDoc> {
  const bytes = fakePdf(seed, options.size);
  const fingerprint = await fingerprintOf(bytes, options.pages ?? 3, seed);
  const entry = await putDocument(
    {
      id,
      name: options.name ?? `Contrato ${id}`,
      docType: "contrato de servicio",
      fileName: `${id}.pdf`,
      pageCount: fingerprint.pageCount,
      pageSizes: fingerprint.pageSizes,
      fingerprint,
      templateIds: [],
    },
    bytes,
    options.now ? { now: options.now } : {},
  );
  return { entry, bytes };
}

let templateCounter = 0;
export async function seedTemplate(documentId: string | null, overrides: Partial<TemplateDraft> = {}, id?: string) {
  templateCounter += 1;
  return createTemplate(sampleDraft(documentId, overrides), { newId: () => id ?? `tpl-kit-${templateCounter}` });
}

/** Otra plantilla distinta (una sola firma en la variante 1). */
export const singleSignerDraft: Partial<TemplateDraft> = {
  name: "Solo una firma",
  variants: { "1": variantOf([signField({ pageIndex: 1 })]), "2": variantOf([]) },
};

export async function exportBlob(password?: string): Promise<Blob> {
  const { module } = await exportLibraryWithReport();
  return buildPackage({ modules: [module], password });
}

export async function planOf(blob: Blob, options: LibraryPlanOptions = {}, password?: string): Promise<LibraryPlan> {
  const read = await readPackage(blob, password);
  return planLibraryImport(read, await loadLibraryExisting(), options);
}

/** Todo lo que hay en la biblioteca en una forma comparable (sin `rev` ni fechas de escritura). */
export async function snapshotLibrary() {
  const docs = (await listDocuments()).documents;
  const out: Array<Record<string, unknown>> = [];
  for (const doc of docs.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const bytes = await getDocumentBytes(doc.id);
    out.push({ ...doc, rev: undefined, bytesSha: bytes ? await sha256Hex(bytes) : null });
  }
  const templates = (await listTemplates()).templates.slice().sort((a, b) => a.id.localeCompare(b.id));
  return { documents: out, templates };
}

/** Cuenta los `put` que reciben los almacenes de IndexedDB mientras corre `work` (0 = no se escribió nada). */
export async function countWrites<T>(work: () => Promise<T>): Promise<{ result: T; writes: number }> {
  const original = IDBObjectStore.prototype.put;
  let writes = 0;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    writes += 1;
    return original.apply(this, args);
  };
  try {
    const result = await work();
    return { result, writes };
  } finally {
    IDBObjectStore.prototype.put = original;
  }
}
