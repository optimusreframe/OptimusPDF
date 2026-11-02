import type { PcmAudio, PcmSource } from "@/lib/media/audio/types";
import { frameCount } from "@/lib/media/audio/types";

/**
 * Operaciones puras sobre muestras (sin Web Audio: corren igual en el navegador y en las pruebas de Node).
 */

/**
 * Cede el hilo al navegador: los bucles largos lo llaman cada ~16 ms para que la pagina siga viva. Usa un canal de
 * mensajes y no `requestAnimationFrame`: en una pestana en segundo plano el rAF se pausa y el proceso se quedaria quieto.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "function") {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Origen peresoso de un audio en memoria. */
export function sourceOfAudio(audio: PcmAudio): PcmSource {
  const length = frameCount(audio);
  return {
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.channels.length,
    length,
    read(start, end) {
      const from = Math.max(0, Math.min(length, Math.floor(start)));
      const to = Math.max(from, Math.min(length, Math.floor(end)));
      return audio.channels.map((channel) => channel.slice(from, to));
    },
  };
}

/** Materializa un origen entero (solo para audios pequenos o pruebas; el codificador lee por bloques). */
export function readAll(source: PcmSource): PcmAudio {
  return { sampleRate: source.sampleRate, channels: source.read(0, source.length) };
}

/**
 * Cambia el numero de canales. Mono -> N copia el canal; N -> mono promedia; multicanal -> estereo reparte los canales
 * pares en el izquierdo y los impares en el derecho (promediados). Un cambio entre numeros iguales no toca nada.
 */
export function remixBlock(block: Float32Array[], targetChannels: number): Float32Array[] {
  const sourceChannels = block.length;
  if (sourceChannels === targetChannels) return block;
  const frames = block[0]?.length ?? 0;
  if (targetChannels === 1) {
    const mono = new Float32Array(frames);
    for (const channel of block) for (let i = 0; i < frames; i += 1) mono[i] += channel[i];
    if (sourceChannels > 1) for (let i = 0; i < frames; i += 1) mono[i] /= sourceChannels;
    return [mono];
  }
  if (sourceChannels === 1) return Array.from({ length: targetChannels }, () => block[0].slice());
  if (targetChannels === 2) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    let leftCount = 0;
    let rightCount = 0;
    block.forEach((channel, index) => {
      const target = index % 2 === 0 ? left : right;
      if (index % 2 === 0) leftCount += 1;
      else rightCount += 1;
      for (let i = 0; i < frames; i += 1) target[i] += channel[i];
    });
    for (let i = 0; i < frames; i += 1) {
      left[i] /= leftCount || 1;
      right[i] /= rightCount || 1;
    }
    return [left, right];
  }
  // Otros casos (p. ej. estereo -> 6 canales): se repite el ultimo canal disponible.
  return Array.from({ length: targetChannels }, (_, index) => block[Math.min(index, sourceChannels - 1)].slice());
}

export function remixSource(source: PcmSource, targetChannels: number): PcmSource {
  if (source.numberOfChannels === targetChannels) return source;
  return {
    sampleRate: source.sampleRate,
    numberOfChannels: targetChannels,
    length: source.length,
    read: (start, end) => remixBlock(source.read(start, end), targetChannels),
  };
}

/** Mayor valor absoluto del origen (recorrido por bloques). */
export function peakOfSource(source: PcmSource, signal?: AbortSignal): number {
  let peak = 0;
  const block = 1 << 16;
  for (let start = 0; start < source.length; start += block) {
    if (signal?.aborted) break;
    for (const channel of source.read(start, Math.min(source.length, start + block))) {
      for (let i = 0; i < channel.length; i += 1) {
        const value = Math.abs(channel[i]);
        if (value > peak) peak = value;
      }
    }
  }
  return peak;
}

/** Ganancia que lleva `peak` a `targetPeak` (por defecto -1 dBFS). 1 si el audio es silencio. */
export function normalizationGain(peak: number, targetPeak = 0.891): number {
  if (!(peak > 1e-6)) return 1;
  return targetPeak / peak;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/** Une audios de la misma frecuencia y canales. */
export function concatAudio(parts: PcmAudio[]): PcmAudio {
  if (parts.length === 0) return { sampleRate: 44100, channels: [new Float32Array(0)] };
  const first = parts[0];
  const total = parts.reduce((sum, part) => sum + frameCount(part), 0);
  const channels = first.channels.map(() => new Float32Array(total));
  let offset = 0;
  for (const part of parts) {
    part.channels.forEach((channel, index) => channels[index].set(channel, offset));
    offset += frameCount(part);
  }
  return { sampleRate: first.sampleRate, channels };
}
