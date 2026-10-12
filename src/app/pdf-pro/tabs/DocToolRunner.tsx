"use client";

import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { AlertTriangle, ChevronLeft, Wifi } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useI18n } from "@/lib/i18n";
import type { PageMm } from "@/app/pdf-pro/ops/cropMath";
import { readFirstPageMm } from "@/app/pdf-pro/ops/pageInfo";
import { getProStrings, proWarningText } from "@/app/pdf-pro/proStrings";
import { useProOperation } from "@/app/pdf-pro/useProOperation";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import type { AnyDocTool } from "@/app/pdf-pro/tabs/docToolDefinitions";
import type { DocToolContext } from "@/app/pdf-pro/tabs/docToolTypes";
import { useOperationPreview } from "@/app/pdf-pro/tabs/useOperationPreview";

export type DocToolRunnerProps = {
  tool: AnyDocTool;
  /** Vuelve al listado (el boton solo se pinta si hay). */
  onBack?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Se llama tras aplicar con exito (hubo snapshot nuevo). */
  onApplied?: () => void;
};

/**
 * Panel contextual de UNA herramienta de documento (Wave 7 · U5): opciones (el panel reutilizable de la
 * herramienta), vista previa real de la primera pagina cuando aplica, «Aplicar» con el motivo cuando no se
 * puede, progreso y cancelacion, errores tipados y el resumen del resultado. «Aplicar» crea UN snapshot con
 * una etiqueta descriptiva; deshacer es el global (Ctrl+Z).
 */
export function DocToolRunner({ tool, onBack, headingRef, onApplied }: DocToolRunnerProps) {
  const { t, language } = useI18n();
  const strings = getProStrings(language);
  const s = strings.docTools;
  const toolText = s.tools[tool.id];
  const { document } = useProWorkingDoc();
  const run = useProOperation();
  const running = run.status === "running";
  const headingId = useId();
  const reasonId = useId();

  const snapshot = document ? document.snapshots[document.cursor] : null;
  const snapshotId = snapshot?.id ?? "";
  const snapshotBytes = snapshot?.bytes ?? null;
  const [firstPage, setFirstPage] = useState<{ snapshotId: string; size: PageMm | null } | null>(null);

  useEffect(() => {
    if (!snapshotBytes) return;
    let cancelled = false;
    readFirstPageMm(snapshotId, snapshotBytes).then((size) => {
      if (!cancelled) setFirstPage({ snapshotId, size });
    });
    return () => {
      cancelled = true;
    };
  }, [snapshotId, snapshotBytes]);

  const ctx = useMemo<DocToolContext | null>(() => {
    if (!document || !snapshot) return null;
    return {
      language,
      fileName: document.name,
      pageCount: snapshot.pageCount,
      byteLength: snapshot.byteLength,
      bytes: snapshot.bytes,
      snapshotId: snapshot.id,
      signatures: document.signatures,
      wasEncrypted: document.wasEncrypted,
      firstPage: firstPage && firstPage.snapshotId === snapshot.id ? firstPage.size : null,
    };
  }, [document, snapshot, language, firstPage]);

  const [options, setOptionsState] = useState<unknown>(() => (ctx ? tool.defaults(ctx) : undefined));
  const setOptions = useMemo(
    () => (patch: Partial<unknown>) =>
      setOptionsState((previous: unknown) =>
        typeof previous === "object" && previous !== null ? { ...(previous as object), ...(patch as object) } : previous,
      ),
    [],
  );

  const preview = useOperationPreview(tool, options, ctx);

  // El resumen del resultado (p. ej. «4,5 MB → 354 KB» de Comprimir) queda bajo el pie fijo del panel: al llegar se
  // trae a la vista para que no pase desapercibido.
  const resultRef = useRef<HTMLDivElement>(null);
  const report = run.report;
  const hasReport = report !== null && report !== undefined && run.status !== "running";
  useEffect(() => {
    if (!hasReport) return;
    const frame = window.requestAnimationFrame(() => resultRef.current?.scrollIntoView?.({ block: "nearest", behavior: "auto" }));
    return () => window.cancelAnimationFrame(frame);
  }, [hasReport, report]);

  if (!ctx || !document) return null;

  const check = tool.canRun(options, ctx);
  const disabled = running || !check.ok;
  const copy = run.error ? errorCopy(t, run.error) : null;
  const Panel = tool.Panel;
  const Result = tool.Result;
  const Icon = tool.icon;
  const showSignatureWarning = document.signatures === "active" && tool.id !== "unlock";

  const onApply = async () => {
    if (disabled) return;
    const result = await run.apply(tool.operation, options, { label: tool.describe(options, ctx) });
    if (result.ok && result.snapshot) onApplied?.();
  };

  const unchanged = run.warnings.some((warning) => warning.code === "unchanged");

  return (
    <section aria-labelledby={headingId} data-doc-tool={tool.id} className="space-y-5">
      <div>
        {onBack ? (
          <Button variant="ghost" size="md" className="-ml-3 mb-1" onClick={onBack} aria-disabled={running || undefined}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            {s.launcher.back}
          </Button>
        ) : null}
        <h2
          id={headingId}
          tabIndex={-1}
          ref={headingRef}
          className="flex items-center gap-2 text-headline text-foreground outline-none"
        >
          <Icon aria-hidden="true" className="size-5 shrink-0 text-signal" />
          {toolText.title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{toolText.description}</p>
      </div>

      {tool.needsNetwork ? (
        <div className="rounded-ios-sm border border-white/10 bg-white/5 p-3" data-needs-network="">
          <Badge variant="neutral">
            <Wifi aria-hidden="true" className="mr-1 size-3" />
            {s.runner.networkBadge}
          </Badge>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.runner.networkBody}</p>
        </div>
      ) : null}

      {showSignatureWarning ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground" data-signature-warning="">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
          {proWarningText(language, { code: "signaturesInvalidated" })}
        </p>
      ) : null}

      {tool.previewOptions ? (
        <figure className="rounded-ios-sm border border-white/10 bg-white/5 p-3" data-preview={preview.status}>
          <figcaption className="ui-label mb-2 text-muted-foreground">{s.runner.previewTitle}</figcaption>
          {preview.status === "ready" ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL local: next/image no aplica.
            <img src={preview.url} alt={s.runner.previewAlt(1)} className="mx-auto max-h-60 w-auto max-w-full rounded-sm bg-white shadow-elevation-1" />
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {preview.status === "outOfRange"
                ? s.runner.previewOutOfRange
                : preview.status === "unavailable"
                  ? s.runner.previewUnavailable
                  : s.runner.previewLoading}
            </p>
          )}
        </figure>
      ) : null}

      <div className="space-y-5">
        <Panel options={options} setOptions={setOptions} ctx={ctx} />
      </div>

      <div className="material-thick sticky bottom-0 z-10 -mx-4 space-y-2 border-t border-hairline px-4 pt-3 pb-3">
        {!check.ok ? (
          <p id={reasonId} data-run-reason="" className="text-xs leading-relaxed text-muted-foreground">
            {check.reason}
          </p>
        ) : null}
        {running ? (
          <div className="flex items-center gap-3">
            <ProgressBar value={run.progress * 100} label={s.runner.applying} className="flex-1" />
            <Button variant="ghost" size="md" onClick={run.cancel}>
              {s.runner.cancel}
            </Button>
          </div>
        ) : null}
        <Button
          fullWidth
          // `aria-disabled` y no `disabled`: el boton pulsado conserva el foco mientras corre.
          aria-disabled={disabled || undefined}
          aria-describedby={!check.ok ? reasonId : undefined}
          data-apply=""
          onClick={() => void onApply()}
        >
          {running ? s.runner.applying : s.runner.apply}
        </Button>
      </div>

      {run.cancelled && !running ? (
        <p className="text-xs text-muted-foreground">{strings.suite.cancelled}</p>
      ) : null}
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
      {unchanged && !running ? (
        <p className="text-xs leading-relaxed text-muted-foreground" data-unchanged="">
          {proWarningText(language, { code: "unchanged" })}
        </p>
      ) : null}
      {Result && run.report && !running ? (
        <div ref={resultRef} className="scroll-mb-24">
          <Result report={run.report} ctx={ctx} />
        </div>
      ) : null}
    </section>
  );
}
