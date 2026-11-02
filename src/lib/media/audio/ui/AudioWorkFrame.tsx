"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, FileAudio, FileVideo, Info, Loader2, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { useFocusTarget, type FocusPlan } from "@/components/tool/useFocusTarget";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { localeTag, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool, type ToolSlug } from "@/lib/tools-registry";
import { convertBatch, type ConvertOutcome } from "@/lib/media/audio/convert";
import { checkMediaFile, type FileCheck } from "@/lib/media/audio/decode";
import { AudioError, toAudioError } from "@/lib/media/audio/errors";
import { formatBytes, formatDuration, saveBlob } from "@/lib/media/audio/format";
import { MAX_AUDIO_FILE_BYTES, MAX_BATCH_FILES, MAX_VIDEO_FILE_BYTES } from "@/lib/media/audio/limits";
import { DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from "@/lib/media/audio/types";
import { AudioDropzone } from "@/lib/media/audio/ui/AudioDropzone";
import { OutputOptions } from "@/lib/media/audio/ui/OutputOptions";
import { SHARED_STRINGS, describeAudioError, fillTemplate } from "@/lib/media/audio/ui/strings";
import { useOutputSupport } from "@/lib/media/audio/ui/useOutputSupport";

/**
 * Marco comun de «Convertidor de audio» y «Extraer audio»: elegir archivos, comprobar cada uno al subirlo, opciones de
 * salida, procesar con progreso y cancelacion, y pantalla de resultado con tamano antes/despues e informe de fallos.
 * Parecido a `ToolShell` en aspecto y foco, pero con errores y limites propios del audio (el shell habla de PDF).
 */

export type AudioWorkStrings = {
  dropTitle: string;
  dropTitleActive: string;
  dropSubtitle: string;
  dropButton: string;
  addMore: string;
  /** `{formats}` y `{max}`. */
  limitsLine: string;
  localNotice: string;
  filesTitle: string;
  checking: string;
  removeFile: string;
  /** Aviso de archivos descartados por tipo: `{names}`. */
  skipped: string;
  tooManyFiles: string;
  progress: string;
  noneUsable: string;
  /** Resumen en la pantalla de descarga: `{count}`. */
  doneOne: string;
  doneMany: string;
  resultsTitle: string;
  /** `{before}` y `{after}`. */
  sizeChange: string;
  failedTitle: string;
  /** Nombre base cuando el archivo no trae uno; sufijo cuando salida y entrada coinciden; nombre del ZIP. */
  fallbackName: string;
  suffix: string;
  zipName: string;
  /** Texto bajo las opciones en el panel (que hace esta herramienta). */
  panelNote?: string;
};

type Phase = "idle" | "files" | "options" | "processing" | "done";
type FocusTarget = "run" | "download" | "dropzone" | "banner";
type Problem = { name: string; code: AudioError["code"]; detail?: string };

export type AudioWorkFrameProps = {
  slug: Extract<ToolSlug, "audio-converter" | "audio-extractor">;
  kind: "audio" | "video";
  strings: AudioWorkStrings;
};

export function AudioWorkFrame({ slug, kind, strings: s }: AudioWorkFrameProps) {
  const { t, language } = useI18n();
  const locale = localeTag(language);
  const shared = SHARED_STRINGS[language];
  const tool = getTool(slug);
  const copy = t.tools[slug];
  const Icon = tool.icon;
  const RowIcon = kind === "video" ? FileVideo : FileAudio;
  const support = useOutputSupport();
  const reasonId = useId();
  const belowHasContent = useScrollEdge("bottom");

  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [checks, setChecks] = useState<ReadonlyMap<File, FileCheck>>(() => new Map());
  const [options, setOptions] = useState<EncodeOptions>(DEFAULT_ENCODE_OPTIONS);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<{ code: AudioError["code"]; detail?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<(ConvertOutcome & { problems: Problem[] }) | null>(null);

  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(new WeakSet<File>());
  const filesRef = useRef<File[]>([]);
  const bannerRef = useRef<HTMLDivElement>(null);
  const dropzoneButtonRef = useRef<HTMLButtonElement>(null);
  const runDesktopRef = useRef<HTMLButtonElement>(null);
  const runMobileRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const neighborRef = useRef(0);

  useEffect(() => {
    filesRef.current = files;
  });

  const resolveFocus = (target: FocusTarget): FocusPlan => {
    switch (target) {
      case "run":
        return { candidates: [runDesktopRef.current, runMobileRef.current] };
      case "download":
        return { candidates: [downloadRef.current] };
      case "dropzone":
        return { candidates: [dropzoneButtonRef.current] };
      case "banner":
        return { candidates: [bannerRef.current, runDesktopRef.current, runMobileRef.current] };
    }
  };
  const { request: requestFocus } = useFocusTarget<FocusTarget>(resolveFocus);

  // Comprobacion de cada archivo recien elegido: tamano, video sin audio y memoria (sin decodificarlo).
  useEffect(() => {
    for (const file of files) {
      if (startedRef.current.has(file)) continue;
      startedRef.current.add(file);
      void checkMediaFile(file).then((check) => {
        setChecks((previous) => new Map(previous).set(file, check));
      });
    }
  }, [files]);

  const usable = files.filter((file) => checks.get(file)?.ok === true);
  const pending = files.filter((file) => !checks.has(file));
  const problems: Problem[] = files.flatMap((file) => {
    const check = checks.get(file);
    return check && !check.ok ? [{ name: file.name, code: check.code, detail: check.detail }] : [];
  });
  const canRun = usable.length > 0 && pending.length === 0;
  const disabledReason = canRun ? "" : pending.length > 0 ? s.checking : files.length > 0 ? s.noneUsable : "";

  const accepts = useCallback(
    (file: File) => {
      const lower = file.name.toLowerCase();
      if (file.type.startsWith(`${kind}/`)) return true;
      return tool.extensions.some((extension) => lower.endsWith(extension));
    },
    [kind, tool.extensions],
  );

  const addFiles = (incoming: File[]) => {
    const valid = incoming.filter(accepts);
    const skipped = incoming.filter((file) => !valid.includes(file));
    const room = Math.max(0, MAX_BATCH_FILES - filesRef.current.length);
    const toAdd = (tool.multiple ? valid : valid.slice(0, 1)).slice(0, room);
    const messages: string[] = [];
    if (skipped.length > 0) messages.push(fillTemplate(s.skipped, { names: skipped.map((file) => file.name).join(", ") }));
    if (valid.length > toAdd.length && tool.multiple) messages.push(fillTemplate(s.tooManyFiles, { max: String(MAX_BATCH_FILES) }));
    setNotice(messages.length > 0 ? messages.join(" ") : null);
    setError(null);
    if (toAdd.length === 0) {
      if (filesRef.current.length === 0 && skipped.length > 0) setError({ code: "unsupportedFormat" });
      return;
    }
    const next = tool.multiple ? [...filesRef.current, ...toAdd] : toAdd;
    setFiles(next);
    setPhase("files");
  };

  const removeFile = (file: File) => {
    const index = filesRef.current.indexOf(file);
    neighborRef.current = Math.max(0, index);
    const next = filesRef.current.filter((candidate) => candidate !== file);
    setFiles(next);
    setError(null);
    setNotice(null);
    if (next.length === 0) {
      setPhase("idle");
      requestFocus("dropzone");
    }
  };

  // Tras quitar un archivo el foco pasa al «Quitar» del vecino (nunca se pierde en <body>).
  useLayoutEffect(() => {
    if (phase !== "files" || !listRef.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const buttons = Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("button[data-remove]"));
    buttons[Math.min(neighborRef.current, buttons.length - 1)]?.focus({ preventScroll: true });
  }, [files, phase]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setFiles([]);
    setChecks(new Map());
    setOutcome(null);
    setProgress(0);
    setError(null);
    setNotice(null);
    setOptions(DEFAULT_ENCODE_OPTIONS);
    setPhase("idle");
    requestFocus("dropzone");
  }, [requestFocus]);

  const run = async () => {
    if (!canRun) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setNotice(null);
    setProgress(0);
    setPhase("processing");
    const skippedProblems = problems;
    try {
      const result = await convertBatch(usable, options, {
        signal: controller.signal,
        onProgress: (value) => {
          if (runIdRef.current === runId) setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
        },
        suffix: s.suffix,
        fallbackName: s.fallbackName,
        zipName: s.zipName,
      });
      if (runIdRef.current !== runId) return;
      setOutcome({ ...result, problems: skippedProblems });
      addRecentEntry(slug, result.filename);
      requestFocus("download");
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      const known = toAudioError(caught);
      if (known.code === "cancelled") setNotice(shared.errors.cancelled.message);
      else setError({ code: known.code, detail: known.detail });
      requestFocus(known.code === "cancelled" ? "run" : "banner");
      setPhase("files");
    }
  };

  const cancel = () => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(0);
    setNotice(shared.errors.cancelled.message);
    setPhase("files");
    requestFocus("run");
  };

  const showWorkspace = phase === "files" || phase === "options";
  useEffect(() => {
    if (!showWorkspace) return;
    document.documentElement.setAttribute("data-action-bar", "");
    return () => document.documentElement.removeAttribute("data-action-bar");
  }, [showWorkspace]);

  const errorText = error ? describeAudioError(shared, error.code, error.detail) : null;
  const maxBytes = kind === "video" ? MAX_VIDEO_FILE_BYTES : MAX_AUDIO_FILE_BYTES;
  const limitsLine = fillTemplate(s.limitsLine, { formats: tool.extensions.join(", "), max: formatBytes(maxBytes, locale) });

  const reasonNode = (suffix: string, className = "mb-2") =>
    disabledReason ? (
      <p id={`${reasonId}-${suffix}`} data-run-reason="" className={cn("text-footnote text-muted-foreground", className)}>
        {disabledReason}
      </p>
    ) : null;
  const describedBy = (suffix: string) => (disabledReason ? `${reasonId}-${suffix}` : undefined);

  const doneSummary = outcome
    ? fillTemplate(outcome.items.length === 1 ? s.doneOne : s.doneMany, { count: String(outcome.items.length) })
    : undefined;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-52 md:px-6 md:pt-10 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[tool.accent])}>
          <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[tool.accent])} />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-1 text-foreground">{copy.name}</h1>
          <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">{copy.description}</p>
        </div>
      </header>

      <ErrorBanner
        show={errorText !== null}
        errorKey={error?.code}
        title={files.length === 0 ? shared.fileProblemTitle : shared.errorTitle}
        message={errorText?.message ?? ""}
        hint={errorText?.hint}
        dismissLabel={t.common.close}
        onDismiss={() => setError(null)}
        bannerRef={bannerRef}
      />

      {/* Region viva siempre montada: los lectores de pantalla anuncian mejor un texto que cambia que uno que nace relleno. */}
      <div className={notice ? "mb-6 flex items-start gap-3 rounded-ios border border-hairline bg-white/5 p-4 pr-2" : undefined}>
        {notice ? <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" /> : null}
        <p role="status" aria-live="polite" aria-atomic="true" className={notice ? "min-w-0 flex-1 pt-0.5 text-subheadline break-words text-foreground" : undefined}>
          {notice}
        </p>
        {notice ? (
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t.common.close}
            className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground group-hover:bg-white/10 group-hover:text-foreground">
              <X aria-hidden="true" className="size-4" />
            </span>
          </button>
        ) : null}
      </div>

      {phase === "idle" ? (
        <AudioDropzone
          accept={[...tool.accept, ...tool.extensions].join(",")}
          multiple={tool.multiple}
          title={s.dropTitle}
          titleActive={s.dropTitleActive}
          subtitle={s.dropSubtitle}
          buttonLabel={s.dropButton}
          limits={limitsLine}
          localNotice={s.localNotice}
          onFiles={addFiles}
          buttonRef={dropzoneButtonRef}
        />
      ) : null}

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
          <div className="min-w-0 flex-1" inert={phase === "options"}>
            <div className="mb-3 flex items-baseline justify-between gap-3 pointer-coarse:mb-5">
              <h2 className="ui-label text-muted-foreground">{s.filesTitle}</h2>
              {files.length > 1 ? <span className="text-caption text-muted-foreground tabular-nums">{files.length}</span> : null}
            </div>
            <ul ref={listRef} className="surface-card divide-y divide-hairline overflow-hidden rounded-ios">
              {files.map((file) => {
                const check = checks.get(file);
                const bad = check && !check.ok ? describeAudioError(shared, check.code, check.detail) : null;
                const duration = check?.ok ? check.probe.durationSec : undefined;
                return (
                  <li key={`${file.name}-${file.size}-${file.lastModified}-${files.indexOf(file)}`} className="flex items-center gap-3 px-4 py-3">
                    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-ios-sm", bad ? "bg-destructive/12" : "bg-white/8")}>
                      {bad ? <AlertTriangle aria-hidden="true" className="size-5 text-destructive" /> : <RowIcon aria-hidden="true" className="size-5 text-muted-foreground" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-subheadline font-medium text-foreground">{file.name}</p>
                      <p className="text-footnote break-words text-muted-foreground tabular-nums">
                        {formatBytes(file.size, locale)}
                        {!check ? (
                          <>
                            {" · "}
                            <Loader2 aria-hidden="true" className="inline size-3 animate-spin align-[-1px] motion-reduce:animate-none" /> {s.checking}
                          </>
                        ) : bad ? (
                          <span className="text-destructive-text"> · {bad.message}</span>
                        ) : duration ? (
                          ` · ${formatDuration(duration, locale)}`
                        ) : null}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-remove=""
                      onClick={() => removeFile(file)}
                      aria-label={fillTemplate(s.removeFile, { name: file.name })}
                      className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
                    >
                      <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground group-hover:bg-white/10 group-hover:text-foreground">
                        <X aria-hidden="true" className="size-4" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {tool.multiple ? (
              <AudioDropzone
                compact
                accept={[...tool.accept, ...tool.extensions].join(",")}
                multiple
                title={s.dropTitle}
                titleActive={s.dropTitleActive}
                subtitle={s.dropSubtitle}
                buttonLabel={s.dropButton}
                addLabel={s.addMore}
                limits={limitsLine}
                localNotice={s.localNotice}
                onFiles={addFiles}
                className="mt-3"
              />
            ) : null}

            <p className="mt-4 flex items-start gap-2 text-footnote text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{limitsLine}</span>
            </p>
          </div>

          <OptionsPanel
            open={phase === "options"}
            onOpenChange={(open) => setPhase(open ? "options" : "files")}
            footer={
              <>
                {reasonNode("panel")}
                <Button
                  ref={runDesktopRef}
                  fullWidth
                  size="lg"
                  disabled={!canRun}
                  aria-describedby={describedBy("panel")}
                  onClick={() => {
                    setPhase("files");
                    void run();
                  }}
                >
                  {t.tool.run}
                </Button>
              </>
            }
          >
            <OutputOptions value={options} onChange={(patch) => setOptions((previous) => ({ ...previous, ...patch }))} support={support} strings={shared} idPrefix={`${reasonId}-opt`} />
            {s.panelNote ? <p className="text-xs leading-relaxed text-muted-foreground">{s.panelNote}</p> : null}
          </OptionsPanel>
        </div>
      ) : null}

      {showWorkspace ? (
        <div
          data-scrolled={belowHasContent ? "true" : "false"}
          inert={phase === "options"}
          className="material-thick scroll-edge-top fixed inset-x-0 z-30 flex flex-col gap-2 px-4 py-3 md:hidden"
          style={{ borderWidth: 0, bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          {reasonNode("bar", "mb-0")}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="md" onClick={() => setPhase("options")}>
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {t.tool.openOptions}
            </Button>
            <Button ref={runMobileRef} size="md" fullWidth disabled={!canRun} aria-describedby={describedBy("bar")} onClick={() => void run()}>
              {t.tool.run}
            </Button>
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {phase === "processing" ? <ProcessingOverlay key="processing" progress={progress} message={s.progress} onCancel={cancel} /> : null}
      </AnimatePresence>

      {phase === "done" && outcome ? (
        <DownloadScreen
          slug={slug}
          filename={outcome.filename}
          size={outcome.blob.size}
          onDownload={() => saveBlob(outcome.blob, outcome.filename)}
          onStartOver={reset}
          downloadButtonRef={downloadRef}
          summary={doneSummary}
          extras={
            <section aria-labelledby={`${reasonId}-results`}>
              <h3 id={`${reasonId}-results`} className="ui-label mb-2 text-muted-foreground">
                {s.resultsTitle}
              </h3>
              <ul className="space-y-2 text-footnote">
                {outcome.items.map((item) => (
                  <li key={item.outputName} className="rounded-ios-sm border border-hairline bg-white/5 px-3 py-2">
                    <p className="font-medium break-words text-foreground">{item.outputName}</p>
                    <p className="text-muted-foreground tabular-nums">
                      {fillTemplate(s.sizeChange, { before: formatBytes(item.inputBytes, locale), after: formatBytes(item.outputBytes, locale) })}
                    </p>
                  </li>
                ))}
              </ul>
              {outcome.failed.length + outcome.problems.length > 0 ? (
                <div role="status" data-testid="audio-failure-report" className="mt-4 rounded-ios border border-destructive/35 bg-destructive/10 p-3">
                  <p className="flex items-center gap-2 text-subheadline font-semibold text-foreground">
                    <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                    {s.failedTitle}
                  </p>
                  <ul className="mt-2 space-y-1.5 text-footnote text-muted-foreground">
                    {[...outcome.problems, ...outcome.failed.map((entry) => ({ name: entry.inputName, code: entry.code, detail: undefined as string | undefined }))].map((entry) => (
                      <li key={`${entry.name}-${entry.code}`} className="break-words">
                        <span className="font-medium text-foreground">{entry.name}</span> — {describeAudioError(shared, entry.code, entry.detail).message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          }
        />
      ) : null}
    </div>
  );
}
