"use client";

import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  JPG_QUALITY_MAX,
  JPG_QUALITY_MIN,
  type PdfToImageScale,
} from "@/lib/pdf/pdfToImages";
import {
  DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
  pdfToPowerpoint,
  type PdfToPowerpointOptions,
} from "@/lib/pdf/pdfToPowerpoint";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/pdf-to-powerpoint/strings";

const TOOL = getTool("pdf-to-powerpoint");

type ScaleKey = "1" | "2" | "3";

function toScaleKey(scale: PdfToImageScale): ScaleKey {
  return String(scale) as ScaleKey;
}

function fromScaleKey(key: ScaleKey): PdfToImageScale {
  return key === "1" ? 1 : key === "3" ? 3 : 2;
}

export function PdfToPowerpointClient() {
  const { language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToPowerpointOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await pdfToPowerpoint(file, options, onProgress, signal);
      return {
        blob,
        filename: withSuffix(file.name, s.filenameSuffix, "pptx"),
      };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<PdfToPowerpointOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_PDF_TO_POWERPOINT_OPTIONS}
      progressMessage={s.progress}
      process={process}
      renderMain={() => (
        <section
          role="note"
          className="rounded-ios flex items-start gap-3 border border-amber-400/40 bg-amber-400/10 p-5"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-amber-400"
          />
          <div>
            <h3 className="text-headline text-foreground">
              {s.notEditableTitle}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {s.notEditableBody}
            </p>
          </div>
        </section>
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <div>
            <Slider
              label={s.qualityLabel}
              min={Math.round(JPG_QUALITY_MIN * 100)}
              max={Math.round(JPG_QUALITY_MAX * 100)}
              step={1}
              suffix="%"
              value={Math.round(options.quality * 100)}
              onChange={(value) => setOptions({ quality: value / 100 })}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.qualityHint}
            </p>
          </div>

          <div>
            <SegmentedControl<ScaleKey>
              label={s.scaleLabel}
              value={toScaleKey(options.scale)}
              onChange={(key) => setOptions({ scale: fromScaleKey(key) })}
              options={[
                { value: "1", label: s.scale1x },
                { value: "2", label: s.scale2x },
                { value: "3", label: s.scale3x },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.scaleHint}
            </p>
          </div>
        </>
      )}
    />
  );
}
