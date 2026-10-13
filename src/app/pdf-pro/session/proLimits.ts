import { MAX_PRO_DRAFT_BYTES } from "@/app/pdf-pro/proDrafts";
import { PRO_MAX_SNAPSHOT_BYTES, residentBytes } from "@/app/pdf-pro/proWorkingDoc";
import type { ProDocument, ProWarning } from "@/app/pdf-pro/proTypes";

/**
 * Limites de tamaño y memoria de PDF Pro (Wave 7 · U8). Un solo sitio para los umbrales y para decidir que avisos
 * se muestran, con la misma fuente de verdad que el presupuesto de snapshots (`proWorkingDoc`) y el de borradores
 * (`proDrafts`).
 *
 *  - ≥ 100 MB: aviso «documento grande» (el motor ya lo acepta: `MAX_SAFE_FILE_SIZE` avisa pero no bloquea).
 *  - > 150 MB: ademas, sin borrador automatico (`MAX_PRO_DRAFT_BYTES`).
 *  - historial RESIDENTE en RAM ≥ 75 % del presupuesto de bytes de los snapshots: aviso de memoria (se descartaran
 *    los mas antiguos); lo volcado a disco (Wave 8) no cuenta.
 *  - el volcado a disco fallo (`historyOffloadFailed`): aviso de que el historial vive solo en memoria.
 */

export const PRO_LARGE_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const PRO_NO_DRAFT_BYTES = MAX_PRO_DRAFT_BYTES;
export const PRO_MEMORY_WARN_BYTES = Math.floor(PRO_MAX_SNAPSHOT_BYTES * 0.75);

/** «120 MB» / «1,2 GB» para los avisos (sin decimales por encima de 100 MB). */
export function formatLimitSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Avisos de tamaño y memoria del documento abierto (vacio si todo cabe sin problema). */
export function limitWarnings(document: ProDocument | null): ProWarning[] {
  if (!document) return [];
  const current = document.snapshots[document.cursor];
  if (!current) return [];
  const warnings: ProWarning[] = [];
  if (current.byteLength >= PRO_LARGE_DOCUMENT_BYTES) {
    warnings.push({ code: "largeDocument", params: { size: formatLimitSize(current.byteLength) } });
  }
  if (current.byteLength > PRO_NO_DRAFT_BYTES) {
    warnings.push({ code: "noDraftTooBig", params: { size: formatLimitSize(current.byteLength) } });
  }
  const total = document.snapshots.reduce((sum, snapshot) => sum + residentBytes(snapshot), 0);
  if (total >= PRO_MEMORY_WARN_BYTES) {
    warnings.push({ code: "memoryHigh", params: { size: formatLimitSize(total) } });
  }
  if (document.historyOffloadFailed) warnings.push({ code: "historyOffloadUnavailable" });
  return warnings;
}

/**
 * Debe el navegador avisar antes de cerrar la pestaña? Solo si HAY cambios sin guardar Y el borrador automatico
 * no los cubre (apagado, sin soporte, fallo al guardar, PDF cifrado o documento demasiado grande), o aun no los
 * cubre (`draftWritePending`: la escritura del borrador espera su debounce o esta en curso; cerrar ahora podria
 * perder justo lo ultimo que se hizo).
 */
export function unloadGuardNeeded(input: {
  dirty: boolean;
  autosaveEnabled: boolean;
  autosaveSupported: boolean;
  autosaveFailed: boolean;
  wasEncrypted: boolean;
  currentBytes: number;
  draftWritePending?: boolean;
}): boolean {
  if (!input.dirty) return false;
  const covered =
    !input.draftWritePending &&
    input.autosaveEnabled &&
    input.autosaveSupported &&
    !input.autosaveFailed &&
    !input.wasEncrypted &&
    input.currentBytes <= PRO_NO_DRAFT_BYTES;
  return !covered;
}
