"use client";

import { useState, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { ChoiceGroup } from "@/components/tool/OptionControls";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Sheet } from "@/components/ui/Sheet";
import { useI18n } from "@/lib/i18n";
import { STRINGS as EXCEL_STRINGS } from "@/app/excel-to-pdf/strings";
import { STRINGS as HTML_STRINGS } from "@/app/html-to-pdf/strings";
import { STRINGS as WORD_STRINGS } from "@/app/word-to-pdf/strings";
import {
  DEFAULT_IMPORT_OPTIONS,
  detectImportKind,
  insertConvertedOperation,
  type ImportKind,
  type ImportOptions,
  type InsertPosition,
} from "@/app/pdf-pro/create/importConvert";
import { getCreateStrings } from "@/app/pdf-pro/create/createStrings";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { useProOperation } from "@/app/pdf-pro/useProOperation";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { useProViewerOptional } from "@/app/pdf-pro/viewer/ProViewerContext";

/**
 * «Insertar desde Word, Excel o HTML» (Wave 7 · U8): hoja con el archivo elegido, las opciones de su herramienta
 * suelta y el sitio donde insertar. Una sola operacion del historial (`insertConvertedOperation`): progreso,
 * cancelacion y error claro (archivo cifrado, formato antiguo `.doc`/`.xls`, corrupto...).
 */
export function ImportInsertSheet({
  open,
  file,
  onClose,
}: {
  open: boolean;
  file: File | null;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const s = getCreateStrings(language).insert;
  return (
    <Sheet open={open} onClose={onClose} title={s.title} closeLabel={t.common.close}>
      {file ? <InsertForm key={`${file.name}:${file.size}:${file.lastModified}`} file={file} onClose={onClose} /> : null}
    </Sheet>
  );
}

function InsertForm({ file, onClose }: { file: File; onClose: () => void }) {
  const { t, language } = useI18n();
  const s = getCreateStrings(language).insert;
  const { doc, pageCount } = useProWorkingDoc();
  const viewer = useProViewerOptional();
  const run = useProOperation();
  const kind = detectImportKind(file);
  const [options, setOptions] = useState<ImportOptions>({
    word: { ...DEFAULT_IMPORT_OPTIONS.word },
    excel: { ...DEFAULT_IMPORT_OPTIONS.excel },
    html: { ...DEFAULT_IMPORT_OPTIONS.html },
  });
  const [where, setWhere] = useState<"start" | "after" | "end">("end");
  const pagesStore = getPagesStore(doc);
  const pending = useSyncExternalStore(
    pagesStore.subscribe,
    () => pagesStore.getState().dirty,
    () => false,
  );
  const running = run.status === "running";
  const copy = run.error ? errorCopy(t, run.error) : null;
  const currentPage = viewer ? viewer.store.getCurrentPage() : 0;

  if (!kind) {
    return (
      <div className="space-y-4 pb-2" data-import-insert="">
        <p role="alert" className="text-subheadline text-destructive-text">
          {/\.(doc|xls|ppt)$/i.test(file.name) ? t.tool.errors.legacyOfficeFormat : s.unsupported}
        </p>
        <Button size="md" variant="secondary" fullWidth onClick={onClose}>
          {s.cancel}
        </Button>
      </div>
    );
  }

  const submit = async () => {
    if (running || pending) return;
    const position: InsertPosition =
      where === "start" ? { at: "start" } : where === "end" ? { at: "end" } : { at: "after", pageIndex: currentPage };
    const result = await run.apply(
      insertConvertedOperation,
      { file, kind, options, position, pageCount },
      { label: s.label(file.name) },
    );
    if (result.ok) {
      const added = (result.report as { added?: number } | undefined)?.added ?? 0;
      if (added > 0) doc.announce(`${s.label(file.name)}. ${s.done(added)}`);
      onClose();
    }
  };

  return (
    <div className="space-y-4 pb-2" data-import-insert="">
      <p className="text-subheadline text-muted-foreground">{s.body(file.name)}</p>
      <p className="ui-label text-muted-foreground">{s.kind[kind]}</p>

      <KindOptions kind={kind} options={options} setOptions={setOptions} />
      {kind === "html" ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {s.fidelityHtml}
        </p>
      ) : null}

      <ChoiceGroup<"start" | "after" | "end">
        label={s.positionLabel}
        value={where}
        columns={1}
        choices={[
          { value: "start", label: s.start },
          { value: "after", label: s.afterCurrent(currentPage + 1) },
          { value: "end", label: s.end },
        ]}
        onChange={setWhere}
      />

      {pending ? (
        <p role="note" data-import-pending="" className="text-xs leading-relaxed text-destructive-text">
          {s.pendingOrganizer}
        </p>
      ) : null}
      {running ? <ProgressBar value={run.progress * 100} label={s.inserting} /> : null}
      <ErrorBanner
        show={copy !== null}
        errorKey={run.error ?? undefined}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        hint={copy?.hint}
        actions={errorActions(t, run.error)}
        dismissLabel={t.common.close}
        onDismiss={run.clearError}
        className="mb-0"
      />
      <div className="flex flex-col gap-2">
        <Button size="md" fullWidth aria-disabled={running || pending || undefined} onClick={() => void submit()} data-import-insert-run="">
          {running ? s.inserting : s.insert}
        </Button>
        <Button
          size="md"
          variant="ghost"
          fullWidth
          onClick={() => {
            if (running) run.cancel();
            onClose();
          }}
        >
          {s.cancel}
        </Button>
      </div>
    </div>
  );
}

function KindOptions({
  kind,
  options,
  setOptions,
}: {
  kind: ImportKind;
  options: ImportOptions;
  setOptions: (updater: (previous: ImportOptions) => ImportOptions) => void;
}) {
  const { language } = useI18n();
  if (kind === "excel") {
    const e = EXCEL_STRINGS[language];
    return (
      <div className="space-y-4">
        <ChoiceGroup<"a4" | "letter">
          label={e.pageSizeLabel}
          value={options.excel.pageSize}
          columns={2}
          choices={[
            { value: "a4", label: e.pageSizeA4 },
            { value: "letter", label: e.pageSizeLetter },
          ]}
          onChange={(pageSize) => setOptions((previous) => ({ ...previous, excel: { ...previous.excel, pageSize } }))}
        />
        <ChoiceGroup<"portrait" | "landscape">
          label={e.orientationLabel}
          value={options.excel.orientation}
          columns={2}
          choices={[
            { value: "portrait", label: e.orientationPortrait },
            { value: "landscape", label: e.orientationLandscape },
          ]}
          onChange={(orientation) => setOptions((previous) => ({ ...previous, excel: { ...previous.excel, orientation } }))}
        />
        <ChoiceGroup<"all" | "first">
          label={e.sheetLabel}
          value={options.excel.sheet}
          columns={2}
          choices={[
            { value: "all", label: e.sheetAll },
            { value: "first", label: e.sheetFirst },
          ]}
          onChange={(sheet) => setOptions((previous) => ({ ...previous, excel: { ...previous.excel, sheet } }))}
        />
      </div>
    );
  }
  // Word y HTML comparten opciones (tamaño, orientacion, margen) y etiquetas.
  const strings = kind === "word" ? WORD_STRINGS[language] : HTML_STRINGS[language];
  const current = kind === "word" ? options.word : options.html;
  const patch = (value: Partial<typeof current>) =>
    setOptions((previous) => ({ ...previous, [kind]: { ...previous[kind], ...value } }));
  return (
    <div className="space-y-4">
      <ChoiceGroup<"a4" | "letter">
        label={strings.pageSizeLabel}
        value={current.pageSize}
        columns={2}
        choices={[
          { value: "a4", label: strings.pageSizeA4 },
          { value: "letter", label: strings.pageSizeLetter },
        ]}
        onChange={(pageSize) => patch({ pageSize })}
      />
      <ChoiceGroup<"portrait" | "landscape">
        label={strings.orientationLabel}
        value={current.orientation}
        columns={2}
        choices={[
          { value: "portrait", label: strings.orientationPortrait },
          { value: "landscape", label: strings.orientationLandscape },
        ]}
        onChange={(orientation) => patch({ orientation })}
      />
      <ChoiceGroup<"none" | "small" | "large">
        label={strings.marginLabel}
        value={current.margin}
        columns={3}
        choices={[
          { value: "none", label: strings.marginNone },
          { value: "small", label: strings.marginSmall },
          { value: "large", label: strings.marginLarge },
        ]}
        onChange={(margin) => patch({ margin })}
      />
    </div>
  );
}
