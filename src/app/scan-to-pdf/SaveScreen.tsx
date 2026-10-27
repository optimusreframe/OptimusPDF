"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Layers, Share2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { ImageQualityPicker } from "@/components/tool/ImageQualityPicker";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { setHandoff } from "@/app/pdf-pro/proHandoff";
import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import type { PdfSizeEstimate } from "@/lib/image/estimatePdfSize";
import { readStoredImagePreset, writeStoredImagePreset } from "@/lib/image/imageQualityPref";
import { type ImagePresetId } from "@/lib/image/prepareForPdf";
import { IMAGE_QUALITY_STRINGS, SHARE_LIMIT_HUGE, describeResult } from "@/lib/image/qualityStrings";
import { downloadBlob, formatFileSize } from "@/lib/pdf/core";
import { addRecentEntry } from "@/lib/recent";
import { toolHref } from "@/lib/tools-registry";
import { fileNameFor } from "@/app/scan-to-pdf/scanState";
import { isAlreadyOptimized } from "@/app/scan-to-pdf/sizeNote";
import { engineNeedsReload, isEngineUnavailableError, ocrModelAvailable, preloadEngine, prepareOcrModel } from "@/app/scan-to-pdf/scanServices";
import { ScreenShell } from "@/app/scan-to-pdf/ScreenShell";
import { useAnnounce } from "@/app/scan-to-pdf/ScanLive";
import { OCR_MODEL_MB, type ScanToPdfStrings } from "@/app/scan-to-pdf/strings";
import type { ScanBuildWarning } from "@/lib/scan/types";
import type { ScanSessionApi } from "@/app/scan-to-pdf/useScanSession";
import { useIsClient } from "@/hooks/useIsClient";

/** Aviso de peso (bytes): por encima de ~20 MB muchos correos rechazan el adjunto. */
export const SIZE_WARN_BYTES = 20 * 1024 * 1024;

type PageSize = "a4" | "letter" | "fit";
type Margin = "none" | "small" | "large";

export type ScanResult = { blob: Blob; filename: string; summary: string; notices?: { title: string; items: string[] } };

export type SaveScreenProps = {
  s: ScanToPdfStrings;
  api: ScanSessionApi;
  onBack: () => void;
  onBuilt: (result: ScanResult) => void;
  fallbackName: string;
};

/** Guardar: nombre inteligente, calidad (con estimacion «≈»), hoja y margen, texto buscable opcional y PDF con progreso cancelable. */
export function SaveScreen({ s, api, onBack, onBuilt, fallbackName }: SaveScreenProps) {
  const { t, language } = useI18n();
  const announce = useAnnounce();
  const isClient = useIsClient();
  const locale = localeTag(language);
  const copy = IMAGE_QUALITY_STRINGS[language];
  const [preset, setPreset] = useState<ImagePresetId | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>("a4");
  const [margin, setMargin] = useState<Margin>("none");
  const [phase, setPhase] = useState<"form" | "building">("form");
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const engineFailedRef = useRef<{ tried: boolean; needsReload: boolean } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const runRef = useRef(0);
  // Texto buscable: el motor es 100 % local por defecto y NO descarga nada solo. Se pregunta si el modelo ya esta en el dispositivo
  // (`ocrModelAvailable`, sin red) y, si no, hay una accion EXPLICITA para bajarlo. Sin el modelo el PDF sale normal y el aviso del
  // motor (`onWarning`) se muestra en el resultado: nunca es un error.
  const [failedWhileSearchable, setFailedWhileSearchable] = useState(false);
  // `null` = el motor cargo; si no, ya se intento una vez (`tried`) y/o el motor pide recargar (`needsReload`).
  const [engineFailed, setEngineFailed] = useState<{ tried: boolean; needsReload: boolean } | null>(null);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [model, setModel] = useState<{ phase: "idle" | "downloading" | "failed"; reason?: "offline" | "network" | "engine" }>({ phase: "idle" });
  const modelAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    engineFailedRef.current = engineFailed;
  }, [engineFailed]);

  // La calidad recordada solo se conoce ya en el cliente (localStorage).
  const effective: ImagePresetId = preset ?? (isClient ? readStoredImagePreset() : "balanced");
  const pages = api.pages;
  const searchable = api.settings.searchable;
  const needsModel = searchable && modelReady === false;

  useEffect(() => {
    if (!searchable) return;
    let live = true;
    void ocrModelAvailable().then((ready) => {
      if (live) setModelReady(ready);
    });
    return () => {
      live = false;
    };
  }, [searchable]);

  useEffect(() => () => modelAbort.current?.abort(), []);

  const downloadModel = async () => {
    if (model.phase === "downloading") return;
    const controller = new AbortController();
    modelAbort.current = controller;
    setModel({ phase: "downloading" });
    announce(s.modelDownloading);
    const result = await prepareOcrModel({ signal: controller.signal });
    if (controller.signal.aborted && !result.ok && result.reason === "cancelled") {
      setModel({ phase: "idle" });
      return;
    }
    if (result.ok) {
      setModelReady(true);
      setModel({ phase: "idle" });
      announce(s.modelReady);
    } else if (result.reason === "cancelled") {
      setModel({ phase: "idle" });
    } else {
      setModel({ phase: "failed", reason: result.reason });
    }
  };

  const nameProposed = useRef(false);
  const { proposeNameNow } = api;
  useEffect(() => {
    if (nameProposed.current) return;
    nameProposed.current = true;
    void proposeNameNow();
  }, [proposeNameNow]);

  // La estimacion recorre TODAS las paginas del motor: no se repite en cada cuadro del progreso (con 40 fotos, cada `setProgress` la
  // recalculaba y el overlay y «Cancelar» tardaban en responder). Solo cambia con las paginas, la calidad o el texto buscable.
  const { estimate: estimateSize } = api;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages` y `searchable` son las entradas reales (`estimateSize` lee el estado vigente)
  const raw = useMemo(() => estimateSize(effective), [estimateSize, effective, pages, searchable]);
  const sourceBytes = useMemo(() => pages.reduce((sum, page) => sum + page.original.size, 0), [pages]);
  // «Sin optimizar» = la estimacion de ORIGINAL del mismo calculo (no una cifra aparte que no coincide con el PDF «Original»).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mismas entradas que `raw`
  const original = useMemo(() => estimateSize("original"), [estimateSize, pages, searchable]);
  const alreadyOptimized = effective !== "original" && isAlreadyOptimized(raw.bytes, original.bytes);
  const estimate: PdfSizeEstimate | null = pages.length
    ? { photos: pages.length, sourceBytes, optimizedBytes: raw.bytes, unoptimizedBytes: original.bytes }
    : null;
  const sizeText = formatFileSize(raw.bytes, locale);

  const build = async () => {
    if (pages.length === 0 || phase === "building") return;
    // El valor vigente en este instante (si viene de «Crear sin texto buscable», `searchable` del render aun es el anterior).
    const wantsText = api.stateRef.current.settings.searchable;
    const run = runRef.current + 1;
    runRef.current = run;
    setError(null);
    setFailedWhileSearchable(false);
    setProgress(0);
    setProgressText(s.buildProgress(1, pages.length));
    setPhase("building");
    const controller = new AbortController();
    abortRef.current = controller;
    const warnings: ScanBuildWarning[] = [];
    try {
      const blob = await api.buildPdf({
        preset: effective,
        pageSize,
        margin,
        signal: controller.signal,
        onWarning: (warning) => warnings.push(warning),
        onProgress: (done, total) => {
          if (runRef.current !== run) return;
          setProgress(Math.round((done / Math.max(1, total)) * 100));
          setProgressText(s.buildProgress(Math.min(total, done + 1), total));
        },
      });
      if (runRef.current !== run) return;
      const name = api.stateRef.current.name;
      const filename = fileNameFor(name, fallbackName);
      const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
      const described = describeResult(copy, { sourceBytes, pdfBytes: blob.size }, (bytes) => formatFileSize(bytes, locale), (value) => percent.format(value / 100));
      addRecentEntry("scan-to-pdf", filename);
      // Pidio texto buscable pero el motor lo degrado (falta el modelo, sin red...): AVISO en el resultado con SU texto (no es un error: el PDF es valido).
      const missing = wantsText ? warnings.map((warning) => s.searchableWarning(warning)) : [];
      const notices = missing.length > 0 ? { title: described.notices?.title ?? s.searchableNoticeTitle, items: [...(described.notices?.items ?? []), ...missing] } : described.notices;
      setEngineFailed(null);
      onBuilt({ blob, filename, summary: described.summary, notices });
    } catch (caught) {
      if (runRef.current !== run) return;
      const aborted = (caught as Error)?.name === "AbortError" || controller.signal.aborted;
      setPhase("form");
      // El escaner no se pudo CARGAR (sin red): mensaje propio con «Reintentar», no «no se pudo crear el PDF» ni nada de fotos dañadas.
      const unavailable = !aborted && isEngineUnavailableError(caught);
      const message = aborted ? s.buildCancelled : unavailable ? s.importProblems.engineUnavailable : wantsText ? s.searchableFailed : s.buildFailed;
      setFailedWhileSearchable(!aborted && !unavailable && wantsText);
      setEngineFailed(unavailable ? { tried: engineFailedRef.current !== null, needsReload: engineNeedsReload(caught) } : null);
      // El aviso recibe el foco: el lector lo lee al llegar (anunciarlo ademas por la region viva lo diria dos veces).
      setError(message);
      requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: false }));
    }
  };

  // Mientras se crea el PDF el foco va a «Cancelar» (el overlay es modal): Intro / Espacio cancelan sin buscar el boton.
  useEffect(() => {
    if (phase !== "building") return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-processing-overlay] button")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const cancel = () => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("form");
    setError(s.buildCancelled);
    announce(s.buildCancelled);
    requestAnimationFrame(() => createRef.current?.focus());
  };

  const big = raw.bytes > SIZE_WARN_BYTES;
  const huge = raw.bytes > SHARE_LIMIT_HUGE;

  return (
    <>
      <ScreenShell
        className="max-w-[720px]"
        rootProps={{ "data-save-screen": "" }}
        barProps={{ "data-save-bar": "" }}
        top={
          <>
            <Button variant="ghost" size="md" data-save-action="back" className="-ml-3" onClick={onBack}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              {s.saveBack}
            </Button>
            <h2 data-view-heading="" tabIndex={-1} className="mt-1 text-title-2 text-foreground outline-none">
              {s.saveTitle}
            </h2>
          </>
        }
        bar={
          <>
            <Button ref={createRef} size="lg" fullWidth wrap className="min-h-[56px]" data-save-action="create" disabled={pages.length === 0} onClick={() => void build()}>
              {s.create}
            </Button>
            <p data-create-meta="" className="mt-1.5 text-center text-footnote text-muted-foreground tabular-nums">
              {needsModel ? s.createMetaNoModel : s.createMeta(pages.length, `≈ ${sizeText}`)}
            </p>
          </>
        }
      >
      <div className="mt-3 flex flex-col gap-6 pb-6">
        <div>
          <label htmlFor="scan-name" className="ui-label text-muted-foreground">
            {s.nameLabel}
          </label>
          <input
            id="scan-name"
            ref={nameRef}
            type="text"
            value={api.name}
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => api.setName(event.target.value, true)}
            className="mt-1.5 h-12 w-full rounded-ios-sm border border-hairline bg-white/5 px-3 text-[16px] text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-footnote text-muted-foreground">{s.nameHint}</p>
            {api.state.nameEdited ? (
              <Button variant="ghost" size="sm" data-save-action="reset-name" onClick={() => { api.setName("", false); void api.proposeNameNow(); }}>
                {s.nameReset}
              </Button>
            ) : null}
          </div>
        </div>

        <ImageQualityPicker
          value={effective}
          estimate={estimate}
          estimateNote={alreadyOptimized ? s.alreadyOptimized(formatFileSize(raw.bytes, locale)) : null}
          onChange={(next) => {
            setPreset(next);
            writeStoredImagePreset(next);
          }}
        />

        {big ? (
          <p data-size-warning={huge ? "huge" : "big"} className="-mt-3 text-footnote text-foreground">
            {huge ? s.sizeHuge : s.sizeBig}
          </p>
        ) : null}

        <SegmentedControl<PageSize>
          label={s.pageSizeLabel}
          value={pageSize}
          onChange={setPageSize}
          options={[
            { value: "a4", label: s.pageSizeA4 },
            { value: "letter", label: s.pageSizeLetter },
            { value: "fit", label: s.pageSizeFit },
          ]}
        />

        <SegmentedControl<Margin>
          label={s.marginLabel}
          value={margin}
          onChange={setMargin}
          options={[
            { value: "none", label: s.marginNone },
            { value: "small", label: s.marginSmall },
            { value: "large", label: s.marginLarge },
          ]}
        />

        <div className="flex flex-col gap-2">
          <Checkbox label={s.searchable} hint={s.searchableHint} checked={searchable} onChange={(checked) => api.setSettings({ searchable: checked })} />
          {needsModel ? (
            <div data-ocr-download="" className="ml-1 rounded-ios border border-accent-edit/50 bg-accent-edit/10 p-3">
              <p className="text-footnote text-foreground">{s.searchableDownloadNote(OCR_MODEL_MB)}</p>
              {model.phase === "failed" && model.reason ? (
                <p data-ocr-download-error="" className="mt-2 text-footnote font-medium text-foreground">
                  {s.modelFailed[model.reason]}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" size="md" wrap data-save-action="download-model" disabled={model.phase === "downloading"} aria-busy={model.phase === "downloading" || undefined} onClick={() => void downloadModel()}>
                  {model.phase === "downloading" ? s.modelDownloading : s.downloadModel(OCR_MODEL_MB)}
                </Button>
                {model.phase === "downloading" ? (
                  <Button variant="ghost" size="md" wrap data-save-action="cancel-model" onClick={() => modelAbort.current?.abort()}>
                    {s.downloadModelCancel}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>


      {error ? (
        <p ref={errorRef} tabIndex={-1} data-save-error="" className="mt-5 rounded-ios border border-hairline bg-white/5 p-3 text-subheadline text-foreground outline-none">
          {error}
        </p>
      ) : null}

        {error && engineFailed ? (
          <div className="mt-3 flex flex-col gap-2 pb-6">
            <p data-save-reload-hint="" className="text-footnote text-muted-foreground">
              {s.importProblems.engineReload(0)}
            </p>
            {/* Recargar es la accion PRINCIPAL: un reintento sin recargar no recupera un trozo que el cargador dio por fallido. */}
            <Button size="md" fullWidth wrap data-save-action="reload" onClick={() => window.location.reload()}>
              {s.importProblems.reload}
            </Button>
            {/* «Reintentar» solo si puede funcionar: hay conexion, el motor no pide recargar y no se acaba de reintentar. */}
            {!engineFailed.needsReload && !engineFailed.tried && (typeof navigator === "undefined" || navigator.onLine !== false) ? (
              <Button variant="secondary" size="md" fullWidth wrap data-save-action="retry" onClick={() => { preloadEngine(); void build(); }}>
                {s.importProblems.retry}
              </Button>
            ) : null}
          </div>
        ) : null}

        {error && searchable && failedWhileSearchable ? (
          <div className="mt-3 pb-6">
            <Button variant="secondary" size="md" fullWidth wrap data-save-action="without-text" onClick={() => { api.setSettings({ searchable: false }); void build(); }}>
              {s.createWithoutText}
            </Button>
          </div>
        ) : null}
      </ScreenShell>

      <AnimatePresence>{phase === "building" ? <ProcessingOverlay progress={progress} message={progressText || t.tools["scan-to-pdf"].name} onCancel={cancel} /> : null}</AnimatePresence>
    </>
  );
}

export type ResultScreenProps = {
  s: ScanToPdfStrings;
  result: ScanResult;
  onBackToReview: () => void;
  onNewScan: () => void;
  downloadRef: React.Ref<HTMLButtonElement>;
};

/** Resultado: «Antes → Despues», descargar, compartir (hoja nativa si existe) y seguir en PDF Pro. */
export function ResultScreen({ s, result, onBackToReview, onNewScan, downloadRef }: ResultScreenProps) {
  const isClient = useIsClient();
  const announce = useAnnounce();
  const file = useMemo(() => new File([result.blob], result.filename, { type: "application/pdf" }), [result]);
  const canShare = isClient && typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] }));
  const { t } = useI18n();

  const share = async () => {
    try {
      await navigator.share({ files: [file], title: result.filename.replace(/\.pdf$/i, "") });
      announce(s.shareDone);
    } catch (caught) {
      if ((caught as Error)?.name !== "AbortError") announce(s.shareFailed);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-10 md:px-6 md:pt-10" data-result="">
      <DownloadScreen
        slug="scan-to-pdf"
        filename={result.filename}
        size={result.blob.size}
        onDownload={() => downloadBlob(result.blob, result.filename)}
        onStartOver={onNewScan}
        downloadButtonRef={downloadRef}
        summary={result.summary}
        notices={result.notices}
        extras={
          <div className="flex flex-col gap-2">
            {canShare ? (
              <Button variant="secondary" size="md" fullWidth data-result-action="share" onClick={() => void share()}>
                <Share2 aria-hidden="true" className="size-4" />
                {s.share}
              </Button>
            ) : null}
            <Button variant="ghost" size="md" fullWidth data-result-action="back" onClick={onBackToReview}>
              <ArrowLeft aria-hidden="true" className="size-4" />
              {s.backToReview}
            </Button>
          </div>
        }
        continueAction={
          <Link href={toolHref("pdf-pro")} onClick={() => setHandoff(file, "scan-to-pdf")} className={cn(buttonClasses("secondary", "md", "mt-2"))} data-result-action="pro">
            <Layers aria-hidden="true" className="size-4" />
            {t.tool.continueInPro}
          </Link>
        }
      />
    </div>
  );
}
