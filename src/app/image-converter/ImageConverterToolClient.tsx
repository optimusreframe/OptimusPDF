"use client";

import { useCallback, useId, useRef, useState, type RefObject } from "react";
import { useIsClient } from "@/hooks/useIsClient";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { localeTag, useI18n, type Language } from "@/lib/i18n";
import { isIosWebKit } from "@/lib/image/platform";
import { createBrowserBackend, probeOutputSupport, yieldToMain } from "@/lib/media/image/browserBackend";
import {
  convertImages,
  errorCodeForFailures,
  packConvertedImages,
  type ConvertOutcome,
} from "@/lib/media/image/convert";
import {
  OUTPUT_FORMAT_INFO,
  needsBackground,
  splitFormats,
  type OutputFormat,
  type OutputSupport,
} from "@/lib/media/image/formats";
import { MAX_MAX_WIDTH, MIN_MAX_WIDTH, limitsFor, type ResizeSpec } from "@/lib/media/image/sizing";
import { PdfError, formatFileSize, type ProgressCallback } from "@/lib/pdf/core";
import { getTool } from "@/lib/tools-registry";
import { ConvertedDetails, rememberConvertedRows } from "@/app/image-converter/ConvertedDetails";
import { ImageProblems } from "@/app/image-converter/ImageProblems";
import { problemReason } from "@/app/image-converter/problemText";
import { STRINGS, fill, type ImageConverterStrings } from "@/app/image-converter/strings";
import { useConverterProblems, type ConverterProblemEntry } from "@/app/image-converter/useConverterProblems";
import { useOutputSupport } from "@/app/image-converter/useOutputSupport";

const TOOL = getTool("image-converter");

type ResizeMode = ResizeSpec["mode"];

export type ImageConverterOptions = {
  format: OutputFormat;
  /** 1-100. */
  quality: number;
  resizeMode: ResizeMode;
  maxWidth: number;
  percent: number;
  /** `#rrggbb`. */
  background: string;
};

const DEFAULT_OPTIONS: ImageConverterOptions = {
  format: "jpeg",
  quality: 90,
  resizeMode: "original",
  maxWidth: 1920,
  percent: 50,
  background: "#ffffff",
};

function resizeSpec(options: ImageConverterOptions): ResizeSpec {
  if (options.resizeMode === "maxWidth") return { mode: "maxWidth", maxWidth: options.maxWidth };
  if (options.resizeMode === "percent") return { mode: "percent", percent: options.percent };
  return { mode: "original" };
}

/**
 * Avisos de la pantalla de descarga: las imagenes que NO se convirtieron (con su motivo) y las que se redujeron mas de lo pedido
 * por el limite del dispositivo. `PartialFailureReport` no se usa a proposito: su texto fijo habla de «documentos firmados».
 */
function buildNotices(s: ImageConverterStrings, language: Language, outcome: ConvertOutcome): ProcessResult["notices"] {
  const capped = outcome.items.filter((item) => item.capped);
  if (outcome.failures.length === 0 && capped.length === 0) return undefined;
  const total = outcome.items.length + outcome.failures.length;
  const counts = { ok: outcome.items.length, total };
  const title =
    outcome.failures.length > 0 && capped.length > 0
      ? s.noticeTitleBoth
      : outcome.failures.length > 0
        ? s.noticeTitleFailures
        : s.noticeTitleCapped;
  return {
    title: fill(title, counts),
    items: [
      ...outcome.failures.map((failure) => fill(s.noticeFailureLine, { name: failure.sourceName, reason: problemReason(language, failure.problem) })),
      ...capped.map((item) => fill(s.noticeCappedLine, { name: item.sourceName, width: item.width, height: item.height })),
    ],
  };
}

export function ImageConverterToolClient() {
  const { language } = useI18n();
  const s = STRINGS[language];
  const locale = localeTag(language);
  const { support } = useOutputSupport();
  // El peso maximo que dice la zona de carga es el de ESTE aparato (64 MB; 32 MB en iPhone/iPad), no los 100 MB de los PDF. En el
  // servidor y durante la hidratacion vale el de escritorio (misma cifra que se pinta alli: sin desajuste).
  const isClient = useIsClient();
  const maxFileBytes = limitsFor(isClient && isIosWebKit()).maxFileBytes;
  const [progressText, setProgressText] = useState("");
  /** Imagenes que fallaron en la ultima conversion cuando NINGUNA salio (si salio alguna, el resultado las nombra). */
  const [failed, setFailed] = useState<ConverterProblemEntry[]>([]);
  /** `ToolShell` la rellena: quita varias imagenes de la lista (el aviso «Quitar y continuar»). */
  const removeFilesRef = useRef<((files: File[]) => void) | null>(null);

  const process = useCallback(
    async (files: File[], options: ImageConverterOptions, onProgress: ProgressCallback, signal: AbortSignal): Promise<ProcessResult> => {
      setProgressText("");
      setFailed([]);
      // Se vuelve a comprobar aqui: lo que se pinto era la respuesta de hace un rato y solo cuesta un lienzo de 2 x 2.
      const available = await probeOutputSupport();
      if (!available[options.format]) throw new PdfError("invalidType");
      const info = OUTPUT_FORMAT_INFO[options.format];
      const outcome = await convertImages(
        files,
        { format: options.format, quality: options.quality, resize: resizeSpec(options), background: options.background, suffix: s.filenameSuffix },
        {
          backend: createBrowserBackend(),
          limits: limitsFor(isIosWebKit()),
          signal,
          onProgress,
          onFileStart: (n, total) => setProgressText(fill(s.progressFile, { n, total })),
          yieldToMain,
        },
      );
      if (outcome.items.length === 0) {
        setFailed(outcome.failures.map((failure) => ({ file: files[failure.index], problem: failure.problem })));
        throw new PdfError(errorCodeForFailures(outcome.failures));
      }
      const packed = await packConvertedImages(outcome.items, s.zipName, options.format);
      rememberConvertedRows(
        packed.blob,
        outcome.items.map((item) => ({
          sourceName: item.sourceName,
          outputName: item.outputName,
          sourceBytes: item.sourceBytes,
          outputBytes: item.blob.size,
          width: item.width,
          height: item.height,
          capped: item.capped,
        })),
      );
      const size = (bytes: number): string => formatFileSize(bytes, locale);
      const summary =
        outcome.items.length === 1
          ? fill(s.summaryOne, { format: info.label, before: size(outcome.sourceBytes), after: size(outcome.outputBytes) })
          : fill(s.summaryMany, { n: outcome.items.length, format: info.label, before: size(outcome.sourceBytes), after: size(outcome.outputBytes) });
      return { blob: packed.blob, filename: packed.filename, summary, subtitle: s.doneSubtitle, notices: buildNotices(s, language, outcome) };
    },
    [s, language, locale],
  );

  return (
    <ToolShell<ImageConverterOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      dropzoneMaxBytes={maxFileBytes}
      progressMessage={progressText || undefined}
      removeFilesRef={removeFilesRef}
      renderMain={({ files }) => <Workbench files={files} failed={failed} removeFilesRef={removeFilesRef} />}
      renderOptions={({ files, options, setOptions }) => (
        <OptionsPanelBody files={files} options={options} setOptions={setOptions} support={support} />
      )}
      renderDownloadExtras={({ result }) => <ConvertedDetails result={result.blob} />}
    />
  );
}

type WorkbenchProps = {
  files: File[];
  failed: readonly ConverterProblemEntry[];
  removeFilesRef: RefObject<((files: File[]) => void) | null>;
};

/** El aviso de imagenes inservibles, sobre la lista de archivos. */
function Workbench({ files, failed, removeFilesRef }: WorkbenchProps) {
  const problems = useConverterProblems(files, failed);
  return <ImageProblems problems={problems} onRemove={() => removeFilesRef.current?.(problems.map((entry) => entry.file))} />;
}

type OptionsProps = {
  files: File[];
  options: ImageConverterOptions;
  setOptions: (patch: Partial<ImageConverterOptions>) => void;
  support: OutputSupport;
};

const hintClass = "mt-2 text-xs leading-relaxed text-muted-foreground";

/** ¿Alguno de los archivos es un GIF? (por tipo o por extension: el aviso del primer fotograma solo sale entonces.) */
function hasGif(files: readonly File[]): boolean {
  return files.some((file) => file.type === "image/gif" || /\.gif$/i.test(file.name));
}

function OptionsPanelBody({ files, options, setOptions, support }: OptionsProps) {
  const { language } = useI18n();
  const s = STRINGS[language];
  const { available, unavailable } = splitFormats(support);
  const info = OUTPUT_FORMAT_INFO[options.format];

  return (
    <>
      <div>
        <SegmentedControl<OutputFormat>
          wrap
          label={s.formatLabel}
          value={options.format}
          onChange={(format) => setOptions({ format })}
          options={available.map((format) => ({ value: format, label: OUTPUT_FORMAT_INFO[format].label }))}
        />
        {unavailable.length > 0 ? (
          <p className={hintClass} data-unavailable-formats="">
            {fill(s.unavailableNote, { formats: unavailable.map((format) => OUTPUT_FORMAT_INFO[format].label).join(", ") })}
          </p>
        ) : null}
      </div>

      {info.lossy ? (
        <div>
          <Slider
            label={s.qualityLabel}
            min={1}
            max={100}
            step={1}
            suffix="%"
            value={options.quality}
            onChange={(quality) => setOptions({ quality })}
          />
          <p className={hintClass}>{s.qualityHint}</p>
        </div>
      ) : (
        <p className={hintClass}>{options.format === "bmp" ? s.bmpHint : s.losslessHint}</p>
      )}

      <div>
        <SegmentedControl<ResizeMode>
          wrap
          label={s.sizeLabel}
          value={options.resizeMode}
          onChange={(resizeMode) => setOptions({ resizeMode })}
          options={[
            { value: "original", label: s.sizeOriginal },
            { value: "maxWidth", label: s.sizeMaxWidth },
            { value: "percent", label: s.sizePercent },
          ]}
        />
        {options.resizeMode === "maxWidth" ? (
          <div className="mt-3">
            <WidthField label={s.maxWidthLabel} value={options.maxWidth} onChange={(maxWidth) => setOptions({ maxWidth })} />
            <p className={hintClass}>{s.maxWidthHint}</p>
          </div>
        ) : null}
        {options.resizeMode === "percent" ? (
          <div className="mt-3">
            <Slider label={s.percentLabel} min={5} max={100} step={5} suffix="%" value={options.percent} onChange={(percent) => setOptions({ percent })} />
            <p className={hintClass}>{s.percentHint}</p>
          </div>
        ) : null}
      </div>

      {needsBackground(options.format) ? (
        <div>
          <ColorField label={s.backgroundLabel} value={options.background} onChange={(background) => setOptions({ background })} />
          <p className={hintClass}>{fill(s.backgroundHint, { format: info.label })}</p>
        </div>
      ) : null}

      <p className="text-footnote leading-relaxed text-muted-foreground">
        {s.privacyNote}
        {hasGif(files) ? ` ${s.gifNote}` : ""}
      </p>
    </>
  );
}

const fieldClass =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground tabular-nums transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

/**
 * Ancho en pixeles. Se escribe como texto y se confirma al soltar el campo: con un campo numerico que recorta en cada tecla,
 * escribir «1920» se quedaba en «16» al pulsar la primera cifra.
 */
function WidthField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string): void => {
    const next = Number.parseInt(text, 10);
    if (Number.isFinite(next)) onChange(Math.min(MAX_MAX_WIDTH, Math.max(MIN_MAX_WIDTH, next)));
    setDraft(null);
  };
  return (
    <div>
      <label htmlFor={id} className="ui-label mb-1.5 block text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
        }}
        className={fieldClass}
      />
    </div>
  );
}

/** Color de fondo: la muestra nativa (selector del sistema) y su valor en texto, que el color solo no dice. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="ui-label mb-1.5 block text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-16 cursor-pointer rounded-ios-sm border border-white/14 bg-white/5 p-1 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
        />
        <span className="text-sm text-foreground tabular-nums uppercase" aria-hidden="true">
          {value}
        </span>
      </div>
    </div>
  );
}
