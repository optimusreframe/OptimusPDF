"use client";

import { useCallback } from "react";
import { AlertTriangle, FileSpreadsheet } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_CSV_OPTIONS,
  pdfToCsv,
  type PdfToCsvFormat,
  type PdfToCsvOptions,
} from "@/lib/pdf/pdfToCsv";
import { getTool } from "@/lib/tools-registry";
import { PDF_TO_CSV_STRINGS } from "@/app/pdf-to-csv/strings";

const TOOL = getTool("pdf-to-csv");

export function PdfToCsvClient() {
  const { language } = useI18n();
  const s = PDF_TO_CSV_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToCsvOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await pdfToCsv(file, options, onProgress, signal);
      return {
        blob,
        filename: withSuffix(file.name, s.filenameSuffix, options.format),
      };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<PdfToCsvOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_CSV_OPTIONS}
      progressMessage={s.progress}
      process={process}
      renderMain={() => (
        <section className="surface-card rounded-ios p-5">
          <div className="flex items-start gap-3">
            <FileSpreadsheet
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
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <SegmentedControl<PdfToCsvFormat>
            label={s.formatLabel}
            value={options.format}
            onChange={(format) => setOptions({ format })}
            options={[
              { value: "csv", label: s.formatCsv },
              { value: "json", label: s.formatJson },
            ]}
          />

          <Checkbox
            label={s.stripRepeatedLabel}
            hint={s.stripRepeatedHint}
            checked={options.stripRepeated}
            onChange={(checked) => setOptions({ stripRepeated: checked })}
          />
        </>
      )}
    />
  );
}
