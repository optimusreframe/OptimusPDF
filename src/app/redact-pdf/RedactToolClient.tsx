"use client";

import { useCallback } from "react";
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
import { redactPdf, type RedactElement } from "@/lib/pdf/redact";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("redact-pdf");

export type RedactToolOptions = {
  elements: RedactElement[];
  /** Pagina visible en la vista previa (indice 0). */
  pageIndex: number;
};

const DEFAULT_OPTIONS: RedactToolOptions = { elements: [], pageIndex: 0 };

export function RedactToolClient() {
  const { language } = useI18n();
  const s = REDACT_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: RedactToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      // `canRun` impide llegar aqui sin zonas; red de seguridad por si algo lo lanza por otra via.
      if (options.elements.length === 0) {
        throw new PdfError("nothingSelected", "redact:noBoxes");
      }

      const file = files[0];
      const blob = await redactPdf(file, { elements: options.elements }, onProgress);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<RedactToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      canRun={(_files, options) =>
        options.elements.length > 0 ? { ok: true } : { ok: false, reason: s.noBoxes }
      }
      renderMain={({ files, options, setOptions }) => (
        <div className="space-y-6">
          <RedactCanvas
            file={files[0] ?? null}
            elements={options.elements}
            onElementsChange={(elements) => setOptions({ elements })}
            pageIndex={options.pageIndex}
            onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
            strings={s}
          />

          <section className="surface-card rounded-ios p-5">
            <div className="flex items-start gap-3">
              <EyeOff
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-security"
              />
              <div className="min-w-0">
                <h3 className="text-headline text-foreground">
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
            <span className="ui-label mb-2 block text-muted-foreground">
              {s.canvasTitle}
            </span>
            <p className="text-sm text-foreground tabular-nums">
              {s.totalBoxes(options.elements.length)}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.drawHintRect}
          </p>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {s.rasterWarning}
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
