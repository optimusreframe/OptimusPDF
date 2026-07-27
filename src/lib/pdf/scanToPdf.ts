import { PdfError, savePdfToBlob, toPdfError } from "@/lib/pdf/core";
import type { ProgressCallback } from "@/lib/pdf/core";
import {
  buildPdfFromImages,
  canvasToBlob,
  type ImageLayout,
} from "@/lib/pdf/imagesToPdf";

/**
 * Motor "escanear con la camara -> PDF".
 *
 * Modulo puro (sin React): abre la camara con `getUserMedia`, congela
 * fotogramas en un canvas y compone el PDF reutilizando la maquinaria de
 * `imagesToPdf.ts`. Ni el video ni las capturas salen del dispositivo.
 */

/* ------------------------------------------------------------------ *
 * Camara
 * ------------------------------------------------------------------ */

export type CameraErrorCode =
  | "denied"
  | "notFound"
  | "busy"
  | "insecure"
  | "unsupported"
  | "unknown";

/** Error tipado de camara; la interfaz traduce `code`. */
export class CameraError extends Error {
  readonly code: CameraErrorCode;

  constructor(code: CameraErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CameraError";
    this.code = code;
  }
}

function mapCameraError(error: unknown): CameraError {
  if (error instanceof CameraError) return error;
  if (error instanceof Error) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return new CameraError("denied", error.message);
      case "NotFoundError":
      case "DevicesNotFoundError":
      case "OverconstrainedError":
        return new CameraError("notFound", error.message);
      case "NotReadableError":
      case "TrackStartError":
        return new CameraError("busy", error.message);
      default:
        return new CameraError("unknown", error.message);
    }
  }
  return new CameraError("unknown");
}

/**
 * Pide la camara trasera cuando existe (`ideal`, no `exact`, para que en
 * portatiles y monitores con webcam frontal siga funcionando).
 */
export async function startCameraStream(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    // Los navegadores solo exponen mediaDevices en contextos seguros.
    const insecure =
      typeof window !== "undefined" && window.isSecureContext === false;
    throw new CameraError(insecure ? "insecure" : "unsupported");
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (error) {
    throw mapCameraError(error);
  }
}

/** Apaga todas las pistas: sin esto el indicador de camara sigue encendido. */
export function stopCameraStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // La pista ya estaba cerrada.
    }
  }
}

export const CAPTURE_QUALITY = 0.92;

/** Congela el fotograma actual del video en un JPEG. */
export async function captureFrame(
  video: HTMLVideoElement,
  quality = CAPTURE_QUALITY,
): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new CameraError("busy", "Video stream not ready");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new CameraError("unsupported", "Canvas 2D unavailable");

  context.drawImage(video, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, "image/jpeg", quality);
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

/* ------------------------------------------------------------------ *
 * Filtro de escaneo
 * ------------------------------------------------------------------ */

export type ScanFilter = "color" | "bw";

/** Contraste aplicado en modo blanco y negro. */
const BW_CONTRAST = 1.35;
const BW_BRIGHTNESS = 8;

/**
 * Convierte una captura a blanco y negro de escaner: luminancia + curva
 * de contraste. Se hace pixel a pixel en vez de con `ctx.filter` para no
 * depender del soporte de filtros de cada navegador.
 */
export async function applyScanFilter(
  source: Blob,
  filter: ScanFilter,
): Promise<Blob> {
  if (filter === "color") return source;
  if (typeof createImageBitmap !== "function") return source;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    // Si el navegador no sabe decodificarla, se deja tal cual: el
    // embebedor de pdf-lib decidira si es valida.
    return source;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return source;
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const luminance =
      data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const adjusted = (luminance - 128) * BW_CONTRAST + 128 + BW_BRIGHTNESS;
    const value = adjusted < 0 ? 0 : adjusted > 255 ? 255 : adjusted;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
  context.putImageData(image, 0, 0);

  const output = await canvasToBlob(canvas, "image/jpeg", CAPTURE_QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  return output;
}

/* ------------------------------------------------------------------ *
 * Composicion del PDF
 * ------------------------------------------------------------------ */

export type ScanToPdfOptions = ImageLayout & {
  filter: ScanFilter;
};

export const DEFAULT_SCAN_OPTIONS: ScanToPdfOptions = {
  filter: "color",
  orientation: "auto",
  pageSize: "a4",
  margin: "none",
};

/** Compone el PDF con las capturas en el orden recibido. */
export async function scanToPdf(
  captures: Blob[],
  options: ScanToPdfOptions = DEFAULT_SCAN_OPTIONS,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (captures.length === 0) throw new PdfError("empty");

  try {
    const processed: Blob[] = [];
    for (let index = 0; index < captures.length; index += 1) {
      processed.push(await applyScanFilter(captures[index], options.filter));
      onProgress?.(((index + 1) / captures.length) * 0.4);
    }

    const document = await buildPdfFromImages(
      processed,
      {
        orientation: options.orientation,
        pageSize: options.pageSize,
        margin: options.margin,
      },
      (value) => onProgress?.(0.4 + value * 0.5),
    );

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
