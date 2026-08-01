"use client";

import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_WORD_OPTIONS,
  pdfToWord,
  type PdfToWordOptions,
} from "@/lib/pdf/pdfToWord";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/pdf-to-word/strings";

const TOOL = getTool("pdf-to-word");

export function PdfToWordClient() {
  const { language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToWordOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await pdfToWord(file, options, onProgress, signal);
      return {
        blob,
        filename: withSuffix(file.name, s.filenameSuffix, "docx"),
      };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<PdfToWordOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_WORD_OPTIONS}
      progressMessage={s.progress}
      process={process}
      renderMain={() => (
        <div className="space-y-4">
          <section className="glass rounded-ios p-5">
            <h3 className="hud-label text-[11px] text-foreground">
              {s.howItWorksTitle}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {s.howItWorksBody}
            </p>
          </section>

          <section
            role="note"
            className="rounded-ios flex items-start gap-3 border border-amber-400/40 bg-amber-400/10 p-5"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-amber-400"
            />
            <div>
              <h3 className="hud-label text-[11px] text-foreground">
                {s.limitsTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.limitsBody}
              </p>
            </div>
          </section>
        </div>
      )}
    />
  );
}
