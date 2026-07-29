"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { QUAD_KEYS, type QuadCorners } from "@/lib/scan/perspective";

export type DocumentOverlayProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Solo se analiza mientras la camara esta encendida y visible. */
  active: boolean;
};

/** Lado maximo del lienzo de analisis: mas resolucion no mejora el contorno. */
const ANALYSIS_SIDE = 480;
/** Pausa entre pasadas. Buscar esquinas cuesta mucho mas que medir nitidez. */
const INTERVAL_MS = 700;

/**
 * Dibuja en vivo el cuadrilatero que el detector encuentra sobre el
 * video, para que el usuario sepa si el documento esta bien encuadrado
 * antes de disparar.
 *
 * Corre en su propio bucle lento, aparte del analisis de nitidez y brillo
 * de `CameraStage`: la deteccion de contornos es un orden de magnitud mas
 * cara y no necesita ir a la velocidad del video. Si una pasada tarda mas
 * de la cuenta, la siguiente simplemente empieza mas tarde -- nunca se
 * encolan dos.
 */
export function DocumentOverlay({ videoRef, active }: DocumentOverlayProps) {
  const [quad, setQuad] = useState<QuadCorners | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const step = async () => {
      const video = videoRef.current;
      const width = video?.videoWidth ?? 0;
      const height = video?.videoHeight ?? 0;

      if (video && width && height && !document.hidden) {
        setSize((previous) =>
          previous?.width === width && previous?.height === height
            ? previous
            : { width, height },
        );

        const scale = Math.min(1, ANALYSIS_SIDE / Math.max(width, height));
        const canvas = (canvasRef.current ??= document.createElement("canvas"));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });

        if (context) {
          try {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const detected = await detectDocumentCorners(canvas);
            if (!stopped) setQuad(detected?.corners ?? null);
          } catch {
            if (!stopped) setQuad(null);
          }
        }
      }

      if (!stopped) timer = setTimeout(() => void step(), INTERVAL_MS);
    };

    void step();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      canvasRef.current = null;
      // Al apagar la camara se borra el ultimo contorno, para que no
      // reaparezca congelado si se vuelve a encender.
      setQuad(null);
    };
  }, [active, videoRef]);

  if (!active || !quad || !size) return null;

  // `viewBox` en pixeles del video + `xMidYMid meet` reproduce exactamente
  // el `object-contain` del <video>, asi que el trazo cae sobre la imagen
  // aunque el visor tenga bandas negras a los lados.
  const points = QUAD_KEYS.map(
    (key) => `${quad[key].x * size.width},${quad[key].y * size.height}`,
  ).join(" ");

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-0 size-full"
    >
      <polygon
        points={points}
        fill="var(--color-signal)"
        fillOpacity="0.14"
        stroke="var(--color-signal)"
        strokeWidth={Math.max(2, size.width / 220)}
        strokeLinejoin="round"
      />
    </svg>
  );
}
