"use client";

import { useCallback } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_WORD_TO_PDF_OPTIONS,
  wordToPdf,
  type WordMargin,
  type WordOrientation,
  type WordPageSize,
  type WordToPdfOptions,
} from "@/lib/pdf/wordToPdf";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/word-to-pdf/strings";

const TOOL = getTool("word-to-pdf");

export function WordToPdfClient() {
  const { language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: WordToPdfOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await wordToPdf(file, options, onProgress, signal);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<WordToPdfOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_WORD_TO_PDF_OPTIONS}
      progressMessage={s.progress}
      process={process}
      renderMain={() => (
        <section className="glass rounded-ios p-5">
          <h3 className="hud-label text-[11px] text-foreground">
            {s.howItWorksTitle}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {s.howItWorksBody}
          </p>
        </section>
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <SegmentedControl<WordPageSize>
            label={s.pageSizeLabel}
            value={options.pageSize}
            onChange={(pageSize) => setOptions({ pageSize })}
            options={[
              { value: "a4", label: s.pageSizeA4 },
              { value: "letter", label: s.pageSizeLetter },
            ]}
          />

          <SegmentedControl<WordOrientation>
            label={s.orientationLabel}
            value={options.orientation}
            onChange={(orientation) => setOptions({ orientation })}
            options={[
              { value: "portrait", label: s.orientationPortrait },
              { value: "landscape", label: s.orientationLandscape },
            ]}
          />

          <SegmentedControl<WordMargin>
            label={s.marginLabel}
            value={options.margin}
            onChange={(margin) => setOptions({ margin })}
            options={[
              { value: "none", label: s.marginNone },
              { value: "small", label: s.marginSmall },
              { value: "large", label: s.marginLarge },
            ]}
          />
        </>
      )}
    />
  );
}
