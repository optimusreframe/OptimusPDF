"use client";

import { useCallback } from "react";
import { Clock, Download, ScanText } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { OcrOptionsPanel } from "@/app/ocr-pdf/OcrOptionsPanel";
import { OCR_STRINGS } from "@/app/ocr-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_OCR_OPTIONS,
  ocrPdf,
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
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await ocrPdf(file, options, onProgress, signal);
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
              <h3 className="text-headline text-foreground">
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
        <OcrOptionsPanel
          options={options}
          setOptions={setOptions}
          strings={s}
          fileSize={files[0]?.size}
        />
      )}
    />
  );
}
