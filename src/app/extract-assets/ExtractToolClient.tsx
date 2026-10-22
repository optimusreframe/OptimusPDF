"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Image as ImageIcon, Info, Layers, RotateCcw, ShieldCheck } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { blockedRunText, errorCopy } from "@/components/tool/errorCopy";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { FileList } from "@/components/tool/FileList";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { useInputProblem } from "@/components/tool/useInputProblem";
import { useOwnToolFocus } from "@/components/tool/useOwnToolFocus";
import { useReplaceFilePicker } from "@/components/tool/useReplaceFilePicker";
import { setHandoff } from "@/app/pdf-pro/proHandoff";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { addRecentEntry } from "@/lib/recent";
import { downloadBlob, toPdfError, withSuffix, type PdfErrorCode } from "@/lib/pdf/core";
import { extractAssets, isExtractUnavailable, renderAsset } from "@/lib/pdf/extractAssets";
import { EXTRACT_LIMITS, type AssetFormat, type ExtractResult, type ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import { buildAssetsZip, type ZipEntry } from "@/lib/pdf/extractAssets/zip";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool, toolHref } from "@/lib/tools-registry";
import { AssetDetailSheet } from "@/app/extract-assets/AssetDetailSheet";
import { ExtractGallery, type ZipState } from "@/app/extract-assets/ExtractGallery";
import { RangeNotice } from "@/app/extract-assets/RangeNotice";
import { RegionPanel } from "@/app/extract-assets/RegionPanel";
import { SaveSignatureSheet } from "@/app/extract-assets/SaveSignatureSheet";
import {
  analyzedRange,
  countByFilter,
  defaultVaultKind,
  fill,
  filterAssets,
  errorCodeOf,
  isCancellation,
  noticesFor,
  offersOriginal,
  planBaseNames,
  pruneSelection,
  resolveFormat,
  sortAssets,
  summaryText,
  toggleAllVisible,
  toggleSelection,
  withExtension,
  type FilterId,
  type FormatPreference,
} from "@/app/extract-assets/model";

/**
 * «Extraer elementos» (F7 · U7.4): saca de un PDF firmas, iniciales, imagenes, logos, sellos y marcas de agua, los muestra
 * en una galeria (filtros, seleccion, descarga individual y ZIP) y deja guardar firmas e iniciales en «Firmas guardadas».
 * «Recortar región» cubre lo que no se detecta solo (p. ej. una firma dentro de una pagina escaneada).
 *
 * Cabecera propia, como `compare-pdf`: replica la maquina de estados de `ToolShell` (idle -> processing -> done) con sus
 * mismas piezas, porque el resultado es una pantalla (galeria) y no un unico archivo. Todo corre en el navegador.
 */

const TOOL = getTool("extract-assets");

type Phase = "idle" | "processing" | "done";
type Tab = "items" | "region";
type Status = { text: string; error: boolean };
type Progress = { page: number; total: number; found: number };

const EMPTY_RESULT: ExtractResult = { pageCount: 0, assets: [], scannedPages: [], warnings: [], truncated: false };

export function ExtractToolClient() {
  const { t, language } = useI18n();
  const x = t.extract;
  const copy = t.tools["extract-assets"];
  const locale = localeTag(language);
  const Icon = TOOL.icon;

  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [autoUnavailable, setAutoUnavailable] = useState(false);
  const [requested, setRequested] = useState<{ from: number; to: number } | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("items");
  const [regionVisited, setRegionVisited] = useState(false);
  const [regionPage, setRegionPage] = useState(0);
  const [filter, setFilter] = useState<FilterId>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [formatPreference, setFormatPreference] = useState<FormatPreference>("png");
  const [status, setStatus] = useState<Status>({ text: "", error: false });
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailAsset, setDetailAsset] = useState<ExtractedAsset | null>(null);
  const [busy, setBusy] = useState<{ id: string; format: AssetFormat } | null>(null);
  const [zip, setZip] = useState<ZipState>({ phase: "idle" });
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveKey, setSaveKey] = useState(0);
  const [saveAsset, setSaveAsset] = useState<ExtractedAsset | null>(null);

  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const zipAbortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      zipAbortRef.current?.abort();
    };
  }, []);

  const say = useCallback((text: string, isError = false) => setStatus({ text, error: isError }), []);

  const { problem, checking } = useInputProblem([file]);
  const bannerCode = problem?.code ?? (error && error !== "cancelled" ? error : null);
  const { ask, bannerRef, runRef, areaRef } = useOwnToolFocus({
    bannerKey: bannerCode ? (problem ? `file-${problem.code}` : bannerCode) : null,
    checking,
  });

  /* ---- Resultado derivado ------------------------------------------------------------------------------------ */

  const sorted = useMemo(() => sortAssets(result?.assets ?? []), [result]);
  const counts = useMemo(() => countByFilter(sorted), [sorted]);
  const visible = useMemo(() => filterAssets(sorted, filter), [sorted, filter]);
  const names = useMemo(() => planBaseNames(sorted, x), [sorted, x]);
  const originalOffered = useMemo(() => offersOriginal(sorted), [sorted]);
  const range = useMemo(
    () => (result ? analyzedRange(result.pageCount, requested, EXTRACT_LIMITS.maxPages) : { from: 1, to: 1 }),
    [result, requested],
  );
  const notices = useMemo(() => (result ? noticesFor(x, result, range) : []), [result, range, x]);

  /* ---- Buscar ------------------------------------------------------------------------------------------------ */

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    setFile(null);
    setResult(null);
    setAutoUnavailable(false);
    setRequested(undefined);
    setProgress(null);
    setError(null);
    setSelected(new Set());
    setFilter("all");
    setTab("items");
    setRegionVisited(false);
    setRegionPage(0);
    setDetailOpen(false);
    setStatus({ text: "", error: false });
    setPhase("idle");
    ask("attention");
  }, [ask]);

  const run = useCallback(
    async (pageRange?: { from: number; to: number }) => {
      if (!file) return;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setProgress({ page: 0, total: 0, found: 0 });
      setPhase("processing");
      setStatus({ text: x.processing, error: false });
      try {
        const output = await extractAssets(file, {
          signal: controller.signal,
          maxPages: EXTRACT_LIMITS.maxPages,
          maxAssets: EXTRACT_LIMITS.maxAssets,
          pageRange: pageRange ? { from: pageRange.from - 1, to: pageRange.to - 1 } : undefined,
          onProgress: (value) => {
            if (runIdRef.current !== runId) return;
            setProgress({ page: Math.min(value.pageCount, value.pageIndex + 1), total: value.pageCount, found: value.assetsSoFar });
          },
        });
        if (runIdRef.current !== runId || !aliveRef.current) return;
        const next = pageRange ? { from: pageRange.from - 1, to: pageRange.to - 1 } : undefined;
        setRequested(next);
        setResult(output);
        setAutoUnavailable(false);
        setSelected((previous) => pruneSelection(previous, output.assets));
        setFilter("all");
        setTab("items");
        const shown = analyzedRange(output.pageCount, next, EXTRACT_LIMITS.maxPages);
        const analyzed = shown.to - shown.from + 1;
        setStatus({ text: summaryText(x, output, analyzed), error: false });
        addRecentEntry("extract-assets", file.name);
        setPhase("done");
      } catch (caught) {
        if (runIdRef.current !== runId || !aliveRef.current) return;
        if (isCancellation(caught)) return;
        if (isExtractUnavailable(caught)) {
          // Sin deteccion automatica: se ofrece el recorte a mano, que no depende de ella.
          setResult(EMPTY_RESULT);
          setAutoUnavailable(true);
          setTab("region");
          setRegionVisited(true);
          setStatus({ text: x.autoUnavailable, error: false });
          setPhase("done");
          return;
        }
        setError(errorCodeOf(caught, (error) => toPdfError(error).code));
        setStatus({ text: "", error: false });
        setPhase("idle");
      }
    },
    [file, x],
  );

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    setProgress(null);
    setError("cancelled");
    setStatus({ text: x.cancelled, error: false });
    setPhase("idle");
    ask("run");
  }, [ask, x.cancelled]);

  // Al terminar, el foco va al titulo del resultado (el que anuncia el recuento).
  useEffect(() => {
    if (phase === "done") headingRef.current?.focus({ preventScroll: false });
  }, [phase]);

  /* ---- Descargas --------------------------------------------------------------------------------------------- */

  const downloadOne = useCallback(
    async (asset: ExtractedAsset, format?: AssetFormat) => {
      if (!file || busy) return;
      const chosen = format ?? resolveFormat(asset, formatPreference);
      setBusy({ id: asset.id, format: chosen });
      try {
        const blob = await renderAsset(file, asset, chosen);
        if (!aliveRef.current) return;
        const name = withExtension(names.get(asset.id) ?? asset.id, chosen);
        downloadBlob(blob, name);
        say(fill(x.downloaded, { name }));
      } catch {
        if (aliveRef.current) say(x.downloadFailed, true);
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    },
    [file, busy, formatPreference, names, say, x],
  );

  const runZip = useCallback(async () => {
    if (!file || zip.phase === "working") return;
    const picked = sorted.filter((asset) => selected.has(asset.id));
    if (picked.length === 0) {
      say(x.zipNeedSelection, true);
      return;
    }
    const controller = new AbortController();
    zipAbortRef.current = controller;
    setZip({ phase: "working", done: 0, total: picked.length });
    say(x.zipBusy);
    const entries: ZipEntry[] = [];
    let failed = 0;
    try {
      for (let index = 0; index < picked.length; index += 1) {
        if (controller.signal.aborted) return;
        const asset = picked[index];
        const format = resolveFormat(asset, formatPreference);
        try {
          entries.push({ name: withExtension(names.get(asset.id) ?? asset.id, format), blob: await renderAsset(file, asset, format) });
        } catch {
          failed += 1;
        }
        if (aliveRef.current) setZip({ phase: "working", done: index + 1, total: picked.length });
      }
      if (controller.signal.aborted || !aliveRef.current) return;
      if (entries.length === 0) {
        say(x.downloadFailed, true);
        return;
      }
      const built = await buildAssetsZip(entries, { signal: controller.signal });
      if (!aliveRef.current || controller.signal.aborted) return;
      downloadBlob(built.blob, withSuffix(file.name, x.zipSuffix, "zip"));
      const base = entries.length === 1 ? x.zipDoneOne : fill(x.zipDone, { n: entries.length });
      say(failed > 0 ? `${base} ${fill(x.zipPartial, { failed })}` : base);
    } catch (caught) {
      if (!aliveRef.current || isCancellation(caught)) return;
      say(errorCodeOf(caught, (error) => toPdfError(error).code) === "tooLarge" ? x.zipTooLarge : x.downloadFailed, true);
    } finally {
      if (aliveRef.current) setZip({ phase: "idle" });
    }
  }, [file, zip.phase, sorted, selected, formatPreference, names, say, x]);

  const cancelZip = useCallback(() => {
    zipAbortRef.current?.abort();
    setZip({ phase: "idle" });
    say(x.cancelled);
  }, [say, x.cancelled]);

  /* ---- Guardar en «Firmas guardadas» --------------------------------------------------------------------------- */

  const openSave = useCallback((asset: ExtractedAsset) => {
    setDetailOpen(false);
    setSaveAsset(asset);
    setSaveKey((current) => current + 1);
    setSaveOpen(true);
  }, []);

  const loadForSave = useMemo(
    () => (file && saveAsset ? () => renderAsset(file, saveAsset, saveAsset.formats.includes("png") ? "png" : undefined) : null),
    [file, saveAsset],
  );

  /* ---- Pantalla ---------------------------------------------------------------------------------------------- */

  const code = problem?.code ?? error;
  const picker = useReplaceFilePicker({
    tool: TOOL,
    onPick: (picked) => {
      setFile(picked);
      setError(null);
      ask("attention");
    },
    onInvalid: setError,
  });
  const banner =
    code && code !== "cancelled"
      ? {
          key: problem ? `file-${problem.code}` : code,
          ...errorCopy(t, code, { fileProblem: problem !== null }),
          detail: problem ? t.tool.fileProblemFile.replace("{name}", problem.file.name) : undefined,
          actions: [
            ...(code === "encrypted"
              ? [{ id: "unlock", label: t.tool.errors.encryptedAction, href: toolHref("unlock-pdf"), primary: true }]
              : []),
            ...(problem
              ? [
                  { id: "choose", label: t.tool.chooseAnother, primary: code !== "encrypted" },
                  { id: "remove", label: t.tool.removeFile },
                ]
              : []),
          ],
        }
      : null;
  const onBannerAction = (action: { id?: string }) => {
    if (action.id === "choose") {
      picker.open();
      return;
    }
    if (action.id !== "remove" || !problem) return;
    setFile(null);
    setError(null);
    ask("attention");
  };

  const proCandidate = file && !problem && !checking ? file : null;
  const goRegion = useCallback(
    (page?: number) => {
      if (page !== undefined) setRegionPage(page);
      setRegionVisited(true);
      setTab("region");
    },
    [],
  );
  const onTab = (next: Tab) => {
    if (next === "region") setRegionVisited(true);
    setTab(next);
  };
  const firstScanned = result?.scannedPages[0] ?? 0;

  const openDetails = useCallback((asset: ExtractedAsset) => {
    setDetailAsset(asset);
    setDetailOpen(true);
  }, []);
  const toggle = useCallback((id: string) => setSelected((previous) => toggleSelection(previous, id)), []);
  const changeFilter = useCallback(
    (next: FilterId) => {
      setFilter(next);
      if (result) {
        const count = filterAssets(sorted, next).length;
        say(fill(x.shown, { n: count, total: sorted.length }));
      }
    },
    [result, sorted, say, x.shown],
  );

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-24 md:px-6 md:pt-12 md:pb-16">
      <header className="mb-4 flex items-start gap-4">
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[TOOL.accent])}>
          <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-1 text-foreground">{copy.name}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{copy.description}</p>
        </div>
      </header>

      {/* Nota fija de una linea: sin casilla ni marca, sin interaccion obligatoria. */}
      <p className="mb-6 flex items-start gap-2 text-footnote text-muted-foreground" data-extract-note>
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{x.note}</span>
      </p>

      <ErrorBanner
        show={banner !== null}
        errorKey={banner?.key}
        title={banner?.title ?? ""}
        message={banner?.message ?? ""}
        hint={banner?.hint}
        detail={banner?.detail}
        actions={banner?.actions}
        onAction={onBannerAction}
        variant={banner?.kind ?? "error"}
        bannerRef={bannerRef}
        onDismiss={problem ? undefined : () => setError(null)}
        dismissLabel={t.common.close}
      />
      {banner ? picker.input : null}

      {/* Region viva UNICA: recuento, filtros, descargas, guardados y cancelaciones pasan por aqui. */}
      <p
        role="status"
        aria-live="polite"
        data-extract-status
        className={cn(
          // En el resultado el recuento ya esta a la vista (titulo): la region viva solo se pinta si es un error.
          status.text && (status.error || phase !== "done") ? "mb-4 text-subheadline" : "sr-only",
          status.error ? "text-destructive-text" : "text-muted-foreground",
        )}
      >
        {status.text}
      </p>

      {phase !== "done" ? (
        <div ref={areaRef as React.RefObject<HTMLDivElement>}>
          <div className="mb-3 flex items-baseline justify-between gap-3 pointer-coarse:mb-5">
            <h2 className="ui-label text-muted-foreground">{x.chooseTitle}</h2>
            {proCandidate ? (
              <Link
                href={toolHref("pdf-pro")}
                onClick={() => setHandoff(proCandidate, "extract-assets", 1)}
                className={buttonClasses("ghost", "sm", "ml-auto")}
              >
                <Layers aria-hidden="true" className="size-4" />
                {t.tool.openInPro}
              </Link>
            ) : null}
          </div>
          {file ? (
            <FileList files={[file]} onChange={(next) => setFile(next[0] ?? null)} />
          ) : (
            <FileDropzone tool={TOOL} files={[]} onFilesChange={(next) => setFile(next[0] ?? null)} onError={setError} />
          )}
          <p className="mt-3 text-footnote text-muted-foreground">{x.chooseHint}</p>

          <div className="mt-8 flex flex-col items-start gap-3">
            <Button
              ref={runRef}
              size="lg"
              disabled={!file || problem !== null || checking}
              aria-describedby={!file || problem ? "extract-run-reason" : undefined}
              onClick={() => void run()}
              className="w-full md:w-auto"
              data-extract-run
            >
              <ImageIcon aria-hidden="true" className="size-4" />
              {x.run}
            </Button>
            {!file || problem ? (
              <p id="extract-run-reason" className="text-footnote text-muted-foreground">
                {problem ? blockedRunText(t, x.run) : x.runNeedFile}
              </p>
            ) : null}
            <p className="flex items-center gap-2 text-footnote text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
              {t.tool.localNotice}
            </p>
          </div>
        </div>
      ) : null}

      {phase === "processing" ? (
        <ProcessingOverlay
          progress={progress && progress.total > 0 ? Math.round((progress.page / progress.total) * 100) : 0}
          message={progress && progress.total > 0 ? fill(x.progress, { page: progress.page, total: progress.total, found: progress.found }) : x.progressStart}
          onCancel={cancel}
        />
      ) : null}

      {phase === "done" && result && file ? (
        <div className="animate-rise-in space-y-6">
          <section className="surface-card rounded-ios p-5">
            <h2 ref={headingRef} tabIndex={-1} className="scroll-mt-24 text-headline text-foreground outline-none" data-extract-heading>
              {autoUnavailable ? x.autoUnavailable : summaryText(x, result, range.to - range.from + 1)}
            </h2>
            <p className="mt-1 text-footnote break-words text-muted-foreground">
              {x.fileLabel}: {file.name}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Link
                href={toolHref("pdf-pro")}
                onClick={() => setHandoff(file, "extract-assets", 1)}
                className={buttonClasses("secondary", "sm")}
              >
                <Layers aria-hidden="true" className="size-4" />
                {t.tool.openInPro}
              </Link>
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {x.startOver}
              </Button>
            </div>
          </section>

          {notices.length > 0 ? (
            <ul className="space-y-2" aria-label={x.noticesLabel} data-extract-notices>
              {notices.map((notice) => (
                <li key={notice.id} className="surface-card flex flex-wrap items-center gap-3 rounded-ios p-3 text-subheadline text-foreground" data-notice={notice.code}>
                  <span className="min-w-0 flex-1 basis-60">{notice.text}</span>
                  {notice.action === "region" ? (
                    <Button size="sm" variant="secondary" onClick={() => goRegion(firstScanned)}>
                      <Crop aria-hidden="true" className="size-4" />
                      {x.warnScannedAction}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {result.pageCount > EXTRACT_LIMITS.maxPages || notices.some((notice) => notice.action === "range") ? (
            <RangeNotice strings={x} pageCount={result.pageCount} initial={range} onApply={(next) => void run(next)} />
          ) : null}

          <SegmentedControl
            label={x.tabsLabel}
            hideLabel
            value={tab}
            onChange={onTab}
            options={[
              { value: "items" as const, label: autoUnavailable ? x.tabItems : `${x.tabItems} (${result.assets.length})` },
              { value: "region" as const, label: x.tabRegion },
            ]}
          />

          <div role="tabpanel" aria-label={x.panelItems} hidden={tab !== "items"}>
            {tab === "items" ? (
              result.assets.length === 0 ? (
                <div className="surface-card space-y-3 rounded-ios p-5" data-extract-empty>
                  <p className="text-headline text-foreground">{autoUnavailable ? x.autoUnavailable : x.foundNone}</p>
                  {autoUnavailable ? null : <p className="text-subheadline text-muted-foreground">{x.emptyBody}</p>}
                  <Button variant="secondary" onClick={() => goRegion(firstScanned)}>
                    <Crop aria-hidden="true" className="size-4" />
                    {x.goRegion}
                  </Button>
                </div>
              ) : (
                <ExtractGallery
                  strings={x}
                  locale={locale}
                  assets={sorted}
                  visible={visible}
                  counts={counts}
                  filter={filter}
                  selected={selected}
                  busyId={busy?.id ?? null}
                  zip={zip}
                  formatPreference={formatPreference}
                  offersOriginal={originalOffered}
                  onFilter={changeFilter}
                  onToggle={toggle}
                  onToggleAll={() => {
                    const next = toggleAllVisible(selected, visible);
                    setSelected(next);
                    say(fill(next.size === 1 ? x.selectedOne : x.selectedMany, { n: next.size }));
                  }}
                  onClearSelection={() => setSelected(new Set())}
                  onFormat={setFormatPreference}
                  onDetails={openDetails}
                  onDownload={(asset) => void downloadOne(asset)}
                  onSave={openSave}
                  onZip={() => void runZip()}
                  onZipCancel={cancelZip}
                />
              )
            ) : null}
          </div>

          <div role="tabpanel" aria-label={x.panelRegion} hidden={tab !== "region"}>
            {regionVisited ? (
              <RegionPanel
                file={file}
                page={regionPage}
                onPageChange={setRegionPage}
                scannedPages={result.scannedPages}
                strings={x}
                closeLabel={t.common.close}
                onStatus={say}
                onSaved={(message) => say(message)}
              />
            ) : null}
          </div>

          <AssetDetailSheet
            open={detailOpen}
            asset={detailAsset}
            strings={x}
            locale={locale}
            closeLabel={t.common.close}
            selected={detailAsset ? selected.has(detailAsset.id) : false}
            busyFormat={busy && detailAsset && busy.id === detailAsset.id ? busy.format : null}
            onClose={() => setDetailOpen(false)}
            onToggle={toggle}
            onDownload={(asset, format) => void downloadOne(asset, format)}
            onSave={openSave}
          />
          <SaveSignatureSheet
            open={saveOpen}
            instanceKey={saveKey}
            onClose={() => setSaveOpen(false)}
            strings={x}
            closeLabel={t.common.close}
            sourceDocument={file.name}
            load={loadForSave}
            preCleaned={false}
            hasAlpha={saveAsset?.pixel?.hasAlpha ?? false}
            defaultKind={saveAsset ? defaultVaultKind(saveAsset) : "signature"}
            onSaved={(message) => say(message)}
            onCropAnother={() => {
              setSaveOpen(false);
              goRegion();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
