"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n, useT, type Dictionary } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  stripExtension,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { formatPageList, parsePageList, splitPdf } from "@/lib/pdf/split";
import { getTool } from "@/lib/tools-registry";
import {
  FieldNote,
  PageBoard,
  PageTile,
  TextField,
  fileKey,
  usePageThumbnails,
} from "@/app/organize-pdf/pageToolkit";
import { pageNotices } from "@/app/organize-pdf/pageNotices";
import {
  getExtractPagesStrings,
  type ExtractPagesStrings,
} from "@/app/extract-pages/strings";

const TOOL = getTool("extract-pages");

type ExtractOutput = "single" | "perPage";
type ListIssue = "none" | "syntax" | "empty";

export type ExtractPagesToolOptions = {
  signature: string;
  pageCount: number;
  /** Numeros de pagina 1-based seleccionados. */
  selected: number[];
  text: string;
  issue: ListIssue;
  output: ExtractOutput;
};

const DEFAULT_OPTIONS: ExtractPagesToolOptions = {
  signature: "",
  pageCount: 0,
  selected: [],
  text: "",
  issue: "none",
  output: "single",
};

function allPages(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

export function ExtractPagesToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getExtractPagesStrings(language), [language]);

  const process = useCallback(
    async (
      files: File[],
      options: ExtractPagesToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const fresh = options.signature === fileKey(file);
      const pages =
        fresh && options.selected.length > 0
          ? options.selected
          : allPages(options.pageCount);

      const baseName = stripExtension(file.name).trim() || strings.outputName;
      const output = await splitPdf(
        file,
        {
          mode: "extract",
          pages,
          separate: options.output === "perPage",
        },
        baseName,
        onProgress,
      );

      return {
        blob: output.blob,
        filename: withSuffix(
          file.name,
          strings.filenameSuffix,
          output.kind === "zip" ? "zip" : "pdf",
        ),
        notices: pageNotices(language, output.warnings),
      };
    },
    [strings, language],
  );

  return (
    <ToolShell<ExtractPagesToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      canRun={(files, options) => {
        // Hasta que el tablero lee las paginas no hay seleccion; una lista escrita mal no se aplica.
        if (options.signature !== fileKey(files[0]) || options.pageCount === 0) {
          return { ok: false, reason: "" };
        }
        if (options.issue === "syntax") return { ok: false, reason: strings.rangeInvalid };
        if (options.issue === "empty" && options.text.trim() === "") {
          return { ok: false, reason: strings.keepOne };
        }
        return options.selected.length > 0
          ? { ok: true }
          : { ok: false, reason: strings.keepOne };
      }}
      renderMain={({ files, options, setOptions }) => (
        <ExtractPagesBoard
          key={fileKey(files[0])}
          file={files[0]}
          options={options}
          onChange={setOptions}
          strings={strings}
          errors={t.tool.errors}
          pageLabel={t.tool.page}
        />
      )}
      renderOptions={({ files, options, setOptions }) => {
        const apply = (text: string) => {
          const parsed = parsePageList(text, options.pageCount);
          if (parsed === null) {
            setOptions({ text, issue: "syntax" });
            return;
          }
          if (parsed.length === 0) {
            setOptions({ text, issue: "empty" });
            return;
          }
          setOptions({ text, selected: parsed, issue: "none" });
        };

        return (
          <div className="space-y-5">
            <FieldNote>{strings.intro}</FieldNote>

            <TextField
              label={strings.rangeLabel}
              value={options.text}
              placeholder={strings.rangePlaceholder}
              invalid={options.issue !== "none"}
              hint={
                options.issue === "syntax"
                  ? strings.rangeInvalid
                  : options.issue === "empty"
                    ? strings.keepOne
                    : strings.rangeHint
              }
              onChange={apply}
            />

            <SegmentedControl<ExtractOutput>
              label={strings.outputLabel}
              value={options.output}
              onChange={(output) => setOptions({ output })}
              options={[
                { value: "single", label: strings.outputSingle },
                { value: "perPage", label: strings.outputPerPage },
              ]}
            />
            <FieldNote>
              {options.output === "single"
                ? strings.outputSingleHint
                : strings.outputPerPageHint}
            </FieldNote>

            <p className="text-sm text-foreground">
              {strings.selected(options.selected.length, options.pageCount)}
            </p>

            {options.output === "perPage" && options.selected.length > 1 ? (
              <FieldNote>
                {strings.zipNotice(options.selected.length)}
              </FieldNote>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setOptions({
                    selected: allPages(options.pageCount),
                    text: formatPageList(allPages(options.pageCount)),
                    issue: "none",
                  })
                }
              >
                {strings.selectAll}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const current = new Set(options.selected);
                  const inverted = allPages(options.pageCount).filter(
                    (page) => !current.has(page),
                  );
                  if (inverted.length === 0) {
                    setOptions({ issue: "empty" });
                    return;
                  }
                  setOptions({
                    selected: inverted,
                    text: formatPageList(inverted),
                    issue: "none",
                  });
                }}
              >
                {strings.invert}
              </Button>
            </div>

            {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
              <FieldNote tone="warning">{strings.largeFile}</FieldNote>
            ) : null}
          </div>
        );
      }}
    />
  );
}

type ExtractPagesBoardProps = {
  file: File | undefined;
  options: ExtractPagesToolOptions;
  onChange: (patch: Partial<ExtractPagesToolOptions>) => void;
  strings: ExtractPagesStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function ExtractPagesBoard({
  file,
  options,
  onChange,
  strings,
  errors,
  pageLabel,
}: ExtractPagesBoardProps) {
  const { pageCount, thumbs, loading, error } = usePageThumbnails(file);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  });

  const signature = fileKey(file);
  const fresh = options.signature === signature;

  // Por defecto se extrae el documento entero: la persona usuaria va
  // quitando lo que no le interesa.
  useEffect(() => {
    if (pageCount < 1) return;
    if (fresh && options.pageCount === pageCount) return;
    const pages = allPages(pageCount);
    changeRef.current({
      signature,
      pageCount,
      selected: pages,
      text: formatPageList(pages),
      issue: "none",
    });
  }, [fresh, options.pageCount, pageCount, signature]);

  const selected = useMemo(
    () => new Set(fresh ? options.selected : []),
    [fresh, options.selected],
  );

  const toggle = useCallback(
    (page: number) => {
      const next = new Set(selected);
      if (next.has(page)) {
        // Sin paginas no hay nada que extraer.
        if (next.size <= 1) {
          changeRef.current({ issue: "empty" });
          return;
        }
        next.delete(page);
      } else {
        next.add(page);
      }
      const list = [...next].sort((a, b) => a - b);
      changeRef.current({
        selected: list,
        text: formatPageList(list),
        issue: "none",
      });
    },
    [selected],
  );

  if (!file) return null;

  const pages = allPages(pageCount);

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        <span className="text-caption text-muted-foreground">
          {strings.selected(selected.size, pageCount)}
        </span>
      }
    >
      {pages.map((page) => {
        const marked = selected.has(page);
        return (
          <li key={page}>
            <PageTile
              number={page}
              label={`${pageLabel} ${page} — ${
                marked ? strings.unselectLabel : strings.selectLabel
              }`}
              url={thumbs[page]}
              tone={marked ? "selected" : "muted"}
              pressed={marked}
              badge={marked ? "check" : undefined}
              onSelect={() => toggle(page)}
            />
          </li>
        );
      })}
    </PageBoard>
  );
}
