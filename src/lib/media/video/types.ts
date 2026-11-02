import type { OutputFormat } from "@/lib/media/video/formats";
import type { FpsOption } from "@/lib/media/video/fps";
import type { QualityProfile } from "@/lib/media/video/profiles";
import type { ResolutionOption } from "@/lib/media/video/resolution";

/** Lo que se sabe de un video tras leer su cabecera (sin decodificarlo entero). Es lo unico que cruza entre el worker y la pagina. */
export type VideoInfo = {
  /** Nombre del contenedor segun su contenido real (no la extension): «MP4», «WebM», «Matroska»... */
  container: string;
  /** Segundos. */
  duration: number;
  /** Medidas TAL Y COMO SE VE: ya con la rotacion de los moviles aplicada (un video vertical de iPhone: 1080 x 1920). */
  width: number;
  height: number;
  /** Grados que el original pide girar (0, 90, 180, 270). Solo informativo: la libreria los aplica. */
  rotation: number;
  /** Fotogramas por segundo medios; `null` si no se pudo medir. */
  fps: number | null;
  videoCodec: string | null;
  /** bits/s medios del video; `null` si no se conoce. */
  videoBitrate: number | null;
  /** El navegador puede decodificar el video (si no, no hay conversion posible). */
  canDecodeVideo: boolean;
  hdr: boolean;
  audio: null | {
    codec: string | null;
    channels: number;
    sampleRate: number;
    bitrate: number | null;
    canDecode: boolean;
  };
  /** Peso del original en bytes. */
  fileSize: number;
};

export type ConversionOptions = {
  format: OutputFormat;
  resolution: ResolutionOption;
  quality: QualityProfile;
  removeAudio: boolean;
  maxFps: FpsOption;
};

export const DEFAULT_CONVERSION_OPTIONS: ConversionOptions = {
  format: "mp4",
  resolution: "original",
  quality: "keep",
  removeAudio: false,
  maxFps: "original",
};
