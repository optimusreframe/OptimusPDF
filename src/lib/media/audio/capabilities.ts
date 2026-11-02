import type { OutputFormat } from "@/lib/media/audio/types";

/**
 * Que formatos de salida puede crear ESTE navegador.
 *
 * - WAV: codificador propio, siempre.
 * - M4A (AAC) y Opus: `AudioEncoder` de WebCodecs (Chrome/Edge, Safari reciente, Firefox reciente segun el codec); se
 *   pregunta al navegador con `isConfigSupported`, no se adivina por el nombre del navegador.
 * - MP3: NO se ofrece. Los navegadores no traen codificador de MP3 y los unicos codificadores en JavaScript/WASM son
 *   derivados de LAME (LGPL), cuya licencia no permite empaquetarlos tal cual en esta aplicacion. Se muestra desactivado
 *   y con el motivo, y se remite a M4A, que se reproduce en todo.
 */

export type UnavailableReason = "noWebCodecs" | "codecUnsupported" | "license";

export type FormatAvailability = { available: true } | { available: false; reason: UnavailableReason };

export type OutputSupport = Record<OutputFormat | "mp3", FormatAvailability>;

const PROBE_CONFIGS: Record<"m4a" | "opus", AudioEncoderConfig> = {
  m4a: { codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 },
  opus: { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 96_000 },
};

async function probe(format: "m4a" | "opus"): Promise<FormatAvailability> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return { available: false, reason: "noWebCodecs" };
  try {
    const support = await AudioEncoder.isConfigSupported(PROBE_CONFIGS[format]);
    return support.supported ? { available: true } : { available: false, reason: "codecUnsupported" };
  } catch {
    return { available: false, reason: "codecUnsupported" };
  }
}

let cached: Promise<OutputSupport> | null = null;

export function detectOutputSupport(): Promise<OutputSupport> {
  cached ??= (async () => {
    const [m4a, opus] = await Promise.all([probe("m4a"), probe("opus")]);
    return { wav: { available: true as const }, m4a, opus, mp3: { available: false as const, reason: "license" as const } };
  })();
  return cached;
}

/** Solo para pruebas: olvida el resultado guardado. */
export function resetOutputSupportCache(): void {
  cached = null;
}

/** Este navegador puede decodificar paquetes sueltos (`AudioDecoder`), necesario para leer videos que `decodeAudioData` no abre. */
export function canDecodePackets(): boolean {
  return typeof AudioDecoder !== "undefined" && typeof EncodedAudioChunk !== "undefined";
}
