"use client";

import { useCallback } from "react";
import { AlertTriangle, Braces } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { PDF_TO_JSON_STRINGS } from "@/app/pdf-to-json/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_JSON_OPTIONS,
  pdfToJson,
  type PdfToJsonOptions,
} from "@/lib/pdf/pdfToJson";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("pdf-to-json");

export function PdfToJsonClient() {
  const { language } = useI18n();
  const s = PDF_TO_JSON_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToJsonOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await pdfToJson(file, options, onProgress, signal);
      return {
        blob,
        filename: withSuffix(file.name, s.filenameSuffix, "json"),
      };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<PdfToJsonOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_JSON_OPTIONS}
      process={process}
      renderMain={({ files }) => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <Braces
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

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <p className="mt-4 text-xs leading-relaxed text-destructive">
              {s.largeFile}
            </p>
          ) : null}
        </section>
      )}
      renderOptions={({ options, setOptions }) => (
        <Checkbox
          label={s.ocrLabel}
          hint={s.ocrHint}
          checked={options.ocrFallback}
          onChange={(checked) => setOptions({ ocrFallback: checked })}
        />
      )}
    />
  );
}
