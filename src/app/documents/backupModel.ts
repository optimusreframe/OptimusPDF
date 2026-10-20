import {
  libraryDecisionOptions,
  type LibraryDecision,
  type LibraryImportItem,
  type LibraryLimitBlock,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import type { ExportFailure } from "@/app/documents/backupFlow";

/**
 * Decisiones de pantalla de «Exportar / Importar plantillas y documentos» que NO dependen de React: qué opciones ofrece
 * cada estado de la vista previa, a qué texto corresponde cada fallo y cómo se cuenta el «último respaldo». Aparte de la
 * interfaz para probarlas (y mutarlas) con precisión.
 */

/** Las decisiones que se ofrecen para un elemento y el rótulo de cada una (la «Añadir plantillas» solo cuando el PDF ya está). */
export type DecisionLabelKey = "decisionImport" | "decisionAdd" | "decisionReplace" | "decisionKeepBoth" | "decisionOmit";

export function decisionOptionsFor(item: Pick<LibraryImportItem, "status" | "difference" | "changesTemplates">): LibraryDecision[] {
  return libraryDecisionOptions(item);
}

/** «Importar» sobre un contrato que ya tienes (solo plantillas nuevas) se llama «Añadir plantillas». */
export function decisionLabelKey(decision: LibraryDecision, item: Pick<LibraryImportItem, "status">): DecisionLabelKey {
  if (decision === "import") return item.status === "different" ? "decisionAdd" : "decisionImport";
  if (decision === "replace") return "decisionReplace";
  if (decision === "keepBoth") return "decisionKeepBoth";
  return "decisionOmit";
}

export type StatusLabelKey = "statusNew" | "statusIdentical" | "statusDifferent" | "statusInvalid";

export function statusLabelKey(status: LibraryImportItem["status"]): StatusLabelKey {
  return status === "new" ? "statusNew" : status === "identical" ? "statusIdentical" : status === "different" ? "statusDifferent" : "statusInvalid";
}

/** Qué explicación acompaña a un elemento «Distinto». */
export type HintKey = "hintPdf" | "hintTemplatesNew" | "hintTemplatesChanged" | "hintTemplateSolo";

export function hintKeyFor(item: Pick<LibraryImportItem, "status" | "kind" | "difference" | "changesTemplates">): HintKey | null {
  if (item.status !== "different") return null;
  if (item.kind === "template") return "hintTemplateSolo";
  if (item.difference === "pdf") return "hintPdf";
  return item.changesTemplates ? "hintTemplatesChanged" : "hintTemplatesNew";
}

export type ApplyFailureKey = "limit" | "quota" | "unavailable" | "invalid" | "changed" | "failed";

/** `blocked` (el plan no era importable) se cuenta como «no válido»: nada se escribió. */
export function describeApplyFailure(reason: "limit" | "quota" | "unavailable" | "invalid" | "blocked" | "changed" | "failed"): ApplyFailureKey {
  return reason === "blocked" ? "invalid" : reason;
}

export type ExportErrorKey = ExportFailure;

/** Lo que la interfaz cuenta de un plan: documentos y plantillas que traería (sin los inválidos), para «El archivo trae …». */
export function planTotals(plan: Pick<LibraryPlan, "items">): { documents: number; templates: number; invalid: number } {
  let documents = 0;
  let templates = 0;
  let invalid = 0;
  for (const item of plan.items) {
    if (item.status === "invalid") {
      invalid += 1;
      continue;
    }
    if (item.kind === "document") documents += 1;
    templates += item.templates.filter((row) => row.status !== "invalid").length;
  }
  return { documents, templates, invalid };
}

/** Clave del motivo de límite que frena una importación. */
export type LimitReasonKey = LibraryLimitBlock;

export type LastBackupView = { kind: "never" } | { kind: "today" } | { kind: "yesterday" } | { kind: "days"; n: number };

/** «Último respaldo: …» según los días naturales (calendario local) desde `at`. */
export function lastBackupView(at: Date | null, now: Date = new Date()): LastBackupView {
  if (!at) return { kind: "never" };
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  return { kind: "days", n: days };
}

/** Los elementos inválidos con su motivo, para el resultado («No se pudieron importar»). */
export function invalidItems(plan: Pick<LibraryPlan, "items">): LibraryImportItem[] {
  return plan.items.filter((item) => item.status === "invalid");
}

/** Rellena los marcadores `{clave}` de un texto del diccionario. */
export function fillText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

/** «1 documento» / «3 documentos» a partir de las dos formas del diccionario. */
export function countText(count: number, one: string, many: string): string {
  return count === 1 ? one : fillText(many, { n: count });
}
