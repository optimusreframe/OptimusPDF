"use client";

import { RotateCw, Minimize2, History, type LucideIcon } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { PRO_OPERATIONS, QUICK_OPERATION_IDS } from "@/app/pdf-pro/proOperations";
import { formatProDate, getProStrings, proOperationLabel } from "@/app/pdf-pro/proStrings";
import { useProOperation } from "@/app/pdf-pro/useProOperation";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

/** Icono de cada operacion de ejemplo (las siguientes unidades añaden el suyo). */
const OPERATION_ICONS: Record<string, LucideIcon> = {
  "rotate-all": RotateCw,
  compress: Minimize2,
};

/**
 * Panel de la pestaña «Inicio»: acciones rapidas (las operaciones registradas de documento completo)
 * y el historial de cambios del documento de trabajo, con salto a cualquier paso.
 */
export function ProHomePanel() {
  const { t, language } = useI18n();
  const s = getProStrings(language).suite;
  const { doc, document } = useProWorkingDoc();
  const run = useProOperation();
  const running = run.status === "running";
  if (!document) return null;
  const { snapshots, cursor } = document;
  const copy = run.error ? errorCopy(t, run.error) : null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="pro-quick-title">
        <h2 id="pro-quick-title" className="ui-label mb-2 text-muted-foreground">
          {s.quickTitle}
        </h2>
        <ul className="space-y-2">
          {PRO_OPERATIONS.filter((operation) => QUICK_OPERATION_IDS.includes(operation.id)).map((operation) => {
            const Icon = OPERATION_ICONS[operation.id] ?? RotateCw;
            return (
              <li key={operation.id}>
                <Button
                  variant="secondary"
                  size="md"
                  fullWidth
                  className="justify-start"
                  // `aria-disabled` y no `disabled`: el boton pulsado conserva el foco mientras corre.
                  aria-disabled={running || undefined}
                  data-operation={operation.id}
                  onClick={() => {
                    if (running) return;
                    void run.apply(operation, undefined);
                  }}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{proOperationLabel(language, operation.labelKey)}</span>
                </Button>
              </li>
            );
          })}
        </ul>
        {running ? (
          <div className="mt-3 flex items-center gap-3">
            <ProgressBar value={run.progress * 100} label={s.running} className="flex-1" />
            <Button variant="ghost" size="md" onClick={run.cancel}>
              {s.cancel}
            </Button>
          </div>
        ) : null}
        {run.cancelled && !running ? (
          <p className="mt-3 text-footnote text-muted-foreground">{s.cancelled}</p>
        ) : null}
        <div className="mt-3">
          <ErrorBanner
            show={copy !== null}
            errorKey={run.error ?? undefined}
            title={copy?.title ?? ""}
            message={copy?.message ?? ""}
            hint={copy?.hint}
            actions={errorActions(t, run.error)}
            dismissLabel={t.common.close}
            onDismiss={run.clearError}
            className="mb-0"
          />
        </div>
      </section>

      <section aria-labelledby="pro-history-title">
        <h2 id="pro-history-title" className="ui-label mb-2 flex items-center gap-1.5 text-muted-foreground">
          <History aria-hidden="true" className="size-3.5" />
          {s.historyTitle}
        </h2>
        {document.restored ? (
          <div className="mb-3 rounded-ios-sm border border-hairline bg-white/5 p-3">
            <p className="text-footnote font-semibold text-foreground">
              {s.historyRestoredTitle(formatProDate(document.restored.savedAt, language))}
            </p>
            <p className="mt-0.5 text-footnote text-muted-foreground">{s.historyRestoredBody}</p>
          </div>
        ) : null}
        {snapshots.length <= 1 ? (
          <p className="mb-2 text-footnote text-muted-foreground">{s.historyEmpty}</p>
        ) : null}
        <ol aria-label={s.historyTitle} className="space-y-1">
          {snapshots.map((snapshot, index) => {
            const current = index === cursor;
            return (
              <li key={snapshot.id}>
                <button
                  type="button"
                  aria-current={current ? "step" : undefined}
                  aria-label={current ? `${snapshot.label} (${s.historyCurrent})` : s.historyGoTo(snapshot.label)}
                  data-history-index={index}
                  onClick={() => {
                    if (!current) doc.goTo(index);
                  }}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 rounded-ios-sm px-3 text-left text-subheadline",
                    "transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                    current ? "bg-white/10 text-foreground" : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{snapshot.label}</span>
                  {current ? <Badge variant="signal">{s.historyCurrent}</Badge> : null}
                </button>
              </li>
            );
          })}
        </ol>
        {document.trimmedCount > 0 ? (
          <p className="mt-2 text-footnote text-muted-foreground">{s.historyTrimmed}</p>
        ) : null}
      </section>
    </div>
  );
}
