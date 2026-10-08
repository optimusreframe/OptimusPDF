"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, GitCompare, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { ToolCard } from "@/components/tool/ToolCard";
import { DiffColumn } from "@/app/compare-pdf/DiffColumn";
import { COMPARE_STRINGS } from "@/app/compare-pdf/strings";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { addRecentEntry } from "@/lib/recent";
import {
  formatFileSize,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import { comparePdfFiles, type CompareResult } from "@/lib/pdf/compare";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  getRelatedTools,
  getTool,
  type Tool,
} from "@/lib/tools-registry";

/**
 * DECISION DE FLUJO: esta herramienta no produce un archivo, muestra el
 * resultado en pantalla. `ToolShell` solo sabe terminar en
 * `DownloadScreen` con un Blob y modificarlo queda fuera del alcance de
 * este workstream, asi que aqui se replica su maquina de estados
 * (idle -> processing -> done) reutilizando sus mismas piezas:
 * `FileDropzone`, `ProcessingOverlay`, `ToolCard` y el historial de
 * `lib/recent`. Unificarlo (por ejemplo, con un `renderDone` opcional en
 * `ToolShell`) es trabajo posterior.
 */

const TOOL = getTool("compare-pdf");
/** Cada hueco acepta exactamente un archivo. */
const SLOT_TOOL: Tool = { ...TOOL, multiple: false };

type Phase = "idle" | "processing" | "done";

export function CompareToolClient() {
  const { t, language } = useI18n();
  const strings = COMPARE_STRINGS[language];
  const copy = t.tools["compare-pdf"];
  const Icon = TOOL.icon;

  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setFileA(null);
    setFileB(null);
    setResult(null);
    setProgress(0);
    setError(null);
    setOnlyChanged(true);
    setPhase("idle");
  }, []);

  const run = useCallback(async () => {
    if (!fileA || !fileB) {
      setError("needTwo");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setError(null);
    setProgress(0);
    setPhase("processing");

    try {
      const output = await comparePdfFiles(fileA, fileB, (value) => {
        if (runIdRef.current !== runId) return;
        setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      addRecentEntry("compare-pdf", fileB.name);
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      setPhase("idle");
    }
  }, [fileA, fileB]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    setProgress(0);
    setError("cancelled");
    setPhase("idle");
  }, []);

  const visiblePages =
    result?.pages.filter((page) => !onlyChanged || page.changed) ?? [];

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-24 md:px-6 md:pt-12 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[TOOL.accent],
          )}
        >
          <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title-1 text-foreground">
              {copy.name}
            </h1>
            <Badge variant="live" dot>
              {t.common.live}
            </Badge>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {copy.description}
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
            <p className="ui-label text-destructive-text">
              {t.tool.errors.title}
            </p>
            <p className="mt-1 text-sm text-foreground">{t.tool.errors[error]}</p>
          </div>
        </div>
      ) : null}

      {phase !== "done" ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <CompareSlot
              title={strings.slotA}
              hint={strings.slotHintA}
              replaceLabel={strings.replace}
              file={fileA}
              onFileChange={setFileA}
              onError={setError}
              locale={localeTag(language)}
            />
            <CompareSlot
              title={strings.slotB}
              hint={strings.slotHintB}
              replaceLabel={strings.replace}
              file={fileB}
              onFileChange={setFileB}
              onError={setError}
              locale={localeTag(language)}
            />
          </div>

          <div className="mt-8 flex flex-col items-start gap-3">
            <Button
              size="lg"
              disabled={!fileA || !fileB}
              onClick={() => void run()}
              className="w-full md:w-auto"
            >
              <GitCompare aria-hidden="true" className="size-4" />
              {strings.run}
            </Button>
            {!fileA || !fileB ? (
              <p className="text-xs text-muted-foreground">{strings.needBoth}</p>
            ) : null}
            <p className="text-footnote text-muted-foreground">
              {t.tool.localNotice}
            </p>
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

      {phase === "done" && result ? (
        <div className="animate-rise-in">
          <section className="glass rounded-ios p-5">
            <h2 className="ui-label text-muted-foreground">
              {strings.summaryTitle}
            </h2>
            <p className="mt-3 text-lg font-bold text-foreground">
              {result.changedPages.length === 0
                ? strings.noChanges
                : strings.changedPages(result.changedPages.length)}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Badge variant="success">
                {strings.addedWords(result.totalAdded)}
              </Badge>
              <Badge variant="destructive">
                {strings.removedWords(result.totalRemoved)}
              </Badge>
              <Badge variant="neutral">
                {strings.pagesCompared(result.pages.length)}
              </Badge>
              <Badge variant="neutral">
                {strings.documentSizes(result.pageCountA, result.pageCountB)}
              </Badge>
            </div>
            {result.noTextLayer ? (
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                {strings.noTextLayer}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOnlyChanged((previous) => !previous)}
              >
                {onlyChanged ? strings.showAll : strings.showOnlyChanged}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {strings.startOver}
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap gap-4">
              <Legend className="bg-white/15" label={strings.legendEqual} />
              <Legend className="bg-success" label={strings.legendAdded} />
              <Legend className="bg-destructive" label={strings.legendRemoved} />
            </div>
          </section>

          <div className="mt-6 space-y-4">
            {visiblePages.map((page) => (
              <section key={page.pageNumber} className="glass rounded-ios p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-subheadline font-semibold text-foreground">
                    {strings.pageLabel(page.pageNumber)}
                  </h3>
                  {page.changed ? (
                    <>
                      {page.added > 0 ? (
                        <Badge variant="success">
                          +{page.added}
                        </Badge>
                      ) : null}
                      {page.removed > 0 ? (
                        <Badge variant="destructive">-{page.removed}</Badge>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {page.coarse ? (
                  <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                    {strings.coarseNotice}
                  </p>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <DiffColumn
                    title={strings.slotA}
                    tokens={page.left}
                    emptyMessage={
                      page.existsInA ? strings.emptyPage : strings.missingInA
                    }
                  />
                  <DiffColumn
                    title={strings.slotB}
                    tokens={page.right}
                    emptyMessage={
                      page.existsInB ? strings.emptyPage : strings.missingInB
                    }
                  />
                </div>
              </section>
            ))}
          </div>

          <section className="mt-10">
            <h3 className="ui-label mb-4 text-muted-foreground">
              {t.tool.relatedTitle}
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {getRelatedTools("compare-pdf", 3).map((tool) => (
                <ToolCard key={tool.slug} tool={tool} compact />
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className={cn("size-2.5 rounded-full", className)} />
      <span className="text-caption text-muted-foreground">{label}</span>
    </span>
  );
}

function CompareSlot({
  title,
  hint,
  replaceLabel,
  file,
  onFileChange,
  onError,
  locale,
}: {
  title: string;
  hint: string;
  replaceLabel: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
  onError: (code: PdfErrorCode) => void;
  locale: string;
}) {
  return (
    <div>
      <h2 className="ui-label mb-1.5 text-muted-foreground">
        {title}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">{hint}</p>
      {file ? (
        <div className="glass rounded-ios flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {file.name}
            </p>
            <p className="mt-1 text-footnote text-muted-foreground tabular-nums">
              {formatFileSize(file.size, locale)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={replaceLabel}
            title={replaceLabel}
            onClick={() => onFileChange(null)}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : (
        <FileDropzone
          tool={SLOT_TOOL}
          files={[]}
          onFilesChange={(next) => onFileChange(next[0] ?? null)}
          onError={onError}
          compact
        />
      )}
    </div>
  );
}
