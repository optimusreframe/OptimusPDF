"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Info, SlidersHorizontal } from "lucide-react";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { Button } from "@/components/ui/Button";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { ErrorBanner, type ErrorBannerAction } from "@/components/tool/ErrorBanner";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { useI18n, localeTag } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import { downloadBlob, formatFileSize, type PdfErrorCode } from "@/lib/pdf/core";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool, toolHref } from "@/lib/tools-registry";
import {
  browserCodecEnv,
  canEncodeVideoAt,
  detectCapabilities,
  type VideoCapabilities,
} from "@/lib/media/video/capabilities";
import { formatDimensions, formatDuration } from "@/lib/media/video/display";
import { VideoError, classifyVideoError, type VideoErrorCode } from "@/lib/media/video/errors";
import { OUTPUT_FORMATS, codecLabel, type OutputFormat } from "@/lib/media/video/formats";
import { availableFps } from "@/lib/media/video/fps";
import { LIMITS, browserDeviceClass, type DeviceClass } from "@/lib/media/video/limits";
import { outputFileName } from "@/lib/media/video/names";
import { planConversion, type ConversionPlan, type PlanIssue } from "@/lib/media/video/plan";
import { availableResolutions } from "@/lib/media/video/resolution";
import { DEFAULT_CONVERSION_OPTIONS, type ConversionOptions, type VideoInfo } from "@/lib/media/video/types";
import { createVideoEngine, type VideoEngine } from "@/lib/media/video/videoEngine";
import { IssueList, type IssueParams } from "@/app/video-converter/IssueList";
import { UnsupportedView } from "@/app/video-converter/UnsupportedView";
import { VideoFileCard } from "@/app/video-converter/VideoFileCard";
import { VideoOptions } from "@/app/video-converter/VideoOptions";
import { STRINGS, fillTemplate, type ErrorText } from "@/app/video-converter/strings";

const TOOL = getTool("video-converter");

type Phase = "idle" | "ready" | "processing" | "done";

type Env = { caps: VideoCapabilities; device: DeviceClass };

type Result = { blob: Blob; filename: string; plan: ConversionPlan; audioDropped: boolean };

/** Tope de progreso que se publica al estado: una vez por cada punto porcentual (el motor avisa por fotograma). */
function percentOf(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** Pide que la pantalla no se apague mientras se convierte (en moviles suspende la pestana). Sin soporte: no pasa nada. */
async function holdScreenAwake(): Promise<() => void> {
  try {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    const sentinel = await wakeLock?.request("screen");
    return () => void sentinel?.release().catch(() => {});
  } catch {
    return () => {};
  }
}

/** Opciones de partida para un video: el formato que el navegador pueda producir (MP4 si es posible) y el resto por defecto. */
function initialOptions(caps: VideoCapabilities): ConversionOptions {
  const format = OUTPUT_FORMATS.find((candidate) => caps.formats[candidate].available) ?? DEFAULT_CONVERSION_OPTIONS.format;
  return { ...DEFAULT_CONVERSION_OPTIONS, format };
}

/** Las opciones tal como valen para ESTE video y ESTE navegador (una opcion que ya no aplica vuelve a «Original»). */
function effectiveOptions(options: ConversionOptions, info: VideoInfo, caps: VideoCapabilities): ConversionOptions {
  const formatOk = caps.formats[options.format].available;
  const format: OutputFormat = formatOk ? options.format : (OUTPUT_FORMATS.find((candidate) => caps.formats[candidate].available) ?? options.format);
  return {
    ...options,
    format,
    resolution: availableResolutions(info.width, info.height).includes(options.resolution) ? options.resolution : "original",
    maxFps: availableFps(info.fps).includes(options.maxFps) ? options.maxFps : "original",
    removeAudio: info.audio ? options.removeAudio : false,
  };
}

export function VideoConverterToolClient() {
  const { t, language } = useI18n();
  const s = STRINGS[language];
  const locale = localeTag(language);
  const copy = t.tools[TOOL.slug];
  const belowHasContent = useScrollEdge("bottom");

  const [env, setEnv] = useState<Env | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [options, setOptions] = useState<ConversionOptions>(DEFAULT_CONVERSION_OPTIONS);
  const [problem, setProblem] = useState<{ code: VideoErrorCode | "invalidType"; during: "read" | "convert" } | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const engineRef = useRef<VideoEngine | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const runDesktopRef = useRef<HTMLButtonElement>(null);
  const runMobileRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const dropzoneButtonRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  /** Donde pone el foco el proximo render (se aplica en `useEffect`, con reintentos mientras el destino aparece). */
  const [focusWish, setFocusWish] = useState<"card" | "run" | "download" | "dropzone" | "banner" | null>(null);

  const getEngine = useCallback((): VideoEngine => {
    if (!engineRef.current) engineRef.current = createVideoEngine();
    return engineRef.current;
  }, []);

  // Capacidades del navegador (una vez montado: en el servidor y al hidratar no se sabe nada).
  useEffect(() => {
    let alive = true;
    detectCapabilities(browserCodecEnv()).then(
      (caps) => {
        if (alive) setEnv({ caps, device: browserDeviceClass() });
      },
      () => {
        if (alive) setEnv({ caps: { supported: false, reason: "no-video-encoder", formats: closedFormats() }, device: browserDeviceClass() });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Al salir de la pagina: se cancela lo que haya en curso y se libera el worker.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Foco: lo que se desmonta (dropzone, boton de convertir) no puede devolverlo; aqui se decide a donde va.
  useEffect(() => {
    if (!focusWish) return;
    let frames = 0;
    let frame = 0;
    const target = () => {
      switch (focusWish) {
        case "card":
          return cardRef.current;
        case "run":
          return [runDesktopRef.current, runMobileRef.current].find((button) => !!button && button.getClientRects().length > 0 && !button.disabled) ?? cardRef.current;
        case "download":
          return downloadRef.current;
        case "dropzone":
          return dropzoneButtonRef.current;
        case "banner":
          return bannerRef.current;
      }
    };
    const attempt = () => {
      const element = target();
      if (element) {
        element.focus({ preventScroll: false });
        if (document.activeElement === element) {
          setFocusWish(null);
          return;
        }
      }
      frames += 1;
      if (frames < 30) frame = requestAnimationFrame(attempt);
      else setFocusWish(null);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusWish, phase]);

  // Barra de accion fija en movil: el final de la pagina reserva su alto (globals.css lee este atributo).
  const showWorkspace = phase === "ready" && info !== null;
  useEffect(() => {
    if (!showWorkspace) return;
    document.documentElement.setAttribute("data-action-bar", "");
    return () => document.documentElement.removeAttribute("data-action-bar");
  }, [showWorkspace]);

  const effective = useMemo(() => (info && env ? effectiveOptions(options, info, env.caps) : null), [info, env, options]);
  const plan = useMemo(
    () => (info && env && effective ? planConversion(info, effective, env.caps, env.device) : null),
    [info, env, effective],
  );

  const resetAll = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setFile(null);
    setInfo(null);
    setProbing(false);
    setProblem(null);
    setCancelled(false);
    setResult(null);
    setProgress(0);
    setOptionsOpen(false);
    setOptions(env ? initialOptions(env.caps) : DEFAULT_CONVERSION_OPTIONS);
    setPhase("idle");
    setFocusWish("dropzone");
    // Los `set*` de useState son estables; se listan para que el compilador de React conserve esta memoizacion (lint).
  }, [env, setOptions, setOptionsOpen]);

  const chooseFile = useCallback(
    (picked: File) => {
      if (!env) return;
      const id = ++runIdRef.current;
      setFile(picked);
      setInfo(null);
      setProblem(null);
      setCancelled(false);
      setResult(null);
      setOptions(initialOptions(env.caps));
      setProbing(true);
      setPhase("ready");
      setFocusWish("card");
      getEngine()
        .probe(picked)
        .then(
          (read) => {
            if (runIdRef.current !== id) return;
            setInfo(read);
            setProbing(false);
          },
          (failure: unknown) => {
            if (runIdRef.current !== id) return;
            setProbing(false);
            setProblem({ code: classifyVideoError(failure).code, during: "read" });
            setFocusWish("banner");
          },
        );
    },
    [env, getEngine, setOptions],
  );

  const onFilesChange = useCallback(
    (files: File[]) => {
      if (files[0]) chooseFile(files[0]);
    },
    [chooseFile],
  );

  const onDropzoneError = useCallback((code: PdfErrorCode) => {
    // El aviso de «archivo grande» de la zona de carga habla de PDF y de 100 MB: aqui los limites son los de `limits.ts`.
    if (code === "tooLarge") return;
    setProblem({ code: "invalidType", during: "read" });
    setFocusWish("banner");
  }, []);

  const run = useCallback(async () => {
    if (!file || !info || !plan || !plan.canConvert || !env) return;
    const id = ++runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setProblem(null);
    setCancelled(false);
    setProgress(0);
    setPhase("processing");
    // No se espera: si el navegador tarda o rechaza la peticion, la conversion no debe quedar detras.
    const awake = holdScreenAwake();
    try {
      // Con las medidas y el ritmo FINALES: un H.264 de 4K o de 60 fps puede no existir en este equipo aunque 720p si.
      if (plan.video.mode === "transcode" && plan.video.bitrate) {
        const ok = await canEncodeVideoAt(browserCodecEnv(), plan.video.codec, {
          width: plan.video.width,
          height: plan.video.height,
          bitrate: plan.video.bitrate,
          framerate: plan.video.fpsCap ?? plan.video.outputFps,
        });
        if (!ok) throw new VideoError("cannotEncode");
      }
      let last = -1;
      const done = await getEngine().convert(file, plan, {
        signal: controller.signal,
        onProgress: (value) => {
          if (runIdRef.current !== id) return;
          const percent = percentOf(value);
          if (percent === last) return;
          last = percent;
          setProgress(percent);
        },
      });
      if (runIdRef.current !== id) return;
      const filename = outputFileName(file.name, plan.format, s.filenameSuffix);
      setResult({ blob: done.blob, filename, plan, audioDropped: done.audioDropped });
      addRecentEntry(TOOL.slug, filename);
      setPhase("done");
      setFocusWish("download");
    } catch (failure) {
      if (runIdRef.current !== id) return;
      const classified = classifyVideoError(failure);
      setPhase("ready");
      if (classified.code === "cancelled") {
        setCancelled(true);
        setFocusWish("run");
      } else {
        setProblem({ code: classified.code, during: "convert" });
        setFocusWish("banner");
      }
    } finally {
      void awake.then((release) => release());
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [env, file, getEngine, info, plan, s.filenameSuffix]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onBannerAction = useCallback(
    (action: ErrorBannerAction) => {
      if (action.id === "choose") pickerRef.current?.click();
      else if (action.id === "remove") resetAll();
    },
    [resetAll],
  );

  // --- Navegador sin WebCodecs: pagina informativa --------------------------------------------------------------------
  if (env && !env.caps.supported) {
    return <UnsupportedView tool={TOOL} name={copy.name} description={copy.description} reason={env.caps.reason} strings={s} />;
  }

  // --- Avisos y textos ---------------------------------------------------------------------------------------------
  const limits = env ? LIMITS[env.device] : LIMITS.desktop;
  const issueParams = (issue: PlanIssue): IssueParams => {
    if (!info || !plan) return {};
    switch (issue.code) {
      case "inputTooLarge":
        return { size: formatFileSize(info.fileSize, locale), limit: formatFileSize(limits.maxInputBytes, locale) };
      case "bigFile":
        return { size: formatFileSize(info.fileSize, locale) };
      case "tooLong":
        return { duration: formatDuration(info.duration), limit: formatDuration(limits.maxDurationSec) };
      case "longVideo":
        return { duration: formatDuration(info.duration) };
      case "outputTooLarge":
        return { size: formatFileSize(plan.estimatedBytes, locale), limit: formatFileSize(limits.maxOutputBytes, locale) };
      case "outputLarger":
        return { size: formatFileSize(plan.estimatedBytes, locale), original: formatFileSize(info.fileSize, locale) };
      case "cannotDecodeVideo":
        return { codec: codecLabel(info.videoCodec) };
      case "audioUndecodable":
        return { codec: codecLabel(info.audio?.codec) };
      case "formatUnavailable":
        return { format: plan.format === "mp4" ? s.formatMp4 : s.formatWebm };
      default:
        return {};
    }
  };

  const errorText = (code: VideoErrorCode | "invalidType"): ErrorText => (code === "invalidType" ? s.invalidType : s.errors[code]);
  const problemActions: ErrorBannerAction[] = [];
  if (problem) {
    if (problem.code === "noVideoTrack") problemActions.push({ label: s.openAudioConverter, href: toolHref("audio-converter"), primary: true });
    problemActions.push({ id: "choose", label: s.chooseAnother, primary: problemActions.length === 0 });
    if (file) problemActions.push({ id: "remove", label: s.removeFile });
  }

  // --- Pantalla de resultado --------------------------------------------------------------------------------------
  if (phase === "done" && result) {
    const notices: string[] = [];
    const audio = result.plan.audio;
    const lost = audio.mode === "none" && (audio.reason === "undecodable" || audio.reason === "unencodable");
    if (result.audioDropped || lost) notices.push(s.noticeAudioDropped);
    else if (audio.mode === "none" && audio.reason === "removed") notices.push(s.noticeAudioRemoved);
    const format = result.plan.format === "mp4" ? s.formatMp4 : s.formatWebm;
    const dimensions = formatDimensions(result.plan.video.width, result.plan.video.height);
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
        <ToolHeader name={copy.name} description={copy.description} />
        <DownloadScreen
          slug={TOOL.slug}
          filename={result.filename}
          size={result.blob.size}
          onDownload={() => downloadBlob(result.blob, result.filename)}
          onStartOver={resetAll}
          downloadButtonRef={downloadRef}
          summary={fillTemplate(result.plan.video.mode === "copy" ? s.summaryCopy : s.summaryTranscode, { format, dimensions })}
          notices={notices.length > 0 ? { title: s.noticesTitle, items: notices } : undefined}
        />
      </div>
    );
  }

  const banner = problem ? errorText(problem.code) : null;
  const canRun = !!plan && plan.canConvert && !probing && !!info;
  const blockedByIssues = !!plan && !plan.canConvert;
  const reasonId = "video-run-reason";
  const reasonText = blockedByIssues ? s.runBlocked : "";
  const estimate =
    plan && info
      ? fillTemplate(plan.video.mode === "copy" && plan.audio.mode !== "transcode" ? s.estimateCopy : s.estimateTranscode, {
          size: formatFileSize(plan.estimatedBytes, locale),
          original: formatFileSize(info.fileSize, locale),
        })
      : null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-52 md:px-6 md:pt-10 md:pb-16">
      <ToolHeader name={copy.name} description={copy.description} />

      <ErrorBanner
        show={banner !== null}
        errorKey={problem ? `${problem.during}-${problem.code}` : undefined}
        title={banner?.title ?? ""}
        message={banner?.message ?? ""}
        hint={banner?.hint}
        detail={file ? t.tool.fileProblemFile.replace("{name}", file.name) : undefined}
        actions={problemActions}
        onAction={onBannerAction}
        onDismiss={problem && problem.during === "convert" ? () => setProblem(null) : undefined}
        dismissLabel={t.common.close}
        bannerRef={bannerRef}
      />

      {/* Region viva siempre montada: el aviso de «cancelado» y el estado de la comprobacion se anuncian sin robar el foco. */}
      <p role="status" aria-live="polite" className={cn(cancelled || !env ? "mb-6 text-subheadline text-muted-foreground" : undefined)}>
        {!env ? s.checking : cancelled ? s.cancelled : null}
      </p>

      {/* Selector oculto de «Elegir otro archivo»: solo existe mientras hay un aviso con esa accion (como en ToolShell). */}
      {problem ? (
        <input
          ref={pickerRef}
          type="file"
          accept={[...TOOL.accept, ...TOOL.extensions].join(",")}
          aria-label={s.chooseAnother}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (picked) chooseFile(picked);
          }}
        />
      ) : null}

      {env && phase === "idle" ? (
        <>
          <FileDropzone
            tool={TOOL}
            files={[]}
            onFilesChange={onFilesChange}
            onError={onDropzoneError}
            buttonRef={dropzoneButtonRef}
          />
          <section className="mt-6 space-y-3" aria-labelledby="video-idle-title">
            <h2 id="video-idle-title" className="text-headline text-foreground">
              {s.idleTitle}
            </h2>
            <p className="max-w-3xl text-subheadline text-muted-foreground">{s.idleBody}</p>
            <p className="max-w-3xl text-footnote text-muted-foreground">{s.idleFormats}</p>
            <p className="max-w-3xl text-footnote text-muted-foreground">
              {fillTemplate(s.idleLimits, {
                warn: formatFileSize(limits.warnInputBytes, locale),
                max: formatFileSize(limits.maxInputBytes, locale),
                duration: formatDuration(limits.maxDurationSec),
              })}
            </p>
            {env.device === "constrained" ? (
              <div className="flex max-w-3xl items-start gap-3 rounded-ios border border-hairline bg-white/5 p-3" data-video-constrained="">
                <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <p className="text-subheadline text-muted-foreground">{s.constrainedNote}</p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {env && phase === "ready" && file ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
          <div className="min-w-0 flex-1" inert={optionsOpen}>
            <VideoFileCard
              file={file}
              info={info}
              probing={probing}
              strings={s}
              locale={locale}
              onRemove={resetAll}
              regionRef={cardRef}
            />
            {plan && info ? (
              <>
                <IssueList issues={plan.issues} strings={s} paramsFor={issueParams} />
                <section className="mt-4 rounded-ios border border-hairline bg-white/5 p-4" aria-labelledby="video-estimate-title" data-video-estimate="">
                  <h2 id="video-estimate-title" className="ui-label text-muted-foreground">
                    {s.estimateTitle}
                  </h2>
                  <p className="mt-1 text-headline text-foreground tabular-nums">{estimate}</p>
                  <p className="mt-1 text-footnote text-muted-foreground">{s.estimateNote}</p>
                </section>
              </>
            ) : null}
          </div>

          {info && effective && env.caps.supported ? (
            <OptionsPanel
              open={optionsOpen}
              onOpenChange={(open) => setOptionsOpen(open)}
              footer={
                <>
                  {reasonText ? (
                    <p id={`${reasonId}-panel`} data-run-reason="" className="mb-2 text-footnote text-muted-foreground">
                      {reasonText}
                    </p>
                  ) : null}
                  <Button
                    ref={runDesktopRef}
                    fullWidth
                    size="lg"
                    disabled={!canRun}
                    aria-describedby={reasonText ? `${reasonId}-panel` : undefined}
                    onClick={() => {
                      setOptionsOpen(false);
                      void run();
                    }}
                  >
                    {s.run}
                  </Button>
                </>
              }
            >
              <VideoOptions
                info={info}
                options={effective}
                caps={env.caps}
                strings={s}
                onChange={(patch) => setOptions((previous) => ({ ...previous, ...patch }))}
              />
            </OptionsPanel>
          ) : null}
        </div>
      ) : null}

      {env && showWorkspace && file ? (
        <div
          data-scrolled={belowHasContent ? "true" : "false"}
          inert={optionsOpen}
          className="material-thick scroll-edge-top fixed inset-x-0 z-30 flex flex-col gap-2 px-4 py-3 md:hidden"
          style={{ borderWidth: 0, bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          {reasonText ? (
            <p id={`${reasonId}-bar`} data-run-reason="" className="text-footnote text-muted-foreground">
              {reasonText}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            {info ? (
              <Button variant="secondary" size="md" onClick={() => setOptionsOpen(true)}>
                <SlidersHorizontal aria-hidden="true" className="size-4" />
                {t.tool.openOptions}
              </Button>
            ) : null}
            <Button
              ref={runMobileRef}
              size="md"
              fullWidth
              disabled={!canRun}
              aria-describedby={reasonText ? `${reasonId}-bar` : undefined}
              onClick={() => void run()}
            >
              {s.run}
            </Button>
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {phase === "processing" ? <ProcessingOverlay key="processing" progress={progress} message={s.progress} onCancel={cancel} /> : null}
      </AnimatePresence>
    </div>
  );
}

/** Cabecera de la herramienta (icono, titulo y descripcion), igual que la de `ToolShell`. */
function ToolHeader({ name, description }: { name: string; description: string }) {
  const Icon = TOOL.icon;
  return (
    <header className="mb-8 flex items-start gap-4">
      <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[TOOL.accent])}>
        <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
      </span>
      <div className="min-w-0">
        <h1 className="text-title-1 text-foreground">{name}</h1>
        <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}

function closedFormats(): VideoCapabilities["formats"] {
  const closed = (format: OutputFormat) => ({ format, available: false, reason: "no-video-encoder" as const, videoCodecs: [], audioEncodable: false });
  return { mp4: closed("mp4"), webm: closed("webm") };
}
