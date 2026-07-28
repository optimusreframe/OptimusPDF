"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Download,
  FileSearch,
  Info,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { ToolCard } from "@/components/tool/ToolCard";
import {
  PDFA_STRINGS,
  buildPdfaReportMarkdown,
} from "@/app/pdf-to-pdfa/strings";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { addRecentEntry } from "@/lib/recent";
import {
  downloadBlob,
  formatFileSize,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  checkPdfaCompliance,
  type PdfaCheck,
  type PdfaCheckStatus,
  type PdfaReport,
} from "@/lib/pdf/pdfaCheck";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  getRelatedTools,
  getTool,
} from "@/lib/tools-registry";

/**
 * DECISION DE FLUJO: igual que `compare-pdf`, esta herramienta no
 * produce un archivo transformado: su resultado es la lista de
 * comprobaciones en pantalla. `ToolShell` solo sabe terminar en
 * `DownloadScreen` con un `{ blob, filename }` (ver `ProcessResult` en
 * `components/tool/ToolShell.tsx`), asi que forzar el informe dentro de
 * ese contrato obligaria a convertirlo en Blob y esconder el resultado
 * detras de una descarga. Se replica su maquina de estados
 * (idle -> processing -> done) reutilizando sus mismas piezas
 * (`FileDropzone`, `ProcessingOverlay`, `ToolCard`, `lib/recent`), y la
 * descarga del informe en Markdown queda como accion secundaria.
 *
 * COPY: el titulo sale del diccionario compartido, pero la entradilla
 * viene de `strings.ts` a proposito. La descripcion global de
 * "pdf-to-pdfa" en `lib/locales/*.ts` todavia promete una CONVERSION que
 * esta herramienta no hace; ese archivo se coordina fuera de este
 * workstream. Con la entradilla local la pagina nunca promete convertir,
 * se actualice el diccionario antes o despues.
 */

const TOOL = getTool("pdf-to-pdfa");
const SLOT_TOOL = { ...TOOL, multiple: false };

type Phase = "idle" | "processing" | "done";

const STATUS_ICON = {
  pass: CheckCircle2,
  fail: XCircle,
  warn: AlertTriangle,
  unknown: CircleHelp,
} as const;

const STATUS_TONE: Record<PdfaCheckStatus, string> = {
  pass: "text-success",
  fail: "text-destructive",
  warn: "text-accent-optimize",
  unknown: "text-muted-foreground",
};

const STATUS_BADGE = {
  pass: "success",
  fail: "destructive",
  warn: "signal",
  unknown: "neutral",
} as const;

export function PdfaCheckerToolClient() {
  const { t, language } = useI18n();
  const strings = PDFA_STRINGS[language];
  const locale = localeTag(language);
  const copy = t.tools["pdf-to-pdfa"];
  const Icon = TOOL.icon;

  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [report, setReport] = useState<PdfaReport | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current = null;
    setFiles([]);
    setReport(null);
    setProgress(0);
    setError(null);
    setPhase("idle");
  }, []);

  const run = useCallback(async () => {
    const file = files[0];
    if (!file) {
      setError("empty");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setProgress(0);
    setPhase("processing");

    try {
      const output = await checkPdfaCompliance(
        file,
        (value) => {
          if (runIdRef.current !== runId) return;
          setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
        },
        controller.signal,
      );
      if (runIdRef.current !== runId) return;
      setReport(output);
      addRecentEntry("pdf-to-pdfa", file.name);
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      setPhase("idle");
    }
  }, [files]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(0);
    setError("cancelled");
    setPhase("idle");
  }, []);

  const downloadReport = useCallback(() => {
    if (!report) return;
    const markdown = buildPdfaReportMarkdown(report, strings, locale);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const dot = report.fileName.lastIndexOf(".");
    const base = (dot > 0 ? report.fileName.slice(0, dot) : report.fileName).trim();
    downloadBlob(blob, strings.reportFilename(base || "documento"));
  }, [locale, report, strings]);

  const claim = report?.claim
    ? `PDF/A-${report.claim.part}${
        report.claim.conformance ? report.claim.conformance.toLowerCase() : ""
      }`
    : null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-24 md:px-6 md:pt-12 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[TOOL.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-6", ACCENT_TEXT[TOOL.accent])}
          />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-black tracking-[-0.025em] text-foreground md:text-3xl">
              {copy.name}
            </h1>
            <Badge variant={TOOL.status === "live" ? "live" : "soon"} dot>
              {TOOL.status === "live" ? t.common.live : t.common.soon}
            </Badge>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {strings.lead}
          </p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-ios mb-6 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div>
            <p className="hud-label text-[10px] text-destructive">
              {t.tool.errors.title}
            </p>
            <p className="mt-1 text-sm text-foreground">{t.tool.errors[error]}</p>
          </div>
        </div>
      ) : null}

      <section className="rounded-ios mb-6 flex items-start gap-3 border border-white/10 bg-white/5 p-4">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div>
          <h2 className="hud-label text-[10px] text-foreground">
            {strings.noticeTitle}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.noticeBody}
          </p>
        </div>
      </section>

      {phase !== "done" ? (
        <>
          <FileDropzone
            tool={SLOT_TOOL}
            files={files}
            onFilesChange={(next) => {
              setFiles(next.slice(0, 1));
              setError(null);
            }}
            onError={setError}
          />

          <div className="mt-8 flex flex-col items-start gap-3">
            <Button
              size="lg"
              disabled={files.length === 0}
              onClick={() => void run()}
              className="w-full md:w-auto"
            >
              <FileSearch aria-hidden="true" className="size-4" />
              {strings.run}
            </Button>
            {files.length === 0 ? (
              <p className="text-xs text-muted-foreground">{strings.needFile}</p>
            ) : null}
          </div>
        </>
      ) : null}

      {phase === "processing" ? (
        <ProcessingOverlay
          progress={progress}
          message={strings.processing}
          onCancel={cancel}
        />
      ) : null}

      {phase === "done" && report ? (
        <div className="animate-rise-in">
          <section className="glass rounded-ios p-5">
            <h2 className="hud-label text-[11px] text-muted-foreground">
              {strings.summaryTitle}
            </h2>
            <div className="mt-3 flex items-start gap-3">
              <VerdictIcon verdict={report.verdict} />
              <div className="min-w-0">
                <p className="text-lg font-bold text-foreground">
                  {strings.verdictTitle[report.verdict]}
                </p>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  {strings.verdictBody[report.verdict]}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {report.failed > 0 ? (
                <Badge variant="destructive">
                  {strings.countFailed(report.failed)}
                </Badge>
              ) : null}
              {report.warnings > 0 ? (
                <Badge variant="signal">
                  {strings.countWarnings(report.warnings)}
                </Badge>
              ) : null}
              {report.unknowns > 0 ? (
                <Badge variant="neutral">
                  {strings.countUnknowns(report.unknowns)}
                </Badge>
              ) : null}
              {report.passed > 0 ? (
                <Badge variant="success">
                  {strings.countPassed(report.passed)}
                </Badge>
              ) : null}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" onClick={downloadReport}>
                <Download aria-hidden="true" className="size-3.5" />
                {strings.downloadReport}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {strings.startOver}
              </Button>
            </div>
          </section>

          <section className="mt-6">
            <h2 className="hud-label mb-3 text-[11px] text-muted-foreground">
              {strings.checklistTitle}
            </h2>
            <ul className="space-y-3">
              {report.checks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  title={strings.checkTitle[check.id]}
                  detail={strings.checkDetail(check)}
                  statusLabel={strings.statusLabel[check.status]}
                />
              ))}
            </ul>
          </section>

          <section className="glass rounded-ios mt-6 p-5">
            <h2 className="hud-label text-[11px] text-muted-foreground">
              {strings.documentTitle}
            </h2>
            <p className="mt-3 truncate text-sm font-medium text-foreground">
              {report.fileName}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="neutral">
                {report.pageCount > 0
                  ? strings.factPages(report.pageCount)
                  : strings.factPagesUnknown}
              </Badge>
              <Badge variant="neutral">
                {report.pdfVersion
                  ? strings.factVersion(report.pdfVersion)
                  : strings.factVersionUnknown}
              </Badge>
              <Badge variant="neutral">
                {formatFileSize(report.fileSize, locale)}
              </Badge>
              <Badge variant={claim ? "signal" : "neutral"}>
                {claim ? strings.factClaim(claim) : strings.factNoClaim}
              </Badge>
            </div>
          </section>

          <section className="rounded-ios mt-6 border border-white/10 bg-white/5 p-5">
            <h2 className="hud-label text-[10px] text-foreground">
              {strings.nextStepsTitle}
            </h2>
            <ul className="mt-3 space-y-2">
              {strings.nextSteps.map((step) => (
                <li
                  key={step}
                  className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="mt-2 size-1 shrink-0 rounded-full bg-current"
                  />
                  {step}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10">
            <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
              {t.tool.relatedTitle}
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {getRelatedTools("pdf-to-pdfa", 3).map((tool) => (
                <ToolCard key={tool.slug} tool={tool} compact />
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function VerdictIcon({ verdict }: { verdict: PdfaReport["verdict"] }) {
  if (verdict === "notCompliant") {
    return (
      <XCircle
        aria-hidden="true"
        className="mt-1 size-6 shrink-0 text-destructive"
      />
    );
  }
  if (verdict === "inconclusive") {
    return (
      <AlertTriangle
        aria-hidden="true"
        className="mt-1 size-6 shrink-0 text-accent-optimize"
      />
    );
  }
  return (
    <ShieldCheck
      aria-hidden="true"
      className="mt-1 size-6 shrink-0 text-success"
    />
  );
}

function CheckRow({
  check,
  title,
  detail,
  statusLabel,
}: {
  check: PdfaCheck;
  title: string;
  detail: string;
  statusLabel: string;
}) {
  const StatusIcon = STATUS_ICON[check.status];
  return (
    <li className="glass rounded-ios flex items-start gap-3 p-4">
      <StatusIcon
        aria-hidden="true"
        className={cn("mt-0.5 size-5 shrink-0", STATUS_TONE[check.status])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <Badge variant={STATUS_BADGE[check.status]}>{statusLabel}</Badge>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </div>
    </li>
  );
}
