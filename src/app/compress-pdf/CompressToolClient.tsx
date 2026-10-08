"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LevelCards } from "@/app/compress-pdf/LevelCards";
import { COMPRESS_STRINGS } from "@/app/compress-pdf/strings";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n, localeTag } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  formatFileSize,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_COMPRESS_OPTIONS,
  compressPdf,
  reductionPercent,
  type CompressOptions,
} from "@/lib/pdf/compress";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("compress-pdf");

type CompressStats = {
  filename: string;
  originalSize: number;
  compressedSize: number;
  /** Modo usado en ESTA ejecucion concreta, para elegir el mensaje correcto. */
  mode: CompressOptions["mode"];
  /** `true` cuando no hubo ganancia real y se devolvio el original sin tocar. */
  alreadyOptimized: boolean;
};

/**
 * Se monta con el area de trabajo (fase de archivos) y limpia el
 * resumen de la compresion anterior: asi los numeros que se muestran
 * siempre corresponden al ultimo archivo procesado.
 */
function StatsResetProbe({ onReset }: { onReset: () => void }) {
  useEffect(() => {
    onReset();
    // Solo al montar: el objetivo es detectar la vuelta al area de trabajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function CompressToolClient() {
  const { language } = useI18n();
  const s = COMPRESS_STRINGS[language];
  const locale = localeTag(language);
  const [stats, setStats] = useState<CompressStats | null>(null);
  /**
   * Identifica la ejecucion en curso. Vuelve al area de trabajo (por
   * cancelacion, error o archivo nuevo) invalida el resumen: asi una
   * compresion cancelada no acaba mostrando numeros de un archivo que
   * nadie va a descargar.
   */
  const runRef = useRef(0);

  const clearStats = useCallback(() => {
    runRef.current += 1;
    setStats(null);
  }, []);

  const process = useCallback(
    async (
      files: File[],
      options: CompressOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const runId = runRef.current;
      const result = await compressPdf(file, options, onProgress, signal);
      const filename = withSuffix(file.name, s.filenameSuffix);
      if (runRef.current === runId) {
        setStats({
          filename,
          originalSize: result.originalSize,
          compressedSize: result.compressedSize,
          mode: options.mode,
          alreadyOptimized: result.alreadyOptimized,
        });
      }
      return { blob: result.blob, filename };
    },
    [s.filenameSuffix],
  );

  const reduction = stats
    ? reductionPercent(stats.originalSize, stats.compressedSize)
    : 0;

  return (
    <>
      <ToolShell<CompressOptions>
        tool={TOOL}
        defaultOptions={DEFAULT_COMPRESS_OPTIONS}
        process={process}
        renderMain={({ files, options }) => (
          <>
            <StatsResetProbe onReset={clearStats} />
            <section className="glass rounded-ios p-5">
              <h3 className="text-headline text-foreground">
                {s.howItWorksTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.howItWorksBody}
              </p>
              {options.mode === "flatten" ? (
                <div className="rounded-ios mt-4 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                  <p className="text-xs leading-relaxed text-foreground">
                    {s.rasterWarning}
                  </p>
                </div>
              ) : null}
              {files[0] ? (
                <p className="mt-4 text-caption text-muted-foreground tabular-nums">
                  {s.originalLabel} · {formatFileSize(files[0].size, locale)}
                </p>
              ) : null}
            </section>
          </>
        )}
        renderOptions={({ files, options, setOptions }) => (
          <>
            <LevelCards
              label={s.levelLabel}
              value={options.level}
              onChange={(level) => setOptions({ level })}
              options={[
                {
                  value: "extreme",
                  name: s.extremeName,
                  hint: s.extremeHint,
                },
                {
                  value: "recommended",
                  name: s.recommendedName,
                  hint: s.recommendedHint,
                },
                { value: "low", name: s.lowName, hint: s.lowHint },
              ]}
            />

            <Checkbox
              label={s.flattenModeLabel}
              hint={s.flattenModeHint}
              checked={options.mode === "flatten"}
              onChange={(checked) =>
                setOptions({ mode: checked ? "flatten" : "recompress" })
              }
            />

            {options.mode === "flatten" &&
            files[0] &&
            files[0].size > MAX_SAFE_FILE_SIZE ? (
              <p className="text-xs leading-relaxed text-destructive">
                {s.largeFile}
              </p>
            ) : null}
          </>
        )}
      />

      {stats ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-16 md:px-6">
          <section className="glass rounded-ios p-5">
            <h2 className="ui-label text-muted-foreground">
              {s.summaryTitle}
            </h2>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {stats.filename}
            </p>
            <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-ios border border-white/10 bg-white/5 p-4">
                <dt className="text-footnote text-muted-foreground">
                  {s.beforeLabel}
                </dt>
                <dd className="mt-1 text-lg font-bold text-foreground tabular-nums">
                  {formatFileSize(stats.originalSize, locale)}
                </dd>
              </div>
              <div className="rounded-ios border border-white/10 bg-white/5 p-4">
                <dt className="text-footnote text-muted-foreground">
                  {s.afterLabel}
                </dt>
                <dd className="mt-1 text-lg font-bold text-foreground tabular-nums">
                  {formatFileSize(stats.compressedSize, locale)}
                </dd>
              </div>
              <div className="rounded-ios border border-white/10 bg-white/5 p-4">
                <dt className="text-footnote text-muted-foreground">
                  {s.reductionLabel}
                </dt>
                <dd
                  className={
                    reduction > 0
                      ? "mt-1 text-lg font-bold text-success tabular-nums"
                      : reduction < 0
                        ? "mt-1 text-lg font-bold text-destructive tabular-nums"
                        : "mt-1 text-lg font-bold text-foreground tabular-nums"
                  }
                >
                  {reduction > 0
                    ? `−${reduction}%`
                    : reduction < 0
                      ? `+${Math.abs(reduction)}%`
                      : "0%"}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              {!stats.alreadyOptimized
                ? s.gainHint
                : stats.mode === "flatten"
                  ? s.flattenNoGainHint
                  : s.noGainHint}
            </p>
          </section>
        </div>
      ) : null}
    </>
  );
}
