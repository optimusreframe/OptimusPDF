"use client";

import { useCallback } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_HTML_TO_PDF_OPTIONS,
  htmlToPdf,
  type HtmlMargin,
  type HtmlOrientation,
  type HtmlPageSize,
  type HtmlToPdfOptions,
} from "@/lib/pdf/htmlToPdf";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/html-to-pdf/strings";

const TOOL = getTool("html-to-pdf");

export function HtmlToPdfToolClient() {
  const { language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: HtmlToPdfOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await htmlToPdf(file, options, onProgress, signal);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<HtmlToPdfOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_HTML_TO_PDF_OPTIONS}
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

          {/*
            La advertencia de fidelidad es obligatoria y visible: el
            usuario tiene que saber ANTES de convertir que recibe una
            captura, no un documento con texto seleccionable.
          */}
          <div className="rounded-ios mt-4 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
            <p className="text-xs leading-relaxed text-foreground">
              {s.fidelityWarning}
            </p>
          </div>

          <div className="mt-3 flex items-start gap-3">
            <ShieldCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-signal"
            />
            <div className="min-w-0">
              <h4 className="hud-label text-[10px] text-foreground">
                {s.securityTitle}
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {s.securityBody}
              </p>
            </div>
          </div>
        </section>
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <SegmentedControl<HtmlPageSize>
            label={s.pageSizeLabel}
            value={options.pageSize}
            onChange={(pageSize) => setOptions({ pageSize })}
            options={[
              { value: "a4", label: s.pageSizeA4 },
              { value: "letter", label: s.pageSizeLetter },
            ]}
          />

          <SegmentedControl<HtmlOrientation>
            label={s.orientationLabel}
            value={options.orientation}
            onChange={(orientation) => setOptions({ orientation })}
            options={[
              { value: "portrait", label: s.orientationPortrait },
              { value: "landscape", label: s.orientationLandscape },
            ]}
          />

          <div>
            <SegmentedControl<HtmlMargin>
              label={s.marginLabel}
              value={options.margin}
              onChange={(margin) => setOptions({ margin })}
              options={[
                { value: "none", label: s.marginNone },
                { value: "small", label: s.marginSmall },
                { value: "large", label: s.marginLarge },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.optionsNote}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.fidelityWarning}
          </p>
        </>
      )}
    />
  );
}
