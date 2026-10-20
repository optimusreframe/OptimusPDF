"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { FileUp, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { ChoiceGroup, NumberField } from "@/components/tool/OptionControls";
import { errorCopy } from "@/components/tool/errorCopy";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { ImageLayout } from "@/lib/pdf/imagesToPdf";
import { parsePageList } from "@/lib/pdf/split";
import { describeGroup, parseRangeParts, planSplit, type SplitParts } from "@/lib/pdf/pageAssemblyExport";
import { PageGrid, type GridItem } from "@/app/pdf-pro/pages/PageGrid";
import type { BlankSizeChoice, InsertPosition } from "@/app/pdf-pro/pages/pagesActions";
import type { PagesStrings } from "@/app/pdf-pro/pages/pagesStrings";
import type { PagesSource } from "@/app/pdf-pro/pages/pagesStore";

/**
 * Hojas (dialogos) del organizador de paginas (Wave 7 · U4). Cada una es controlada desde
 * `PagesTab`; aqui solo hay formularios y su validacion.
 */

const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-callout text-foreground pointer-coarse:text-base transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal aria-[invalid=true]:border-destructive/60 forced-colors:border-[ButtonText]";

function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="ui-label mb-1.5 block text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-footnote text-destructive-text">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-footnote text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Posicion
 * ------------------------------------------------------------------ */

export function PositionChoice({
  value,
  onChange,
  hasSelection,
  strings,
  allowSelectionRelative = true,
}: {
  value: InsertPosition;
  onChange: (value: InsertPosition) => void;
  hasSelection: boolean;
  strings: PagesStrings;
  allowSelectionRelative?: boolean;
}) {
  const s = strings.sheets;
  const choices: { value: InsertPosition; label: string }[] = [
    { value: "start", label: s.positionStart },
    ...(hasSelection && allowSelectionRelative
      ? [
          { value: "before" as const, label: s.positionBefore },
          { value: "after" as const, label: s.positionAfter },
        ]
      : []),
    { value: "end", label: s.positionEnd },
  ];
  return <ChoiceGroup label={s.position} value={value} choices={choices} onChange={onChange} columns={2} />;
}

function SubmitRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 pt-2 pb-2">{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Seleccionar rango
 * ------------------------------------------------------------------ */

export function RangeSheet({
  open,
  onClose,
  total,
  strings,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  total: number;
  strings: PagesStrings;
  onSubmit: (positions: number[]) => void;
}) {
  const s = strings.sheets;
  return (
    <Sheet open={open} onClose={onClose} title={s.selectRangeTitle} closeLabel={s.close}>
      <RangeForm total={total} strings={strings} onSubmit={onSubmit} onClose={onClose} />
    </Sheet>
  );
}

function RangeForm({
  total,
  strings,
  onSubmit,
  onClose,
}: {
  total: number;
  strings: PagesStrings;
  onSubmit: (positions: number[]) => void;
  onClose: () => void;
}) {
  const s = strings.sheets;
  const id = useId();
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parsePageList(text, total), [text, total]);
  const invalid = touched && (parsed === null || parsed.length === 0);
  const error = invalid ? s.selectRangeInvalid.replace("{total}", String(total)) : null;
  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!parsed || parsed.length === 0) return;
        onSubmit(parsed);
        onClose();
      }}
    >
      <Field label={s.selectRangeLabel} hint={s.selectRangeHint} error={error} htmlFor={id}>
        <input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          onChange={(event) => setText(event.target.value)}
          className={INPUT_CLASS}
          placeholder="1-3, 7"
        />
      </Field>
      <SubmitRow>
        <Button type="submit" size="md" fullWidth>
          {s.selectRangeSubmit}
        </Button>
      </SubmitRow>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Pagina en blanco
 * ------------------------------------------------------------------ */

export function BlankSheet({
  open,
  onClose,
  hasSelection,
  strings,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  hasSelection: boolean;
  strings: PagesStrings;
  onSubmit: (options: { position: InsertPosition; size: BlankSizeChoice; count: number }) => void;
}) {
  const s = strings.sheets;
  return (
    <Sheet open={open} onClose={onClose} title={s.blankTitle} closeLabel={s.close}>
      <BlankForm hasSelection={hasSelection} strings={strings} onSubmit={onSubmit} onClose={onClose} />
    </Sheet>
  );
}

// El formulario solo existe mientras la hoja esta abierta: su estado nace con la seleccion de ESE momento.
function BlankForm({
  hasSelection,
  strings,
  onSubmit,
  onClose,
}: {
  hasSelection: boolean;
  strings: PagesStrings;
  onSubmit: (options: { position: InsertPosition; size: BlankSizeChoice; count: number }) => void;
  onClose: () => void;
}) {
  const s = strings.sheets;
  const [position, setPosition] = useState<InsertPosition>(hasSelection ? "after" : "end");
  const [size, setSize] = useState<BlankSizeChoice>("neighbour");
  const [count, setCount] = useState(1);
  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ position, size, count: Math.max(1, Math.min(100, count)) });
        onClose();
      }}
    >
      <PositionChoice value={position} onChange={setPosition} hasSelection={hasSelection} strings={strings} />
      <ChoiceGroup
        label={s.blankSize}
        value={size}
        columns={1}
        choices={[
          { value: "neighbour", label: s.blankSizeNeighbour },
          { value: "a4", label: s.blankSizeA4 },
          { value: "letter", label: s.blankSizeLetter },
        ]}
        onChange={setSize}
      />
      <NumberField label={s.blankCount} value={count} min={1} max={100} onChange={setCount} />
      <SubmitRow>
        <Button type="submit" size="md" fullWidth>
          {s.blankSubmit}
        </Button>
      </SubmitRow>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Estado de un archivo sumado
 * ------------------------------------------------------------------ */

export function SourceStatus({ source, strings }: { source: PagesSource; strings: PagesStrings }) {
  const { t } = useI18n();
  const s = strings.sheets;
  if (source.status === "reading") {
    return (
      <span className="flex items-center gap-2 text-footnote text-muted-foreground">
        <Spinner className="size-4" />
        {s.fileReading}
      </span>
    );
  }
  if (source.status === "password") {
    return <span className="text-footnote text-muted-foreground">{s.filePassword}</span>;
  }
  if (source.status === "error") {
    const copy = errorCopy(t, source.error ?? "unknown", { fileProblem: true });
    return <span className="text-footnote text-destructive-text">{copy.message}</span>;
  }
  return <span className="text-footnote text-muted-foreground">{source.pageCount ? s.fileReady(source.pageCount) : ""}</span>;
}

/* ------------------------------------------------------------------ *
 * Insertar paginas de otro PDF
 * ------------------------------------------------------------------ */

export function InsertPdfSheet({
  open,
  onClose,
  source,
  items,
  hasSelection,
  strings,
  onPick,
  onVisible,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  source: PagesSource | null;
  /** Una tarjeta por pagina del PDF elegido (con su miniatura cuando ya esta). */
  items: readonly GridItem[];
  hasSelection: boolean;
  strings: PagesStrings;
  onPick: () => void;
  onVisible: (range: { first: number; last: number } | null) => void;
  onSubmit: (indices: number[], position: InsertPosition) => void;
}) {
  const s = strings.sheets;
  return (
    <Sheet open={open} onClose={onClose} title={s.pdfTitle} closeLabel={s.close} mobileFullscreen>
      <InsertPdfForm
        key={source?.id ?? "none"}
        source={source}
        items={items}
        hasSelection={hasSelection}
        strings={strings}
        onPick={onPick}
        onVisible={onVisible}
        onSubmit={(indices, position) => {
          onSubmit(indices, position);
          onClose();
        }}
      />
    </Sheet>
  );
}

function InsertPdfForm({
  source,
  items,
  hasSelection,
  strings,
  onPick,
  onVisible,
  onSubmit,
}: {
  source: PagesSource | null;
  items: readonly GridItem[];
  hasSelection: boolean;
  strings: PagesStrings;
  onPick: () => void;
  onVisible: (range: { first: number; last: number } | null) => void;
  onSubmit: (indices: number[], position: InsertPosition) => void;
}) {
  const s = strings.sheets;
  const ready = source?.status === "ready" && items.length > 0;
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set(items.map((item) => item.id)));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [position, setPosition] = useState<InsertPosition>(hasSelection ? "after" : "end");
  const chosen = items.filter((item) => selection.has(item.id)).map((item) => Number(item.id.slice(2)));
  const [seeded, setSeeded] = useState(ready);

  // Al terminar de leer el PDF se eligen todas sus paginas (una sola vez).
  if (ready && !seeded) {
    setSeeded(true);
    setSelection(new Set(items.map((item) => item.id)));
  }

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="md" onClick={onPick}>
          <FileUp aria-hidden="true" className="size-4" />
          {s.pdfChoose}
        </Button>
        <div className="min-w-0 flex-1">
          {source ? (
            <>
              <p className="truncate text-subheadline font-semibold" title={source.name}>
                {source.name}
              </p>
              <SourceStatus source={source} strings={strings} />
            </>
          ) : (
            <p className="text-footnote text-muted-foreground">{s.pdfPick}</p>
          )}
        </div>
      </div>

      {ready ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setSelection(new Set(items.map((item) => item.id)))}
            >
              {s.pdfSelectAll}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setSelection(new Set())}>
              {s.pdfSelectNone}
            </Button>
            <span className="ml-auto text-footnote text-muted-foreground tabular-nums">
              {s.pdfPagesChosen(chosen.length, items.length)}
            </span>
          </div>
          <div data-sheet-no-drag="" className="h-[min(46vh,22rem)] overflow-hidden rounded-ios border border-hairline bg-white/3">
            <PageGrid
              items={items}
              selection={selection}
              anchorId={anchor}
              focusId={focus}
              label={s.pdfPages(items.length)}
              strings={{
                dragHandle: strings.card.dragHandle,
                dragStart: strings.announce.dragStart,
                dragCancel: strings.announce.dragCancel,
                loading: strings.card.loading,
              }}
              draggable={false}
              className="h-full"
              onSelectionChange={(ids, nextAnchor, nextFocus) => {
                setSelection(new Set(ids));
                setAnchor(nextAnchor);
                setFocus(nextFocus);
              }}
              onFocusChange={setFocus}
              onVisibleChange={onVisible}
            />
          </div>
          <PositionChoice value={position} onChange={setPosition} hasSelection={hasSelection} strings={strings} />
          <SubmitRow>
            <Button
              type="button"
              size="md"
              fullWidth
              disabled={chosen.length === 0}
              onClick={() => onSubmit(chosen, position)}
            >
              {chosen.length === 0 ? s.pdfNoneChosen : s.pdfSubmit(chosen.length)}
            </Button>
          </SubmitRow>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Imagenes y unir PDFs (lista de archivos + posicion)
 * ------------------------------------------------------------------ */

export function AddFilesSheet({
  open,
  onClose,
  mode,
  sources,
  hasSelection,
  strings,
  onPick,
  onRemove,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  mode: "images" | "merge";
  sources: readonly PagesSource[];
  hasSelection: boolean;
  strings: PagesStrings;
  onPick: () => void;
  onRemove: (id: string) => void;
  onSubmit: (position: InsertPosition, layout?: Partial<ImageLayout>) => void;
}) {
  const s = strings.sheets;
  return (
    <Sheet open={open} onClose={onClose} title={mode === "images" ? s.imagesTitle : s.mergeTitle} closeLabel={s.close}>
      <AddFilesForm
        mode={mode}
        sources={sources}
        hasSelection={hasSelection}
        strings={strings}
        onPick={onPick}
        onRemove={onRemove}
        onSubmit={(position, layout) => {
          onSubmit(position, layout);
          onClose();
        }}
      />
    </Sheet>
  );
}

function AddFilesForm({
  mode,
  sources,
  hasSelection,
  strings,
  onPick,
  onRemove,
  onSubmit,
}: {
  mode: "images" | "merge";
  sources: readonly PagesSource[];
  hasSelection: boolean;
  strings: PagesStrings;
  onPick: () => void;
  onRemove: (id: string) => void;
  onSubmit: (position: InsertPosition, layout?: Partial<ImageLayout>) => void;
}) {
  const s = strings.sheets;
  const [position, setPosition] = useState<InsertPosition>(mode === "merge" ? "end" : hasSelection ? "after" : "end");
  const [pageSize, setPageSize] = useState<"a4" | "letter" | "fit">("a4");
  const usable = sources.filter((source) => source.status === "ready");
  const reading = sources.some((source) => source.status === "reading" || source.status === "password");
  const pages = usable.reduce((sum, source) => sum + (source.pageCount ?? 0), 0);
  const title = mode === "images" ? s.imagesTitle : s.mergeTitle;
  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="md" onClick={onPick}>
          <FileUp aria-hidden="true" className="size-4" />
          {mode === "images" ? s.imagesChoose : s.mergeChoose}
        </Button>
        {mode === "merge" ? <p className="text-footnote text-muted-foreground">{s.mergeHint}</p> : null}
      </div>

      {sources.length > 0 ? (
        <ul aria-label={title} className="space-y-1.5">
          {sources.map((source) => (
            <li
              key={source.id}
              className="flex min-h-11 items-center gap-2 rounded-ios-sm border border-hairline bg-white/4 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-subheadline" title={source.name}>
                  {source.name}
                </p>
                <SourceStatus source={source} strings={strings} />
              </div>
              <button
                type="button"
                aria-label={s.removeFile(source.name)}
                onClick={() => onRemove(source.id)}
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                  "hover:bg-white/8 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal",
                )}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {mode === "images" ? (
        <ChoiceGroup
          label={s.imagesSize}
          value={pageSize}
          columns={3}
          choices={[
            { value: "a4", label: s.imagesSizeA4 },
            { value: "letter", label: s.imagesSizeLetter },
            { value: "fit", label: s.imagesSizeFit },
          ]}
          onChange={setPageSize}
        />
      ) : null}
      <PositionChoice
        value={position}
        onChange={setPosition}
        hasSelection={hasSelection}
        strings={strings}
        allowSelectionRelative={mode === "images"}
      />
      <SubmitRow>
        <Button
          type="button"
          size="md"
          fullWidth
          disabled={usable.length === 0 || reading}
          onClick={() => onSubmit(position, mode === "images" ? { pageSize } : undefined)}
        >
          {mode === "images" ? s.imagesSubmit(usable.length) : s.mergeSubmit(usable.length, pages)}
        </Button>
      </SubmitRow>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Extraer
 * ------------------------------------------------------------------ */

export function ExtractSheet({
  open,
  onClose,
  count,
  defaultName,
  busy,
  canOpenAsNew,
  strings,
  onDownload,
  onOpenAsNew,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  defaultName: string;
  busy: boolean;
  canOpenAsNew: boolean;
  strings: PagesStrings;
  onDownload: (name: string) => void;
  onOpenAsNew: (name: string) => void;
}) {
  const s = strings.sheets;
  const id = useId();
  const [name, setName] = useState(defaultName);
  const [confirm, setConfirm] = useState(false);
  const clean = () => {
    const trimmed = name.trim() || defaultName;
    return trimmed.toLowerCase().endsWith(".pdf") ? trimmed : `${trimmed}.pdf`;
  };
  return (
    <>
      <Sheet open={open} onClose={onClose} title={s.extractTitle} closeLabel={s.close}>
        <div className="space-y-4 pb-2">
          <p className="text-subheadline text-muted-foreground">{s.extractBody(count)}</p>
          <Field label={s.extractName} htmlFor={id}>
            <input
              id={id}
              type="text"
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              className={INPUT_CLASS}
            />
          </Field>
          <SubmitRow>
            <Button type="button" size="md" fullWidth disabled={busy} onClick={() => onDownload(clean())}>
              {busy ? s.working : s.extractDownload}
            </Button>
            {canOpenAsNew ? (
              <Button type="button" size="md" variant="secondary" fullWidth disabled={busy} onClick={() => setConfirm(true)}>
                {s.extractOpen}
              </Button>
            ) : null}
          </SubmitRow>
        </div>
      </Sheet>
      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => onOpenAsNew(clean())}
        title={s.extractOpenConfirmTitle}
        body={s.extractOpenConfirmBody}
        confirmLabel={s.extractOpenConfirm}
        cancelLabel={strings.status.keep}
        closeLabel={s.close}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Dividir
 * ------------------------------------------------------------------ */

type SplitMode = "ranges" | "every" | "bookmarks";

export function SplitSheet({
  open,
  onClose,
  bytes,
  loading,
  pageCount,
  pending,
  busy,
  strings,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** El documento tal como se ve (con los cambios sin aplicar ya ensamblados), o `null` mientras se prepara. */
  bytes: Uint8Array | null;
  loading: boolean;
  pageCount: number;
  pending: boolean;
  busy: boolean;
  strings: PagesStrings;
  onSubmit: (parts: SplitParts) => void;
}) {
  const s = strings.sheets;
  return (
    <Sheet open={open} onClose={onClose} title={s.splitTitle} closeLabel={s.close}>
      <SplitForm
        bytes={bytes}
        loading={loading}
        pageCount={pageCount}
        pending={pending}
        busy={busy}
        strings={strings}
        onSubmit={onSubmit}
      />
    </Sheet>
  );
}

function SplitForm({
  bytes,
  loading,
  pageCount,
  pending,
  busy,
  strings,
  onSubmit,
}: {
  bytes: Uint8Array | null;
  loading: boolean;
  pageCount: number;
  pending: boolean;
  busy: boolean;
  strings: PagesStrings;
  onSubmit: (parts: SplitParts) => void;
}) {
  const s = strings.sheets;
  const id = useId();
  const [mode, setMode] = useState<SplitMode>("ranges");
  const [rangesText, setRangesText] = useState("");
  const [every, setEvery] = useState(1);
  const [parts, setParts] = useState<SplitParts | null>(null);
  const [rangesTouched, setRangesTouched] = useState(false);
  const generation = useRef(0);

  // Los grupos salen del texto/valor actual; los marcadores se leen del documento (asincrono).
  useEffect(() => {
    if (!bytes) return;
    const mine = (generation.current += 1);
    let cancelled = false;
    void (async () => {
      let next: SplitParts = { groups: [], titles: [] };
      try {
        if (mode === "ranges") {
          const ranges = parseRangeParts(rangesText, pageCount);
          next = ranges && ranges.length > 0 ? await planSplit(bytes, { mode: "ranges", ranges }, pageCount) : next;
        } else if (mode === "every") {
          next = await planSplit(bytes, { mode: "every", size: every }, pageCount);
        } else {
          next = await planSplit(bytes, { mode: "bookmarks", leadingTitle: "" }, pageCount);
        }
      } catch {
        next = { groups: [], titles: [] };
      }
      if (!cancelled && mine === generation.current) setParts(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, mode, rangesText, every, pageCount]);

  const groups = parts?.groups ?? [];
  const rangesInvalid = mode === "ranges" && rangesTouched && rangesText.trim().length > 0 && groups.length === 0;
  const hasBookmarks = mode === "bookmarks" && groups.length > 1;
  const summary =
    groups.length > 0
      ? `${s.splitPreview(groups.length)}: ${groups
          .slice(0, 6)
          .map((group) => describeGroup(group))
          .join(" · ")}${groups.length > 6 ? " …" : ""}`
      : "";

  return (
    <form
      className="space-y-4 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        setRangesTouched(true);
        if (parts && parts.groups.length > 0 && !busy) onSubmit(parts);
      }}
    >
      {pending ? <p className="text-footnote text-muted-foreground">{s.splitPending}</p> : null}
      <div>
        <span className="ui-label mb-2 block text-muted-foreground">{s.splitModeLabel}</span>
        <SegmentedControl<SplitMode>
          label={s.splitModeLabel}
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: "ranges", label: s.splitModeRanges },
            { value: "every", label: s.splitModeEvery },
            { value: "bookmarks", label: s.splitModeBookmarks },
          ]}
        />
      </div>

      {mode === "ranges" ? (
        <Field
          label={s.splitRangesLabel}
          hint={s.splitRangesHint}
          error={rangesInvalid ? s.splitInvalid.replace("{total}", String(pageCount)) : null}
          htmlFor={id}
        >
          <input
            id={id}
            type="text"
            autoComplete="off"
            placeholder="1-3, 5, 7-9"
            value={rangesText}
            aria-invalid={rangesInvalid || undefined}
            aria-describedby={rangesInvalid ? `${id}-error` : `${id}-hint`}
            onChange={(event) => {
              setRangesText(event.target.value);
              setRangesTouched(true);
            }}
            className={INPUT_CLASS}
          />
        </Field>
      ) : null}
      {mode === "every" ? (
        <NumberField label={s.splitEveryLabel} value={every} min={1} max={Math.max(1, pageCount)} onChange={setEvery} />
      ) : null}
      {mode === "bookmarks" ? (
        <p className="text-footnote text-muted-foreground">
          {loading || !bytes ? s.working : hasBookmarks ? s.splitBookmarksHint : s.splitNoBookmarks}
        </p>
      ) : null}

      <p className="min-h-5 text-footnote text-muted-foreground" aria-live="off">
        {loading || !bytes ? s.working : summary}
      </p>

      <SubmitRow>
        <Button type="submit" size="md" fullWidth disabled={busy || loading || !bytes || groups.length === 0}>
          {busy ? s.working : s.splitSubmit}
        </Button>
      </SubmitRow>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Mas acciones (barra compacta)
 * ------------------------------------------------------------------ */

export type MoreAction = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** `false`: la accion solo cambia el estado (la hoja devuelve el foco a «Más»). Por defecto la accion lleva el foco a otro sitio. */
  handsOffFocus?: boolean;
  run: () => void;
};

export function MoreSheet({
  open,
  onClose,
  strings,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  strings: PagesStrings;
  groups: { title: string; actions: MoreAction[] }[];
}) {
  // Una accion que abre otra hoja o mueve el foco por su cuenta: esta no se lo quita al cerrarse.
  const handedOff = useRef(false);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={strings.actions.moreTitle}
      closeLabel={strings.sheets.close}
      restoreFocusOnClose={() => {
        const keep = !handedOff.current;
        handedOff.current = false;
        return keep;
      }}
    >
      <div className="space-y-4 pb-2">
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="ui-label mb-1.5 text-muted-foreground">{group.title}</h3>
            <ul className="space-y-1">
              {group.actions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    disabled={action.disabled}
                    onClick={() => {
                      handedOff.current = action.handsOffFocus !== false;
                      onClose();
                      action.run();
                    }}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-ios-sm px-3 text-left text-callout",
                      "hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                      "disabled:opacity-50 forced-colors:disabled:text-[GrayText]",
                    )}
                  >
                    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                      {action.icon}
                    </span>
                    {action.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Sheet>
  );
}
