import type { Dictionary } from "@/lib/i18n";
import type { DraftDecision, DraftImportItem } from "@/lib/backup/modules/drafts";
import type { ExportDescription, ModuleChoice, ModuleCounts, ModuleOutcome, ModuleSummary, OmittedModule, PackageModuleName } from "@/lib/backup/globalPackage";
import { PACKAGE_MODULES } from "@/lib/backup/globalPackage";
import { countText, fillText } from "@/app/documents/backupModel";
import { formatBytes } from "@/app/documents/documentsModel";

/**
 * Decisiones de pantalla de «Respaldo y traslado» (U4.7) que NO dependen de React: qué texto lleva cada recuento, qué
 * opciones se ofrecen para un borrador, cómo se cuenta el resultado de cada módulo. Aparte de la interfaz para probarlas
 * (y mutarlas) con precisión.
 */

export type BackupCopy = Dictionary["settings"]["backup"];

/** Qué casillas están marcadas al abrir «Exportar mi paquete»: todo lo que tiene contenido; el historial de valores, NO. */
export function defaultExportChoice(description: Pick<ExportDescription, "signatures" | "library" | "drafts" | "settings">): ModuleChoice {
  return {
    signatures: description.signatures.count > 0,
    library: description.library.documents + description.library.templates > 0,
    drafts: description.drafts.count > 0,
    settings: description.settings.keys > 0,
  };
}

/** Los módulos con casilla activa, en el orden del paquete. */
export function chosenModules(choice: ModuleChoice): PackageModuleName[] {
  return PACKAGE_MODULES.filter((name) => choice[name] === true);
}

export function moduleName(copy: BackupCopy, name: PackageModuleName): string {
  return copy.moduleNames[name];
}

/** «3 firmas, 2 documentos, 3 plantillas, 2 borradores (…: sí), ajustes» (solo lo que viaja). */
export function summaryParts(description: ExportDescription, copy: BackupCopy, options: { includeValueHistory: boolean }): string[] {
  const parts: string[] = [];
  if (description.willInclude.includes("signatures")) parts.push(countText(description.signatures.count, copy.sigOne, copy.sigMany));
  if (description.willInclude.includes("library")) {
    if (description.library.documents > 0) parts.push(countText(description.library.documents, copy.docsOne, copy.docsMany));
    if (description.library.templates > 0) parts.push(countText(description.library.templates, copy.templatesOne, copy.templatesMany));
  }
  if (description.willInclude.includes("drafts")) {
    const drafts = countText(description.drafts.count, copy.draftsOne, copy.draftsMany);
    parts.push(
      description.drafts.signCount > 0
        ? fillText(copy.summaryDrafts, { drafts, answer: description.drafts.includesStrokes ? copy.yes : copy.no })
        : drafts,
    );
  }
  if (description.willInclude.includes("settings")) {
    parts.push(copy.summarySettings);
    if (options.includeValueHistory && description.settings.valueHistoryLabels > 0) parts.push(copy.summaryHistory);
  }
  return parts;
}

/** La línea de resumen previo (o el motivo de que no haya nada que exportar). */
export function summaryLine(description: ExportDescription | null, copy: BackupCopy, locale: string, options: { includeValueHistory: boolean }): string {
  if (description === null) return copy.summaryLoading;
  if (description.nothingToExport) return copy.summaryNothing;
  return fillText(copy.summary, {
    parts: summaryParts(description, copy, options).join(", "),
    size: formatBytes(description.estimatedBytes, locale),
  });
}

/** Avisos de módulos elegidos que no van (vacíos o ilegibles), uno por motivo. */
export function omissionNotes(omitted: readonly OmittedModule[], copy: BackupCopy): string[] {
  const names = (reason: OmittedModule["reason"]) =>
    omitted
      .filter((item) => item.reason === reason)
      .map((item) => moduleName(copy, item.module))
      .join(", ");
  const notes: string[] = [];
  const empty = names("empty");
  const unavailable = names("unavailable");
  if (empty) notes.push(fillText(copy.omittedEmpty, { names: empty }));
  if (unavailable) notes.push(fillText(copy.omittedUnavailable, { names: unavailable }));
  return notes;
}

/** Lo que se pregunta en la vista previa de exportar: ¿está vacío / ilegible cada módulo elegido? (para deshabilitar la casilla). */
export function moduleAvailability(description: ExportDescription, name: PackageModuleName): "ok" | "empty" | "unavailable" {
  const available = name === "signatures" ? description.signatures.available : name === "library" ? description.library.available : name === "drafts" ? description.drafts.available : description.settings.available;
  if (!available) return "unavailable";
  const hasContent =
    name === "signatures"
      ? description.signatures.count > 0
      : name === "library"
        ? description.library.documents + description.library.templates > 0
        : name === "drafts"
          ? description.drafts.count > 0
          : description.settings.keys > 0;
  return hasContent ? "ok" : "empty";
}

/** «3 nuevos · 1 ya los tienes · …» (solo los recuentos distintos de cero). */
export function countsLine(counts: ModuleCounts, copy: BackupCopy): string {
  const parts: string[] = [];
  if (counts.new > 0) parts.push(fillText(copy.countsNew, { n: counts.new }));
  if (counts.identical > 0) parts.push(fillText(copy.countsIdentical, { n: counts.identical }));
  if (counts.different > 0) parts.push(fillText(copy.countsDifferent, { n: counts.different }));
  if (counts.invalid > 0) parts.push(fillText(copy.countsInvalid, { n: counts.invalid }));
  return parts.join(" · ");
}

/** «Firmas, Documentos…» que trae un paquete leído: cuenta lo que SE PUEDE importar (sin los inválidos). */
export function packageParts(
  modules: readonly ModuleSummary[],
  copy: BackupCopy,
  extra: { signatures: number; documents: number; templates: number; drafts: number; settings: number },
): string[] {
  const parts: string[] = [];
  for (const summary of modules) {
    if (!summary.importable) continue;
    if (summary.module === "signatures" && extra.signatures > 0) parts.push(countText(extra.signatures, copy.sigOne, copy.sigMany));
    if (summary.module === "library") {
      if (extra.documents > 0) parts.push(countText(extra.documents, copy.docsOne, copy.docsMany));
      if (extra.templates > 0) parts.push(countText(extra.templates, copy.templatesOne, copy.templatesMany));
    }
    if (summary.module === "drafts" && extra.drafts > 0) parts.push(countText(extra.drafts, copy.draftsOne, copy.draftsMany));
    if (summary.module === "settings" && extra.settings > 0) parts.push(countText(extra.settings, copy.keysOne, copy.keysMany));
  }
  return parts;
}

/** Opciones de decisión de un borrador: nuevo → importar; distinto → reemplazar (y conservar ambos solo en Firmar). */
export function draftDecisionOptions(item: Pick<DraftImportItem, "status" | "canKeepBoth">): DraftDecision[] {
  if (item.status === "new") return ["import", "omit"];
  if (item.status === "different") return item.canKeepBoth ? ["replace", "keepBoth", "omit"] : ["replace", "omit"];
  return [];
}

export function draftKindLabel(item: Pick<DraftImportItem, "kind" | "documents">, copy: BackupCopy): string {
  if (item.kind === "sign-document") return copy.kindSignDocument;
  if (item.kind === "sign-session") return fillText(copy.kindSignSession, { n: item.documents });
  return item.kind === "edit" ? copy.kindEdit : copy.kindPro;
}

export type OutcomeLine = { tone: "ok" | "info" | "error"; text: string };

/** Una línea de resultado por módulo, con su tono (verde/neutro/error). Los módulos ausentes del paquete no tienen línea. */
export function outcomeLine(outcome: ModuleOutcome, copy: BackupCopy): OutcomeLine | null {
  const label = moduleName(copy, outcome.module);
  if (outcome.status === "skipped") return outcome.why === "absent" ? null : { tone: "info", text: fillText(copy.resultSkipped, { module: label }) };
  if (outcome.status === "failed") {
    return { tone: "error", text: fillText(copy.resultFailed, { module: label, reason: copy.applyFailed[outcome.reason] }) };
  }
  if (outcome.status === "nothing") return { tone: "info", text: fillText(copy.resultNothing, { module: label }) };
  if (outcome.module === "signatures") {
    return {
      tone: "ok",
      text: outcome.replaced > 0 ? fillText(copy.resultSignaturesReplaced, { n: outcome.written, r: outcome.replaced }) : fillText(copy.resultSignatures, { n: outcome.written }),
    };
  }
  if (outcome.module === "library") {
    return {
      tone: "ok",
      text: fillText(copy.resultLibrary, {
        docs: countText(outcome.documents + outcome.documentsReplaced, copy.docsOne, copy.docsMany),
        templates: countText(outcome.templates + outcome.templatesReplaced, copy.templatesOne, copy.templatesMany),
      }),
    };
  }
  if (outcome.module === "drafts") {
    const base = fillText(copy.resultDrafts, { n: outcome.written });
    return { tone: "ok", text: outcome.strokesDropped > 0 ? `${base} ${fillText(copy.resultDraftsNoStrokes, { n: outcome.strokesDropped })}` : base };
  }
  return { tone: "ok", text: fillText(outcome.valueHistory ? copy.resultSettingsHistory : copy.resultSettings, { n: outcome.written }) };
}

/** Todas las líneas de resultado (sin las de módulos que no venían) más la nota de «lo ya importado se conserva» si algo falló. */
export function outcomeLines(outcomes: readonly ModuleOutcome[], copy: BackupCopy): OutcomeLine[] {
  const lines = outcomes.map((outcome) => outcomeLine(outcome, copy)).filter((line): line is OutcomeLine => line !== null);
  const anyFailed = outcomes.some((outcome) => outcome.status === "failed");
  const anyApplied = outcomes.some((outcome) => outcome.status === "applied");
  if (anyFailed && anyApplied) lines.push({ tone: "info", text: copy.resultKeptOthers });
  if (!anyApplied && !outcomes.some((outcome) => outcome.status === "nothing") && !anyFailed) lines.push({ tone: "info", text: copy.resultNothingAtAll });
  return lines;
}

export type LastBackupKind = "never" | "today" | "yesterday" | "days";

/** Texto «Último respaldo: …» según la vista calculada por `lastBackupView`. */
export function lastBackupText(view: { kind: LastBackupKind; n?: number }, copy: BackupCopy): string {
  if (view.kind === "never") return copy.lastNever;
  if (view.kind === "today") return copy.lastToday;
  if (view.kind === "yesterday") return copy.lastYesterday;
  return fillText(copy.lastDays, { n: view.n ?? 0 });
}
