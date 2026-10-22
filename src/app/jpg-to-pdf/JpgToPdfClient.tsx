"use client";

import { useCallback, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ImageQualityPicker } from "@/components/tool/ImageQualityPicker";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize, slugify, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_IMAGES_TO_PDF_OPTIONS,
  MARGINS,
  imagesToPdf,
  pageSizeInPoints,
  type ImageMargin,
  type ImageOrientation,
  type ImagePageSize,
  type ImagesToPdfOptions,
} from "@/lib/pdf/imagesToPdf";
import { PHOTOS_PER_PAGE_OPTIONS, gridShape, type PhotosPerPage } from "@/lib/pdf/photoGrid";
import { estimatePdfSize } from "@/lib/image/estimatePdfSize";
import { readStoredImagePreset, writeStoredImagePreset } from "@/lib/image/imageQualityPref";
import type { ImagePresetId } from "@/lib/image/prepareForPdf";
import { IMAGE_QUALITY_STRINGS, describeResult, fillCopy } from "@/lib/image/qualityStrings";
import { useImageProbes } from "@/lib/image/useImageProbes";
import { getTool } from "@/lib/tools-registry";
import { ImageOrderGrid } from "@/app/jpg-to-pdf/ImageOrderGrid";
import { SheetPreview } from "@/app/jpg-to-pdf/SheetPreview";
import { STRINGS } from "@/app/jpg-to-pdf/strings";
import { useImageThumbnails } from "@/app/jpg-to-pdf/useImageThumbnails";

const TOOL = getTool("jpg-to-pdf");

export type JpgToPdfToolOptions = ImagesToPdfOptions;

/**
 * `order` queda sin definir a proposito: hasta que la rejilla de
 * miniaturas emite su plan, el motor usa todas las imagenes en el orden
 * de subida. `quality` tambien: sin elegir nada se usa la ultima calidad
 * recordada en este dispositivo (o la recomendada), que se lee al pintar el
 * panel y al procesar, nunca al montar (evita desajustes de hidratacion).
 */
const DEFAULT_OPTIONS: JpgToPdfToolOptions = {
  ...DEFAULT_IMAGES_TO_PDF_OPTIONS,
  quality: undefined,
};

/** Las fotos en el orden final (`order` ya filtrado a indices validos). */
function orderedIndices(count: number, order: number[] | undefined): number[] {
  if (!order) return Array.from({ length: count }, (_, index) => index);
  return order.filter((index) => index >= 0 && index < count);
}

const PER_PAGE_VALUES = PHOTOS_PER_PAGE_OPTIONS.map(String);

export function JpgToPdfClient() {
  const { t, language } = useI18n();
  const copy = IMAGE_QUALITY_STRINGS[language];
  const locale = localeTag(language);
  const [progressText, setProgressText] = useState("");

  const process = useCallback(
    async (
      files: File[],
      options: JpgToPdfToolOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const quality: ImagePresetId = options.quality ?? readStoredImagePreset();
      setProgressText("");
      const result = await imagesToPdf(files, { ...options, quality }, onProgress, {
        signal,
        onPhotoStart: (n, total) =>
          setProgressText(fillCopy(quality === "original" ? copy.progressAdding : copy.progressOptimizing, { n, total })),
      });
      const base =
        t.filenames["jpg-to-pdf"] ?? slugify(t.tools["jpg-to-pdf"].name);
      const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
      const described = describeResult(
        copy,
        { sourceBytes: result.stats.sourceBytes, pdfBytes: result.blob.size, zip: result.kind === "zip" },
        (bytes) => formatFileSize(bytes, locale),
        (value) => percent.format(value / 100),
      );
      return {
        blob: result.blob,
        filename: `${base}.${result.kind === "zip" ? "zip" : "pdf"}`,
        summary: described.summary,
        notices: described.notices,
      };
    },
    [t, copy, locale],
  );

  return (
    <ToolShell<JpgToPdfToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      progressMessage={progressText || undefined}
      renderMain={({ files, options, setOptions }) => (
        <Workbench files={files} options={options} setOptions={setOptions} />
      )}
      renderOptions={({ files, options, setOptions }) => (
        <OptionsPanelBody files={files} options={options} setOptions={setOptions} />
      )}
    />
  );
}

type BodyProps = {
  files: File[];
  options: JpgToPdfToolOptions;
  setOptions: (patch: Partial<JpgToPdfToolOptions>) => void;
};

/** Fotos por hoja efectivas: con un PDF por imagen (ZIP) cada foto va sola. */
function effectivePerPage(options: JpgToPdfToolOptions): PhotosPerPage {
  return options.merge ? (options.photosPerPage ?? 1) : 1;
}

/** Orden de las miniaturas, vista previa de hojas y miniaturas hechas una vez para las dos. */
function Workbench({ files, options, setOptions }: BodyProps) {
  const { language } = useI18n();
  const s = STRINGS[language];
  const thumbnails = useImageThumbnails(files);
  const probes = useImageProbes(files);
  const order = useMemo(() => orderedIndices(files.length, options.order), [files.length, options.order]);
  const orderedProbes = useMemo(() => (probes ? order.map((index) => probes[index]) : null), [probes, order]);
  const orderedThumbs = useMemo(() => order.map((index) => thumbnails[index]), [thumbnails, order]);
  return (
    <>
      <SheetPreview
        className="mb-8"
        count={order.length}
        probes={orderedProbes}
        thumbnails={orderedThumbs}
        perPage={effectivePerPage(options)}
        pageSize={options.pageSize}
        orientation={options.orientation}
        margin={options.margin}
        strings={s}
      />
      <ImageOrderGrid
        files={files}
        thumbnails={thumbnails}
        onOrderChange={(next) => setOptions({ order: next })}
      />
    </>
  );
}

function OptionsPanelBody({ files, options, setOptions }: BodyProps) {
  const { language } = useI18n();
  const s = STRINGS[language];
  const quality: ImagePresetId = options.quality ?? readStoredImagePreset();
  const perPage = effectivePerPage(options);
  const ordered = useMemo(
    () => orderedIndices(files.length, options.order).map((index) => files[index]),
    [files, options.order],
  );
  const probes = useImageProbes(ordered);
  const estimate = useMemo(
    () =>
      probes
        ? estimatePdfSize(probes, quality, {
            perPage,
            pageSize: pageSizeInPoints(options.pageSize),
            orientation: options.orientation,
            margin: MARGINS[options.margin],
          })
        : null,
    [probes, quality, perPage, options.pageSize, options.orientation, options.margin],
  );

  const shape = gridShape(perPage);
  const perPageHint =
    perPage === 1
      ? s.perPageOne
      : perPage === 2
        ? s.perPageTwo
        : fillCopy(s.perPageMany, { n: perPage, rows: shape.rows });

  return (
    <>
      <ImageQualityPicker
        value={quality}
        estimate={estimate}
        onChange={(next) => {
          setOptions({ quality: next });
          writeStoredImagePreset(next);
        }}
      />

      <div>
        <div inert={!options.merge} className={options.merge ? undefined : "opacity-40"}>
          <SegmentedControl<string>
            label={s.perPageLabel}
            value={String(options.photosPerPage ?? 1)}
            onChange={(value) => setOptions({ photosPerPage: Number(value) as PhotosPerPage })}
            options={PER_PAGE_VALUES.map((value) => ({ value, label: value }))}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-per-page-hint="">
          {options.merge ? perPageHint : s.perPageZip}
        </p>
        {perPage > 1 && options.pageSize === "fit" ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.perPageFit}</p>
        ) : null}
      </div>

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

      {/* Con «Ajustar» (una foto por hoja), la orientacion la impone la propia imagen. */}
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
            options.pageSize === "fit" && perPage === 1
              ? "pointer-events-none opacity-40"
              : undefined
          }
        />
        {options.pageSize === "fit" && perPage === 1 ? (
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

      <Checkbox
        label={s.mergeLabel}
        checked={options.merge}
        onChange={(merge) => setOptions({ merge })}
        hint={options.merge ? s.mergeHintOn : s.mergeHintOff}
      />
    </>
  );
}
