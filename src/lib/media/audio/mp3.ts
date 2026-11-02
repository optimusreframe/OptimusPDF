import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import { AudioSample, AudioSampleSource, BufferTarget, Mp3OutputFormat, Output } from "mediabunny";
import { AudioError, throwIfAborted, toAudioError } from "@/lib/media/audio/errors";
import { MAX_MP3_BYTES } from "@/lib/media/audio/limits";
import { clampMp3BitrateKbps } from "@/lib/media/audio/mp3Params";
import type { PcmSource, Progress } from "@/lib/media/audio/types";

/**
 * Codificacion a MP3 con LAME 3.100 en WebAssembly (`@mediabunny/mp3-encoder`, MPL-2.0; LAME es LGPL: ver `/licenses`).
 *
 * Es el UNICO archivo de audio que importa `mediabunny` y el codificador, y `encode.ts` solo lo carga con `import()` cuando
 * se elige MP3: el WASM (~130 kB comprimido) no entra en el codigo de las demas rutas ni en el de las demas salidas. El
 * codificador crea su propio Worker desde un blob (la CSP ya permite `worker-src blob:` y `wasm-unsafe-eval`), asi que la
 * pestana no se bloquea; aqui solo se trocea el audio, se espera a cada trozo (contrapresion), se informa del progreso y se
 * cancela. `mediabunny` arma el .mp3 (tramas + cabecera Xing/Info con el retraso del codificador) en memoria.
 *
 * Sin etiquetas: no se llama a `setMetadataTags`, asi que el archivo NO lleva ID3 (ni titulo, ni artista, ni nada del
 * original). Solo lleva la trama inicial Xing/Info de `mediabunny` (numero de tramas, indice de busqueda y retraso del
 * codificador, con la cadena «LAME» sin version).
 */

/** Medio segundo de audio por viaje al Worker: reparte el progreso y deja respirar al hilo principal. */
const BLOCK_SECONDS = 0.5;
/** El primer trozo incluye crear el Worker y compilar el WASM; si en este tiempo no ha vuelto nada, algo lo bloquea. */
const START_TIMEOUT_MS = 45_000;

/** Espera `work`, pero lo abandona si se cancela o (con `timeoutMs`) tarda demasiado. */
function guard<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(() => reject(new AudioError("cancelled")));
    const finish = (settle: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => finish(() => reject(new AudioError("encoderUnavailable", "mp3-timeout"))), timeoutMs);
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Codifica `source` (ya en 1 o 2 canales y a una frecuencia valida de MP3) a un Blob `audio/mpeg` a tasa constante.
 * Lanza `AudioError`: `cancelled`, `tooLarge` o `encoderUnavailable` (no se pudo crear el Worker, compilar el WASM o
 * llegar a codificar el primer trozo).
 */
export async function encodeMp3(source: PcmSource, bitrateKbps: number, signal?: AbortSignal, onProgress?: Progress): Promise<Blob> {
  const channels = source.numberOfChannels;
  if (channels !== 1 && channels !== 2) throw new AudioError("encoderUnavailable", "mp3-channels");
  const kbps = clampMp3BitrateKbps(bitrateKbps, source.sampleRate);
  if (((source.length / source.sampleRate) * kbps * 1000) / 8 > MAX_MP3_BYTES) throw new AudioError("tooLarge");
  throwIfAborted(signal);

  // Siempre el LAME empaquetado (los encoders propios ganan a los del navegador): misma salida en todos los navegadores.
  registerMp3Encoder();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const audio = new AudioSampleSource({ codec: "mp3", bitrate: kbps * 1000 });
  output.addAudioTrack(audio);

  let started = false;
  try {
    await guard(output.start(), signal, START_TIMEOUT_MS);
    const block = Math.max(1152, Math.round(source.sampleRate * BLOCK_SECONDS));
    for (let start = 0; start < source.length; start += block) {
      throwIfAborted(signal);
      const end = Math.min(source.length, start + block);
      const frames = end - start;
      const packed = new Float32Array(frames * channels);
      source.read(start, end).forEach((plane, index) => packed.set(plane, index * frames));
      const sample = new AudioSample({ data: packed, format: "f32-planar", numberOfChannels: channels, sampleRate: source.sampleRate, timestamp: start / source.sampleRate });
      try {
        // `add` espera a que el Worker pueda recibir mas, pero NO cierra la muestra (mediabunny avisa en consola si se olvida).
        await guard(audio.add(sample), signal, started ? undefined : START_TIMEOUT_MS);
      } finally {
        sample.close();
      }
      started = true;
      onProgress?.((end / source.length) * 0.95);
    }
    audio.close();
    await guard(output.finalize(), signal);
    if (!target.buffer) throw new AudioError("unknown", "mp3-no-buffer");
    onProgress?.(1);
    return new Blob([target.buffer], { type: "audio/mpeg" });
  } catch (error) {
    // Suelta el Worker y la memoria del WASM aunque el fallo venga del propio codificador.
    await output.cancel().catch(() => undefined);
    const known = toAudioError(error);
    // Antes del primer trozo casi todo lo que falla es el arranque (Worker o WASM bloqueados): se dice asi, no «algo ha fallado».
    if (!started && known.code === "unknown") throw new AudioError("encoderUnavailable", "mp3-init");
    throw known;
  }
}
