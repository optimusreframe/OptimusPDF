import { loadJSZip } from "@/lib/pdf/lazyZip";
import { decodeMedia } from "@/lib/media/audio/decode";
import { AudioError, throwIfAborted, toAudioError, type AudioErrorCode } from "@/lib/media/audio/errors";
import { encodeAudio } from "@/lib/media/audio/encode";
import { MAX_BATCH_FILES, MAX_BATCH_OUTPUT_BYTES } from "@/lib/media/audio/limits";
import { outputName, uniqueZipName } from "@/lib/media/audio/names";
import { sourceOfAudio } from "@/lib/media/audio/pcm";
import { FORMAT_INFO, durationOf, type EncodeOptions, type Progress } from "@/lib/media/audio/types";

/**
 * Conversion de uno o varios archivos (Audio Converter) y extraccion de audio de un video (Extraer audio). Es la misma
 * maquinaria: decodificar -> codificar. Los archivos se procesan de uno en uno para que solo haya UN audio decodificado
 * en memoria a la vez; los fallos de un archivo no tiran el lote.
 */

export type ConvertedItem = {
  inputName: string;
  outputName: string;
  inputBytes: number;
  outputBytes: number;
  durationSec: number;
};

export type FailedItem = { inputName: string; code: AudioErrorCode };

export type ConvertOutcome = {
  /** El audio convertido, o un ZIP con todos si habia varios. */
  blob: Blob;
  filename: string;
  zipped: boolean;
  items: ConvertedItem[];
  failed: FailedItem[];
};

export type ConvertContext = {
  signal?: AbortSignal;
  onProgress?: Progress;
  /** Sufijo (`convertido`) para cuando salida y entrada comparten extension. */
  suffix: string;
  /** Nombre base si el archivo no trae uno usable. */
  fallbackName: string;
  /** Nombre del ZIP (sin extension) cuando hay varios archivos. */
  zipName: string;
};

/** Convierte UN archivo. Lanza `AudioError`. */
export async function convertOne(
  file: File,
  options: EncodeOptions,
  context: { signal?: AbortSignal; onProgress?: Progress; suffix: string; fallbackName: string },
): Promise<{ blob: Blob; item: ConvertedItem }> {
  const { signal, onProgress } = context;
  const decoded = await decodeMedia(file, { signal, onProgress: (value) => onProgress?.(value * 0.45) });
  throwIfAborted(signal);
  const blob = await encodeAudio(sourceOfAudio(decoded.audio), options, {
    signal,
    onProgress: (value) => onProgress?.(0.45 + value * 0.55),
  });
  return {
    blob,
    item: {
      inputName: file.name,
      outputName: outputName(file.name, options.format, context.suffix, context.fallbackName),
      inputBytes: file.size,
      outputBytes: blob.size,
      durationSec: durationOf(decoded.audio),
    },
  };
}

/** Convierte un lote. Si TODOS fallan lanza el error del primero; si solo algunos, se informa en `failed`. */
export async function convertBatch(files: File[], options: EncodeOptions, context: ConvertContext): Promise<ConvertOutcome> {
  const { signal, onProgress } = context;
  if (files.length === 0) throw new AudioError("empty");
  if (files.length > MAX_BATCH_FILES) throw new AudioError("tooLarge");

  const done: Array<{ blob: Blob; item: ConvertedItem }> = [];
  const failed: FailedItem[] = [];
  let firstError: AudioError | null = null;
  let outputBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    throwIfAborted(signal);
    const file = files[index];
    try {
      if (outputBytes > MAX_BATCH_OUTPUT_BYTES) throw new AudioError("tooLarge");
      const result = await convertOne(file, options, {
        signal,
        suffix: context.suffix,
        fallbackName: context.fallbackName,
        onProgress: (value) => onProgress?.((index + value) / files.length),
      });
      outputBytes += result.blob.size;
      done.push(result);
    } catch (error) {
      const known = toAudioError(error);
      if (known.code === "cancelled") throw known;
      firstError ??= known;
      failed.push({ inputName: file.name, code: known.code });
    }
  }

  if (done.length === 0) throw firstError ?? new AudioError("unknown");
  onProgress?.(1);

  if (done.length === 1) {
    return { blob: done[0].blob, filename: done[0].item.outputName, zipped: false, items: [done[0].item], failed };
  }

  // Varios: ZIP. Se guardan los bytes tal cual (el audio ya va comprimido; WAV es sencillo de abrir sin recomprimir).
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const used = new Set<string>();
  const items: ConvertedItem[] = [];
  for (const entry of done) {
    throwIfAborted(signal);
    const name = uniqueZipName(entry.item.outputName, used, { key: (value) => value.normalize("NFC").toLowerCase() });
    zip.file(name, new Uint8Array(await entry.blob.arrayBuffer()));
    items.push({ ...entry.item, outputName: name });
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return { blob, filename: `${context.zipName}.zip`, zipped: true, items, failed };
}

export { FORMAT_INFO };
