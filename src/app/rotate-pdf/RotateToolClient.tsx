"use client";

import { useCallback, useMemo } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n, useT, type Dictionary } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { normalizeRotation, rotatePdf } from "@/lib/pdf/rotate";
import { getTool } from "@/lib/tools-registry";
import {
  FieldNote,
  PageBoard,
  PageTile,
  TileButton,
  fileKey,
  usePageThumbnails,
} from "@/app/organize-pdf/pageToolkit";
import { getRotateStrings, type RotateStrings } from "@/app/rotate-pdf/strings";

const TOOL = getTool("rotate-pdf");

type RotateScope = "all" | "page";

export type RotateToolOptions = {
  /** Documento al que pertenecen las rotaciones por pagina. */
  signature: string;
  scope: RotateScope;
  /** Angulo aplicado a todo el documento en modo `all`. */
  angle: number;
  /** Angulo por numero de pagina 1-based en modo `page`. */
  byPage: Record<number, number>;
};

const DEFAULT_OPTIONS: RotateToolOptions = {
  signature: "",
  scope: "all",
  angle: 90,
  byPage: {},
};

export function RotateToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getRotateStrings(language), [language]);

  const process = useCallback(
    async (
      files: File[],
      options: RotateToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const fresh = options.signature === fileKey(file);
      const plan =
        options.scope === "all"
          ? { base: normalizeRotation(options.angle) }
          : { base: 0, byPage: fresh ? options.byPage : {} };
      const blob = await rotatePdf(file, plan, onProgress);
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings],
  );

  return (
    <ToolShell<RotateToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      canRun={(files, options) =>
        // Por pagina sin ninguna girada: el PDF saldria idéntico.
        options.scope === "page" &&
        (options.signature !== fileKey(files[0]) || countTouched(options) === 0)
          ? { ok: false, reason: strings.needTurn }
          : { ok: true }
      }
      renderMain={({ files, options, setOptions }) => (
        <RotateBoard
          key={fileKey(files[0])}
          file={files[0]}
          options={options}
          onChange={setOptions}
          strings={strings}
          errors={t.tool.errors}
          pageLabel={t.tool.page}
        />
      )}
      renderOptions={({ files, options, setOptions }) => (
        <div className="space-y-5">
          <SegmentedControl<RotateScope>
            label={strings.scopeLabel}
            value={options.scope}
            onChange={(scope) => setOptions({ scope })}
            options={[
              { value: "all", label: strings.scopeAll },
              { value: "page", label: strings.scopePage },
            ]}
          />

          {options.scope === "all" ? (
            <>
              <SegmentedControl<string>
                label={strings.angleLabel}
                value={String(options.angle)}
                onChange={(value) => setOptions({ angle: Number(value) })}
                options={[
                  { value: "90", label: strings.angle90 },
                  { value: "180", label: strings.angle180 },
                  { value: "270", label: strings.angle270 },
                ]}
              />
              <FieldNote>{strings.allHint}</FieldNote>
            </>
          ) : (
            <>
              <FieldNote>{strings.pageHint}</FieldNote>
              <p className="text-sm text-foreground">
                {countTouched(options) > 0
                  ? strings.touched(countTouched(options))
                  : strings.untouched}
              </p>
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                onClick={() => setOptions({ byPage: {} })}
              >
                {strings.reset}
              </Button>
            </>
          )}

          {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
            <FieldNote tone="warning">{strings.largeFile}</FieldNote>
          ) : null}
        </div>
      )}
    />
  );
}

function countTouched(options: RotateToolOptions): number {
  return Object.values(options.byPage).filter(
    (angle) => normalizeRotation(angle) !== 0,
  ).length;
}

type RotateBoardProps = {
  file: File | undefined;
  options: RotateToolOptions;
  onChange: (patch: Partial<RotateToolOptions>) => void;
  strings: RotateStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function RotateBoard({
  file,
  options,
  onChange,
  strings,
  errors,
  pageLabel,
}: RotateBoardProps) {
  const { pageCount, thumbs, loading, error } = usePageThumbnails(file);
  const signature = fileKey(file);
  const fresh = options.signature === signature;

  const rotatePage = useCallback(
    (page: number) => {
      const current = fresh ? (options.byPage[page] ?? 0) : 0;
      const next = fresh ? { ...options.byPage } : {};
      next[page] = normalizeRotation(current + 90);
      onChange({ signature, byPage: next });
    },
    [fresh, onChange, options.byPage, signature],
  );

  const rotateAll = useCallback(() => {
    const next: Record<number, number> = {};
    for (let page = 1; page <= pageCount; page += 1) {
      const current = fresh ? (options.byPage[page] ?? 0) : 0;
      next[page] = normalizeRotation(current + 90);
    }
    onChange({ signature, byPage: next });
  }, [fresh, onChange, options.byPage, pageCount, signature]);

  if (!file) return null;

  const perPage = options.scope === "page";
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        perPage ? (
          <>
            <span className="text-caption text-muted-foreground">
              {strings.tapHint}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={rotateAll}
              // Actua sobre las paginas YA leidas: sin ellas no giraba nada, en silencio.
              disabled={pageCount === 0}
            >
              <RotateCw aria-hidden="true" className="size-4" />
              {strings.rotateAll}
            </Button>
          </>
        ) : (
          <span className="text-caption text-muted-foreground">
            {strings.allHint}
          </span>
        )
      }
    >
      {pages.map((page) => {
        const rotation = perPage
          ? fresh
            ? normalizeRotation(options.byPage[page] ?? 0)
            : 0
          : normalizeRotation(options.angle);
        return (
          <li key={page}>
            <PageTile
              number={page}
              label={`${pageLabel} ${page}`}
              url={thumbs[page]}
              rotation={rotation}
              tone={rotation === 0 ? "plain" : "selected"}
              onSelect={perPage ? () => rotatePage(page) : undefined}
              note={rotation === 0 ? undefined : `${rotation}°`}
              actions={
                perPage ? (
                  <TileButton
                    label={strings.rotatePage}
                    onClick={() => rotatePage(page)}
                  >
                    <RotateCw aria-hidden="true" className="size-4" />
                  </TileButton>
                ) : null
              }
            />
          </li>
        );
      })}
    </PageBoard>
  );
}
