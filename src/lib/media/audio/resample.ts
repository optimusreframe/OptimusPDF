import type { PcmSource } from "@/lib/media/audio/types";

/**
 * Cambio de frecuencia de muestreo con filtro sinc ventaneado (Kaiser), por bloques y peresoso.
 *
 * - Subir la frecuencia interpola con un filtro de corte en la frecuencia original.
 * - Bajarla filtra antes (corte a la frecuencia nueva / 2) para que no aparezcan alias.
 * Los bordes se renormalizan con los pesos disponibles (sin saltos al inicio y al final). Es codigo propio: sin
 * dependencias.
 */

/** Semiancho del filtro en muestras de entrada (a cada lado del punto central). */
const HALF_WIDTH = 12;
/** Entradas de la tabla del nucleo por muestra de entrada (con interpolacion lineal entre ellas). */
const TABLE_RES = 256;
const KAISER_BETA = 7.5;

function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const quarter = (x * x) / 4;
  for (let k = 1; k < 40; k += 1) {
    term *= quarter / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const BESSEL_BETA = bessel0(KAISER_BETA);

/** Nucleo f(x) con x en unidades de muestras de entrada, normalizado para ganancia 1 en continua. */
function makeKernelTable(cutoff: number): Float32Array {
  const halfTaps = HALF_WIDTH / cutoff; // al bajar la frecuencia el filtro se ensancha
  const size = Math.ceil(halfTaps * TABLE_RES) + 2;
  const table = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const x = i / TABLE_RES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x * cutoff);
    const r = x / halfTaps;
    const window = r >= 1 ? 0 : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / BESSEL_BETA;
    table[i] = sinc * window * cutoff;
  }
  return table;
}

export function outputLength(inputLength: number, inputRate: number, outputRate: number): number {
  return Math.max(0, Math.round((inputLength * outputRate) / inputRate));
}

/** Origen con otra frecuencia. Si ya coincide devuelve el mismo origen. */
export function resampleSource(source: PcmSource, targetRate: number): PcmSource {
  if (source.sampleRate === targetRate) return source;
  const ratio = source.sampleRate / targetRate; // muestras de entrada por muestra de salida
  const cutoff = Math.min(1, 1 / ratio);
  const table = makeKernelTable(cutoff);
  const halfTaps = HALF_WIDTH / cutoff;
  const length = outputLength(source.length, source.sampleRate, targetRate);

  return {
    sampleRate: targetRate,
    numberOfChannels: source.numberOfChannels,
    length,
    read(start, end) {
      const from = Math.max(0, Math.min(length, Math.floor(start)));
      const to = Math.max(from, Math.min(length, Math.floor(end)));
      const count = to - from;
      const firstNeeded = Math.max(0, Math.floor(from * ratio - halfTaps) - 1);
      const lastNeeded = Math.min(source.length, Math.ceil(to * ratio + halfTaps) + 1);
      const input = source.read(firstNeeded, lastNeeded);
      const inputLength = lastNeeded - firstNeeded;
      return input.map((channel) => {
        const out = new Float32Array(count);
        for (let n = 0; n < count; n += 1) {
          const center = (from + n) * ratio; // posicion en muestras de entrada
          const lo = Math.max(firstNeeded, Math.ceil(center - halfTaps));
          const hi = Math.min(firstNeeded + inputLength - 1, Math.floor(center + halfTaps));
          let acc = 0;
          let weights = 0;
          for (let j = lo; j <= hi; j += 1) {
            const position = Math.abs(j - center) * TABLE_RES;
            const index = Math.floor(position);
            const frac = position - index;
            const weight = table[index] + (table[index + 1] - table[index]) * frac;
            acc += channel[j - firstNeeded] * weight;
            weights += weight;
          }
          out[n] = weights > 1e-9 ? acc / weights : 0;
        }
        return out;
      });
    },
  };
}
