"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n, useT, type Dictionary } from "@/lib/i18n";
import { MAX_SAFE_FILE_SIZE, type ProgressCallback } from "@/lib/pdf/core";
import { removePdfPages } from "@/lib/pdf/removePages";
import { formatPageList, parsePageList } from "@/lib/pdf/split";
import { getTool } from "@/lib/tools-registry";
import {
  FieldNote,
  PageBoard,
  PageTile,
  TextField,
  fileKey,
  usePageThumbnails,
} from "@/app/organize-pdf/pageToolkit";
import {
  getRemovePagesStrings,
  type RemovePagesStrings,
} from "@/app/remove-pages/strings";

const TOOL = getTool("remove-pages");

/** Motivo por el que la lista escrita a mano no se ha podido aplicar. */
type ListIssue = "none" | "syntax" | "all";

export type RemovePagesToolOptions = {
  signature: string;
  pageCount: number;
  /** Numeros de pagina 1-based marcados para eliminar. */
  removed: number[];
  /** Texto tal cual lo escribe la persona usuaria. */
  text: string;
  issue: ListIssue;
};

const DEFAULT_OPTIONS: RemovePagesToolOptions = {
  signature: "",
  pageCount: 0,
  removed: [],
  text: "",
  issue: "none",
};

export function RemovePagesToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getRemovePagesStrings(language), [language]);

  const process = useCallback(
    async (
      files: File[],
      options: RemovePagesToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const fresh = options.signature === fileKey(file);
      const blob = await removePdfPages(
        file,
        { remove: fresh ? options.removed : [] },
        onProgress,
      );
      return { blob, filename: `${strings.outputName}.pdf` };
    },
    [strings],
  );

  return (
    <ToolShell<RemovePagesToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <RemovePagesBoard
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
          if (
            options.pageCount > 0 &&
            parsed.length >= options.pageCount
          ) {
            setOptions({ text, issue: "all" });
            return;
          }
          setOptions({ text, removed: parsed, issue: "none" });
        };

        const kept = Math.max(0, options.pageCount - options.removed.length);

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
                  : options.issue === "all"
                    ? strings.keepLast
                    : strings.rangeHint
              }
              onChange={apply}
            />

            <p className="text-sm text-foreground">
              {options.removed.length === 0
                ? strings.markedNone
                : `${strings.marked(options.removed.length)} · ${strings.kept(
                    kept,
                    options.pageCount,
                  )}`}
            </p>

            <Button
              variant="secondary"
              size="sm"
              fullWidth
              disabled={options.removed.length === 0}
              onClick={() =>
                setOptions({ removed: [], text: "", issue: "none" })
              }
            >
              {strings.clear}
            </Button>

            {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
              <FieldNote tone="warning">{strings.largeFile}</FieldNote>
            ) : null}
          </div>
        );
      }}
    />
  );
}

type RemovePagesBoardProps = {
  file: File | undefined;
  options: RemovePagesToolOptions;
  onChange: (patch: Partial<RemovePagesToolOptions>) => void;
  strings: RemovePagesStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function RemovePagesBoard({
  file,
  options,
  onChange,
  strings,
  errors,
  pageLabel,
}: RemovePagesBoardProps) {
  const { pageCount, thumbs, loading, error } = usePageThumbnails(file);
  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  });

  const signature = fileKey(file);
  const fresh = options.signature === signature;

  useEffect(() => {
    if (pageCount < 1) return;
    if (fresh && options.pageCount === pageCount) return;
    changeRef.current({
      signature,
      pageCount,
      removed: [],
      text: "",
      issue: "none",
    });
  }, [fresh, options.pageCount, pageCount, signature]);

  const removed = useMemo(
    () => new Set(fresh ? options.removed : []),
    [fresh, options.removed],
  );

  const toggle = useCallback(
    (page: number) => {
      const next = new Set(removed);
      if (next.has(page)) {
        next.delete(page);
      } else {
        // Quitar la ultima pagina dejaria un PDF vacio.
        if (next.size + 1 >= pageCount) {
          changeRef.current({ issue: "all" });
          return;
        }
        next.add(page);
      }
      const list = [...next].sort((a, b) => a - b);
      changeRef.current({
        removed: list,
        text: formatPageList(list),
        issue: "none",
      });
    },
    [pageCount, removed],
  );

  if (!file) return null;

  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        <span className="hud-label text-[10px] text-muted-foreground">
          {removed.size === 0
            ? strings.rangeHint
            : strings.marked(removed.size)}
        </span>
      }
    >
      {pages.map((page) => {
        const marked = removed.has(page);
        return (
          <li key={page}>
            <PageTile
              number={page}
              label={`${pageLabel} ${page} — ${
                marked ? strings.unmarkLabel : strings.markLabel
              }`}
              url={thumbs[page]}
              tone={marked ? "removed" : "plain"}
              pressed={marked}
              badge={marked ? "cross" : undefined}
              onSelect={() => toggle(page)}
            />
          </li>
        );
      })}
    </PageBoard>
  );
}
