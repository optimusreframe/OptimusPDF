"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Check, Download, Loader2, Pause, Play, Redo2, Undo2, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { localeTag, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool } from "@/lib/tools-registry";
import { decodeMedia } from "@/lib/media/audio/decode";
import {
  appendClip,
  applyFade,
  applyGain,
  commit,
  emptyTrack,
  initHistory,
  moveSegment,
  peakInRangeAsync,
  redo,
  removeRange,
  removeSegment,
  segmentStarts,
  splitTrackAt,
  trackDuration,
  trackLength,
  trackSource,
  trimToRange,
  undo,
  type History,
  type Track,
} from "@/lib/media/audio/edit";
import { encodeAudio } from "@/lib/media/audio/encode";
import { AudioError, toAudioError } from "@/lib/media/audio/errors";
import { formatBytes, formatClock, saveBlob } from "@/lib/media/audio/format";
import { MAX_STUDIO_CLIPS, MAX_AUDIO_FILE_BYTES, decodedBudgetBytes, minutesThatFit } from "@/lib/media/audio/limits";
import { editedName } from "@/lib/media/audio/names";
import { dbToGain, normalizationGain } from "@/lib/media/audio/pcm";
import { TrackPlayer } from "@/lib/media/audio/player";
import { DEFAULT_ENCODE_OPTIONS, type EncodeOptions } from "@/lib/media/audio/types";
import { AudioDropzone } from "@/lib/media/audio/ui/AudioDropzone";
import { OutputOptions } from "@/lib/media/audio/ui/OutputOptions";
import { SHARED_STRINGS, describeAudioError, fillTemplate } from "@/lib/media/audio/ui/strings";
import { useOutputSupport } from "@/lib/media/audio/ui/useOutputSupport";
import { ClipList } from "@/app/audio-studio/ClipList";
import { SecondsField } from "@/app/audio-studio/SecondsField";
import { Waveform, type Selection } from "@/app/audio-studio/Waveform";
import { STRINGS } from "@/app/audio-studio/strings";

/**
 * Audio Studio: editor de UNA pista hecha de clips en orden. Todo en la memoria de esta pestana: ningun audio se envia
 * ni se guarda (ni siquiera como borrador). El modelo y las operaciones viven en `@/lib/media/audio/edit` (puros y
 * probados); aqui solo hay estado de interfaz, reproduccion, importacion y exportacion.
 */

const TOOL = getTool("audio-studio");
const TOOL_ICON = TOOL.icon;

type ExportResult = { blob: Blob; filename: string; durationSec: number };

/** Boton de accion del editor (componente aparte: los manejadores van como propiedades, no se llaman al pintar). */
function ActionButton({ label, onClick, disabled, icon, id }: { label: string; onClick: () => void; disabled: boolean; icon?: ReactNode; id: string }) {
  return (
    <Button variant="secondary" size="md" wrap disabled={disabled} onClick={onClick} data-action={id}>
      {icon}
      {label}
    </Button>
  );
}

const rangeOf = (a: number, b: number): Selection | null => (a === b ? null : { start: Math.min(a, b), end: Math.max(a, b) });

export function AudioStudioClient() {
  const { t, language } = useI18n();
  const locale = localeTag(language);
  const s = STRINGS[language];
  const shared = SHARED_STRINGS[language];
  const support = useOutputSupport();
  const uid = useId();

  const [history, setHistory] = useState<History<Track>>(() => initHistory(emptyTrack()));
  const historyRef = useRef(history);
  const track = history.present;
  const total = trackLength(track);
  const rate = track.sampleRate;

  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const anchorRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const playerRef = useRef<TrackPlayer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ name: string; index: number; total: number } | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [announce, setAnnounce] = useState("");
  const [error, setError] = useState<{ code: AudioError["code"]; detail?: string } | null>(null);
  const [fadeSeconds, setFadeSeconds] = useState(2);
  const [volumeDb, setVolumeDb] = useState(0);
  const [exportOptions, setExportOptions] = useState<EncodeOptions>(DEFAULT_ENCODE_OPTIONS);
  const [exporting, setExporting] = useState<{ progress: number } | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const waveFocusRef = useRef<HTMLDivElement | null>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const dropzoneButtonRef = useRef<HTMLButtonElement>(null);

  const hasAudio = track.segments.length > 0;
  const working = importing !== null || busy !== null || exporting !== null;

  const updateHistory = useCallback((next: History<Track>) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  /* ---------------------------- reproduccion ---------------------------- */

  const getPlayer = useCallback((): TrackPlayer => {
    playerRef.current ??= new TrackPlayer({
      onEnded: () => {
        setPlaying(false);
        setPlayhead(null);
        setCursor(playerRef.current?.position() ?? 0);
      },
    });
    return playerRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player?.playing) return;
    const at = player.pause();
    setPlaying(false);
    setPlayhead(null);
    setCursor(at);
  }, []);

  useEffect(
    () => () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    },
    [],
  );

  // El cursor de reproduccion se actualiza una vez por fotograma de pantalla mientras suena.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const player = playerRef.current;
      if (player?.playing) setPlayhead(player.position());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const togglePlay = () => {
    if (!hasAudio || working) return;
    if (playing) {
      stopPlayback();
      return;
    }
    const from = selection ? selection.start : cursor >= total ? 0 : cursor;
    const to = selection ? selection.end : total;
    getPlayer().play(track, from, to);
    setPlayhead(from);
    setPlaying(true);
  };

  /* ------------------------------ cursor / seleccion --------------------- */

  const moveCursor = (frame: number, extend: boolean) => {
    const wasPlaying = playing;
    if (wasPlaying) stopPlayback();
    if (extend) {
      const anchor = anchorRef.current ?? cursor;
      anchorRef.current = anchor;
      const next = rangeOf(anchor, frame);
      setSelection(next);
      setAnnounce(next ? fillTemplate(s.selectionAnnounce, { start: formatClock(next.start / rate), end: formatClock(next.end / rate) }) : "");
    } else {
      anchorRef.current = null;
      setSelection(null);
    }
    setCursor(frame);
    if (wasPlaying && !extend) {
      getPlayer().play(track, frame, total);
      setPlayhead(frame);
      setPlaying(true);
    }
  };

  const dragSelect = (anchor: number, frame: number) => {
    if (playing) stopPlayback();
    anchorRef.current = anchor;
    setSelection(rangeOf(anchor, frame));
    setCursor(frame);
  };

  const setSelectionEdge = (edge: "start" | "end", frames: number) => {
    const current = selection ?? { start: cursor, end: cursor };
    const next = edge === "start" ? rangeOf(frames, Math.max(frames, current.end)) ?? rangeOf(frames, Math.min(total, frames + rate)) : rangeOf(Math.min(current.start, frames), frames);
    anchorRef.current = null;
    setSelection(next);
  };

  /* ------------------------------ ediciones ------------------------------ */

  const apply = (next: Track, patch: { cursor?: number; selection?: Selection | null; message: string }) => {
    stopPlayback();
    updateHistory(commit(historyRef.current, next));
    if (patch.cursor !== undefined) setCursor(Math.min(trackLength(next), Math.max(0, patch.cursor)));
    if (patch.selection !== undefined) setSelection(patch.selection);
    anchorRef.current = null;
    setResult(null);
    setAnnounce(patch.message);
  };

  const duration = (next: Track) => formatClock(trackDuration(next));

  const doTrim = () => {
    if (!selection) return;
    const next = trimToRange(track, selection.start, selection.end);
    apply(next, { cursor: 0, selection: null, message: fillTemplate(s.doneTrim, { duration: duration(next) }) });
  };
  const doCut = () => {
    if (!selection) return;
    const next = removeRange(track, selection.start, selection.end);
    apply(next, { cursor: selection.start, selection: null, message: fillTemplate(s.doneCut, { duration: duration(next) }) });
  };
  // Dividir solo tiene sentido dentro de la pista y donde aun no hay un limite entre clips.
  const canSplit = cursor > 0 && cursor < total && !segmentStarts(track).includes(cursor);
  const doSplit = () => {
    if (!canSplit) return;
    apply(splitTrackAt(track, cursor), { message: fillTemplate(s.doneSplit, { time: formatClock(cursor / rate) }) });
  };
  const fadeRange = (direction: "in" | "out"): [number, number] => {
    if (selection) return [selection.start, selection.end];
    const length = Math.min(total, Math.max(1, Math.round(fadeSeconds * rate)));
    return direction === "in" ? [0, length] : [total - length, total];
  };
  const doFade = (direction: "in" | "out") => {
    const [from, to] = fadeRange(direction);
    apply(applyFade(track, from, to, direction), { message: s[direction === "in" ? "doneFadeIn" : "doneFadeOut"] });
  };
  const doVolume = () => {
    if (volumeDb === 0) return;
    const [from, to] = selection ? [selection.start, selection.end] : [0, total];
    apply(applyGain(track, from, to, dbToGain(volumeDb)), { message: fillTemplate(s.doneVolume, { db: `${volumeDb > 0 ? "+" : ""}${volumeDb}` }) });
    setVolumeDb(0);
  };
  const doNormalize = async () => {
    const [from, to] = selection ? [selection.start, selection.end] : [0, total];
    setBusy(s.normalizing);
    try {
      const peak = await peakInRangeAsync(track, from, to);
      if (peak < 1e-4) {
        setAnnounce(s.normalizeSilent);
        return;
      }
      apply(applyGain(track, from, to, normalizationGain(peak)), { message: s.doneNormalize });
    } finally {
      setBusy(null);
    }
  };
  const doUndo = () => {
    if (historyRef.current.past.length === 0) return;
    stopPlayback();
    const next = undo(historyRef.current);
    updateHistory(next);
    const length = trackLength(next.present);
    setCursor((value) => Math.min(value, length));
    setSelection(null);
    anchorRef.current = null;
    setResult(null);
    setAnnounce(s.undone);
  };
  const doRedo = () => {
    if (historyRef.current.future.length === 0) return;
    stopPlayback();
    const next = redo(historyRef.current);
    updateHistory(next);
    setCursor((value) => Math.min(value, trackLength(next.present)));
    setSelection(null);
    anchorRef.current = null;
    setResult(null);
    setAnnounce(s.redone);
  };

  const moveClip = (from: number, to: number) => {
    const next = moveSegment(track, from, to);
    apply(next, { cursor: 0, selection: null, message: fillTemplate(s.doneMoveClip, { from: String(from + 1), to: String(to + 1) }) });
  };
  const removeClip = (index: number) => {
    const name = track.segments[index]?.name ?? "";
    const next = removeSegment(track, index);
    apply(next, { cursor: 0, selection: null, message: fillTemplate(s.doneRemoveClip, { name }) });
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) doRedo();
      else doUndo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      doRedo();
    }
  };

  /* ------------------------------ importar ------------------------------- */

  const importFiles = async (incoming: File[]) => {
    const audio = incoming.filter((file) => file.type.startsWith("audio/") || TOOL.extensions.some((extension) => file.name.toLowerCase().endsWith(extension)));
    const skipped = incoming.filter((file) => !audio.includes(file));
    const messages: string[] = [];
    if (skipped.length > 0) messages.push(fillTemplate(s.skipped, { names: skipped.map((file) => file.name).join(", ") }));
    const room = Math.max(0, MAX_STUDIO_CLIPS - historyRef.current.present.segments.length);
    const queue = audio.slice(0, room);
    if (audio.length > queue.length) messages.push(fillTemplate(s.tooManyClips, { max: String(MAX_STUDIO_CLIPS) }));
    setError(null);
    if (queue.length === 0) {
      setNotices(messages);
      if (messages.length === 0 && incoming.length > 0) setError({ code: "unsupportedFormat" });
      return;
    }
    stopPlayback();
    const controller = new AbortController();
    importAbortRef.current = controller;
    let added = 0;
    let conformedAny = false;
    for (let index = 0; index < queue.length; index += 1) {
      const file = queue[index];
      setImporting({ name: file.name, index: index + 1, total: queue.length });
      try {
        const decoded = await decodeMedia(file, { signal: controller.signal });
        const current = historyRef.current;
        // Memoria: solo cuenta lo que esta en la pista (y el historial, que se recorta si no cabe).
        const incomingBytes = decoded.audio.channels.length * (decoded.audio.channels[0]?.length ?? 0) * 4;
        const sources = new Set<unknown>();
        let presentBytes = 0;
        for (const segment of current.present.segments) {
          if (sources.has(segment.source)) continue;
          sources.add(segment.source);
          presentBytes += segment.source.channels.length * (segment.source.channels[0]?.length ?? 0) * 4;
        }
        if (presentBytes + incomingBytes > decodedBudgetBytes()) {
          messages.push(fillTemplate(s.memoryFull, { name: file.name, minutes: String(minutesThatFit()) }));
          continue;
        }
        const appended = appendClip(current.present, decoded.audio, file.name);
        conformedAny ||= appended.conformed;
        // Si con el historial no cabe, se renuncia a deshacer lo anterior antes que a importar.
        let base = current;
        let historyBytes = 0;
        const seen = new Set<unknown>();
        for (const state of [...current.past, current.present, ...current.future]) {
          for (const segment of state.segments) {
            if (seen.has(segment.source)) continue;
            seen.add(segment.source);
            historyBytes += segment.source.channels.length * (segment.source.channels[0]?.length ?? 0) * 4;
          }
        }
        if (historyBytes + incomingBytes > decodedBudgetBytes()) base = initHistory(current.present);
        updateHistory(commit(base, appended.track));
        added += 1;
        if (current.present.segments.length === 0) {
          setCursor(0);
          setSelection(null);
        }
      } catch (caught) {
        const known = toAudioError(caught);
        if (known.code === "cancelled") break;
        messages.push(fillTemplate(s.importFailed, { name: file.name, reason: describeAudioError(shared, known.code, known.detail).message }));
      }
    }
    setImporting(null);
    importAbortRef.current = null;
    if (conformedAny) {
      const base = historyRef.current.present;
      messages.push(fillTemplate(s.conformed, { rate: String(base.sampleRate / 1000), channels: base.channels === 1 ? s.mono : s.stereo }));
    }
    setNotices(messages);
    if (added > 0) {
      setResult(null);
      setAnnounce(fillTemplate(added === 1 ? s.importedOne : s.importedMany, { count: String(added) }));
      requestAnimationFrame(() => waveFocusRef.current?.focus({ preventScroll: true }));
    } else if (!historyRef.current.present.segments.length) {
      requestAnimationFrame(() => dropzoneButtonRef.current?.focus());
    }
  };

  /* ------------------------------ exportar ------------------------------- */

  const exportAudio = async () => {
    if (!hasAudio || exporting) return;
    stopPlayback();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setError(null);
    setResult(null);
    setExporting({ progress: 0 });
    const exported = historyRef.current.present;
    try {
      const blob = await encodeAudio(trackSource(exported), exportOptions, {
        signal: controller.signal,
        onProgress: (value) => setExporting({ progress: Math.round(Math.min(1, Math.max(0, value)) * 100) }),
      });
      const first = exported.segments[0]?.name ?? s.fallbackName;
      const filename = editedName(first, exportOptions.format, s.suffix, s.fallbackName);
      setResult({ blob, filename, durationSec: trackDuration(exported) });
      addRecentEntry("audio-studio", filename);
      requestAnimationFrame(() => downloadRef.current?.focus());
    } catch (caught) {
      const known = toAudioError(caught);
      if (known.code === "cancelled") setAnnounce(shared.errors.cancelled.message);
      else {
        setError({ code: known.code, detail: known.detail });
        requestAnimationFrame(() => bannerRef.current?.focus());
      }
    } finally {
      exportAbortRef.current = null;
      setExporting(null);
    }
  };

  const startOver = () => {
    stopPlayback();
    importAbortRef.current?.abort();
    updateHistory(initHistory(emptyTrack()));
    setCursor(0);
    setSelection(null);
    setResult(null);
    setNotices([]);
    setError(null);
    setAnnounce("");
    requestAnimationFrame(() => dropzoneButtonRef.current?.focus());
  };

  /* -------------------------------- vista -------------------------------- */

  const errorText = error ? describeAudioError(shared, error.code, error.detail) : null;
  const clock = (frames: number) => formatClock(frames / rate);
  const valueText = !hasAudio
    ? ""
    : selection
      ? fillTemplate(s.summarySelection, { duration: formatClock(total / rate), start: clock(selection.start), end: clock(selection.end), length: clock(selection.end - selection.start) })
      : fillTemplate(s.summaryCursor, { duration: formatClock(total / rate), cursor: clock(cursor) });
  const shownPosition = playhead ?? cursor;
  const canCut = hasAudio && selection !== null && !working;
  const limitsLine = fillTemplate(s.limitsLine, { formats: TOOL.extensions.join(", "), max: formatBytes(MAX_AUDIO_FILE_BYTES, locale) });
  const dropProps = {
    accept: [...TOOL.accept, ...TOOL.extensions].join(","),
    multiple: true,
    title: s.dropTitle,
    titleActive: s.dropTitleActive,
    subtitle: s.dropSubtitle,
    buttonLabel: s.dropButton,
    limits: limitsLine,
    localNotice: s.localNotice,
    onFiles: (files: File[]) => void importFiles(files),
  };

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-28 md:px-6 md:pt-10 md:pb-16" onKeyDown={onEditorKeyDown}>
      <header className="mb-8 flex items-start gap-4">
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-ios", ACCENT_BG_SOFT[TOOL.accent])}>
          <TOOL_ICON aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-1 text-foreground">{t.tools["audio-studio"].name}</h1>
          <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">{t.tools["audio-studio"].description}</p>
        </div>
      </header>

      <ErrorBanner
        show={errorText !== null}
        errorKey={error?.code}
        title={shared.errorTitle}
        message={errorText?.message ?? ""}
        hint={errorText?.hint}
        dismissLabel={t.common.close}
        onDismiss={() => setError(null)}
        bannerRef={bannerRef}
      />

      {notices.length > 0 ? (
        <div className="mb-6 flex items-start gap-3 rounded-ios border border-hairline bg-white/5 p-4 pr-2">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <ul className="min-w-0 flex-1 space-y-1 pt-0.5 text-subheadline break-words text-foreground">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setNotices([])}
            aria-label={t.common.close}
            className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground group-hover:bg-white/10 group-hover:text-foreground">
              <X aria-hidden="true" className="size-4" />
            </span>
          </button>
        </div>
      ) : null}

      {/* Region viva: las acciones del editor se anuncian aqui. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="studio-status">
        {announce}
      </p>

      {importing ? (
        <div role="status" className="surface-card mb-6 flex flex-wrap items-center gap-3 rounded-ios p-4">
          <Loader2 aria-hidden="true" className="size-5 shrink-0 animate-spin text-signal motion-reduce:animate-none" />
          <p className="min-w-0 flex-1 text-subheadline break-words text-foreground">
            {fillTemplate(s.opening, { name: importing.name, index: String(importing.index), total: String(importing.total) })}
          </p>
          <Button variant="secondary" size="sm" onClick={() => importAbortRef.current?.abort()}>
            {s.cancelImport}
          </Button>
        </div>
      ) : null}

      {!hasAudio ? (
        <div className={importing ? "hidden" : undefined}>
          <AudioDropzone {...dropProps} buttonRef={dropzoneButtonRef} />
          {history.past.length > 0 ? (
            <div className="mt-4 flex flex-col items-center gap-2 text-center">
              <p className="text-subheadline text-muted-foreground">{s.emptyTrack}</p>
              <Button variant="secondary" size="md" onClick={doUndo}>
                <Undo2 aria-hidden="true" className="size-4" />
                {s.undo}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Transporte */}
          <section aria-labelledby={`${uid}-transport`} className="surface-card rounded-ios p-4">
            <h2 id={`${uid}-transport`} className="sr-only">
              {s.transportTitle}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="md" onClick={togglePlay} disabled={working} aria-pressed={playing} data-action="play">
                {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
                {playing ? s.pause : s.play}
              </Button>
              <p className="min-w-0 flex-1 text-callout text-foreground tabular-nums" data-testid="clock">
                <span className="sr-only">{s.positionLabel}: </span>
                {formatClock(shownPosition / rate)} <span className="text-muted-foreground">/ {formatClock(total / rate)}</span>
              </p>
              <Button variant="ghost" size="md" onClick={doUndo} disabled={working || history.past.length === 0} data-action="undo">
                <Undo2 aria-hidden="true" className="size-4" />
                {s.undo}
              </Button>
              <Button variant="ghost" size="md" onClick={doRedo} disabled={working || history.future.length === 0} data-action="redo">
                <Redo2 aria-hidden="true" className="size-4" />
                {s.redo}
              </Button>
            </div>
          </section>

          {/* Onda */}
          <section aria-labelledby={`${uid}-wave`}>
            <h2 id={`${uid}-wave`} className="ui-label mb-2 text-muted-foreground">
              {s.waveTitle}
            </h2>
            <Waveform
              track={track}
              cursor={cursor}
              playhead={playhead}
              selection={selection}
              ariaLabel={s.waveformLabel}
              valueText={valueText}
              onMove={moveCursor}
              onDrag={(anchor, frame) => dragSelect(anchor, frame)}
              onTogglePlay={togglePlay}
              onClearSelection={() => {
                setSelection(null);
                anchorRef.current = null;
                setAnnounce(s.selectionCleared);
              }}
              focusRef={waveFocusRef}
            />
            <p className="mt-2 text-footnote text-muted-foreground" data-testid="wave-summary">
              {valueText}
            </p>
            <p className="mt-1 text-footnote text-muted-foreground">{s.waveHelp}</p>
          </section>

          {/* Seleccion */}
          <section aria-labelledby={`${uid}-selection`} className="surface-card rounded-ios p-4">
            <h2 id={`${uid}-selection`} className="ui-label mb-3 text-muted-foreground">
              {s.selectionTitle}
            </h2>
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[8rem] flex-1">
                <SecondsField label={s.selectionStart} frames={selection?.start ?? cursor} sampleRate={rate} maxFrames={total} disabled={working} onCommit={(frames) => setSelectionEdge("start", frames)} />
              </div>
              <div className="min-w-[8rem] flex-1">
                <SecondsField label={s.selectionEnd} frames={selection?.end ?? cursor} sampleRate={rate} maxFrames={total} disabled={working} onCommit={(frames) => setSelectionEdge("end", frames)} />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ghost" size="md" wrap disabled={working} onClick={() => setSelectionEdge("start", cursor)}>
                {s.markStart}
              </Button>
              <Button variant="ghost" size="md" wrap disabled={working} onClick={() => setSelectionEdge("end", cursor)}>
                {s.markEnd}
              </Button>
              <Button
                variant="ghost"
                size="md"
                wrap
                disabled={working}
                onClick={() => {
                  setSelection(rangeOf(0, total));
                  setAnnounce(s.selectedAll);
                }}
              >
                {s.selectAll}
              </Button>
              <Button variant="ghost" size="md" wrap disabled={working || !selection} onClick={() => setSelection(null)}>
                {s.deselect}
              </Button>
            </div>
          </section>

          {/* Editar */}
          <section aria-labelledby={`${uid}-edit`} className="surface-card rounded-ios p-4">
            <h2 id={`${uid}-edit`} className="ui-label mb-3 text-muted-foreground">
              {s.editTitle}
            </h2>
            <div className="flex flex-wrap gap-2">
              <ActionButton id="trim" label={s.trim} onClick={doTrim} disabled={working || !canCut} />
              <ActionButton id="cut" label={s.cut} onClick={doCut} disabled={working || !canCut} />
              <ActionButton id="split" label={s.split} onClick={doSplit} disabled={working || !canSplit} />
            </div>
            {!selection ? <p className="mt-2 text-footnote text-muted-foreground">{s.needSelection}</p> : null}

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <div>
                <h3 className="text-subheadline font-semibold text-foreground">{s.fadeTitle}</h3>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-[7rem] flex-1">
                    <label htmlFor={`${uid}-fade`} className="ui-label mb-1.5 block text-muted-foreground">
                      {s.fadeDuration}
                    </label>
                    <input
                      id={`${uid}-fade`}
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      max={60}
                      step={0.1}
                      value={fadeSeconds}
                      disabled={working || selection !== null}
                      onChange={(event) => setFadeSeconds(Math.min(60, Math.max(0.1, Number(event.target.value) || 0.1)))}
                      className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground tabular-nums focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal disabled:opacity-60"
                    />
                  </div>
                  <ActionButton id="fade-in" label={s.fadeIn} onClick={() => doFade("in")} disabled={working} />
                  <ActionButton id="fade-out" label={s.fadeOut} onClick={() => doFade("out")} disabled={working} />
                </div>
                <p className="mt-2 text-footnote text-muted-foreground">{s.fadeHint}</p>
              </div>

              <div>
                <h3 className="text-subheadline font-semibold text-foreground">{s.volumeTitle}</h3>
                <Slider label={s.volumeLabel} value={volumeDb} min={-24} max={24} step={1} suffix=" dB" disabled={working} onChange={setVolumeDb} className="mt-2" />
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton id="volume" label={s.volumeApply} onClick={doVolume} disabled={working || volumeDb === 0} icon={<Volume2 aria-hidden="true" className="size-4" />} />
                  <ActionButton id="normalize" label={s.normalize} onClick={() => void doNormalize()} disabled={working} />
                </div>
                <p className="mt-2 text-footnote text-muted-foreground">{s.volumeHint}</p>
              </div>
            </div>
          </section>

          {/* Clips */}
          <ClipList
            track={track}
            disabled={working}
            onMove={moveClip}
            onRemove={removeClip}
            strings={{ title: s.clipsTitle, hint: s.clipsHint, moveUp: s.moveUp, moveDown: s.moveDown, remove: s.removeClip, clipOf: s.clipOf }}
          />
          {track.segments.length < MAX_STUDIO_CLIPS ? <AudioDropzone {...dropProps} compact addLabel={s.addMore} className="mt-[-0.5rem]" /> : null}

          {/* Exportar */}
          <section aria-labelledby={`${uid}-export`} className="surface-card rounded-ios p-4 md:p-5">
            <h2 id={`${uid}-export`} className="mb-4 text-headline text-foreground">
              {s.exportTitle}
            </h2>
            <div className="max-w-md">
              <OutputOptions value={exportOptions} onChange={(patch) => setExportOptions((previous) => ({ ...previous, ...patch }))} support={support} strings={shared} idPrefix={`${uid}-out`} />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button size="lg" wrap onClick={() => void exportAudio()} disabled={working} data-action="export">
                {s.exportButton}
              </Button>
              <Button variant="ghost" size="md" wrap onClick={startOver} disabled={importing !== null || exporting !== null}>
                {t.tool.startOver}
              </Button>
            </div>
            <p className="mt-3 text-footnote text-muted-foreground">{shared.privacyNote}</p>

            {result ? (
              <div role="status" data-testid="export-result" className="mt-5 flex flex-col gap-3 rounded-ios border border-hairline bg-white/5 p-4">
                <p className="flex items-start gap-2 text-subheadline text-foreground">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  <span className="min-w-0 break-words">
                    {fillTemplate(s.exportDone, { name: result.filename, size: formatBytes(result.blob.size, locale), duration: formatClock(result.durationSec) })}
                  </span>
                </p>
                <div>
                  <Button ref={downloadRef} size="md" wrap onClick={() => saveBlob(result.blob, result.filename)}>
                    <Download aria-hidden="true" className="size-4" />
                    {t.tool.download}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      )}

      <AnimatePresence>
        {exporting ? (
          <ProcessingOverlay key="exporting" progress={exporting.progress} message={s.exporting} onCancel={() => exportAbortRef.current?.abort()} />
        ) : null}
      </AnimatePresence>
      {busy ? (
        <p role="status" className="sr-only">
          {busy}
        </p>
      ) : null}
    </div>
  );
}

