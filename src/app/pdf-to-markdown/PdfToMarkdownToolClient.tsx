"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Eye, FileCode, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  toPdfError,
  withSuffix,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { OCR_LANGUAGES, type OcrLanguage } from "@/lib/pdf/ocr";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  pdfToMarkdown,
  type MarkdownStats,
  type PdfToMarkdownConversion,
  type PdfToMarkdownOptions,
} from "@/lib/pdf/pdfToMarkdown";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("pdf-to-markdown");

/** Tope de caracteres pintados en la vista previa (la descarga va entera). */
const PREVIEW_LIMIT = 20_000;

type PreviewState =
  | { status: "idle" }
  | { status: "running"; progress: number }
  | { status: "ready"; key: string; markdown: string; stats: MarkdownStats };

/**
 * La conversion se hace una sola vez: la vista previa guarda el
 * resultado en `cacheRef` y `process` lo reutiliza si el archivo y las
 * opciones no han cambiado. Sin esa cache, pulsar "convertir" despues de
 * previsualizar volveria a pagar el OCR entero.
 */
function cacheKey(file: File, options: PdfToMarkdownOptions): string {
  return [
    file.name,
    file.size,
    file.lastModified,
    JSON.stringify(options),
  ].join("|");
}

export function PdfToMarkdownToolClient() {
  const { language } = useI18n();
  const s = PDF_TO_MARKDOWN_STRINGS[language];

  const cacheRef = useRef<{
    key: string;
    conversion: PdfToMarkdownConversion;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  const runPreview = useCallback(
    async (
      file: File,
      options: PdfToMarkdownOptions,
      setError: (code: PdfErrorCode) => void,
    ) => {
      const key = cacheKey(file, options);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPreview({ status: "running", progress: 0 });

      try {
        const conversion = await pdfToMarkdown(
          file,
          options,
          (value) => {
            if (controller.signal.aborted) return;
            setPreview({
              status: "running",
              progress: Math.round(Math.min(1, Math.max(0, value)) * 100),
            });
          },
          controller.signal,
          s.ocrFailureMarker,
        );
        if (controller.signal.aborted) return;
        cacheRef.current = { key, conversion };
        setPreview({
          status: "ready",
          key,
          markdown: conversion.markdown,
          stats: conversion.stats,
        });
      } catch (caught) {
        if (controller.signal.aborted) {
          setPreview({ status: "idle" });
          return;
        }
        setError(toPdfError(caught).code);
        setPreview({ status: "idle" });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [s.ocrFailureMarker],
  );

  const cancelPreview = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPreview({ status: "idle" });
  }, []);

  const process = useCallback(
    async (
      files: File[],
      options: PdfToMarkdownOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const filename = withSuffix(file.name, s.filenameSuffix, "md");
      const key = cacheKey(file, options);

      const cached = cacheRef.current;
      if (cached && cached.key === key) {
        onProgress(1);
        return { blob: cached.conversion.blob, filename };
      }

      const conversion = await pdfToMarkdown(
        file,
        options,
        onProgress,
        signal,
        s.ocrFailureMarker,
      );
      cacheRef.current = { key, conversion };
      return { blob: conversion.blob, filename };
    },
    [s.filenameSuffix, s.ocrFailureMarker],
  );

  return (
    <ToolShell<PdfToMarkdownOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_MARKDOWN_OPTIONS}
      process={process}
      progressMessage={s.previewRunning}
      renderMain={({ files, options, setError }) => {
        const file = files[0];
        const currentKey = file ? cacheKey(file, options) : "";
        const stale =
          preview.status === "ready" && preview.key !== currentKey;

        return (
          <div className="space-y-4">
            <section className="surface-card rounded-ios p-5">
              <div className="flex items-start gap-3">
                <FileCode
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-accent-convert"
                />
                <div className="min-w-0">
                  <h3 className="text-headline text-foreground">
                    {s.howItWorksTitle}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {s.howItWorksBody}
                  </p>
                </div>
              </div>

              <div className="rounded-ios mt-4 flex items-start gap-3 border border-white/10 bg-white/5 p-4">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0">
                  <h4 className="text-subheadline font-semibold text-foreground">
                    {s.limitsTitle}
                  </h4>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {s.limitsBody}
                  </p>
                </div>
              </div>
            </section>

            <section className="surface-card rounded-ios p-5">
              <h3 className="text-headline text-foreground">
                {s.previewTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.previewIntro}
              </p>

              {preview.status === "running" ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Spinner label={s.previewRunning} />
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {s.previewRunning} · {preview.progress}%
                  </span>
                  <Button variant="ghost" size="sm" onClick={cancelPreview}>
                    <X aria-hidden="true" className="size-3.5" />
                    {s.previewCancel}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  disabled={!file}
                  onClick={() => {
                    if (file) void runPreview(file, options, setError);
                  }}
                >
                  {preview.status === "ready" ? (
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Eye aria-hidden="true" className="size-3.5" />
                  )}
                  {preview.status === "ready" ? s.previewRefresh : s.previewRun}
                </Button>
              )}

              {preview.status === "ready" ? (
                <div className="mt-5">
                  <PreviewStats stats={preview.stats} strings={s} />
                  {stale ? (
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {s.previewStale}
                    </p>
                  ) : null}
                  {preview.markdown.trim().length === 0 ? (
                    <p className="mt-4 text-sm text-muted-foreground">
                      {s.previewEmpty}
                    </p>
                  ) : (
                    <>
                      <pre className="rounded-ios-sm mt-4 max-h-[28rem] overflow-auto border border-white/10 bg-white/[0.03] p-4 text-xs leading-relaxed whitespace-pre-wrap text-foreground/85">
                        {preview.markdown.slice(0, PREVIEW_LIMIT)}
                      </pre>
                      {preview.markdown.length > PREVIEW_LIMIT ? (
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                          {s.previewTruncated(
                            PREVIEW_LIMIT,
                            preview.markdown.length,
                          )}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </section>
          </div>
        );
      }}
      renderOptions={({ files, options, setOptions }) => (
        <>
          <Checkbox
            label={s.headingsLabel}
            hint={s.headingsHint}
            checked={options.detectHeadings}
            onChange={(checked) => setOptions({ detectHeadings: checked })}
          />
          <Checkbox
            label={s.tablesLabel}
            hint={s.tablesHint}
            checked={options.detectTables}
            onChange={(checked) => setOptions({ detectTables: checked })}
          />
          <Checkbox
            label={s.stripRepeatedLabel}
            hint={s.stripRepeatedHint}
            checked={options.stripRepeated}
            onChange={(checked) => setOptions({ stripRepeated: checked })}
          />
          <Checkbox
            label={s.pageSeparatorsLabel}
            hint={s.pageSeparatorsHint}
            checked={options.pageSeparators}
            onChange={(checked) => setOptions({ pageSeparators: checked })}
          />
          <Checkbox
            label={s.ocrLabel}
            hint={s.ocrHint}
            checked={options.ocrFallback}
            onChange={(checked) => setOptions({ ocrFallback: checked })}
          />

          {options.ocrFallback ? (
            <div>
              <SegmentedControl<OcrLanguage>
                label={s.ocrLanguageLabel}
                value={options.ocrLanguage}
                onChange={(value) => setOptions({ ocrLanguage: value })}
                options={OCR_LANGUAGES.map((code) => ({
                  value: code,
                  label: s.ocrLanguageNames[code],
                }))}
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {s.ocrNotice}
              </p>
            </div>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.limitsBody}
          </p>

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <p className="text-xs leading-relaxed text-destructive">
              {s.largeFile}
            </p>
          ) : null}
        </>
      )}
    />
  );
}

function PreviewStats({
  stats,
  strings,
}: {
  stats: MarkdownStats;
  strings: typeof PDF_TO_MARKDOWN_STRINGS.es;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="neutral">{strings.statPages(stats.pages)}</Badge>
      {stats.ocrPages > 0 ? (
        <Badge variant="signal">{strings.statOcrPages(stats.ocrPages)}</Badge>
      ) : null}
      {stats.ocrFailedPages > 0 ? (
        <Badge variant="destructive">
          {strings.statOcrFailedPages(stats.ocrFailedPages)}
        </Badge>
      ) : null}
      {stats.headings > 0 ? (
        <Badge variant="neutral">{strings.statHeadings(stats.headings)}</Badge>
      ) : null}
      {stats.listItems > 0 ? (
        <Badge variant="neutral">{strings.statListItems(stats.listItems)}</Badge>
      ) : null}
      {stats.tables > 0 ? (
        <Badge variant="neutral">{strings.statTables(stats.tables)}</Badge>
      ) : null}
      {stats.codeBlocks > 0 ? (
        <Badge variant="neutral">
          {strings.statCodeBlocks(stats.codeBlocks)}
        </Badge>
      ) : null}
      <Badge variant="neutral">{strings.statCharacters(stats.characters)}</Badge>
    </div>
  );
}
