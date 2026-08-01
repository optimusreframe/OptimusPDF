"use client";

import { useCallback } from "react";
import { FileText } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_TEXT_OPTIONS,
  pdfToText,
  type PdfToTextOptions,
} from "@/lib/pdf/pdfToText";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("pdf-to-text");

export function PdfToTextClient() {
  const { language } = useI18n();
  const s = PDF_TO_TEXT_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToTextOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await pdfToText(file, options, onProgress, signal);
      return {
        blob,
        filename: withSuffix(file.name, s.filenameSuffix, "txt"),
      };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<PdfToTextOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_TEXT_OPTIONS}
      process={process}
      renderMain={({ files }) => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <FileText
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-accent-convert"
            />
            <div className="min-w-0">
              <h3 className="hud-label text-[11px] text-foreground">
                {s.howItWorksTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.howItWorksBody}
              </p>
            </div>
          </div>

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <p className="mt-4 text-xs leading-relaxed text-destructive">
              {s.largeFile}
            </p>
          ) : null}
        </section>
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <Checkbox
            label={s.ocrLabel}
            hint={s.ocrHint}
            checked={options.ocrFallback}
            onChange={(checked) => setOptions({ ocrFallback: checked })}
          />
          <Checkbox
            label={s.pageSeparatorsLabel}
            hint={s.pageSeparatorsHint}
            checked={options.pageSeparators}
            onChange={(checked) => setOptions({ pageSeparators: checked })}
          />
        </>
      )}
    />
  );
}
