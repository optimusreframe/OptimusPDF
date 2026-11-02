import type { OutputFormat } from "@/lib/media/audio/types";

/**
 * Que formatos de salida puede crear ESTE navegador.
 *
 * - WAV: codificador propio, siempre.
 * - M4A (AAC) y Opus: `AudioEncoder` de WebCodecs (Chrome/Edge, Safari reciente, Firefox reciente segun el codec); se
 *   pregunta al navegador con `isConfigSupported`, no se adivina por el nombre del navegador.
 * - MP3: ningun navegador trae codificador, asi que se usa LAME 3.100 compilado a WebAssembly (`@mediabunny/mp3-encoder`,
 *   `mp3.ts`), que corre en un Worker propio. Necesita WebAssembly CON instrucciones SIMD (Chrome 91, Firefox 89, Safari
 *   16.4) y Worker; se comprueba con `WebAssembly.validate` y por existencia de `Worker`, sin descargar nada. Que la
 *   directiva CSP deje crear el Worker o compilar el WASM no se puede saber de antemano: si falla al codificar, `mp3.ts`
 *   lo declara como `encoderUnavailable`.
 */

export type UnavailableReason = "noWebCodecs" | "codecUnsupported" | "noWasm" | "noWorker";

export type FormatAvailability = { available: true } | { available: false; reason: UnavailableReason };

export type OutputSupport = Record<OutputFormat, FormatAvailability>;

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

/** Modulo WebAssembly minimo que usa una instruccion SIMD (`v128`): valida solo si el motor la entiende (wasm-feature-detect). */
const WASM_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/** MP3 (LAME en WASM + Worker): sin descargar ni crear nada, solo preguntando al navegador que sabe hacer. */
export function probeMp3(): FormatAvailability {
  try {
    if (typeof WebAssembly === "undefined" || !WebAssembly.validate(WASM_SIMD_PROBE)) return { available: false, reason: "noWasm" };
  } catch {
    return { available: false, reason: "noWasm" };
  }
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return { available: false, reason: "noWorker" };
  }
  return { available: true };
}

let cached: Promise<OutputSupport> | null = null;

export function detectOutputSupport(): Promise<OutputSupport> {
  cached ??= (async () => {
    const [m4a, opus] = await Promise.all([probe("m4a"), probe("opus")]);
    return { wav: { available: true as const }, m4a, opus, mp3: probeMp3() };
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
