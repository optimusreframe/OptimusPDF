/**
 * Limites de Sign PDF en un modulo sin React ni pdf.js, para que lo importen
 * por igual los componentes (`SignerManager`), los modulos de datos
 * (`signTemplates`, `docSet`) y los tests sin arrastrar un arbol de UI.
 */

/**
 * Firmantes que se pueden DAR DE ALTA en una ronda. Es un limite de producto,
 * no de paleta: `SIGNER_COLORS` sigue teniendo seis colores (`SOLO_COLOR`
 * depende del indice 4) y no se acorta.
 *
 * Solo limita el alta. Un borrador, una configuracion importada o una
 * plantilla que ya traiga mas firmantes se conserva intacto: perder gente en
 * silencio es peor que tolerar un dato heredado.
 */
export const MAX_SIGNERS = 2;

/** Documentos a la vez en una misma ronda. */
export const MAX_DOCUMENTS = 10;

/**
 * Copias por documento (1..5) y archivos que entrega una ronda contando las copias (50 = 10 documentos x 5 copias).
 * Viven en `signCopies.ts` (sin dependencias, lo usa tambien el motor del ZIP) y se reexportan aqui con el resto de topes.
 */
export { MAX_COPIES, MAX_OUTPUT_FILES } from "@/lib/pdf/signCopies";

/** Tope por documento (el mismo de `FileDropzone`: `MAX_SAFE_FILE_SIZE`). */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** Tope de la suma de todos los documentos de la ronda. */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export type RejectReason =
  /** Pesa mas que `MAX_DOCUMENT_BYTES`. */
  | "size"
  /** La ronda ya tiene `MAX_DOCUMENTS`. */
  | "count"
  /** Con el, la ronda pasaria de `MAX_TOTAL_BYTES`. */
  | "total";

export type DocumentAdmission<T> = {
  accepted: T[];
  rejected: { file: T; reason: RejectReason }[];
};

/**
 * Decide cuales de los `incoming` caben en la ronda que ya tiene `current`.
 * Se miran en orden de llegada y cada uno se juzga con lo ya admitido: lo que
 * no cabe se devuelve con su motivo para avisarlo con amabilidad. Un archivo
 * que sobrepasa el tope por documento nunca entra (aunque fuera el unico).
 */
export function admitDocuments<T extends { size: number }>(
  current: readonly T[],
  incoming: readonly T[],
  limits: {
    maxDocuments?: number;
    maxDocumentBytes?: number;
    maxTotalBytes?: number;
  } = {},
): DocumentAdmission<T> {
  const maxDocuments = limits.maxDocuments ?? MAX_DOCUMENTS;
  const maxDocumentBytes = limits.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const accepted: T[] = [];
  const rejected: DocumentAdmission<T>["rejected"] = [];
  let count = current.length;
  let total = current.reduce((sum, file) => sum + file.size, 0);
  for (const file of incoming) {
    if (file.size > maxDocumentBytes) {
      rejected.push({ file, reason: "size" });
    } else if (count >= maxDocuments) {
      rejected.push({ file, reason: "count" });
    } else if (total + file.size > maxTotalBytes) {
      rejected.push({ file, reason: "total" });
    } else {
      accepted.push(file);
      count += 1;
      total += file.size;
    }
  }
  return { accepted, rejected };
}

/**
 * Cuantos documentos del PRINCIPIO de la cola caben en una ronda (los primeros
 * que quepan, en orden: se para en el primero que no cabe, para no saltarse un
 * documento y dejar la cola con huecos). Se usa al restaurar una sesion o una
 * configuracion que traiga mas de lo que admite la herramienta.
 */
export function fitDocumentPrefix(
  items: readonly { size: number }[],
  limits: Parameters<typeof admitDocuments>[2] = {},
): number {
  const accepted: { size: number }[] = [];
  for (const item of items) {
    const result = admitDocuments(accepted, [item], limits);
    if (result.accepted.length === 0) break;
    accepted.push(item);
  }
  return accepted.length;
}
