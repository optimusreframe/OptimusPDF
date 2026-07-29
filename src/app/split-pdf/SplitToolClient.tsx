"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Plus, X } from "lucide-react";
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
import {
  buildSplitGroups,
  formatPageList,
  parsePageList,
  splitPdf,
  type SplitPlan,
} from "@/lib/pdf/split";
import { getTool } from "@/lib/tools-registry";
import {
  FieldNote,
  NumberField,
  PageBoard,
  PageTile,
  TextField,
  ToggleRow,
  fileKey,
  usePageThumbnails,
} from "@/app/organize-pdf/pageToolkit";
import { getSplitStrings, type SplitStrings } from "@/app/split-pdf/strings";

const TOOL = getTool("split-pdf");

type SplitMode = "custom" | "fixed" | "extract";
type ExtractScope = "all" | "selection";
type ListIssue = "none" | "syntax" | "empty";

type RangeRow = {
  id: string;
  from: number;
  to: number;
};

export type SplitToolOptions = {
  signature: string;
  pageCount: number;
  mode: SplitMode;
  ranges: RangeRow[];
  merge: boolean;
  fixedSize: number;
  extractScope: ExtractScope;
  /** Numeros de pagina 1-based del modo extraer > seleccion. */
  selected: number[];
  text: string;
  issue: ListIssue;
};

const DEFAULT_OPTIONS: SplitToolOptions = {
  signature: "",
  pageCount: 0,
  mode: "custom",
  ranges: [],
  merge: false,
  fixedSize: 2,
  extractScope: "all",
  selected: [],
  text: "",
  issue: "none",
};

let rangeCounter = 0;
function newRange(from: number, to: number): RangeRow {
  rangeCounter += 1;
  return { id: `r${rangeCounter}`, from, to };
}

function allPages(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

/** Traduce las opciones de la interfaz al plan que entiende el motor. */
function toPlan(options: SplitToolOptions): SplitPlan {
  if (options.mode === "custom") {
    return {
      mode: "ranges",
      ranges: options.ranges.map((row) => ({ from: row.from, to: row.to })),
      merge: options.merge,
    };
  }
  if (options.mode === "fixed") {
    return { mode: "fixed", size: options.fixedSize };
  }
  return options.extractScope === "all"
    ? { mode: "extract", pages: allPages(options.pageCount), separate: true }
    : { mode: "extract", pages: options.selected, separate: false };
}

export function SplitToolClient() {
  const { language } = useI18n();
  const t = useT();
  const strings = useMemo(() => getSplitStrings(language), [language]);

  const process = useCallback(
    async (
      files: File[],
      options: SplitToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const baseName = stripExtension(file.name).trim() || strings.outputName;
      const output = await splitPdf(
        file,
        toPlan(options),
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
      };
    },
    [strings],
  );

  return (
    <ToolShell<SplitToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <SplitBoard
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
        <SplitOptions
          file={files[0]}
          options={options}
          onChange={setOptions}
          strings={strings}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Panel de opciones
 * ------------------------------------------------------------------ */

type SplitOptionsProps = {
  file: File | undefined;
  options: SplitToolOptions;
  onChange: (patch: Partial<SplitToolOptions>) => void;
  strings: SplitStrings;
};

function SplitOptions({
  file,
  options,
  onChange,
  strings,
}: SplitOptionsProps) {
  const pageCount = Math.max(1, options.pageCount);
  const groups = buildSplitGroups(toPlan(options), options.pageCount);

  const clamp = (value: number) => Math.min(pageCount, Math.max(1, value));

  const patchRange = (id: string, patch: Partial<RangeRow>) => {
    onChange({
      ranges: options.ranges.map((row) =>
        row.id === id ? { ...row, ...patch } : row,
      ),
    });
  };

  const applyList = (text: string) => {
    const parsed = parsePageList(text, options.pageCount);
    if (parsed === null) {
      onChange({ text, issue: "syntax" });
      return;
    }
    if (parsed.length === 0) {
      onChange({ text, issue: "empty" });
      return;
    }
    onChange({ text, selected: parsed, issue: "none" });
  };

  return (
    <div className="space-y-5">
      <SegmentedControl<SplitMode>
        label={strings.modeLabel}
        value={options.mode}
        onChange={(mode) => onChange({ mode })}
        options={[
          { value: "custom", label: strings.modeCustom },
          { value: "fixed", label: strings.modeFixed },
          { value: "extract", label: strings.modeExtract },
        ]}
      />

      {options.mode === "custom" ? (
        <div className="space-y-4">
          <FieldNote>{strings.customHint}</FieldNote>

          {options.ranges.map((row, index) => (
            <div
              key={row.id}
              className="rounded-ios-sm border border-white/10 bg-white/4 p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="hud-label text-[10px] text-muted-foreground">
                  {strings.rangeTitle(index + 1)}
                </span>
                <button
                  type="button"
                  aria-label={strings.removeRange}
                  title={strings.removeRange}
                  disabled={options.ranges.length <= 1}
                  onClick={() =>
                    onChange({
                      ranges: options.ranges.filter(
                        (item) => item.id !== row.id,
                      ),
                    })
                  }
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </div>
              <div className="flex items-end gap-2">
                <NumberField
                  label={strings.from}
                  value={row.from}
                  min={1}
                  max={pageCount}
                  onChange={(value) =>
                    patchRange(row.id, { from: clamp(value) })
                  }
                />
                <NumberField
                  label={strings.to}
                  value={row.to}
                  min={1}
                  max={pageCount}
                  onChange={(value) => patchRange(row.id, { to: clamp(value) })}
                />
              </div>
            </div>
          ))}

          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() => {
              const last = options.ranges[options.ranges.length - 1];
              const start = last ? clamp(last.to + 1) : 1;
              onChange({
                ranges: [...options.ranges, newRange(start, pageCount)],
              });
            }}
          >
            <Plus aria-hidden="true" className="size-4" />
            {strings.addRange}
          </Button>

          <ToggleRow
            label={strings.mergeLabel}
            description={strings.mergeHint}
            checked={options.merge}
            onChange={(merge) => onChange({ merge })}
          />

          {options.pageCount > 0 && groups.length === 0 ? (
            <FieldNote tone="warning">{strings.rangesInvalid}</FieldNote>
          ) : null}
        </div>
      ) : null}

      {options.mode === "fixed" ? (
        <div className="space-y-4">
          <NumberField
            label={strings.fixedLabel}
            value={options.fixedSize}
            min={1}
            max={pageCount}
            onChange={(value) =>
              onChange({ fixedSize: Math.min(pageCount, Math.max(1, value)) })
            }
          />
          <FieldNote>{strings.fixedHint}</FieldNote>
        </div>
      ) : null}

      {options.mode === "extract" ? (
        <div className="space-y-4">
          <SegmentedControl<ExtractScope>
            label={strings.extractScopeLabel}
            value={options.extractScope}
            onChange={(extractScope) => onChange({ extractScope })}
            options={[
              { value: "all", label: strings.extractAll },
              { value: "selection", label: strings.extractSelection },
            ]}
          />
          <FieldNote>
            {options.extractScope === "all"
              ? strings.extractAllHint
              : strings.extractSelectionHint}
          </FieldNote>

          {options.extractScope === "selection" ? (
            <TextField
              label={strings.rangeLabel}
              value={options.text}
              placeholder={strings.rangePlaceholder}
              invalid={options.issue !== "none"}
              hint={
                options.issue === "syntax"
                  ? strings.rangeInvalid
                  : options.issue === "empty"
                    ? strings.pickOne
                    : strings.rangeHint
              }
              onChange={applyList}
            />
          ) : null}
        </div>
      ) : null}

      {options.pageCount > 0 ? (
        <p className="text-sm text-foreground">
          {groups.length === 0
            ? strings.resultNone
            : groups.length === 1
              ? strings.resultOne
              : strings.resultMany(groups.length)}
        </p>
      ) : null}

      {file && file.size > MAX_SAFE_FILE_SIZE ? (
        <FieldNote tone="warning">{strings.largeFile}</FieldNote>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tablero de miniaturas
 * ------------------------------------------------------------------ */

type SplitBoardProps = {
  file: File | undefined;
  options: SplitToolOptions;
  onChange: (patch: Partial<SplitToolOptions>) => void;
  strings: SplitStrings;
  errors: Dictionary["tool"]["errors"];
  pageLabel: string;
};

function SplitBoard({
  file,
  options,
  onChange,
  strings,
  errors,
  pageLabel,
}: SplitBoardProps) {
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
    const pages = allPages(pageCount);
    changeRef.current({
      signature,
      pageCount,
      ranges: [newRange(1, pageCount)],
      fixedSize: Math.min(2, pageCount),
      selected: pages,
      text: formatPageList(pages),
      issue: "none",
    });
  }, [fresh, options.pageCount, pageCount, signature]);

  const selectable =
    options.mode === "extract" && options.extractScope === "selection";

  const toggle = useCallback(
    (page: number) => {
      const current = new Set(options.selected);
      if (current.has(page)) {
        if (current.size <= 1) {
          changeRef.current({ issue: "empty" });
          return;
        }
        current.delete(page);
      } else {
        current.add(page);
      }
      const list = [...current].sort((a, b) => a - b);
      changeRef.current({
        selected: list,
        text: formatPageList(list),
        issue: "none",
      });
    },
    [options.selected],
  );

  const groupByPage = useMemo(() => {
    const map = new Map<number, number>();
    const groups = buildSplitGroups(toPlan(options), pageCount);
    groups.forEach((indices, groupIndex) => {
      for (const index of indices) map.set(index + 1, groupIndex + 1);
    });
    return { map, parts: groups.length };
  }, [options, pageCount]);

  if (!file) return null;

  return (
    <PageBoard
      title={strings.boardTitle}
      loading={loading}
      errorText={error ? errors[error] : null}
      toolbar={
        <span className="hud-label text-[10px] text-muted-foreground">
          {strings.outsideHint}
        </span>
      }
    >
      {allPages(pageCount).map((page) => {
        const part = groupByPage.map.get(page);
        return (
          <li key={page}>
            <PageTile
              number={page}
              label={
                selectable
                  ? `${pageLabel} ${page} — ${
                      part ? strings.unselectLabel : strings.selectLabel
                    }`
                  : `${pageLabel} ${page}`
              }
              url={thumbs[page]}
              tone={part ? "selected" : "muted"}
              pressed={selectable ? Boolean(part) : undefined}
              onSelect={selectable ? () => toggle(page) : undefined}
              note={
                part && groupByPage.parts > 1
                  ? strings.partBadge(part)
                  : undefined
              }
            />
          </li>
        );
      })}
    </PageBoard>
  );
}
