"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import {
  checkLibraryLimits,
  defaultLibraryDecisions,
  type LibraryLimitCheck,
  type LibraryDecision,
  type LibraryImportItem,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import { applyLibraryBackup, readLibraryBackup, type ImportSummary } from "@/app/documents/backupFlow";
import {
  countText,
  decisionLabelKey,
  decisionOptionsFor,
  describeApplyFailure,
  fillText,
  hintKeyFor,
  invalidItems,
  planTotals,
  statusLabelKey,
} from "@/app/documents/backupModel";
import { BACKUP_INPUT_CLASS } from "@/app/documents/ExportBackupSheet";
import { formatBytes } from "@/app/documents/documentsModel";

/**
 * «Importar» plantillas y documentos (U4.5 + U4.2): elegir el `.zip` → contraseña si hace falta → hoja de VISTA PREVIA por
 * elemento (Nuevo / Ya lo tienes / Distinto / No se puede importar) con su decisión (Importar / Reemplazar / Conservar
 * ambos / Omitir), límites comprobados ANTES, progreso y resultado con recuento. Todo se lee y se valida sin escribir nada;
 * «Importar» aplica en UNA transacción (todo o nada). La lógica vive en `backupFlow.ts`, `backupModel.ts` y `lib/backup`.
 */

type Phase = "pick" | "reading" | "password" | "preview" | "importing" | "done";

export function ImportBackupSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: (message: string) => void }) {
  const { t } = useI18n();
  // Mientras se escribe la importación la hoja no se cierra (Escape, clic fuera, X): se perdería su resultado.
  const [applying, setApplying] = useState(false);
  const [blockedAttempts, setBlockedAttempts] = useState(0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t.documents.backup.importTitle}
      closeLabel={t.common.close}
      initialFocus="[data-backup-first]"
      closeLocked={applying}
      onCloseBlocked={() => setBlockedAttempts((count) => count + 1)}
    >
      <ImportBody onClose={onClose} onDone={onDone} onApplyingChange={setApplying} blockedAttempts={blockedAttempts} />
    </Sheet>
  );
}

function ImportBody({
  onClose,
  onDone,
  onApplyingChange,
  blockedAttempts = 0,
}: {
  onClose: () => void;
  onDone?: (message: string) => void;
  onApplyingChange?: (applying: boolean) => void;
  blockedAttempts?: number;
}) {
  const { t, language } = useI18n();
  const copy = t.documents.backup;
  const locale = localeTag(language);
  const [phase, setPhase] = useState<Phase>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState<LibraryPlan | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, LibraryDecision>>({});
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ summary: ImportSummary; lines: string[]; problems: LibraryImportItem[] } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const aliveRef = useRef(true);
  const mountedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (phase === "password") passwordRef.current?.focus();
    else headingRef.current?.focus();
  }, [phase]);

  const docsText = (n: number) => countText(n, copy.docsOne, copy.docsMany);
  const templatesText = (n: number) => countText(n, copy.templatesOne, copy.templatesMany);

  const open = async (target: File, pass?: string) => {
    setFile(target);
    setError("");
    setProgress(null);
    setPhase("reading");
    const read = await readLibraryBackup(target, pass, {
      onProgress: (done, total) => {
        if (aliveRef.current) setProgress({ done, total });
      },
    });
    if (!aliveRef.current) return;
    setProgress(null);
    if (read.ok) {
      setPlan(read.plan);
      setEncrypted(read.encrypted);
      setDecisions(defaultLibraryDecisions(read.plan));
      setPhase("preview");
      return;
    }
    if (read.reason === "needsPassword") {
      setPassword("");
      setPhase("password");
      return;
    }
    if (read.reason === "wrongPassword") {
      setPassword("");
      setError(copy.wrongPassword);
      setPhase("password");
      return;
    }
    setError(copy.readErrors[read.reason]);
    setPhase("pick");
  };

  const onPicked = (picked: File | undefined) => {
    if (picked) void open(picked);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onPicked(event.dataTransfer?.files?.[0]);
  };

  const check = plan ? checkLibraryLimits(plan, decisions) : null;
  const totals = plan ? planTotals(plan) : null;

  const apply = async () => {
    if (!plan || !check || check.wanted === 0 || !check.ok) return;
    setPhase("importing");
    const outcome = await applyLibraryBackup(plan, decisions);
    if (!aliveRef.current) return;
    if (!outcome.ok) {
      const failure = describeApplyFailure(outcome.reason);
      if (failure === "changed" && file) {
        // Otra pestaña cambió lo que se iba a reemplazar: nada se escribió; se vuelve a leer el archivo contra la
        // biblioteca de AHORA y se muestra la vista previa nueva (con las decisiones sugeridas) junto al aviso.
        const fresh = await readLibraryBackup(file, password === "" ? undefined : password);
        if (!aliveRef.current) return;
        if (fresh.ok) {
          setPlan(fresh.plan);
          setDecisions(defaultLibraryDecisions(fresh.plan));
        }
      }
      setError(copy.applyFailed[failure]);
      setPhase("preview");
      return;
    }
    const { summary } = outcome;
    const lines: string[] = [];
    if (summary.documents + summary.documentsReplaced + summary.templates + summary.templatesReplaced === 0) lines.push(copy.resultNothing);
    else {
      lines.push(fillText(copy.resultLine, { docs: docsText(summary.documents + summary.documentsReplaced), templates: templatesText(summary.templates + summary.templatesReplaced) }));
      if (summary.documentsReplaced + summary.templatesReplaced > 0) lines.push(fillText(copy.resultReplaced, { n: summary.documentsReplaced + summary.templatesReplaced }));
    }
    if (summary.skipped > 0) lines.push(fillText(copy.resultSkipped, { n: summary.skipped }));
    if (summary.reassigned > 0) lines.push(fillText(copy.resultReassigned, { n: summary.reassigned }));
    setResult({ summary, lines, problems: invalidItems(plan) });
    setError("");
    setPhase("done");
    onDone?.(
      fillText(copy.announceImported, {
        docs: docsText(summary.documents + summary.documentsReplaced),
        templates: templatesText(summary.templates + summary.templatesReplaced),
      }),
    );
  };

  useEffect(() => {
    onApplyingChange?.(phase === "importing");
    return () => onApplyingChange?.(false);
  }, [phase, onApplyingChange]);

  const working = phase === "reading" || phase === "importing";
  const statusText = error
    ? error
    : phase === "reading"
      ? progress
        ? fillText(copy.checkingPdf, { done: progress.done, total: progress.total })
        : copy.reading
      : phase === "importing"
        ? blockedAttempts > 0
          ? `${copy.importing} ${copy.closeBusy}`
          : copy.importing
        : phase === "done"
          ? (result?.lines.join(" ") ?? "")
          : "";

  return (
    <div className="space-y-4 pb-2" data-backup-import="">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {phase === "preview" || phase === "importing" ? copy.previewTitle : copy.importTitle}
      </h3>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-backup-file-input
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          onPicked(picked);
        }}
      />

      {phase === "pick" || phase === "reading" ? (
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            "space-y-3 rounded-ios-sm border border-dashed p-4 transition-colors",
            dragging ? "border-signal bg-signal/10" : "border-white/20 bg-white/5",
          )}
        >
          <p className="text-subheadline text-muted-foreground">{copy.importIntro}</p>
          <Button size="md" fullWidth wrap disabled={working} data-backup-first onClick={() => inputRef.current?.click()}>
            <FileUp aria-hidden="true" className="size-4" />
            {copy.pickZip}
          </Button>
          <p className="text-footnote text-muted-foreground">{dragging ? copy.dropZipActive : copy.dropZip}</p>
        </div>
      ) : null}

      {phase === "password" && file ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (password !== "") void open(file, password);
          }}
        >
          <p className="text-subheadline text-muted-foreground">{copy.passwordBody}</p>
          <div>
            <label htmlFor="docs-backup-import-password" className="ui-label mb-1.5 block text-muted-foreground">
              {copy.passwordLabel}
            </label>
            <input
              ref={passwordRef}
              id="docs-backup-import-password"
              type="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              className={BACKUP_INPUT_CLASS}
            />
          </div>
          <Button type="submit" size="md" fullWidth wrap disabled={password === ""}>
            {copy.passwordOpen}
          </Button>
        </form>
      ) : null}

      {(phase === "preview" || phase === "importing") && plan && check && totals ? (
        <div className="space-y-4">
          <p className="text-subheadline text-muted-foreground" data-backup-preview-intro="">
            {fillText(copy.previewIntro, { docs: docsText(totals.documents), templates: templatesText(totals.templates), enc: encrypted ? copy.previewEncrypted : "" })}
          </p>
          <ul className="space-y-2">
            {plan.items.map((item) => (
              <li key={item.key}>
                <ItemCard
                  item={item}
                  locale={locale}
                  decision={decisions[item.key]}
                  disabled={phase === "importing"}
                  onDecision={(decision) => setDecisions((current) => ({ ...current, [item.key]: decision }))}
                />
              </li>
            ))}
          </ul>
          <LibraryLimitLine plan={plan} check={check} locale={locale} />
          <Button size="md" fullWidth wrap disabled={phase === "importing" || check.wanted === 0 || !check.ok} onClick={() => void apply()} data-backup-first data-backup-confirm="">
            {check.wanted === 0 ? copy.importNothing : countText(check.wanted, copy.importConfirmOne, copy.importConfirmMany)}
          </Button>
        </div>
      ) : null}

      {phase === "done" && result ? (
        <div className="space-y-3">
          <div className="space-y-1" data-backup-result="">
            {result.lines.map((line) => (
              <p key={line} className="text-subheadline text-foreground [overflow-wrap:anywhere]">
                {line}
              </p>
            ))}
          </div>
          {result.problems.length > 0 ? (
            <div data-backup-problems="">
              <p className="text-footnote font-medium text-destructive-text">{copy.resultErrors}</p>
              <ul className="mt-1 space-y-1">
                {result.problems.map((item) => (
                  <li key={item.key} className="text-footnote text-muted-foreground [overflow-wrap:anywhere]">
                    {item.name || "—"}: {item.reason ? copy.invalidReasons[item.reason] : copy.statusInvalid}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Button size="md" fullWidth wrap onClick={onClose} data-backup-first>
            {copy.doneClose}
          </Button>
        </div>
      ) : null}

      {/* Región de estado ÚNICA. */}
      <p
        role="status"
        aria-live="polite"
        className={cn("flex items-center gap-2 text-footnote", error ? "text-destructive-text" : working ? "text-muted-foreground" : "sr-only")}
      >
        {working && !error ? <Spinner className="size-4" /> : null}
        {statusText}
      </p>
    </div>
  );
}

/** Línea de límites de la biblioteca de la vista previa («Después de importar tendrás N de 50 documentos…»); la reutiliza el paquete global (U4.7). */
export function LibraryLimitLine({ plan, check, locale }: { plan: LibraryPlan; check: LibraryLimitCheck; locale: string }) {
  const { t } = useI18n();
  const copy = t.documents.backup;
  return (
    <p className={cn("text-footnote leading-relaxed", check.ok ? "text-muted-foreground" : "text-destructive-text")} data-backup-limits="">
      {check.ok
        ? fillText(copy.limitOk, {
            docs: check.documentsAfter,
            maxDocs: plan.limits.maxDocuments,
            templates: check.templatesAfter,
            maxTemplates: plan.limits.maxTemplates,
          })
        : fillText(copy.limitExceeded, {
            fits: check.fits,
            wanted: check.wanted,
            reason: fillText(copy.limitReasons[check.blockedBy ?? "documents"], {
              max:
                check.blockedBy === "bytes"
                  ? formatBytes(plan.limits.maxTotalBytes, locale)
                  : check.blockedBy === "templates"
                    ? plan.limits.maxTemplates
                    : check.blockedBy === "perDocument"
                      ? plan.limits.maxTemplatesPerDocument
                      : plan.limits.maxDocuments,
            }),
          })}
    </p>
  );
}

/** Tarjeta de un elemento de la vista previa; la reutiliza la hoja del paquete global (U4.7). */
export function ItemCard({
  item,
  locale,
  decision,
  disabled,
  onDecision,
}: {
  item: LibraryImportItem;
  locale: string;
  decision: LibraryDecision | undefined;
  disabled: boolean;
  onDecision: (decision: LibraryDecision) => void;
}) {
  const { t } = useI18n();
  const copy = t.documents.backup;
  const options = decisionOptionsFor(item);
  const hint = hintKeyFor(item);
  const label = item.name || "—";
  const visibleRows = item.templates.filter((row) => row.status !== "invalid" || item.status === "invalid");
  return (
    <div className="surface-card rounded-ios-sm space-y-2 p-3" data-backup-item={item.key} data-status={item.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-callout font-semibold text-foreground [overflow-wrap:anywhere]">{label}</p>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-caption font-medium",
            item.status === "new" && "border-success/40 text-success-text",
            item.status === "different" && "border-signal/50 text-signal-text",
            item.status === "identical" && "border-white/20 text-muted-foreground",
            item.status === "invalid" && "border-destructive/40 text-destructive-text",
          )}
        >
          {item.duplicateOf ? copy.statusDuplicate : copy[statusLabelKey(item.status)]}
        </span>
      </div>
      {item.kind === "template" ? (
        <p className="text-footnote text-muted-foreground">{copy.kindTemplate}</p>
      ) : item.status !== "invalid" ? (
        <p className="text-caption text-muted-foreground">
          {countText(item.pageCount, t.documents.pagesOne, t.documents.pagesMany)} · {formatBytes(item.bytes, locale)} ·{" "}
          {item.templates.length === 0 ? copy.templatesNone : countText(item.templates.length, copy.templatesOne, copy.templatesMany)}
        </p>
      ) : null}
      {item.status === "invalid" && item.reason ? <p className="text-footnote text-destructive-text">{copy.invalidReasons[item.reason]}</p> : null}
      {item.kind === "document" && visibleRows.length > 0 && item.status !== "identical" ? (
        <ul className="space-y-0.5">
          {visibleRows.map((row) => (
            <li key={row.id} className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
              {fillText(copy.templateLine, {
                name: row.name,
                state:
                  row.status === "new"
                    ? copy.templateNew
                    : row.status === "identical"
                      ? copy.templateIdentical
                      : row.status === "different"
                        ? copy.templateDifferent
                        : copy.templateInvalid,
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {hint ? (
        <p className="text-footnote text-muted-foreground" data-backup-hint="">
          {fillText(copy[hint], { name: item.duplicateOf?.name ?? item.conflictWith?.name ?? item.name })}
        </p>
      ) : null}
      {options.length > 0 ? (
        <div role="radiogroup" aria-label={fillText(copy.decisionGroup, { name: label })} className="flex flex-wrap gap-1.5">
          {options.map((option) => {
            const active = decision === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                data-decision={option}
                onClick={() => onDecision(option)}
                className={cn(
                  "min-h-11 flex-1 rounded-ios-sm border px-3 py-2 text-center text-footnote leading-tight font-medium whitespace-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50 forced-colors:border-[ButtonText]",
                  active
                    ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-2 forced-colors:border-[Highlight]"
                    : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:text-foreground",
                )}
              >
                {copy[decisionLabelKey(option, item)]}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
