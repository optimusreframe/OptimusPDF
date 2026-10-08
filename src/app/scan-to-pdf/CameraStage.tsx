"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Check,
  ImagePlus,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { matchesAccept } from "@/lib/pdf/core";
import {
  CameraError,
  captureFrame,
  startCameraStream,
  stopCameraStream,
  type CameraErrorCode,
  type ScanFilter,
} from "@/lib/pdf/scanToPdf";
import {
  MOTION_STABLE_THRESHOLD,
  UNKNOWN_METRICS,
  analyzeSample,
  getCaptureHint,
  sampleFrame,
  type CaptureHint,
  type FrameSample,
} from "@/lib/scan/frameAnalysis";
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { previewFilter } from "@/app/scan-to-pdf/preview";
import { DocumentOverlay } from "@/app/scan-to-pdf/DocumentOverlay";

const TOOL = getTool("scan-to-pdf");

/** ~9 analisis por segundo: reacciona rapido sin castigar la bateria. */
const ANALYSIS_INTERVAL_MS = 110;

/** Fotogramas seguidos en verde antes de armar la cuenta atras (~1 s). */
const STABLE_FRAMES_TO_ARM = 9;

/** Cuenta atras visible —y cancelable— antes de la captura automatica. */
const AUTO_COUNTDOWN_MS = 1000;

/*
 * La pista va SOBRE el video (oscuro tambien con el tema claro): `on-media`
 * fija la paleta del tema oscuro (texto claro) en ambos temas. Con el texto
 * del tema claro eran 1.1:1 (foreground) y 3.1:1 (success) sobre el chip.
 * Ningun tono lleva texto de color: un verde sobre un tinte verde del 20 %
 * sobre un fotograma claro media ~2:1 y el gris atenuado de "unknown" 2.7:1
 * sobre el fotograma (1.6:1 sobre una hoja blanca). El texto es siempre
 * blanco sobre negro al 55-60 % (>= 4.7:1 incluso sobre blanco puro) y el
 * verde de "ok" queda en el borde como refuerzo (W1-D).
 */
const HINT_TONE: Record<CaptureHint, string> = {
  ok: "border-success/60 bg-black/60 text-foreground",
  hold_steady: "border-white/16 bg-black/55 text-foreground",
  too_dark: "border-white/16 bg-black/55 text-foreground",
  unknown: "border-white/16 bg-black/55 text-foreground",
};

/**
 * La auto-captura arranca encendida en pantallas tactiles —el caso real de
 * escanear con el movil en la mano— y apagada con raton: una webcam
 * apoyada en la mesa ya esta quieta, asi que dispararia capturas de la
 * misma pagina en bucle. El interruptor sigue a la vista en ambos casos.
 *
 * Se lee como store externo (igual que la preferencia de idioma) para que
 * el render del servidor y la hidratacion coincidan sin efectos.
 */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

export type CameraStageProps = {
  filter: ScanFilter;
  /** Fotograma tomado de la vista en vivo, ya derecho desde el canvas. */
  onCapture: (blob: Blob) => void;
  /** Foto que llega de un input de archivo; el padre la endereza. */
  onImport: (file: File) => void;
};

/**
 * Captura con la camara del dispositivo. Pide `facingMode: environment`
 * en modo `ideal`, asi que en un portatil sin camara trasera se abre la
 * webcam frontal en lugar de fallar. Si la camara no esta disponible se
 * ofrece anadir fotos ya guardadas, sin fingir que el escaneo funciona.
 *
 * Sobre la vista en vivo corre un analisis del fotograma (nitidez, luz y
 * movimiento) que guia el encuadre y, si la auto-captura esta encendida,
 * dispara solo: es el camino rapido para escanear varias paginas. Como
 * ningun navegador movil deja controlar el flash ni el enfoque del stream,
 * para eso se ofrece la rafaga con la app de Camara del sistema.
 */
export function CameraStage({
  filter,
  onCapture,
  onImport,
}: CameraStageProps) {
  const { language } = useI18n();
  const s = STRINGS[language];

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [errorCode, setErrorCode] = useState<CameraErrorCode | null>(null);
  const [hint, setHint] = useState<CaptureHint>("unknown");
  const [autoCaptureChoice, setAutoCaptureChoice] = useState<boolean | null>(
    null,
  );
  const [countdown, setCountdown] = useState<number | null>(null);
  const [burst, setBurst] = useState(false);
  const [burstCount, setBurstCount] = useState(0);

  const coarsePointer = useSyncExternalStore(
    subscribeCoarsePointer,
    getCoarsePointer,
    () => false,
  );
  const autoCapture = autoCaptureChoice ?? coarsePointer;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nativeInputRef = useRef<HTMLInputElement | null>(null);

  const previousSampleRef = useRef<FrameSample | null>(null);
  const stableFramesRef = useRef(0);
  const countdownStartRef = useRef<number | null>(null);
  const lastAnalysisRef = useRef(0);
  const movedRef = useRef(false);
  const autoCaptureRef = useRef(false);
  const capturingRef = useRef(false);
  const captureRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    autoCaptureRef.current = autoCapture;
  }, [autoCapture]);

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  // Apagar la camara al desmontar: sin esto el indicador del sistema se
  // queda encendido despues de salir de la herramienta.
  useEffect(
    () => () => {
      stopCameraStream(streamRef.current);
      streamRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {
      // Safari puede rechazar el autoplay: el usuario vera el primer
      // fotograma congelado y podra pulsar sobre el video.
    });
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const start = useCallback(async () => {
    setStarting(true);
    setErrorCode(null);
    try {
      setStream(await startCameraStream());
    } catch (error) {
      setErrorCode(error instanceof CameraError ? error.code : "unknown");
    } finally {
      setStarting(false);
    }
  }, []);

  const resetAutoCapture = useCallback(() => {
    stableFramesRef.current = 0;
    countdownStartRef.current = null;
    movedRef.current = false;
    setCountdown(null);
  }, []);

  const stop = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setHint("unknown");
    previousSampleRef.current = null;
    resetAutoCapture();
  }, [resetAutoCapture]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      onCapture(await captureFrame(video));
    } catch (error) {
      setErrorCode(error instanceof CameraError ? error.code : "unknown");
    } finally {
      capturingRef.current = false;
      setCapturing(false);
      resetAutoCapture();
    }
  }, [onCapture, resetAutoCapture]);

  useEffect(() => {
    captureRef.current = capture;
  }, [capture]);

  const analyze = useCallback(
    (now: number) => {
      const video = videoRef.current;
      if (!video) return;

      const sample = sampleFrame(video, video.videoWidth, video.videoHeight);
      const metrics = sample
        ? analyzeSample(sample, previousSampleRef.current)
        : UNKNOWN_METRICS;
      previousSampleRef.current = sample;

      const next = getCaptureHint(metrics);
      setHint((current) => (current === next ? current : next));

      // La auto-captura solo se arma despues de mover la camara: sin esta
      // condicion, un telefono apoyado sobre el documento capturaria la
      // misma pagina una y otra vez.
      if (metrics.motionDelta > MOTION_STABLE_THRESHOLD) movedRef.current = true;

      const ready =
        autoCaptureRef.current &&
        !capturingRef.current &&
        movedRef.current &&
        next === "ok";

      if (!ready) {
        stableFramesRef.current = 0;
        countdownStartRef.current = null;
        setCountdown((current) => (current === null ? current : null));
        return;
      }

      stableFramesRef.current += 1;
      if (stableFramesRef.current < STABLE_FRAMES_TO_ARM) return;

      if (countdownStartRef.current === null) countdownStartRef.current = now;
      const remaining = AUTO_COUNTDOWN_MS - (now - countdownStartRef.current);
      if (remaining > 0) {
        const seconds = Math.max(1, Math.ceil(remaining / 1000));
        setCountdown((current) => (current === seconds ? current : seconds));
        return;
      }

      void captureRef.current();
    },
    [],
  );

  // Bucle de analisis del fotograma en vivo. `requestVideoFrameCallback`
  // se despierta con cada fotograma real del stream (y se detiene solo
  // cuando el video se pausa o pasa a segundo plano); donde no existe
  // —Firefox, por ejemplo— el fallback es `requestAnimationFrame`. En
  // ambos casos el trabajo pesado va limitado por ANALYSIS_INTERVAL_MS.
  useEffect(() => {
    const video = videoRef.current;
    if (!stream || !video) return;

    const useVideoFrames = typeof video.requestVideoFrameCallback === "function";
    let stopped = false;
    let handle = 0;

    const schedule = () => {
      if (stopped) return;
      handle = useVideoFrames
        ? video.requestVideoFrameCallback(tick)
        : requestAnimationFrame(tick);
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
      previousSampleRef.current = null;
      if (useVideoFrames) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [analyze, stream]);

  /**
   * Puerta de entrada comun de los dos inputs de archivo (camara del
   * sistema y fotos ya guardadas). Cada foto se publica de inmediato y en
   * el orden de la seleccion, sin ningun `await` por delante: el
   * enderezado por EXIF corre despues, en el padre, sobre una captura que
   * para entonces ya existe y consta como pendiente. Hacerlo aqui antes
   * de publicar dejaba un hueco en el que el gate de generacion no veia
   * la foto en curso.
   *
   * Devuelve cuantas fotos se han publicado: la rafaga lo necesita para
   * no reabrir la camara cuando la seleccion no traia nada valido.
   */
  const addFromDevice = useCallback(
    (list: FileList | null) => {
      if (!list) return 0;
      let added = 0;
      for (const file of Array.from(list)) {
        if (!matchesAccept(file, TOOL.accept, TOOL.extensions)) continue;
        onImport(file);
        added += 1;
      }
      return added;
    },
    [onImport],
  );

  /**
   * Rafaga con la camara del sistema: una sola pulsacion abre la app de
   * Camara y, en cuanto vuelve una foto, se reabre sola para la
   * siguiente. Apaga la vista en vivo antes de empezar —dos camaras a la
   * vez no aportan nada y en iOS el stream queda suspendido de todas
   * formas— y solo se corta con "Terminar": el `change` del input no
   * distingue "he cancelado" de "sigo pensando", asi que ese boton se
   * queda fijo en pantalla mientras el modo esta activo.
   */
  const startBurst = useCallback(() => {
    stop();
    setBurst(true);
    setBurstCount(0);
    nativeInputRef.current?.click();
  }, [stop]);

  return (
    <div>
      {errorCode ? (
        <div
          role="alert"
          className="rounded-ios mb-4 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div>
            <p className="ui-label text-destructive-text">
              {s.cameraErrorTitle}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {s.cameraErrors[errorCode]}
            </p>
          </div>
        </div>
      ) : null}

      {burst ? (
        // Fijo y por encima de la cabecera (z-40): es la unica salida del
        // bucle, asi que tiene que estar a mano vuelva el usuario donde
        // vuelva y sin importar cuanto haya scrolleado.
        <div
          className="glass-bar fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-white/10 px-4 pb-3"
          style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
        >
          <div className="min-w-0">
            <p className="ui-label text-signal-text">{s.burstTitle}</p>
            <p aria-live="polite" className="mt-0.5 text-sm text-foreground">
              {s.burstCount.replace("{count}", String(burstCount))}
            </p>
          </div>
          <Button size="md" className="ml-auto" onClick={() => setBurst(false)}>
            <Check aria-hidden="true" className="size-4" />
            {s.burstDone}
          </Button>
        </div>
      ) : null}

      {stream ? (
        <div className="glass rounded-ios-lg relative overflow-hidden p-3">
          <div className="relative overflow-hidden rounded-[16px] bg-black">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label={s.liveTitle}
              className="block max-h-[60vh] w-full object-contain"
              style={{ filter: previewFilter(filter) }}
            />

            <DocumentOverlay videoRef={videoRef} active={Boolean(stream)} />

            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
              <span
                aria-live="polite"
                className={cn(
                  "on-media rounded-full border px-3 py-1.5 text-caption font-semibold backdrop-blur-md",
                  HINT_TONE[hint],
                )}
              >
                {countdown === null
                  ? s.captureHints[hint]
                  : s.autoCountdown.replace("{seconds}", String(countdown))}
              </span>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <Button variant="ghost" size="sm" onClick={stop}>
              <CameraOff aria-hidden="true" className="size-3.5" />
              {s.stopCamera}
            </Button>
            <Button size="md" disabled={capturing} onClick={() => void capture()}>
              {capturing ? (
                <Spinner className="size-4" />
              ) : (
                <Camera aria-hidden="true" className="size-4" />
              )}
              {s.capture}
            </Button>
          </div>

          <div className="mt-3 border-t border-white/10 pt-3">
            <Checkbox
              label={s.autoCaptureLabel}
              hint={s.autoCaptureHint}
              checked={autoCapture}
              onChange={(checked) => {
                setAutoCaptureChoice(checked);
                resetAutoCapture();
              }}
            />
          </div>
        </div>
      ) : (
        <div className="glass rounded-ios-lg flex flex-col items-center px-6 py-12 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-signal/15">
            <Camera aria-hidden="true" className="size-6 text-signal" />
          </span>

          <h2 className="mt-5 text-lg font-bold text-foreground md:text-xl">
            {s.startTitle}
          </h2>
          <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {s.startBody}
          </p>

          <Button
            size="lg"
            className="mt-6"
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? <Spinner className="size-4" /> : null}
            {starting
              ? s.starting
              : errorCode
                ? s.retryCamera
                : s.startButton}
          </Button>

          <p className="mt-6 max-w-sm text-xs leading-relaxed text-muted-foreground">
            {s.nativeCameraHint}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={startBurst}
          >
            <Smartphone aria-hidden="true" className="size-3.5" />
            {s.nativeCamera}
          </Button>

          <p className="mt-6 max-w-sm text-xs leading-relaxed text-muted-foreground">
            {s.uploadHint}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus aria-hidden="true" className="size-3.5" />
            {s.uploadInstead}
          </Button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={[...TOOL.accept, ...TOOL.extensions].join(",")}
        multiple
        className="sr-only"
        onChange={(event) => {
          addFromDevice(event.target.files);
          event.target.value = "";
        }}
      />

      {/*
        `capture="environment"` abre la app de Camara del sistema en movil,
        con flash y enfoque reales —lo unico que `getUserMedia` no deja
        controlar—. En escritorio el atributo se ignora y el dialogo se
        comporta como un selector de archivos normal.

        El `click()` de la rafaga sale del propio manejador del `change`,
        que Safari sigue tratando como gesto del usuario: sacarlo a un
        `setTimeout` haria que iOS bloquease la reapertura.
      */}
      <input
        ref={nativeInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          const input = event.target;
          const added = addFromDevice(input.files);
          input.value = "";
          if (!burst || added === 0) return;
          setBurstCount((current) => current + added);
          input.click();
        }}
      />
    </div>
  );
}
