import { withSuffix } from "@/lib/pdf/core";
import type { ProDocument } from "@/app/pdf-pro/proTypes";

/**
 * Reglas puras de «Descargar PDF» (Wave 7 · U8): como se llama el archivo y que avisos hay que dar ANTES de
 * descargarlo. Sin React ni navegador: `proSave.test.ts` las comprueba una a una.
 */

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Limpia lo que el usuario escribe como nombre: sin rutas ni caracteres prohibidos, y con `.pdf` al final. */
export function ensurePdfName(input: string): string {
  const cleaned = input.replace(ILLEGAL_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
  const withoutExt = cleaned.replace(/\.pdf$/i, "").replace(/^\.+/, "").trim();
  return withoutExt.length === 0 ? "" : `${withoutExt}.pdf`;
}

/**
 * Nombre de la descarga. Un nombre elegido en «Guardar como…» se respeta tal cual. Si no, `informe.pdf` →
 * `informe-pro.pdf` en cuanto el documento tiene cambios o historial (el archivo ya no es el original), y el
 * nombre original si se descarga tal cual se abrio.
 */
export function downloadFileName(
  document: Pick<ProDocument, "name" | "renamed" | "snapshots">,
  dirty: boolean,
): string {
  if (document.renamed) return ensurePdfName(document.name) || document.name;
  return dirty || document.snapshots.length > 1 ? withSuffix(document.name, "pro") : document.name;
}

export type SavePrompt = {
  /** Hay firmas digitales activas y cambios sin guardar: descargar las invalida. */
  signatures: boolean;
  /** El archivo estaba cifrado: la descarga sale sin contraseña. */
  decrypted: boolean;
};

/**
 * Que hay que confirmar antes de descargar. Las firmas solo importan con cambios sin guardar (descargar el
 * original intacto no las invalida). El aviso de la copia sin cifrar se da una vez por documento
 * (`decryptedAcknowledged`) para no repetirlo en cada descarga.
 */
export function savePrompt(
  document: Pick<ProDocument, "signatures" | "wasEncrypted">,
  dirty: boolean,
  decryptedAcknowledged: boolean,
): SavePrompt | null {
  const signatures = dirty && document.signatures === "active";
  const decrypted = document.wasEncrypted && !decryptedAcknowledged;
  return signatures || decrypted ? { signatures, decrypted } : null;
}
