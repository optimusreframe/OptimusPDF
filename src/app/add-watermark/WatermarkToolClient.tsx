"use client";

import { useCallback, useMemo } from "react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { WatermarkOptionsPanel } from "@/app/add-watermark/WatermarkOptionsPanel";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { useI18n } from "@/lib/i18n";
import { toWinAnsiSafe, withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_WATERMARK_OPTIONS,
  addWatermark,
  type WatermarkOptions,
} from "@/lib/pdf/watermark";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("add-watermark");

export function WatermarkToolClient() {
  const { language } = useI18n();
  const strings = WATERMARK_STRINGS[language];

  // Arrancar con un texto real evita el estado vacío inicial (y el error
  // genérico que produciría) sin quitarle al usuario el control.
  const defaultOptions = useMemo<WatermarkOptions>(
    () => ({ ...DEFAULT_WATERMARK_OPTIONS, text: strings.textPlaceholder }),
    [strings.textPlaceholder],
  );

  const process = useCallback(
    async (
      files: File[],
      options: WatermarkOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await addWatermark(file, options, onProgress);
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings.filenameSuffix],
  );

  return (
    <ToolShell<WatermarkOptions>
      tool={TOOL}
      defaultOptions={defaultOptions}
      process={process}
      canRun={(_files, options) => {
        // Una marca sin texto (o sin imagen) no estampa nada.
        if (options.kind === "text" && toWinAnsiSafe(options.text.trim()).length === 0) {
          return { ok: false, reason: strings.textRequired };
        }
        if (options.kind === "image" && !options.image) {
          return { ok: false, reason: strings.imageRequired };
        }
        return { ok: true };
      }}
      renderMain={({ files }) => <PageThumbnailGrid files={files} />}
      renderOptions={({ options, setOptions }) => (
        <WatermarkOptionsPanel
          options={options}
          setOptions={setOptions}
          strings={strings}
        />
      )}
    />
  );
}
