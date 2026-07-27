"use client";

import { useCallback, useState } from "react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CropCanvas } from "@/app/crop-pdf/CropCanvas";
import { CROP_STRINGS } from "@/app/crop-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_CROP_OPTIONS,
  cropPdf,
  type CropOptions,
  type CropScope,
} from "@/lib/pdf/crop";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("crop-pdf");

export function CropToolClient() {
  const { language } = useI18n();
  const strings = CROP_STRINGS[language];
  const [pageCount, setPageCount] = useState(0);

  const process = useCallback(
    async (
      files: File[],
      options: CropOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await cropPdf(file, options, onProgress);
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings.filenameSuffix],
  );

  return (
    <ToolShell<CropOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_CROP_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <CropCanvas
          file={files[0] ?? null}
          rect={options.rect}
          onRectChange={(rect) => setOptions({ rect })}
          pageIndex={options.pageIndex}
          onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
          pageCount={pageCount}
          onPageCount={setPageCount}
          strings={strings}
        />
      )}
      renderOptions={({ options, setOptions }) => (
        <section className="space-y-3">
          <SegmentedControl<CropScope>
            label={strings.scopeLabel}
            value={options.scope}
            options={[
              { value: "all", label: strings.scopeAll },
              { value: "current", label: strings.scopeCurrent },
            ]}
            onChange={(scope) => setOptions({ scope })}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {strings.scopeHint}
          </p>
        </section>
      )}
    />
  );
}
