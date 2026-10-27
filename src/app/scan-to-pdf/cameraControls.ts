import { CameraError } from "@/lib/pdf/scanToPdf";

/*
 * Camara del Escaner: abrir el flujo (trasera o frontal) y leer / aplicar lo que la pista permita (linterna, zoom, enfoque por
 * toque). `MediaStreamTrack.getCapabilities()` no existe en todos los navegadores (Safari/iOS solo ofrece una parte): cada
 * funcion degrada con gracia (devuelve `false`/`null`) y la interfaz oculta el control que no se puede usar.
 */

export type Facing = "environment" | "user";

type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
};

type ExtendedConstraint = MediaTrackConstraintSet & { torch?: boolean; zoom?: number; focusMode?: string; pointsOfInterest?: Array<{ x: number; y: number }> };

export type CameraCaps = {
  torch: boolean;
  zoom: { min: number; max: number; step: number } | null;
  focus: boolean;
};

export const NO_CAPS: CameraCaps = { torch: false, zoom: null, focus: false };

function mapError(error: unknown): CameraError {
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

export async function openCamera(facing: Facing): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    const insecure = typeof window !== "undefined" && window.isSecureContext === false;
    throw new CameraError(insecure ? "insecure" : "unsupported");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } },
    });
  } catch (error) {
    throw mapError(error);
  }
}

export function videoTrackOf(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getVideoTracks()[0] ?? null;
}

export function readCaps(track: MediaStreamTrack | null): CameraCaps {
  if (!track || typeof track.getCapabilities !== "function") return NO_CAPS;
  try {
    const caps = track.getCapabilities() as ExtendedCapabilities;
    const zoom = caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step ?? 0.1 } : null;
    return {
      torch: caps.torch === true,
      zoom,
      focus: Array.isArray(caps.focusMode) && caps.focusMode.includes("single-shot"),
    };
  } catch {
    return NO_CAPS;
  }
}

async function apply(track: MediaStreamTrack, advanced: ExtendedConstraint): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [advanced] });
    return true;
  } catch {
    return false;
  }
}

export const setTorch = (track: MediaStreamTrack, on: boolean) => apply(track, { torch: on });
export const setZoom = (track: MediaStreamTrack, value: number) => apply(track, { zoom: value });

/** Enfoque de un disparo en un punto 0..1 del fotograma. */
export const focusAt = (track: MediaStreamTrack, x: number, y: number) =>
  apply(track, { focusMode: "single-shot", pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }] });

/** Pasos de zoom que se ofrecen al tocar el boton: 1x, 2x, 3x ... dentro del rango de la pista. */
export function zoomSteps(zoom: { min: number; max: number }): number[] {
  const steps = [zoom.min];
  for (const candidate of [2, 3, 5]) if (candidate > zoom.min && candidate <= zoom.max) steps.push(candidate);
  return steps;
}

export async function hasSeveralCameras(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}
