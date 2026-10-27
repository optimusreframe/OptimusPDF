"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Camera, CameraOff, Flashlight, FlashlightOff, ImagePlus, Layers, SwitchCamera, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { CameraError, captureFrame, stopCameraStream, type CameraErrorCode } from "@/lib/pdf/scanToPdf";
import { QUAD_KEYS, type QuadCorners } from "@/lib/scan/perspective";
import type { FrameVerdict, ScanMode, ScanSettings } from "@/lib/scan/types";
import { analyzeFrameInMode, resolveScanEngine } from "@/app/scan-to-pdf/scanServices";
import { FullscreenLayer } from "@/app/scan-to-pdf/FullscreenLayer";
import { useAnnounce } from "@/app/scan-to-pdf/ScanLive";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import { ModeChips } from "@/app/scan-to-pdf/ModeChips";
import type { CaptureOutcome } from "@/app/scan-to-pdf/useScanSession";
import {
  NO_CAPS,
  focusAt,
  hasSeveralCameras,
  openCamera,
  readCaps,
  setTorch,
  setZoom,
  videoTrackOf,
  zoomSteps,
  type CameraCaps,
  type Facing,
} from "@/app/scan-to-pdf/cameraControls";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

/** ~9 analisis por segundo: reacciona rapido sin castigar la bateria. */
export const ANALYSIS_INTERVAL_MS = 110;
/** Tras una captura automatica no se dispara otra hasta pasado este tiempo (y hasta que el documento cambie). */
export const AUTO_COOLDOWN_MS = 1200;
/** `stableMs` con el que el anillo de progreso se ve completo. */
export const RING_FULL_MS = 900;
/** Ancho de la muestra que se entrega al motor para analizar el fotograma. */
const SAMPLE_WIDTH = 320;

export type CameraScreenProps = {
  s: ScanToPdfStrings;
  settings: ScanSettings;
  onSettings: (patch: Partial<ScanSettings>) => void;
  pageCount: number;
  lastThumb: Blob | null;
  lastNumber: number;
  canUndoLast: boolean;
  /** Identificacion: lado que se espera ahora (`null` si el modo no es Identificacion). */
  idSide: "front" | "back" | null;
  /** Texto fijo bajo la guia (p. ej. «Repetir página 3»). */
  target?: string | null;
  onCapture: (blob: Blob) => Promise<CaptureOutcome>;
  onUndoLast: () => void;
  onImport: (files: File[]) => void;
  /** Ir a revisar (con `pageCount` paginas). */
  onDone: () => void;
  /** Cerrar la camara sin mas. */
  onClose: () => void;
  /** Se cierra sola tras una captura (insertar / repetir). */
  closeAfterCapture?: boolean;
  onModeChange: (mode: ScanMode) => void;
};

/** Cuadrilatero que el motor ve sobre el video (mismo encaje que `object-contain`). */
function QuadOverlay({ quad, size }: { quad: QuadCorners | null; size: { width: number; height: number } | null }) {
  if (!quad || !size) return null;
  const points = QUAD_KEYS.map((key) => `${quad[key].x * size.width},${quad[key].y * size.height}`).join(" ");
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 size-full">
      <polygon points={points} fill="var(--color-signal)" fillOpacity="0.16" stroke="var(--color-signal)" strokeWidth={Math.max(2, size.width / 220)} strokeLinejoin="round" />
    </svg>
  );
}

function guideText(s: ScanToPdfStrings, mode: ScanMode, hint: FrameVerdict["hint"]): string {
  // En Foto no hay documento que buscar; en el resto, la guia unica es la del motor.
  if (mode === "photo") return hint === "too_dark" || hint === "glare" || hint === "hold_steady" ? s.hints[hint] : s.hintPhoto;
  if (mode === "book" && (hint === "no_document" || hint === "unknown")) return s.hintBook;
  if (mode === "receipt" && hint === "no_document") return s.hintReceipt;
  if (mode === "whiteboard" && hint === "no_document") return s.hintBoard;
  return s.hints[hint];
}

const TOOL_BUTTON =
  "flex size-11 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white backdrop-blur-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-95 disabled:opacity-40";

export function CameraScreen({
  s,
  settings,
  onSettings,
  pageCount,
  lastThumb,
  lastNumber,
  canUndoLast,
  idSide,
  target,
  onCapture,
  onUndoLast,
  onImport,
  onDone,
  onClose,
  closeAfterCapture = false,
  onModeChange,
}: CameraScreenProps) {
  const announce = useAnnounce();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(true);
  const [errorCode, setErrorCode] = useState<CameraErrorCode | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [facing, setFacing] = useState<Facing>("environment");
  const [severalCameras, setSeveralCameras] = useState(false);
  const [caps, setCaps] = useState<CameraCaps>(NO_CAPS);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [verdict, setVerdict] = useState<FrameVerdict | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(0);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number; id: number } | null>(null);
  const [ring, setRing] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const previousRef = useRef<{ quad: QuadCorners | null; at: number } | null>(null);
  const lastAnalysisRef = useRef(0);
  const capturingRef = useRef(false);
  const armedRef = useRef(true);
  const cooldownUntilRef = useRef(0);
  const settingsRef = useRef(settings);
  const closeAfterRef = useRef(closeAfterCapture);
  const onCaptureRef = useRef(onCapture);
  const onDoneRef = useRef(onDone);
  const announcedHintRef = useRef<{ hint: string; at: number }>({ hint: "", at: 0 });
  useEffect(() => {
    settingsRef.current = settings;
    closeAfterRef.current = closeAfterCapture;
    onCaptureRef.current = onCapture;
    onDoneRef.current = onDone;
  });

  const thumbUrl = useBlobUrl(lastThumb);

  /* ---------------- abrir / cerrar el flujo ---------------- */
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- arrancar la camara es el efecto externo de este montaje
    setStarting(true);
    setErrorCode(null);
    void (async () => {
      try {
        const next = await openCamera(facing);
        if (cancelled) {
          stopCameraStream(next);
          return;
        }
        streamRef.current = next;
        setStream(next);
        const track = videoTrackOf(next);
        setCaps(readCaps(track));
        setTorchOn(false);
        setZoomIndex(0);
        void hasSeveralCameras().then((several) => {
          if (!cancelled) setSeveralCameras(several);
        });
      } catch (error) {
        if (!cancelled) setErrorCode(error instanceof CameraError ? error.code : "unknown");
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
      stopCameraStream(streamRef.current);
      streamRef.current = null;
      setStream(null);
    };
  }, [facing, attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      // Safari puede rechazar el autoplay: el primer fotograma queda quieto hasta tocar.
    });
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  /* ---------------- captura ---------------- */
  const shoot = useCallback(async (auto: boolean) => {
    const video = videoRef.current;
    if (!video || capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      const blob = await captureFrame(video);
      try {
        navigator.vibrate?.(auto ? [12] : [8]);
      } catch {
        // Sin vibracion (iOS): solo el destello.
      }
      setFlash((n) => n + 1);
      await onCaptureRef.current(blob);
      armedRef.current = false;
      cooldownUntilRef.current = performance.now() + AUTO_COOLDOWN_MS;
      if (closeAfterRef.current || !settingsRef.current.batch) onDoneRef.current();
    } catch (error) {
      setErrorCode(error instanceof CameraError ? error.code : "unknown");
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  }, []);

  /* ---------------- analisis del fotograma en vivo ---------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!stream || !video) return;
    const useVideoFrames = typeof video.requestVideoFrameCallback === "function";
    let stopped = false;
    let handle = 0;

    const analyze = (now: number) => {
      if (document.hidden || !video.videoWidth || !video.videoHeight) return;
      const scale = Math.min(1, SAMPLE_WIDTH / video.videoWidth);
      const canvas = (sampleRef.current ??= document.createElement("canvas"));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      let next: FrameVerdict;
      try {
        next = analyzeFrameInMode(resolveScanEngine(), ctx.getImageData(0, 0, canvas.width, canvas.height), previousRef.current ?? undefined, now, settingsRef.current.mode);
      } catch {
        return;
      }
      previousRef.current = { quad: next.quad, at: now };
      setVideoSize((previous) => (previous?.width === video.videoWidth && previous.height === video.videoHeight ? previous : { width: video.videoWidth, height: video.videoHeight }));
      setVerdict((previous) =>
        previous && previous.hint === next.hint && previous.stable === next.stable && Math.round(previous.stableMs / 100) === Math.round(next.stableMs / 100) && previous.quad === next.quad
          ? previous
          : next,
      );

      // Captura automatica: solo con documento estable y OK; despues de capturar se espera a que el documento cambie.
      const mode = settingsRef.current.mode;
      const ready = next.shouldAutoCapture && next.hint === "ok";
      const waiting = !settingsRef.current.autoCapture || mode === "photo" || next.hint !== "ok" || !armedRef.current;
      const progress = waiting ? 0 : Math.min(1, next.stableMs / RING_FULL_MS);
      setRing((previous) => (Math.abs(previous - progress) < 0.04 ? previous : Math.round(progress * 20) / 20));
      if (!armedRef.current) {
        if (!ready || !next.stable) armedRef.current = true;
        return;
      }
      if (!settingsRef.current.autoCapture || mode === "photo" || capturingRef.current || now < cooldownUntilRef.current) return;
      if (ready) void shoot(true);
    };

    const schedule = () => {
      if (stopped) return;
      handle = useVideoFrames ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      if (now - lastAnalysisRef.current >= ANALYSIS_INTERVAL_MS) {
        lastAnalysisRef.current = now;
        analyze(now);
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      previousRef.current = null;
      if (useVideoFrames) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [stream, shoot]);

  // Un fallo de camara recibe el foco: la capa es la misma, asi que no lo hace su montaje.
  useEffect(() => {
    if (errorCode) document.querySelector<HTMLElement>("[data-camera-error]")?.focus();
  }, [errorCode]);

  /* ---------------- guia hablada (poco a poco: no cada fotograma) ---------------- */
  const hint = verdict?.hint ?? "unknown";
  const guide = guideText(s, settings.mode, hint);
  useEffect(() => {
    if (!verdict) return;
    const timer = setTimeout(() => {
      const last = announcedHintRef.current;
      const now = Date.now();
      if (hint === "unknown" || last.hint === hint || now - last.at < 4000) return;
      announcedHintRef.current = { hint, at: now };
      announce(guide);
    }, 1500);
    return () => clearTimeout(timer);
  }, [hint, guide, verdict, announce]);

  /* ---------------- linterna, zoom, enfoque, cambio de camara ---------------- */
  const track = videoTrackOf(stream);
  const zoomList = caps.zoom ? zoomSteps(caps.zoom) : [];

  const toggleTorch = async () => {
    if (!track) return;
    const next = !torchOn;
    if (await setTorch(track, next)) setTorchOn(next);
    else setCaps((previous) => ({ ...previous, torch: false }));
  };

  const cycleZoom = async () => {
    if (!track || zoomList.length < 2) return;
    const next = (zoomIndex + 1) % zoomList.length;
    if (await setZoom(track, zoomList[next])) setZoomIndex(next);
  };

  const onVideoPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!track || !caps.focus || (event.target as HTMLElement).closest("button")) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    setFocusPoint({ x: event.clientX - box.left, y: event.clientY - box.top, id: Date.now() });
    void focusAt(track, x, y);
  };

  useEffect(() => {
    if (!focusPoint) return;
    const timer = setTimeout(() => setFocusPoint(null), 800);
    return () => clearTimeout(timer);
  }, [focusPoint]);

  const ringProgress = ring;
  const RING_R = 34;
  const ringLength = 2 * Math.PI * RING_R;

  const idText = idSide ? s.idStep(idSide === "front" ? s.idFront : s.idBack, idSide === "front" ? 1 : 2) : null;

  /* ---------------- sin camara ---------------- */
  if (errorCode) {
    return (
      <FullscreenLayer label={s.cameraRegion} tone="dark" initialFocus="[data-camera-error]" onEscape={onClose} dataAttr="data-camera-stage">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-8 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-white/10">
            <CameraOff aria-hidden="true" className="size-6" />
          </span>
          <div role="alert" tabIndex={-1} data-camera-error="" className="max-w-md outline-none">
            <h2 className="text-headline font-semibold">{s.cameraErrorTitle}</h2>
            <p className="mt-2 text-callout text-white/80">{s.cameraErrors[errorCode]}</p>
          </div>
          <div className="mt-2 w-full max-w-sm">
            <p className="text-subheadline font-semibold">{s.cameraFallbackTitle}</p>
            <p className="mt-1 text-footnote text-white/75">{s.cameraFallbackBody}</p>
          </div>
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Button size="lg" fullWidth data-camera-action="upload" onClick={() => importRef.current?.click()}>
              <ImagePlus aria-hidden="true" className="size-5" />
              {s.pickPhotos}
            </Button>
            <button type="button" data-camera-action="start" onClick={() => setAttempt((n) => n + 1)} className="inline-flex min-h-11 w-full items-center justify-center rounded-ios-sm border border-white/25 bg-white/15 px-4 py-2 text-center text-callout font-semibold text-white outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              {s.retryCamera}
            </button>
            <button type="button" onClick={onClose} className="inline-flex min-h-11 w-full items-center justify-center rounded-ios-sm px-4 py-2 text-center text-callout font-semibold text-white outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              {s.closeCamera}
            </button>
          </div>
        </div>
        <input
          ref={importRef}
          type="file"
          accept="image/*"
          multiple
          aria-label={s.inputFiles}
          aria-hidden="true"
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) {
              onImport(files);
              onClose();
            }
          }}
        />
      </FullscreenLayer>
    );
  }

  return (
    <FullscreenLayer label={s.cameraRegion} tone="dark" initialFocus='[data-camera-action="capture"]' onEscape={onClose} dataAttr="data-camera-stage">
      {/* Zona de vision: el video llena todo el espacio disponible */}
      <div className="relative min-h-0 flex-1 overflow-hidden" onPointerDown={onVideoPointer} style={{ touchAction: "manipulation" }}>
        <video ref={videoRef} autoPlay muted playsInline aria-label={s.liveTitle} className="absolute inset-0 size-full object-contain" />
        {settings.mode !== "photo" ? <QuadOverlay quad={verdict?.quad ?? null} size={videoSize} /> : null}

        {flash > 0 ? <motion.span key={flash} aria-hidden="true" initial={{ opacity: 0.75 }} animate={{ opacity: 0 }} transition={{ duration: 0.16 }} className="pointer-events-none absolute inset-0 bg-white" /> : null}
        {focusPoint ? (
          <span
            aria-hidden="true"
            data-focus-ring=""
            className="pointer-events-none absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-yellow-300"
            style={{ left: focusPoint.x, top: focusPoint.y }}
          />
        ) : null}

        {/* Barra superior: cerrar + contador */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-3" style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}>
          <button type="button" data-camera-action="close" aria-label={s.closeCamera} className={TOOL_BUTTON} onClick={onClose}>
            <X aria-hidden="true" className="size-5" />
          </button>
          <span data-camera-count="" className="on-media rounded-full border border-white/20 bg-black/55 px-3 py-1.5 text-caption font-semibold tabular-nums text-white backdrop-blur-md">
            {s.pagesBadge(pageCount)}
          </span>
        </div>

        {/* La guia unica */}
        <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center gap-1.5 px-14" style={{ top: "calc(4.5rem + env(safe-area-inset-top, 0px))" }}>
          <span
            data-camera-hint={hint}
            className={cn(
              "on-media max-w-full rounded-full border px-3 py-1.5 text-center text-caption font-semibold text-white backdrop-blur-md",
              hint === "ok" ? "border-success/70 bg-black/60" : "border-white/20 bg-black/55",
            )}
          >
            {guide}
          </span>
          {idText ? <span className="on-media max-w-full rounded-full bg-signal px-3 py-1 text-center text-caption font-semibold text-[var(--color-on-signal)]">{idText}</span> : null}
          {target ? <span className="on-media max-w-full rounded-full border border-white/20 bg-black/55 px-3 py-1 text-center text-caption text-white backdrop-blur-md">{target}</span> : null}
        </div>

        {/* Controles a la derecha, al alcance del pulgar */}
        <div role="group" aria-label={s.toolsLabel} className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-2.5">
          <button
            type="button"
            data-camera-action="auto"
            aria-label={settings.autoCapture ? s.autoOn : s.autoOff}
            className={cn(TOOL_BUTTON, settings.autoCapture && "border-signal bg-signal text-[var(--color-on-signal)]")}
            onClick={() => onSettings({ autoCapture: !settings.autoCapture })}
          >
            <Timer aria-hidden="true" className="size-5" />
          </button>
          <button
            type="button"
            data-camera-action="burst"
            aria-label={settings.batch ? s.burstOn : s.burstOff}
            className={cn(TOOL_BUTTON, settings.batch && "border-signal bg-signal text-[var(--color-on-signal)]")}
            onClick={() => onSettings({ batch: !settings.batch })}
          >
            <Layers aria-hidden="true" className="size-5" />
          </button>
          {caps.torch ? (
            <button type="button" data-camera-action="torch" aria-label={torchOn ? s.torchOn : s.torchOff} className={cn(TOOL_BUTTON, torchOn && "border-yellow-300 bg-yellow-300 text-black")} onClick={() => void toggleTorch()}>
              {torchOn ? <Flashlight aria-hidden="true" className="size-5" /> : <FlashlightOff aria-hidden="true" className="size-5" />}
            </button>
          ) : null}
          {zoomList.length > 1 ? (
            <button type="button" data-camera-action="zoom" aria-label={s.zoomLabel(String(Math.round(zoomList[zoomIndex] * 10) / 10))} className={cn(TOOL_BUTTON, "text-caption font-semibold tabular-nums")} onClick={() => void cycleZoom()}>
              {Math.round(zoomList[zoomIndex] * 10) / 10}×
            </button>
          ) : null}
          {severalCameras ? (
            <button type="button" data-camera-action="switch" aria-label={s.switchCamera} className={TOOL_BUTTON} onClick={() => setFacing((current) => (current === "environment" ? "user" : "environment"))}>
              <SwitchCamera aria-hidden="true" className="size-5" />
            </button>
          ) : null}
          <button type="button" data-camera-action="import" aria-label={s.importPhotos} className={TOOL_BUTTON} onClick={() => importRef.current?.click()}>
            <ImagePlus aria-hidden="true" className="size-5" />
          </button>
        </div>

        {starting ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner className="size-6" label={s.starting} />
          </div>
        ) : null}
      </div>

      {/* Panel inferior: modos y disparador (abajo, al alcance del pulgar) */}
      <div className="shrink-0 bg-black px-3 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}>
        <ModeChips s={s} mode={settings.mode} onChange={onModeChange} tone="dark" />
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {thumbUrl && canUndoLast ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img data-camera-last="" src={thumbUrl} alt={s.lastShotAlt(lastNumber)} className="size-12 rounded-lg border border-white/30 bg-white/10 object-cover" />
                <button
                  type="button"
                  data-camera-action="undo-last"
                  onClick={onUndoLast}
                  className="on-media inline-flex min-h-11 items-center rounded-full border border-white/25 bg-white/10 px-3 text-footnote font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                >
                  {s.undoLast}
                </button>
              </>
            ) : null}
          </div>

          <button
            type="button"
            data-camera-action="capture"
            aria-label={s.shutter}
            // `aria-disabled` y no `disabled`: un boton que se desactiva pierde el foco justo al pulsarlo.
            aria-disabled={capturing || undefined}
            onClick={() => {
              if (!capturing) void shoot(false);
            }}
            className="relative flex size-[76px] items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal aria-disabled:opacity-60"
          >
            <svg aria-hidden="true" viewBox="0 0 76 76" className="absolute inset-0 size-full -rotate-90">
              <circle cx="38" cy="38" r={RING_R} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="4" />
              <circle
                data-camera-ring={ringProgress.toFixed(2)}
                cx="38"
                cy="38"
                r={RING_R}
                fill="none"
                stroke="var(--color-signal)"
                strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={ringLength}
                strokeDashoffset={ringLength * (1 - ringProgress)}
              />
            </svg>
            <span className="relative flex size-[56px] items-center justify-center rounded-full bg-white text-black">
              {capturing ? <Spinner className="size-5" /> : <Camera aria-hidden="true" className="size-6" />}
            </span>
          </button>

          <div className="flex min-w-0 justify-end">
            <Button size="md" wrap className="min-w-0 px-3" data-camera-action="done" onClick={onDone} disabled={pageCount === 0}>
              {pageCount > 0 ? s.review(pageCount) : s.reviewEmpty}
            </Button>
          </div>
        </div>
      </div>

      <input
        ref={importRef}
        type="file"
        accept="image/*"
        multiple
        aria-label={s.inputFiles}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) onImport(files);
        }}
      />
    </FullscreenLayer>
  );
}
