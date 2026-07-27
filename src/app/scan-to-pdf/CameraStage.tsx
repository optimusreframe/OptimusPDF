"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CameraOff, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
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
import { getTool } from "@/lib/tools-registry";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { previewFilter } from "@/app/scan-to-pdf/preview";

const TOOL = getTool("scan-to-pdf");

export type CameraStageProps = {
  filter: ScanFilter;
  /** Se llama con cada captura o foto anadida desde el dispositivo. */
  onCapture: (blob: Blob) => void;
};

/**
 * Captura con la camara del dispositivo. Pide `facingMode: environment`
 * en modo `ideal`, asi que en un portatil sin camara trasera se abre la
 * webcam frontal en lugar de fallar. Si la camara no esta disponible se
 * ofrece anadir fotos ya guardadas, sin fingir que el escaneo funciona.
 */
export function CameraStage({ filter, onCapture }: CameraStageProps) {
  const { language } = useI18n();
  const s = STRINGS[language];

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [starting, setStarting] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [errorCode, setErrorCode] = useState<CameraErrorCode | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

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

  const stop = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, []);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setCapturing(true);
    try {
      onCapture(await captureFrame(video));
    } catch (error) {
      setErrorCode(error instanceof CameraError ? error.code : "unknown");
    } finally {
      setCapturing(false);
    }
  }, [onCapture]);

  const addFromDevice = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      for (const file of Array.from(list)) {
        if (matchesAccept(file, TOOL.accept, TOOL.extensions)) onCapture(file);
      }
    },
    [onCapture],
  );

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
            <p className="hud-label text-[10px] text-destructive">
              {s.cameraErrorTitle}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {s.cameraErrors[errorCode]}
            </p>
          </div>
        </div>
      ) : null}

      {stream ? (
        <div className="glass rounded-ios-lg overflow-hidden p-3">
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
    </div>
  );
}
