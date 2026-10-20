import { passwordBoxAvailable } from "@/lib/crypto/passwordBox";
import { browserInputGuard } from "@/lib/pdf/inputGuard";
import { LibraryError } from "@/lib/docLibrary/types";
import { PACKAGE_LIMITS, PackageError } from "@/lib/backup/types";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applyLibraryImport,
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  summarizeLibraryExport,
  type ApplyLibraryResult,
  type LibraryDecision,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import { readFailureFor, type ReadFailure } from "@/app/sign-pdf/backupFlow";

/**
 * Lógica de «Exportar plantillas y documentos» / «Importar» de Mis documentos (U4.5 + U4.2), sin interfaz: construir el
 * paquete, leer uno ajeno SIN escribir nada y planificar la fusión, y aplicarla. La contraseña (mínimo y medidor), compartir
 * en iPad y el mapa de errores del contenedor se reutilizan de `sign-pdf/backupFlow.ts` (mismas reglas que el baúl de firmas).
 * Nada de aquí sale del dispositivo.
 */

export { MIN_PASSWORD_LENGTH, canShareFile, checkNewPassword, passwordStrength, shareFile, toFile } from "@/app/sign-pdf/backupFlow";

/** Nombre del archivo que se descarga o se comparte. */
export const LIBRARY_BACKUP_FILENAME = "OptimusPDF-documentos.optimuspdf.zip";

/* ------------------------------------------------------------------------------------------------------------ */
/* Exportar                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export type ExportFailure = "empty" | "unavailable" | "encryptionUnavailable" | "tooLarge" | "failed";

export type LibraryExportBuild =
  | { ok: true; blob: Blob; filename: string; documents: number; templates: number; bytes: number; encrypted: boolean }
  | { ok: false; reason: ExportFailure };

/** Margen del índice y los JSON dentro del tope de bytes del paquete. */
const PACKAGE_SLACK_BYTES = 8 * 1024 * 1024;

/** Empaqueta TODA la biblioteca (nunca un subconjunto); no escribe ni descarga nada. */
export async function buildLibraryExport(options: { password?: string } = {}): Promise<LibraryExportBuild> {
  const password = options.password === "" ? undefined : options.password;
  if (password !== undefined && !passwordBoxAvailable()) return { ok: false, reason: "encryptionUnavailable" };
  try {
    const summary = await summarizeLibraryExport();
    if (!summary.available) return { ok: false, reason: "unavailable" };
    if (summary.documents === 0 && summary.templates === 0) return { ok: false, reason: "empty" };
    // Antes de leer los PDF: un paquete que pasara del tope no se podría importar.
    if (summary.bytes > PACKAGE_LIMITS.maxUncompressedBytes - PACKAGE_SLACK_BYTES) return { ok: false, reason: "tooLarge" };
    const { module, report } = await exportLibraryWithReport();
    if (report.documents === 0 && report.templates === 0) return { ok: false, reason: "empty" };
    const blob = await buildPackage({ modules: [module], password });
    return {
      ok: true,
      blob,
      filename: LIBRARY_BACKUP_FILENAME,
      documents: report.documents,
      templates: report.templates,
      bytes: report.bytes,
      encrypted: password !== undefined,
    };
  } catch (error) {
    if (error instanceof LibraryError && error.code === "unavailable") return { ok: false, reason: "unavailable" };
    if (error instanceof PackageError) {
      if (error.code === "tooLarge") return { ok: false, reason: "tooLarge" };
      if (error.code === "unavailable") return { ok: false, reason: password !== undefined ? "encryptionUnavailable" : "unavailable" };
    }
    return { ok: false, reason: "failed" };
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Importar                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export type LibraryReadFailure = Exclude<ReadFailure, "noSignatures"> | "noLibrary" | "storage";

export type ReadLibraryResult =
  | { ok: true; plan: LibraryPlan; encrypted: boolean }
  | { ok: false; reason: LibraryReadFailure; code?: string };

/** La puerta de entrada de producción para un PDF de un paquete: el mismo `inputGuard` que el resto de herramientas. */
export async function guardPdfBytes(bytes: Uint8Array): Promise<boolean> {
  const file = new File([bytes as BlobPart], "documento.pdf", { type: "application/pdf" });
  const check = await browserInputGuard(file);
  // Un PDF que solo restringe permisos se abre sin contraseña: la biblioteca ya lo admite al añadir.
  return check.status === "ok" || (check.status === "encrypted" && !check.needsPassword);
}

export type ReadLibraryOptions = {
  /** Se llama tras revisar cada PDF (`total` = lo que dice el paquete que trae; informativo). */
  onProgress?: (done: number, total: number) => void;
  /** Para pruebas: sustituye la puerta de entrada. */
  validatePdf?: (bytes: Uint8Array) => Promise<boolean>;
};

/**
 * Lee el paquete SIN escribir nada y planifica la fusión con la biblioteca actual. `needsPassword` / `wrongPassword` los
 * resuelve la interfaz pidiendo (o repitiendo) la contraseña; un paquete válido sin biblioteca, o con ella de una versión
 * más nueva, se dice con claridad en vez de abrir una vista previa vacía.
 */
export async function readLibraryBackup(file: Blob, password?: string, options: ReadLibraryOptions = {}): Promise<ReadLibraryResult> {
  try {
    const read = await readPackage(file, password === "" ? undefined : password);
    const declared = read.modules.find((module) => module.name === "library")?.meta.documents;
    const total = typeof declared === "number" && Number.isFinite(declared) ? Math.max(0, Math.floor(declared)) : 0;
    let done = 0;
    const guard = options.validatePdf ?? guardPdfBytes;
    const plan = await planLibraryImport(read, await loadLibraryExisting(), {
      validatePdf: async (bytes) => {
        const ok = await guard(bytes);
        done += 1;
        options.onProgress?.(done, Math.max(total, done));
        return ok;
      },
    });
    if (plan.state === "newerVersion") return { ok: false, reason: "newer" };
    if (plan.state === "damaged") return { ok: false, reason: "damaged" };
    if (plan.state === "absent") return { ok: false, reason: "noLibrary" };
    return { ok: true, plan, encrypted: read.encrypted };
  } catch (error) {
    if (error instanceof PackageError) {
      const reason = readFailureFor(error.code);
      return { ok: false, reason: reason === "noSignatures" ? "generic" : reason, code: error.code };
    }
    if (error instanceof LibraryError && error.code === "unavailable") return { ok: false, reason: "storage" };
    return { ok: false, reason: "generic" };
  }
}

export type ImportSummary = {
  documents: number;
  documentsReplaced: number;
  templates: number;
  templatesReplaced: number;
  skipped: number;
  reassigned: number;
};

export type ApplyLibraryBackup =
  | { ok: true; summary: ImportSummary }
  | { ok: false; reason: Extract<ApplyLibraryResult, { ok: false }>["reason"]; fits?: number; wanted?: number };

/** Aplica lo aprobado (atómico: todo o nada). */
export async function applyLibraryBackup(plan: LibraryPlan, decisions: Record<string, LibraryDecision | undefined>): Promise<ApplyLibraryBackup> {
  const result = await applyLibraryImport(plan, decisions);
  if (!result.ok) return { ok: false, reason: result.reason, fits: result.fits, wanted: result.wanted };
  return {
    ok: true,
    summary: {
      documents: result.documents,
      documentsReplaced: result.documentsReplaced,
      templates: result.templates,
      templatesReplaced: result.templatesReplaced,
      skipped: result.skipped,
      reassigned: result.reassigned,
    },
  };
}
