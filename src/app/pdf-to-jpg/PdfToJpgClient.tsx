"use client";

import { useCallback } from "react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { slugify, type PageRef, type ProgressCallback } from "@/lib/pdf/core";
import {
  JPG_QUALITY_DEFAULT,
  JPG_QUALITY_MAX,
  JPG_QUALITY_MIN,
  pdfToImages,
  type PdfToImageScale,
} from "@/lib/pdf/pdfToImages";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/pdf-to-jpg/strings";

const TOOL = getTool("pdf-to-jpg");

type PageMode = "all" | "custom";
type ScaleKey = "1" | "2" | "3";

export type PdfToJpgToolOptions = {
  /** Calidad JPEG normalizada 0..1. */
  quality: number;
  scale: PdfToImageScale;
  mode: PageMode;
  /** Plan de paginas que produce PageThumbnailGrid. */
  pages: PageRef[];
};

const DEFAULT_OPTIONS: PdfToJpgToolOptions = {
  quality: JPG_QUALITY_DEFAULT,
  scale: 2,
  mode: "all",
  pages: [],
};

function toScaleKey(scale: PdfToImageScale): ScaleKey {
  return String(scale) as ScaleKey;
}

function fromScaleKey(key: ScaleKey): PdfToImageScale {
  return key === "1" ? 1 : key === "3" ? 3 : 2;
}

export function PdfToJpgClient() {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: PdfToJpgToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const selected =
        options.mode === "custom"
          ? options.pages
              .filter((page) => page.selected)
              .map((page) => page.pageIndex)
          : undefined;

      const result = await pdfToImages(
        files[0],
        {
          quality: options.quality,
          scale: options.scale,
          pages: selected,
          namePrefix: s.filePrefix,
        },
        onProgress,
      );

      const base =
        t.filenames["pdf-to-jpg"] ?? slugify(t.tools["pdf-to-jpg"].name);
      return {
        blob: result.blob,
        filename: `${base}.${result.kind === "zip" ? "zip" : "jpg"}`,
      };
    },
    [s.filePrefix, t],
  );

  return (
    <ToolShell<PdfToJpgToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <PageThumbnailGrid
          files={files}
          selectable={options.mode === "custom"}
          onItemsChange={(pages) => setOptions({ pages })}
        />
      )}
      renderOptions={({ options, setOptions }) => {
        const emptySelection =
          options.mode === "custom" &&
          options.pages.length > 0 &&
          options.pages.every((page) => !page.selected);

        return (
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

            <div>
              <SegmentedControl<PageMode>
                label={s.pagesLabel}
                value={options.mode}
                onChange={(mode) => setOptions({ mode })}
                options={[
                  { value: "all", label: s.pagesAll },
                  { value: "custom", label: s.pagesCustom },
                ]}
              />
              {options.mode === "custom" ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {s.pagesHint}
                </p>
              ) : null}
              {emptySelection ? (
                <p className="mt-2 text-xs leading-relaxed text-destructive">
                  {s.noPagesSelected}
                </p>
              ) : null}
            </div>

            <p className="hud-label text-[10px] leading-relaxed text-muted-foreground">
              {s.outputHint}
            </p>
          </>
        );
      }}
    />
  );
}
