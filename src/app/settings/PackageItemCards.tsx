"use client";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { DraftDecision, DraftImportItem } from "@/lib/backup/modules/drafts";
import { settingsRows, type SettingsDecisions, type SettingsImportPlan, type SettingsRow } from "@/lib/backup/modules/settings";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { countText, fillText } from "@/app/documents/backupModel";
import { formatBytes } from "@/app/documents/documentsModel";
import {
  commonRowDecision,
  draftDecisionOptions,
  draftKindLabel,
  rowDecision,
  settingChangeText,
  withAllRows,
  withRowDecision,
} from "@/app/settings/packageModel";

/**
 * Tarjetas de la vista previa del paquete global que NO existían (U4.7): borradores y ajustes. Las de firmas y de
 * plantillas/documentos son las de sus propias hojas (`SignatureBackupSheet`, `ImportBackupSheet`). Mismo aspecto, mismo
 * grupo de opciones (`role=radiogroup`, ≥ 44 px) y mismos estados en texto (nunca solo color).
 */

const STATUS_STYLE = {
  new: "border-success/40 text-success-text",
  different: "border-signal/50 text-signal-text",
  identical: "border-white/20 text-muted-foreground",
  invalid: "border-destructive/40 text-destructive-text",
} as const;

export function statusChipClass(status: keyof typeof STATUS_STYLE): string {
  return cn("rounded-full border px-2 py-0.5 text-caption font-medium", STATUS_STYLE[status]);
}

const OPTION_CLASS =
  "min-h-11 flex-1 rounded-ios-sm border px-3 py-2 text-center text-footnote leading-tight font-medium whitespace-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50 forced-colors:border-[ButtonText]";

export function optionClass(active: boolean): string {
  return cn(
    OPTION_CLASS,
    active
      ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-2 forced-colors:border-[Highlight]"
      : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:text-foreground",
  );
}

function formatDate(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  return new Date(time).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

export function DraftItemCard({
  item,
  locale,
  decision,
  disabled,
  onDecision,
}: {
  item: DraftImportItem;
  locale: string;
  decision: DraftDecision | undefined;
  disabled: boolean;
  onDecision: (decision: DraftDecision) => void;
}) {
  const { t } = useI18n();
  const copy = t.settings.backup;
  const options = draftDecisionOptions(item);
  const label = item.fileName || "—";
  const labels: Record<DraftDecision, string> = {
    import: copy.decisionImport,
    replace: copy.decisionReplace,
    keepBoth: copy.decisionKeepBoth,
    omit: copy.decisionOmit,
  };
  const status =
    item.status === "new" ? copy.statusNew : item.status === "identical" ? copy.statusIdentical : item.status === "different" ? copy.statusDifferent : copy.statusInvalid;
  return (
    <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-item={item.key} data-status={item.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-callout font-semibold text-foreground [overflow-wrap:anywhere]">{label}</p>
        <span className={statusChipClass(item.status)}>{status}</span>
      </div>
      {item.status !== "invalid" ? (
        <p className="text-caption text-muted-foreground">
          {draftKindLabel(item, copy)} · {fillText(copy.draftSaved, { date: formatDate(item.savedAt, locale) })} · {formatBytes(item.bytes, locale)}
        </p>
      ) : item.reason ? (
        <p className="text-footnote text-destructive-text">{copy.draftInvalidReasons[item.reason]}</p>
      ) : null}
      {item.status !== "invalid" && item.hasStrokes ? (
        <p className="text-footnote font-medium text-foreground" data-backup-draft-strokes="">
          {copy.draftHasStrokes}
        </p>
      ) : null}
      {item.status !== "invalid" && item.strokesDropped ? <p className="text-footnote text-muted-foreground">{copy.draftStrokesDropped}</p> : null}
      {item.status !== "invalid" && item.discarded ? <p className="text-footnote text-muted-foreground">{fillText(copy.draftDiscarded, { n: item.discarded })}</p> : null}
      {item.status === "different" && item.conflictWith ? (
        <p className="text-footnote text-muted-foreground" data-backup-hint="">
          {fillText(item.conflictWith.newer ? copy.draftLocalNewer : copy.draftLocalOlder, { date: formatDate(item.conflictWith.savedAt, locale) })}
        </p>
      ) : null}
      {options.length > 0 ? (
        <div role="radiogroup" aria-label={fillText(copy.decisionGroup, { name: label })} className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={decision === option}
              disabled={disabled}
              data-decision={option}
              onClick={() => onDecision(option)}
              className={optionClass(decision === option)}
            >
              {labels[option]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type SettingsDecision = "replace" | "omit";

const REMEMBERED_SIGNERS_KEY = "optimuspdf.sign.templateSigners";
const NOTICE_NAMES: Record<string, "signNotice" | "editNotice"> = {
  "optimuspdf.sign-pdf.privacyNoticeSeen": "signNotice",
  "optimuspdf.edit-pdf.privacyNoticeSeen": "editNotice",
};
const APPEARANCE_NAMES: Record<string, "theme" | "language" | "sidebarCollapsed"> = {
  "optimuspdf.theme": "theme",
  "optimuspdf.language": "language",
  "optimuspdf.sidebarCollapsed": "sidebarCollapsed",
};

/**
 * Los ajustes del paquete: un resumen con los recuentos y, debajo, QUÉ cambiaría ajuste a ajuste («Ahora: … → Paquete: …»),
 * con los que afectan a la privacidad marcados y en «Omitir» por defecto. Se decide por ajuste o para todos; el historial de
 * valores (datos de clientes) va aparte, también omitido por defecto.
 */
export function SettingsCards({
  plan,
  decisions,
  historyDecision,
  disabled,
  onSettings,
  onHistory,
}: {
  plan: SettingsImportPlan;
  decisions: SettingsDecisions;
  historyDecision: SettingsDecision | undefined;
  disabled: boolean;
  onSettings: (decisions: SettingsDecisions) => void;
  onHistory: (decision: SettingsDecision) => void;
}) {
  const { t, language } = useI18n();
  const copy = t.settings.backup;
  const templateFlags = SIGN_STRINGS[language].template.flags;
  const rows = settingsRows(plan);
  const changes = plan.counts.new + plan.counts.different;
  const status: keyof typeof STATUS_STYLE = plan.counts.different > 0 ? "different" : plan.counts.new > 0 ? "new" : plan.counts.invalid > 0 && plan.items.length === plan.counts.invalid ? "invalid" : "identical";
  const statusText = status === "new" ? copy.statusNew : status === "different" ? copy.statusDifferent : status === "invalid" ? copy.statusInvalid : copy.statusIdentical;
  const parts: string[] = [];
  if (plan.counts.new > 0) parts.push(fillText(copy.countsNew, { n: plan.counts.new }));
  if (plan.counts.different > 0) parts.push(fillText(copy.countsDifferent, { n: plan.counts.different }));
  if (plan.counts.identical > 0) parts.push(fillText(copy.countsIdentical, { n: plan.counts.identical }));
  const history = plan.valueHistory;
  const historyStatus: keyof typeof STATUS_STYLE | null = history.status === "absent" ? null : history.status;
  const choices: { value: SettingsDecision; label: string }[] = [
    { value: "replace", label: copy.decisionReplace },
    { value: "omit", label: copy.decisionOmit },
  ];
  const radio = (
    name: string,
    value: SettingsDecision | null | undefined,
    onChange: (decision: SettingsDecision) => void,
    labels: { replace: string; omit: string } = { replace: copy.decisionReplace, omit: copy.decisionOmit },
  ) => (
    <div role="radiogroup" aria-label={fillText(copy.decisionGroup, { name })} className="flex flex-wrap gap-1.5">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={value === choice.value}
          disabled={disabled}
          data-decision={choice.value}
          onClick={() => onChange(choice.value)}
          className={optionClass(value === choice.value)}
        >
          {labels[choice.value]}
        </button>
      ))}
    </div>
  );

  /** «Firmar PDF · Firmas guardadas»: el grupo y el nombre legible del ajuste (nunca la clave técnica). */
  const rowName = (row: SettingsRow): string => {
    const group = copy.settingGroups[row.group];
    let name: string = row.flag ?? row.key;
    if (row.flag !== undefined) {
      const sign = t.settings.signPdfFeatures as Record<string, { label: string } | undefined>;
      const edit = t.settings.editPdfFeatures as Record<string, { label: string } | undefined>;
      const pro = t.settings.proFeatures as Record<string, { label: string } | undefined>;
      const template = templateFlags as unknown as Record<string, { label: string } | undefined>;
      const entry = row.group === "sign" ? (Object.hasOwn(sign, row.flag) ? sign[row.flag] : template[row.flag]) : row.group === "edit" ? edit[row.flag] : row.group === "pro" ? pro[row.flag] : undefined;
      if (entry && Object.hasOwn(entry, "label")) name = entry.label;
    } else if (Object.hasOwn(APPEARANCE_NAMES, row.key)) name = copy.settingNames[APPEARANCE_NAMES[row.key]];
    else if (Object.hasOwn(NOTICE_NAMES, row.key)) name = copy.settingNames[NOTICE_NAMES[row.key]];
    else if (row.key === REMEMBERED_SIGNERS_KEY) name = copy.settingNames.templateSigners;
    else if (row.group === "pro") name = copy.settingNames.proLayout;
    return fillText(copy.settingRowName, { group, name });
  };

  const common = commonRowDecision(decisions, rows);
  const anySensitive = rows.some((row) => row.sensitive);
  return (
    <>
      <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-item="settings" data-status={status}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-callout font-semibold text-foreground [overflow-wrap:anywhere]">{copy.settingsCardTitle}</p>
          <span className={statusChipClass(status)}>{statusText}</span>
        </div>
        <p className="text-caption text-muted-foreground">{fillText(copy.settingsLine, { n: plan.items.length, parts: parts.join(" · ") || "—" })}</p>
        {plan.counts.invalid > 0 ? <p className="text-footnote text-destructive-text">{fillText(copy.settingsInvalidLine, { n: plan.counts.invalid })}</p> : null}
        {plan.ignoredKeys > 0 ? <p className="text-footnote text-muted-foreground">{fillText(copy.settingsIgnored, { n: plan.ignoredKeys })}</p> : null}
        {changes > 0 ? <p className="text-footnote text-muted-foreground">{copy.settingsReloadHint}</p> : null}
        {rows.length > 0 ? (
          <>
            <h5 className="pt-1 text-subheadline font-semibold text-foreground">{copy.settingsRowsTitle}</h5>
            {anySensitive ? (
              <p className="text-footnote text-muted-foreground" data-backup-sensitive-note="">
                {copy.settingsSensitiveNote}
              </p>
            ) : null}
            {radio(copy.settingsAllGroup, common, (decision) => onSettings(withAllRows(decisions, decision)), { replace: copy.decisionReplaceAll, omit: copy.decisionOmitAll })}
            <ul className="space-y-2" aria-label={copy.settingsRowsTitle} data-backup-setting-rows="">
              {rows.map((row) => {
                const name = rowName(row);
                return (
                  <li
                    key={row.id}
                    className="space-y-1.5 rounded-ios-sm border border-white/10 bg-white/5 p-2.5"
                    data-backup-setting-row={row.id}
                    data-sensitive={row.sensitive ? "true" : "false"}
                  >
                    <p className="text-footnote font-medium text-foreground [overflow-wrap:anywhere]">{name}</p>
                    {row.sensitive ? (
                      <p className="text-footnote font-medium text-signal-text" data-backup-setting-sensitive="">
                        {copy.settingSensitiveBadge}
                      </p>
                    ) : null}
                    <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{settingChangeText(row, copy)}</p>
                    {radio(name, rowDecision(decisions, row.id), (decision) => onSettings(withRowDecision(decisions, rows, row.id, decision)))}
                  </li>
                );
              })}
            </ul>
          </>
        ) : changes > 0 ? (
          // Nada visible cambia (lo que trae el paquete ya es lo que tienes o el valor por defecto): solo la decisión general.
          <>
            <p className="text-footnote text-muted-foreground">{copy.settingsNoChanges}</p>
            {radio(copy.settingsCardTitle, decisions.settings, (decision) => onSettings(withAllRows(decisions, decision)))}
          </>
        ) : null}
      </div>
      {historyStatus ? (
        <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-item="valueHistory" data-status={historyStatus}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 text-callout font-semibold text-foreground [overflow-wrap:anywhere]">{copy.historyCardTitle}</p>
            <span className={statusChipClass(historyStatus)}>
              {historyStatus === "new" ? copy.statusNew : historyStatus === "different" ? copy.statusDifferent : historyStatus === "invalid" ? copy.statusInvalid : copy.statusIdentical}
            </span>
          </div>
          {historyStatus !== "invalid" ? (
            <p className="text-caption text-muted-foreground">
              {fillText(copy.historyLine, {
                labels: countText(history.labels, copy.labelsOne, copy.labelsMany),
                values: countText(history.values, copy.valuesOne, copy.valuesMany),
              })}
            </p>
          ) : null}
          {history.status === "new" || history.status === "different" ? (
            <>
              {history.status === "different" ? <p className="text-footnote text-muted-foreground">{copy.historyReplaceHint}</p> : null}
              {radio(copy.historyCardTitle, historyDecision, onHistory)}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
