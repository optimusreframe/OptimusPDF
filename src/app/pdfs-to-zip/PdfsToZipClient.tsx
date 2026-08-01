"use client";

import { useCallback } from "react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import type { ProgressCallback } from "@/lib/pdf/core";
import { pdfsToZip } from "@/lib/pdf/pdfsToZip";
import { getTool } from "@/lib/tools-registry";
import { PDFS_TO_ZIP_STRINGS } from "@/app/pdfs-to-zip/strings";

const TOOL = getTool("pdfs-to-zip");

/** Sin opciones reales: empaquetar no tiene nada que configurar (mismo
 * patron que `PdfToWordOptions`/`PdfToTextOptions` para herramientas sin
 * `renderOptions`). */
export type PdfsToZipOptions = Record<string, never>;

const DEFAULT_OPTIONS: PdfsToZipOptions = {};

export function PdfsToZipClient() {
  const { language } = useI18n();
  const s = PDFS_TO_ZIP_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      _options: PdfsToZipOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const blob = await pdfsToZip(files, onProgress, signal);
      return { blob, filename: `${s.filenameBase}.zip` };
    },
    [s.filenameBase],
  );

  return (
    <ToolShell<PdfsToZipOptions>
      tool={TOOL}
      minFiles={2}
      defaultOptions={DEFAULT_OPTIONS}
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
    />
  );
}
