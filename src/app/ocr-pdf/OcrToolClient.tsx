"use client";

import { useCallback } from "react";
import { Clock, Download, ScanText } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { OCR_STRINGS } from "@/app/ocr-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_OCR_OPTIONS,
  OCR_LANGUAGES,
  ocrPdf,
  type OcrLanguage,
  type OcrOptions,
} from "@/lib/pdf/ocr";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("ocr-pdf");

export function OcrToolClient() {
  const { language } = useI18n();
  const s = OCR_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: OcrOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await ocrPdf(file, options, onProgress);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<OcrOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OCR_OPTIONS}
      process={process}
      renderMain={() => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <ScanText
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-accent-optimize"
            />
            <div className="min-w-0">
              <h3 className="hud-label text-[11px] text-foreground">
                {s.howItWorksTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.howItWorksBody}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {s.qualityNotice}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-ios flex items-start gap-3 border border-white/10 bg-white/5 p-4">
              <Download
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-xs leading-relaxed text-foreground">
                {s.downloadNotice}
              </p>
            </div>
            <div className="rounded-ios flex items-start gap-3 border border-white/10 bg-white/5 p-4">
              <Clock
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-xs leading-relaxed text-foreground">
                {s.slowNotice}
              </p>
            </div>
          </div>
        </section>
      )}
      renderOptions={({ files, options, setOptions }) => (
        <>
          <div>
            <SegmentedControl<OcrLanguage>
              label={s.languageLabel}
              value={options.language}
              onChange={(value) => setOptions({ language: value })}
              options={OCR_LANGUAGES.map((code) => ({
                value: code,
                label: s.languageNames[code],
              }))}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.languageHint}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.downloadNotice}
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
