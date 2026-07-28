"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  RotateCcw,
  ShieldOff,
  Sparkles,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { ToolCard } from "@/components/tool/ToolCard";
import { SUMMARIZER_STRINGS } from "@/app/pdf-summarizer/strings";
import { cn } from "@/lib/cn";
import { localeTag, useI18n, type Language } from "@/lib/i18n";
import { addRecentEntry } from "@/lib/recent";
import {
  downloadBlob,
  formatFileSize,
  toPdfError,
  withSuffix,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  DEFAULT_SUMMARIZER_MODEL,
  SUMMARIZER_MODELS,
  SUMMARIZER_MODEL_KEYS,
  detectWebGpuSupport,
  formatPageRange,
  isModelCached,
  renderSummaryDocument,
  summarizePdf,
  type SummarizerModelKey,
  type SummarizerProgress,
  type SummaryLength,
  type SummaryResult,
  type WebGpuStatus,
} from "@/lib/pdf/summarize";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  getRelatedTools,
  getTool,
} from "@/lib/tools-registry";

/**
 * Resumir PDF: resumen con un modelo de lenguaje que se ejecuta en el
 * navegador (WebGPU + @mlc-ai/web-llm). Sin nube, sin API, sin
 * degradacion silenciosa.
 *
 * DECISION DE FLUJO (mismo razonamiento que `compare-pdf`): esta
 * herramienta no termina en un archivo procesado, sino en un texto en
 * pantalla, y ademas necesita dos pasos que `ToolShell` no contempla —
 * una comprobacion de capacidades ANTES de dejar empezar y un
 * consentimiento explicito para una descarga de cientos de megabytes.
 * Por eso se replica su maquina de estados reutilizando sus piezas
 * (`FileDropzone`, `ProcessingOverlay`, `ToolCard`, `lib/recent`) en vez
 * de forzar `ToolShell`, que queda intacto para las demas.
 *
 * ORDEN DE LAS PANTALLAS, y por que:
 *   capabilities -> si el navegador no puede, no se ofrece nada mas.
 *   idle/files   -> el PDF entra en la pestana, todavia sin descargas.
 *   consent      -> se ensena el peso del modelo y se pide permiso.
 *   processing   -> extraer, (OCR), descargar modelo, resumir, combinar.
 *   done         -> resumen SIEMPRE acompanado del aviso de IA.
 */

const TOOL = getTool("pdf-summarizer");

type Phase = "idle" | "files" | "processing" | "done";

/** Error local de esta herramienta, sin equivalente en `PdfErrorCode`. */
type LocalError = "noText" | "model";

export function PdfSummarizerToolClient() {
  const { t, language } = useI18n();
  const s = SUMMARIZER_STRINGS[language];
  const copy = t.tools["pdf-summarizer"];
  const Icon = TOOL.icon;
  const locale = localeTag(language);

  const [gpu, setGpu] = useState<WebGpuStatus>("checking");
  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [modelKey, setModelKey] =
    useState<SummarizerModelKey>(DEFAULT_SUMMARIZER_MODEL);
  const [cached, setCached] = useState(false);
  const [consented, setConsented] = useState(false);
  const [length, setLength] = useState<SummaryLength>("medium");
  const [outputLanguage, setOutputLanguage] = useState<Language>(language);
  const [ocrFallback, setOcrFallback] = useState(true);

  const [progress, setProgress] = useState(0);
  const [stageMessage, setStageMessage] = useState("");
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [localError, setLocalError] = useState<LocalError | null>(null);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [copiedFlag, setCopiedFlag] = useState(false);

  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const model = SUMMARIZER_MODELS[modelKey];

  /* --------------------------------------------------------------- *
   * Compuerta de capacidades. Solo consulta al driver: no descarga
   * nada ni pide permisos al usuario.
   * --------------------------------------------------------------- */
  useEffect(() => {
    let alive = true;
    void detectWebGpuSupport().then((status) => {
      if (alive) setGpu(status);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* --------------------------------------------------------------- *
   * ¿Estan ya los pesos en cache? Cambia el copy del consentimiento:
   * pedir permiso para una descarga que no va a ocurrir seria mentir.
   * --------------------------------------------------------------- */
  useEffect(() => {
    if (gpu !== "ready") return;
    let alive = true;
    void isModelCached(model).then((value) => {
      if (alive) setCached(value);
    });
    return () => {
      alive = false;
    };
  }, [gpu, model]);

  const onFilesChange = useCallback((next: File[]) => {
    setFiles(next);
    setError(null);
    setLocalError(null);
    setPhase(next.length === 0 ? "idle" : "files");
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setFiles([]);
    setResult(null);
    setProgress(0);
    setStageMessage("");
    setError(null);
    setLocalError(null);
    setConsented(false);
    setCopiedFlag(false);
    setPhase("idle");
  }, []);

  const describeStage = useCallback(
    (report: SummarizerProgress): string => {
      switch (report.stage) {
        case "extracting":
          return s.stageExtracting;
        case "ocr":
          return s.stageOcr;
        case "loadingModel":
          return report.detail
            ? `${s.stageLoadingModel} — ${report.detail}`
            : s.stageLoadingModel;
        case "summarizing":
          return s.stageSummarizing(report.step ?? 1, report.stepCount ?? 1);
        case "synthesizing":
          return s.stageSynthesizing;
      }
    },
    [s],
  );

  /**
   * Reparto de la barra global entre etapas. Son tramos fijos porque el
   * coste real depende del documento y de la GPU: preferimos una barra
   * que avanza de forma comprensible a un porcentaje falso.
   */
  const globalProgress = useCallback((report: SummarizerProgress): number => {
    switch (report.stage) {
      case "extracting":
      case "ocr":
        return report.progress * 0.15;
      case "loadingModel":
        return 0.15 + report.progress * 0.25;
      case "summarizing":
        return 0.4 + report.progress * 0.45;
      case "synthesizing":
        return 0.85 + report.progress * 0.15;
    }
  }, []);

  const run = useCallback(async () => {
    const file = files[0];
    if (!file) {
      setError("empty");
      return;
    }
    // Se vuelve a comprobar aqui, no solo al pintar el boton: arrancar
    // desde un render obsoleto seria saltarse el consentimiento.
    if (gpu !== "ready" || !consented) return;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setLocalError(null);
    setProgress(0);
    setStageMessage(s.stageExtracting);
    setPhase("processing");

    try {
      const output = await summarizePdf(
        file,
        {
          model: modelKey,
          language: outputLanguage,
          length,
          ocrFallback,
          ocrLanguage: outputLanguage === "es" ? "spa" : "eng",
        },
        (report) => {
          if (runIdRef.current !== runId) return;
          setStageMessage(describeStage(report));
          setProgress(
            Math.round(Math.min(1, Math.max(0, globalProgress(report))) * 100),
          );
        },
        controller.signal,
      );
      if (runIdRef.current !== runId) return;
      setResult(output);
      addRecentEntry("pdf-summarizer", file.name);
      setPhase("done");
      // El efecto que llama a `isModelCached` solo corre al montar o al
      // cambiar de modelo: sin esto, tras acabar de descargar y usar el
      // modelo en esta misma pestana, "cached" se quedaria en `false` y
      // un segundo resumen en la misma sesion volveria a pedir
      // consentimiento como si el modelo no estuviera ya disponible.
      setCached(true);
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      const pdfError = toPdfError(caught);
      // `corrupt` con este mensaje concreto significa "no hay texto",
      // que merece un consejo distinto a "el archivo esta danado".
      if (pdfError.message.includes("no extractable text")) {
        setLocalError("noText");
      } else if (pdfError.code === "unknown") {
        setLocalError("model");
      } else {
        setError(pdfError.code);
      }
      setPhase("files");
    }
  }, [
    consented,
    describeStage,
    files,
    globalProgress,
    gpu,
    length,
    modelKey,
    ocrFallback,
    outputLanguage,
    s.stageExtracting,
  ]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(0);
    setError("cancelled");
    setPhase("files");
  }, []);

  const documentText = result
    ? renderSummaryDocument(result, {
        title: s.fileTitle,
        aiWarning: s.fileAiWarning,
        overviewTitle: s.fileOverviewTitle,
        sectionsTitle: s.fileSectionsTitle,
        modelLine: s.fileModelLine,
        truncatedLine: s.fileTruncatedLine,
        ocrLine: s.fileOcrLine,
      })
    : "";

  const onCopy = useCallback(() => {
    if (!documentText) return;
    void navigator.clipboard.writeText(documentText).then(
      () => {
        setCopiedFlag(true);
        window.setTimeout(() => setCopiedFlag(false), 2000);
      },
      () => {
        // Sin portapapeles (permiso denegado, http): el boton de
        // descarga sigue disponible, no hace falta romper nada.
      },
    );
  }, [documentText]);

  const onDownload = useCallback(() => {
    if (!documentText || !files[0]) return;
    const blob = new Blob([documentText], {
      type: "text/plain;charset=utf-8",
    });
    downloadBlob(blob, withSuffix(files[0].name, s.filenameSuffix, "txt"));
  }, [documentText, files, s.filenameSuffix]);

  const header = (
    <header className="mb-8 flex items-start gap-4">
      <span
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-ios",
          ACCENT_BG_SOFT[TOOL.accent],
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-6", ACCENT_TEXT[TOOL.accent])}
        />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-black tracking-[-0.025em] text-foreground md:text-3xl">
            {copy.name}
          </h1>
          <Badge variant={TOOL.status === "live" ? "live" : "soon"} dot>
            {TOOL.status === "live" ? t.common.live : t.common.soon}
          </Badge>
          <Badge variant="neutral">
            <Sparkles aria-hidden="true" className="size-3" />
            {s.aiBadge}
          </Badge>
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {copy.description}
        </p>
      </div>
    </header>
  );

  /* --------------------------------------------------------------- *
   * Pantalla 0: comprobando capacidades
   * --------------------------------------------------------------- */
  if (gpu === "checking") {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-16 md:px-6 md:pt-12">
        {header}
        <section className="glass rounded-ios flex items-start gap-3 p-5">
          <Spinner className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <h2 className="hud-label text-[11px] text-foreground">
              {s.checkingTitle}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {s.checkingBody}
            </p>
          </div>
        </section>
      </div>
    );
  }

  /* --------------------------------------------------------------- *
   * Pantalla 0-bis: el navegador no puede. Se dice y se para.
   * --------------------------------------------------------------- */
  if (gpu !== "ready") {
    const alternatives = getRelatedTools("pdf-summarizer", 3).filter(
      (candidate) => candidate.status === "live",
    );
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-16 md:px-6 md:pt-12">
        {header}
        <section
          role="alert"
          className="rounded-ios border border-destructive/40 bg-destructive/10 p-5"
        >
          <div className="flex items-start gap-3">
            <ShieldOff
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-destructive"
            />
            <div className="min-w-0">
              <h2 className="hud-label text-[11px] text-destructive">
                {s.unsupportedTitle}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-foreground">
                {s.unsupported[gpu]}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-foreground">
                {s.unsupportedNoFallback}
              </p>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {s.whatIsWebGpu}
              </p>
            </div>
          </div>
        </section>

        {alternatives.length > 0 ? (
          <section className="mt-10">
            <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
              {t.tool.relatedTitle}
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {alternatives.map((candidate) => (
                <ToolCard key={candidate.slug} tool={candidate} compact />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  /* --------------------------------------------------------------- *
   * Flujo normal
   * --------------------------------------------------------------- */
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-24 md:px-6 md:pt-12 md:pb-16">
      {header}

      {error ? (
        <div
          role="alert"
          className="rounded-ios mb-6 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div>
            <p className="hud-label text-[10px] text-destructive">
              {t.tool.errors.title}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {t.tool.errors[error]}
            </p>
          </div>
        </div>
      ) : null}

      {localError ? (
        <div
          role="alert"
          className="rounded-ios mb-6 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div>
            <p className="hud-label text-[10px] text-destructive">
              {t.tool.errors.title}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {localError === "noText" ? s.noTextError : s.modelError}
            </p>
          </div>
        </div>
      ) : null}

      {phase !== "done" ? (
        <>
          {files.length === 0 ? (
            <FileDropzone
              tool={TOOL}
              files={files}
              onFilesChange={onFilesChange}
              onError={setError}
            />
          ) : (
            <div className="glass rounded-ios flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {files[0].name}
                </p>
                <p className="hud-label mt-1 text-[10px] text-muted-foreground">
                  {formatFileSize(files[0].size, locale)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t.tool.remove}
                title={t.tool.remove}
                onClick={() => onFilesChange([])}
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
          )}

          <section className="glass rounded-ios mt-6 p-5">
            <div className="flex items-start gap-3">
              <Sparkles
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-edit"
              />
              <div className="min-w-0">
                <h2 className="hud-label text-[11px] text-foreground">
                  {s.howItWorksTitle}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.howItWorksBody}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {s.privacyNotice}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {s.slowNotice}
                </p>
              </div>
            </div>
          </section>

          {/* Aviso de IA visible ANTES de generar nada, no solo despues. */}
          <section className="rounded-ios mt-4 border border-accent-edit/40 bg-accent-edit/10 p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-edit"
              />
              <div className="min-w-0">
                <h2 className="hud-label text-[11px] text-foreground">
                  {s.aiWarningTitle}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {s.aiWarningBody}
                </p>
              </div>
            </div>
          </section>

          <section className="glass rounded-ios mt-4 p-5">
            <h2 className="hud-label text-[11px] text-foreground">
              {t.tool.optionsTitle}
            </h2>

            <div className="mt-4 grid gap-5 md:grid-cols-2">
              <div>
                <SegmentedControl
                  label={s.modelLabel}
                  value={modelKey}
                  onChange={setModelKey}
                  options={SUMMARIZER_MODEL_KEYS.map((key) => ({
                    value: key,
                    label: s.modelNames[key],
                  }))}
                />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {s.modelHints[modelKey]}
                </p>
                <p className="hud-label mt-2 text-[10px] text-muted-foreground">
                  {s.modelMeta(
                    formatFileSize(model.approxDownloadBytes, locale),
                    formatFileSize(model.approxVramMb * 1024 * 1024, locale),
                  )}
                </p>
              </div>

              <div className="flex flex-col gap-5">
                <SegmentedControl
                  label={s.lengthLabel}
                  value={length}
                  onChange={setLength}
                  options={(["short", "medium"] as SummaryLength[]).map(
                    (value) => ({ value, label: s.lengthNames[value] }),
                  )}
                />
                <SegmentedControl
                  label={s.outputLanguageLabel}
                  value={outputLanguage}
                  onChange={setOutputLanguage}
                  options={(["es", "en"] as Language[]).map((value) => ({
                    value,
                    label: s.outputLanguageNames[value],
                  }))}
                />
              </div>
            </div>

            <div className="mt-5">
              <Checkbox
                label={s.ocrLabel}
                hint={s.ocrHint}
                checked={ocrFallback}
                onChange={setOcrFallback}
              />
            </div>
          </section>

          {/* Consentimiento explicito: sin este clic no se descarga nada. */}
          <section className="rounded-ios mt-4 border border-white/10 bg-white/5 p-5">
            <div className="flex items-start gap-3">
              <Download
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <h2 className="hud-label text-[11px] text-foreground">
                  {s.consentTitle}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {s.consentBody(
                    formatFileSize(model.approxDownloadBytes, locale),
                  )}
                </p>
                {cached ? (
                  <p className="mt-2 text-sm leading-relaxed text-success">
                    {s.consentCached}
                  </p>
                ) : null}

                <div className="mt-4">
                  <Checkbox
                    label={s.consentCheckbox}
                    checked={consented}
                    onChange={setConsented}
                  />
                </div>

                <div className="mt-5 flex flex-col items-start gap-3">
                  <Button
                    size="lg"
                    disabled={files.length === 0 || !consented}
                    onClick={() => void run()}
                    className="w-full md:w-auto"
                  >
                    <Sparkles aria-hidden="true" className="size-4" />
                    {cached ? s.consentButtonCached : s.consentButton}
                  </Button>
                  <p className="hud-label text-[10px] text-muted-foreground">
                    {t.tool.localNotice}
                  </p>
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {phase === "processing" ? (
        <ProcessingOverlay
          progress={progress}
          message={stageMessage || copy.name}
          onCancel={cancel}
        />
      ) : null}

      {phase === "done" && result ? (
        <div className="animate-rise-in">
          {/* El aviso encabeza el resultado: no es un pie de pagina. */}
          <section
            role="note"
            className="rounded-ios border border-accent-edit/40 bg-accent-edit/10 p-5"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-edit"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="hud-label text-[11px] text-foreground">
                    {s.aiWarningTitle}
                  </h2>
                  <Badge variant="neutral">
                    <Sparkles aria-hidden="true" className="size-3" />
                    {s.aiBadge}
                  </Badge>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-foreground">
                  {s.aiWarningBody}
                </p>
                <p className="hud-label mt-3 text-[10px] text-muted-foreground">
                  {s.modelUsed(result.modelId)}
                </p>
              </div>
            </div>
          </section>

          {result.truncated ? (
            <p className="rounded-ios mt-4 border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-foreground">
              {s.truncatedNotice(result.coveredUpToPage, result.pageCount)}
            </p>
          ) : null}
          {result.ocrPages.length > 0 ? (
            <p className="rounded-ios mt-4 border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-foreground">
              {s.ocrNotice(result.ocrPages.join(", "))}
            </p>
          ) : null}
          {result.emptyPages.length > 0 ? (
            <p className="rounded-ios mt-4 border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-muted-foreground">
              {s.emptyNotice(result.emptyPages.length)}
            </p>
          ) : null}

          <section className="glass rounded-ios mt-6 p-5">
            <h2 className="hud-label text-[11px] text-muted-foreground">
              {s.resultTitle}
            </h2>
            <p className="mt-3 text-base leading-relaxed whitespace-pre-wrap text-foreground">
              {result.overview}
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" onClick={onCopy}>
                {copiedFlag ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="size-3.5" />
                )}
                {copiedFlag ? s.copied : s.copy}
              </Button>
              <Button variant="secondary" size="sm" onClick={onDownload}>
                <Download aria-hidden="true" className="size-3.5" />
                {s.download}
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" className="size-3.5" />
                {s.startOver}
              </Button>
            </div>
          </section>

          {/*
            Con un solo tramo el resumen general Y el tramo son el mismo
            texto: repetirlo daria la falsa impresion de dos analisis.
          */}
          {result.sections.length > 1 ? (
          <section className="mt-6">
            <h2 className="hud-label text-[11px] text-muted-foreground">
              {s.sectionsTitle}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.sectionsHint}
            </p>
            <div className="mt-4 space-y-3">
              {result.sections.map((section, index) => (
                <article
                  key={`${section.firstPage}-${section.lastPage}-${index}`}
                  className="glass rounded-ios p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="neutral">
                      {formatPageRange(section.firstPage, section.lastPage)}
                    </Badge>
                    {section.partialPage ? (
                      <Badge variant="neutral">{s.partialPageNotice}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                    {section.text}
                  </p>
                </article>
              ))}
            </div>
          </section>
          ) : null}

          <section className="mt-10">
            <h2 className="hud-label mb-4 text-[11px] text-muted-foreground">
              {t.tool.relatedTitle}
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {getRelatedTools("pdf-summarizer", 3).map((tool) => (
                <ToolCard key={tool.slug} tool={tool} compact />
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
