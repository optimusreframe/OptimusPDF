"use client";

import { useCallback, useState } from "react";
import { EyeOff } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { RedactCanvas } from "@/app/redact-pdf/RedactCanvas";
import { REDACT_STRINGS } from "@/app/redact-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { redactPdf, type RedactBox } from "@/lib/pdf/redact";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("redact-pdf");

export type RedactToolOptions = {
  boxes: RedactBox[];
  /** Pagina visible en la vista previa (indice 0). */
  pageIndex: number;
};

const DEFAULT_OPTIONS: RedactToolOptions = { boxes: [], pageIndex: 0 };

export function RedactToolClient() {
  const { language } = useI18n();
  const s = REDACT_STRINGS[language];
  const [missingBoxes, setMissingBoxes] = useState(false);

  const process = useCallback(
    async (
      files: File[],
      options: RedactToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      if (options.boxes.length === 0) {
        setMissingBoxes(true);
        throw new PdfError("nothingSelected", "redact:noBoxes");
      }
      setMissingBoxes(false);

      const file = files[0];
      const blob = await redactPdf(file, { boxes: options.boxes }, onProgress);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<RedactToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <div className="space-y-6">
          <RedactCanvas
            file={files[0] ?? null}
            boxes={options.boxes}
            onBoxesChange={(boxes) => {
              if (boxes.length > 0) setMissingBoxes(false);
              setOptions({ boxes });
            }}
            pageIndex={options.pageIndex}
            onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
            strings={s}
          />

          {missingBoxes ? (
            <p role="alert" className="text-sm text-destructive">
              {s.noBoxes}
            </p>
          ) : null}

          <section className="glass rounded-ios p-5">
            <div className="flex items-start gap-3">
              <EyeOff
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-security"
              />
              <div className="min-w-0">
                <h3 className="hud-label text-[11px] text-foreground">
                  {s.howItWorksTitle}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.howItWorksBody}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {s.rasterWarning}
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
      renderOptions={({ files, options }) => (
        <>
          <div>
            <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
              {s.canvasTitle}
            </span>
            <p className="text-sm text-foreground tabular-nums">
              {s.totalBoxes(options.boxes.length)}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.drawHint}
          </p>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.rasterWarning}
          </p>

          {options.boxes.length === 0 ? (
            <p className="text-xs leading-relaxed text-destructive">
              {s.noBoxes}
            </p>
          ) : null}

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
