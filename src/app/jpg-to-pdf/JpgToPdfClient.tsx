"use client";

import { useCallback } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { slugify, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_IMAGES_TO_PDF_OPTIONS,
  imagesToPdf,
  type ImageMargin,
  type ImageOrientation,
  type ImagePageSize,
  type ImagesToPdfOptions,
} from "@/lib/pdf/imagesToPdf";
import { getTool } from "@/lib/tools-registry";
import { ImageOrderGrid } from "@/app/jpg-to-pdf/ImageOrderGrid";
import { OptionCheckbox } from "@/app/jpg-to-pdf/OptionCheckbox";
import { STRINGS } from "@/app/jpg-to-pdf/strings";

const TOOL = getTool("jpg-to-pdf");

export type JpgToPdfToolOptions = ImagesToPdfOptions;

/**
 * `order` queda sin definir a proposito: hasta que la rejilla de
 * miniaturas emite su plan, el motor usa todas las imagenes en el orden
 * de subida.
 */
const DEFAULT_OPTIONS: JpgToPdfToolOptions = {
  ...DEFAULT_IMAGES_TO_PDF_OPTIONS,
};

export function JpgToPdfClient() {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: JpgToPdfToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const result = await imagesToPdf(files, options, onProgress);
      const base =
        t.filenames["jpg-to-pdf"] ?? slugify(t.tools["jpg-to-pdf"].name);
      return {
        blob: result.blob,
        filename: `${base}.${result.kind === "zip" ? "zip" : "pdf"}`,
      };
    },
    [t],
  );

  return (
    <ToolShell<JpgToPdfToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, setOptions }) => (
        <ImageOrderGrid
          files={files}
          onOrderChange={(order) => setOptions({ order })}
        />
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <SegmentedControl<ImagePageSize>
            label={s.pageSizeLabel}
            value={options.pageSize}
            onChange={(pageSize) => setOptions({ pageSize })}
            options={[
              { value: "a4", label: s.pageSizeA4 },
              { value: "letter", label: s.pageSizeLetter },
              { value: "fit", label: s.pageSizeFit },
            ]}
          />

          {/* Con «Ajustar», la orientacion la impone la propia imagen. */}
          <div>
            <SegmentedControl<ImageOrientation>
              label={s.orientationLabel}
              value={options.orientation}
              onChange={(orientation) => setOptions({ orientation })}
              options={[
                { value: "portrait", label: s.orientationPortrait },
                { value: "landscape", label: s.orientationLandscape },
                { value: "auto", label: s.orientationAuto },
              ]}
              className={
                options.pageSize === "fit"
                  ? "pointer-events-none opacity-40"
                  : undefined
              }
            />
            {options.pageSize === "fit" ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {s.fitNote}
              </p>
            ) : null}
          </div>

          <SegmentedControl<ImageMargin>
            label={s.marginLabel}
            value={options.margin}
            onChange={(margin) => setOptions({ margin })}
            options={[
              { value: "none", label: s.marginNone },
              { value: "small", label: s.marginSmall },
              { value: "large", label: s.marginLarge },
            ]}
          />

          <OptionCheckbox
            label={s.mergeLabel}
            checked={options.merge}
            onChange={(merge) => setOptions({ merge })}
            hint={options.merge ? s.mergeHintOn : s.mergeHintOff}
          />
        </>
      )}
    />
  );
}
