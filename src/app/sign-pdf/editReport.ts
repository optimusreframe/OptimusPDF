import { countWarnings, exportNotices, type ExportWarningCounts } from "@/app/edit-pdf/editExport";
import { EDIT_FLOW_STRINGS, type EditFlowStrings } from "@/app/edit-pdf/flowStrings";
import type { ProcessResult } from "@/components/tool/ToolShell";
import type { Language } from "@/lib/i18n";
import type { AppliedEdits } from "@/app/sign-pdf/textEdits";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { EditWarning, OriginalTextRemainsReason, TextEdit } from "@/lib/pdf/editTypes";

/*
 * Resumen de lo que paso con el texto original editado al firmar (B1).
 *
 * `applyTextEdits` (Wave 8 · F2) quita de verdad el texto original de cada bloque editado, o avisa de que no pudo y
 * por que. Firmar usa esa misma exportacion; antes tiraba los avisos. Aqui se convierten en un informe PURO (sin
 * React, sin idioma) y despues en el texto de la pantalla de resultado: «N textos editados: el original se elimino
 * del archivo» y, por cada bloque que NO se pudo limpiar, donde esta, por que y que hacer.
 *
 * Los motivos y los avisos genericos (fuente parecida, caracteres sin dibujo, fondo, solapes, omitidas) son los de
 * Editar PDF (`EditFlowStrings`): no se duplican textos.
 */

/** Un bloque cuyo original NO se pudo quitar del archivo. */
export type RemainEntry = {
  editId: string;
  /** Pagina en base 0. */
  pageIndex: number;
  /** Primer renglon del texto NUEVO (lo que la persona escribio), acortado; `null` si borro el texto. */
  excerpt: string | null;
  /** Por que no se pudo (ausente = el motor no lo precisa). */
  reason: OriginalTextRemainsReason | undefined;
};

export type EditReport = {
  /** Ediciones que reemplazan un texto del PDF. */
  replaced: number;
  /** Textos propios anadidos (con contenido). */
  added: number;
  /** De los reemplazados, a cuantos se les quito de verdad el original. */
  removed: number;
  /** De los reemplazados, los que conservan el original bajo la edicion. */
  remains: RemainEntry[];
  /** Avisos de la exportacion contados por texto (`originalRemains`/`originalRemoved` van aparte). */
  warnings: ExportWarningCounts;
};

/** Cuantos bloques sin limpiar se listan uno a uno (el resto se resume). */
export const MAX_REMAINS_LISTED = 6;

const EXCERPT_MAX = 40;

/** Primer renglon del texto nuevo, sin espacios sobrantes y acortado. `null` si esta vacio. */
export function excerptOf(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const chars = Array.from(firstLine);
  return chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX - 1).join("").trimEnd()}…` : firstLine;
}

function reasonOf(list: readonly EditWarning[] | undefined): { remains: boolean; reason?: OriginalTextRemainsReason; removed: boolean } {
  let remains = false;
  let removed = false;
  let reason: OriginalTextRemainsReason | undefined;
  for (const warning of list ?? []) {
    if (warning.kind === "original-text-remains") {
      remains = true;
      reason = warning.reason ?? reason;
    } else if (warning.kind === "original-text-removed") {
      removed = true;
    }
  }
  return { remains, removed, reason };
}

/**
 * Informe de UNA exportacion de ediciones. `null` si no hubo ediciones efectivas (nada que contar: la pantalla de
 * resultado es la de siempre).
 */
export function buildEditReport(
  applied: Pick<AppliedEdits, "applied" | "warningsByEdit" | "skipped">,
): EditReport | null {
  const edits: readonly TextEdit[] = applied.applied;
  if (edits.length === 0) return null;
  let replaced = 0;
  let added = 0;
  let removed = 0;
  const remains: RemainEntry[] = [];
  for (const edit of edits) {
    if (edit.blockId === undefined) {
      added += 1;
      continue;
    }
    replaced += 1;
    const state = reasonOf(applied.warningsByEdit[edit.id]);
    if (state.remains) {
      remains.push({ editId: edit.id, pageIndex: edit.pageIndex, excerpt: excerptOf(edit.text), reason: state.reason });
    } else if (state.removed) {
      removed += 1;
    }
  }
  return {
    replaced,
    added,
    removed,
    remains,
    warnings: countWarnings(applied.warningsByEdit, applied.skipped.length, edits, []),
  };
}

export type EditReportEntry = {
  /** Nombre del documento (solo se usa con varios: «contrato.pdf, pagina 2...»). */
  docName: string;
  report: EditReport;
};

export type EditReportText = {
  /** Va bajo el nombre del archivo: «N textos editados: el original se elimino del archivo.» */
  summary: string;
  title: string;
  /** Cada bloque sin limpiar, la salida recomendada (una vez) y los avisos genericos de la exportacion. */
  items: string[];
};

function sumWarnings(reports: readonly EditReport[]): ExportWarningCounts {
  const total: ExportWarningCounts = {
    fontSubstituted: 0,
    glyphMissing: 0,
    originalRemains: 0,
    originalRemoved: 0,
    backgroundNotUniform: 0,
    overlap: 0,
    mixedStyle: 0,
    coverOverlaps: 0,
    flattenDrops: null,
    skipped: 0,
  };
  for (const { warnings } of reports) {
    total.fontSubstituted += warnings.fontSubstituted;
    total.glyphMissing += warnings.glyphMissing;
    total.backgroundNotUniform += warnings.backgroundNotUniform;
    total.overlap += warnings.overlap;
    total.mixedStyle += warnings.mixedStyle;
    total.coverOverlaps += warnings.coverOverlaps;
    total.skipped += warnings.skipped;
  }
  return total;
}

/**
 * Texto de la pantalla de resultado para uno o varios documentos (ZIP). Sin entradas devuelve `null`. Con varios
 * documentos (`named`), cada bloque lleva el nombre de su documento y el resumen cuenta los textos de todos.
 */
export function describeEditReports(
  entries: readonly EditReportEntry[],
  strings: SignStrings,
  flow: EditFlowStrings,
  options: { named?: boolean } = {},
): EditReportText | null {
  if (entries.length === 0) return null;
  // Con un ZIP (varios documentos) se nombra siempre el documento, aunque solo uno traiga ediciones.
  const named = options.named ?? entries.length > 1;
  const reports = entries.map((entry) => entry.report);
  const replaced = reports.reduce((sum, report) => sum + report.replaced, 0);
  const added = reports.reduce((sum, report) => sum + report.added, 0);
  const removed = reports.reduce((sum, report) => sum + report.removed, 0);
  const remains = entries.flatMap((entry) =>
    entry.report.remains.map((item) => ({ ...item, docName: named ? entry.docName : null })),
  );

  const parts: string[] = [];
  if (replaced > 0) {
    const several = entries.length > 1;
    const base = `${flow.summaryEditedTexts(replaced)}${several ? strings.editInDocs(entries.length) : ""}`;
    if (remains.length === 0 && removed > 0) parts.push(`${base}: ${strings.editTailAllRemoved(several)}.`);
    else if (remains.length > 0 && removed === 0) parts.push(`${base}: ${strings.editTailNoneRemoved(remains.length)}.`);
    else if (remains.length > 0) parts.push(`${base}: ${strings.editTailSomeRemoved(removed, remains.length)}.`);
    else parts.push(`${base}.`);
  }
  if (added > 0) parts.push(`${flow.summaryAddedTexts(added)}.`);

  const items: string[] = [];
  for (const entry of remains.slice(0, MAX_REMAINS_LISTED)) {
    items.push(strings.editRemainsItem(entry.docName, entry.pageIndex + 1, entry.excerpt, flow.remainsReason(entry.reason)));
  }
  if (remains.length > MAX_REMAINS_LISTED) items.push(strings.editRemainsMore(remains.length - MAX_REMAINS_LISTED));
  if (remains.length > 0) items.push(strings.editRemainsAdvice(flow.flattenAction));
  items.push(...exportNotices(sumWarnings(reports), { signatures: "none", wasEncrypted: false, flattenedPages: 0 }, flow));

  return { summary: parts.join(" "), title: strings.editReportTitle, items };
}

/**
 * Resumen y avisos de la pantalla de resultado (`ProcessResult.summary` / `.notices`) de uno o varios documentos con
 * texto editado. Sin ediciones devuelve `{}`: la pantalla es exactamente la de antes.
 */
export function editResultText(
  entries: readonly EditReportEntry[],
  language: Language,
  strings: SignStrings,
  options: { named?: boolean } = {},
): Pick<ProcessResult, "summary" | "notices"> {
  const text = describeEditReports(entries, strings, EDIT_FLOW_STRINGS[language], options);
  if (!text) return {};
  return {
    ...(text.summary ? { summary: text.summary } : {}),
    ...(text.items.length > 0 ? { notices: { title: text.title, items: text.items } } : {}),
  };
}
