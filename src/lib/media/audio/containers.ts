/**
 * Tipos compartidos por los lectores de contenedores (MP4/MOV y WebM/Matroska) y por la decodificacion.
 */

/** Una pista de audio encontrada en un contenedor de video/audio. */
export type AudioTrackInfo = {
  container: "mp4" | "webm";
  trackId: number;
  /** Nombre del codec tal cual lo da el contenedor (`mp4a`, `Opus`, `A_VORBIS`...), solo para diagnostico. */
  rawCodec: string;
  /** Cadena de codec de WebCodecs (`mp4a.40.2`, `opus`, `vorbis`, `mp3`, `flac`) o `null` si no sabemos decodificarlo. */
  codec: string | null;
  sampleRate: number;
  channels: number;
  /** Configuracion extra que pide `AudioDecoder.configure` (ASC de AAC, OpusHead, cabeceras Vorbis, STREAMINFO FLAC). */
  description?: Uint8Array;
  durationSec?: number;
};

/** Estructura leida de un archivo: cuantas pistas de video y que pistas de audio trae. */
export type MediaStructure = {
  container: "mp4" | "webm";
  videoTracks: number;
  audioTracks: AudioTrackInfo[];
  durationSec?: number;
  /** MP4 fragmentado (`moof`): se ve la estructura pero este lector no extrae sus paquetes. */
  fragmented?: boolean;
};

/** Paquete codificado de una pista, listo para `AudioDecoder`. */
export type EncodedPacket = {
  data: Uint8Array;
  timestampUs: number;
  durationUs?: number;
};
