import type { Dictionary } from "@/lib/i18n";
import type { DraftDecision, DraftImportItem } from "@/lib/backup/modules/drafts";
import type { SettingsDecisions, SettingsRow } from "@/lib/backup/modules/settings";
import type { SettingValue } from "@/lib/backup/settingsRegistry";
import type { ExportDescription, ModuleChoice, ModuleCounts, ModuleOutcome, ModuleSummary, OmittedModule, PackageModuleName } from "@/lib/backup/globalPackage";
import { PACKAGE_MODULES } from "@/lib/backup/globalPackage";
import { countText, fillText, lastBackupView, type LastBackupView as BackupWhen } from "@/app/documents/backupModel";
import { BACKUP_PARTS, type BackupParts, type BackupPart } from "@/lib/backup/lastBackup";
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

/** Una línea de resultado por módulo, con su tono (verde/neutro/error). Los módulos ausentes del paquete no tienen línea propia: `outcomeLines` los junta en una. */
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
  // Lo que el paquete NI TRAÍA se dice aparte y en una sola línea: no es un fallo ni algo que «no se importó».
  const absent = outcomes.filter((outcome) => outcome.status === "skipped" && outcome.why === "absent").map((outcome) => moduleName(copy, outcome.module));
  if (absent.length > 0) lines.push({ tone: "info", text: fillText(copy.resultAbsent, { names: absent.join(", ") }) });
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

/**
 * Las partes que se respaldaron DESPUÉS del último respaldo completo (o todas las anotadas, si nunca hubo uno completo) y
 * cuándo fue el más reciente. `null` si el último respaldo fue completo (o no hay ninguno).
 */
export function partialBackup(full: Date | null, parts: BackupParts): { parts: BackupPart[]; at: Date } | null {
  const newer = BACKUP_PARTS.filter((part) => {
    const date = parts[part];
    return date !== undefined && (full === null || date.getTime() > full.getTime());
  });
  if (newer.length === 0) return null;
  return { parts: newer, at: new Date(Math.max(...newer.map((part) => (parts[part] as Date).getTime()))) };
}

function whenText(view: BackupWhen, copy: BackupCopy): string {
  if (view.kind === "today") return copy.whenToday;
  if (view.kind === "yesterday") return copy.whenYesterday;
  if (view.kind === "days") return fillText(copy.whenDays, { n: view.n });
  return copy.whenNever;
}

/**
 * La línea «Último respaldo…» que ven Ajustes y «Mis documentos». Si el último respaldo fue COMPLETO es la de siempre
 * («Último respaldo: hoy»). Si fue PARCIAL (p. ej. solo Ajustes) lo dice sin presumir: «Último respaldo parcial (Ajustes): hoy.
 * Aún no has hecho un respaldo completo.».
 */
export function lastBackupLine(full: Date | null, parts: BackupParts, copy: BackupCopy, now: Date = new Date()): string {
  const partial = partialBackup(full, parts);
  if (!partial) return lastBackupText(lastBackupView(full, now), copy);
  const sentence = fillText(copy.lastPartial, {
    parts: partial.parts.map((part) => copy.moduleNames[part]).join(", "),
    when: whenText(lastBackupView(partial.at, now), copy),
  });
  const tail = full ? fillText(copy.lastFullWas, { when: whenText(lastBackupView(full, now), copy) }) : copy.lastNoFull;
  return `${sentence} ${tail}`;
}

/** «N documentos no se incluirán / no se incluyeron porque falta su copia del PDF» (antes / después de exportar); `null` si no falta ninguna. */
export function withoutCopyNote(count: number, copy: BackupCopy, when: "before" | "after"): string | null {
  if (count <= 0) return null;
  const one = when === "before" ? copy.withoutCopyWarnOne : copy.withoutCopyDoneOne;
  const many = when === "before" ? copy.withoutCopyWarnMany : copy.withoutCopyDoneMany;
  return countText(count, one, many);
}

/** Por qué lo elegido no cabe en un paquete: con cuánto pesa, el máximo y cuánto sobra (o el motivo general si solo lo dicen los borradores). */
export function tooLargeText(
  description: Pick<ExportDescription, "estimatedBytes" | "limitBytes" | "overBy">,
  copy: BackupCopy,
  locale: string,
): string {
  if (description.overBy <= 0) return copy.tooLarge;
  return fillText(copy.tooLargeSize, {
    size: formatBytes(description.estimatedBytes, locale),
    limit: formatBytes(description.limitBytes, locale),
    over: formatBytes(description.overBy, locale),
  });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Vista previa de Ajustes: qué cambiaría, valor a valor (H8)                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

const THEME_KEY = "optimuspdf.theme";
const LANGUAGE_KEY = "optimuspdf.language";
const LAYOUT_KEY = "optimuspdf.pro.layout.v1";
const NOTICE_KEYS = new Set(["optimuspdf.sign-pdf.privacyNoticeSeen", "optimuspdf.edit-pdf.privacyNoticeSeen"]);

/** El valor de un ajuste en lenguaje de persona («Activado», «Oscuro», «Español»…). Todo es texto: nada del paquete se interpreta. */
export function settingValueText(row: Pick<SettingsRow, "key" | "flag">, value: SettingValue, copy: BackupCopy): string {
  if (typeof value === "boolean") {
    if (NOTICE_KEYS.has(row.key)) return value ? copy.valueSeen : copy.valueUnseen;
    return value ? copy.valueOn : copy.valueOff;
  }
  if (typeof value === "string") {
    if (row.key === THEME_KEY) return Object.hasOwn(copy.themeValues, value) ? copy.themeValues[value as keyof typeof copy.themeValues] : value;
    if (row.key === LANGUAGE_KEY) return Object.hasOwn(copy.languageValues, value) ? copy.languageValues[value as keyof typeof copy.languageValues] : value;
    return value;
  }
  if (typeof value === "number") return String(value);
  if (row.key === LAYOUT_KEY) {
    return fillText(copy.layoutValue, {
      thumbs: Number(value.thumbsWidth) || 0,
      thumbsState: value.thumbsOpen === true ? copy.stateOpen : copy.stateClosed,
      context: Number(value.contextWidth) || 0,
      contextState: value.contextOpen === true ? copy.stateOpen : copy.stateClosed,
    });
  }
  return Object.entries(value)
    .map(([name, item]) => `${name}: ${String(item)}`)
    .join(", ");
}

/** «Ahora: Activado → Paquete: Desactivado»; si lo de ahora no está guardado, dice que es el valor por defecto. */
export function settingChangeText(row: SettingsRow, copy: BackupCopy): string {
  const now = settingValueText(row, row.local, copy);
  return fillText(copy.settingRowLine, {
    now: row.localStored ? now : fillText(copy.settingRowDefault, { value: now }),
    value: settingValueText(row, row.value, copy),
  });
}

/** La decisión efectiva de una fila: la suya, o la general de Ajustes. */
export function rowDecision(decisions: Pick<SettingsDecisions, "settings" | "rows">, id: string): "replace" | "omit" {
  const own = decisions.rows !== undefined && Object.hasOwn(decisions.rows, id) ? decisions.rows[id] : undefined;
  return own === "replace" || own === "omit" ? own : decisions.settings;
}

/**
 * Cambia la decisión de UNA fila. Si con ello todas las filas quedan igual se vuelve a «todos Reemplazar / Omitir» (sin
 * decisiones por fila); si quedan mezcladas se guarda la decisión de CADA fila, sin ambigüedad.
 */
export function withRowDecision(decisions: SettingsDecisions, rows: readonly SettingsRow[], id: string, decision: "replace" | "omit"): SettingsDecisions {
  const next = new Map(rows.map((row) => [row.id, row.id === id ? decision : rowDecision(decisions, row.id)] as const));
  const values = new Set(next.values());
  if (values.size <= 1) {
    const { rows: _rows, ...rest } = decisions;
    void _rows;
    return { ...rest, settings: values.values().next().value ?? decisions.settings };
  }
  return { ...decisions, rows: Object.fromEntries(next) };
}

/** «Reemplazar todos» / «Omitir todos»: una sola decisión para todas las filas (sin decisiones por fila). */
export function withAllRows(decisions: SettingsDecisions, decision: "replace" | "omit"): SettingsDecisions {
  const { rows: _rows, ...rest } = decisions;
  void _rows;
  return { ...rest, settings: decision };
}

/** Si todas las filas llevan la misma decisión, cuál; si están mezcladas, `null` (ninguna opción general marcada). */
export function commonRowDecision(decisions: Pick<SettingsDecisions, "settings" | "rows">, rows: readonly SettingsRow[]): "replace" | "omit" | null {
  if (rows.length === 0) return decisions.settings;
  const first = rowDecision(decisions, rows[0].id);
  return rows.every((row) => rowDecision(decisions, row.id) === first) ? first : null;
}
