import { errorKeyOf, looksLikePdf, newDocumentId, replaceVerdict, suggestedName, type ErrorKey, type ReplaceVerdict } from "@/app/documents/documentsModel";
import { computeFingerprint } from "@/lib/docLibrary/fingerprint";
import {
  deleteDocument,
  markTemplatesCurrent,
  putDocument,
  renameDocument,
  replaceDocumentBytes,
  requestPersistence,
} from "@/lib/docLibrary/store";
import type { DocumentEntry } from "@/lib/docLibrary/types";

/**
 * Acciones de «Mis documentos» sobre la biblioteca (U2.5). Ninguna lanza: devuelven `{ ok:false, error }` con la clave de
 * texto (`documents.error*`) para que la interfaz lo diga con claridad. Sin red: todo ocurre en este navegador.
 */
export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: ErrorKey };

const fail = (error: unknown): { ok: false; error: ErrorKey } => ({ ok: false, error: errorKeyOf(error) });

async function readPdf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export type NewDocument = { file: File; name: string; docType: string };

/**
 * Guarda un contrato en la biblioteca: lee los bytes, calcula la huella (en un worker) y escribe entrada y copia en UNA
 * transaccion. Si era el primer documento pide el almacenamiento persistente (el resultado se ve luego en la pagina).
 */
export async function addDocument(input: NewDocument, existingCount: number): Promise<ActionResult<DocumentEntry>> {
  try {
    if (!looksLikePdf(input.file)) return { ok: false, error: "errorNotPdf" };
    const bytes = await readPdf(input.file);
    const fingerprint = await computeFingerprint(bytes);
    const name = input.name.trim() || suggestedName(input.file.name) || input.file.name;
    const entry = await putDocument(
      {
        id: newDocumentId(),
        name,
        docType: input.docType.trim(),
        fileName: input.file.name,
        pageCount: fingerprint.pageCount,
        pageSizes: fingerprint.pageSizes,
        fingerprint,
        templateIds: [],
      },
      bytes,
    );
    if (existingCount === 0) await requestPersistence();
    return { ok: true, value: entry };
  } catch (error) {
    return fail(error);
  }
}

export async function renameDoc(doc: DocumentEntry, name: string): Promise<ActionResult<DocumentEntry>> {
  try {
    return { ok: true, value: await renameDocument(doc.id, name.trim(), { expectedRev: doc.rev }) };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteDoc(doc: DocumentEntry): Promise<ActionResult> {
  try {
    await deleteDocument(doc.id, { expectedRev: doc.rev });
    return { ok: true, value: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** «Esta plantilla sigue valiendo»: quita el aviso de «desactualizada» del documento (la plantilla no cambia). */
export async function keepTemplate(doc: DocumentEntry): Promise<ActionResult<DocumentEntry>> {
  try {
    return { ok: true, value: await markTemplatesCurrent(doc.id, { expectedRev: doc.rev }) };
  } catch (error) {
    return fail(error);
  }
}

/** Reemplaza el PDF base (recalcula la huella). Avisa si la plantilla ya no cuadra con el PDF nuevo. */
export async function replaceDoc(
  doc: DocumentEntry,
  file: File,
  hasTemplate: boolean,
): Promise<ActionResult<{ entry: DocumentEntry; verdict: ReplaceVerdict }>> {
  try {
    if (!looksLikePdf(file)) return { ok: false, error: "errorNotPdf" };
    const entry = await replaceDocumentBytes(doc.id, await readPdf(file), { expectedRev: doc.rev, fileName: file.name });
    // Se compara con el PDF sobre el que se configuro la plantilla (si ya estaba desactualizada, no con el reemplazo anterior).
    return { ok: true, value: { entry, verdict: replaceVerdict(doc.templateStale?.base ?? doc.fingerprint, entry.fingerprint, hasTemplate) } };
  } catch (error) {
    return fail(error);
  }
}
