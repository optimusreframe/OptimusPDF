/**
 * Troceado por CONTENIDO de los snapshots grandes de PDF Pro (Wave 9 · memoria y escritura).
 *
 * Un PDF de 100 MB tras «Rotar todo» es, byte a byte, casi el mismo PDF: pdf-lib copia los flujos tal cual y solo
 * cambian unos objetos pequeños que quedan ENTRE los flujos grandes. Guardar el snapshot entero a disco en cada paso
 * (borrador + historial) escribia ~200 MB por operacion. Aqui se parte cada snapshot en trozos de ~48 KB cuyos limites
 * dependen del CONTENIDO (no de la posicion): si un objeto cambia de tamaño y desplaza todo lo que viene detras, los
 * trozos de detras siguen cortandose en los mismos sitios y por tanto tienen el mismo hash. Los almacenes
 * (`proDrafts`, `proHistoryStore`) escriben solo los trozos que no tienen ya.
 *
 *  - Limites: hash de «engranaje» (gear) de 32 bits; se corta cuando sus 15 bajos son cero, tras saltar `MIN_SKIP` bytes
 *    (acelera el bucle ~2x y evita trozos diminutos) y como tarde a los `MAX_CHUNK`. Determinista: mismos bytes, mismos
 *    trozos.
 *  - Identidad de un trozo: SHA-256 (hex) de sus bytes. Un trozo con el mismo hash ES el mismo contenido.
 *  - Sin bloquear: el bucle cede el hilo cada ~8 ms (una tajada nunca pasa de unos 10 ms) y el SHA-256 lo hace el
 *    navegador fuera del hilo principal.
 *  - El resultado (`ChunkPlan`: hashes y longitudes, ~100 KB por cada 100 MB) se recuerda por objeto `Uint8Array`
 *    (`WeakMap`): el borrador y el historial piden el plan del mismo snapshot y solo se calcula una vez.
 */

/** Por debajo de este tamaño un snapshot se guarda entero (sin trocear): no compensa y los PDF pequeños no cambian. */
export const CHUNK_MIN_TOTAL_BYTES = 4 * 1024 * 1024;
const CHUNK_MASK = (1 << 15) - 1;
const MIN_SKIP = 16 * 1024;
export const MAX_CHUNK = 128 * 1024;
/** Tiempo maximo seguido en el hilo principal antes de ceder (ms). */
const SLICE_BUDGET_MS = 8;

export type ChunkPlan = {
  byteLength: number;
  /** SHA-256 (hex, 64 caracteres) de cada trozo, en orden. */
  hashes: readonly string[];
  /** Longitud en bytes de cada trozo. La suma es `byteLength`. */
  sizes: readonly number[];
};

/** Tabla del hash de engranaje: 256 palabras pseudoaleatorias FIJAS (el troceado debe ser identico entre sesiones). */
const GEAR = (() => {
  const table = new Int32Array(256);
  let seed = 0x9e3779b9 | 0;
  for (let i = 0; i < 256; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    // Mezcla extra: el generador congruencial tiene poca entropia en los bits bajos, que son los que se comprueban.
    let mixed = seed ^ (seed >>> 15);
    mixed = Math.imul(mixed, 0x2c1b3c6d);
    mixed ^= mixed >>> 12;
    table[i] = mixed | 0;
  }
  return table;
})();

/** Bytes de «calentamiento» del hash antes del primer punto de corte posible: los 15 bajos solo dependen de los 15 ultimos. */
const WARM_UP = 16;

/**
 * Longitud del trozo que empieza en `start`: hasta el primer corte por contenido (o el tope). El hash se calienta con
 * los `WARM_UP` bytes anteriores al primer corte posible, asi la decision en cada posicion depende SOLO de los bytes
 * que la rodean (no de donde empezo el trozo): es lo que permite que dos versiones del mismo PDF vuelvan a cortar en
 * los mismos sitios tras un cambio.
 */
export function nextChunkLength(bytes: Uint8Array, start: number): number {
  const end = bytes.byteLength;
  const hardEnd = Math.min(end, start + MAX_CHUNK);
  const firstCut = start + MIN_SKIP;
  if (hardEnd <= firstCut) return hardEnd - start;
  let hash = 0;
  for (let i = firstCut - WARM_UP; i < firstCut; i += 1) hash = ((hash << 1) + GEAR[bytes[i]]) | 0;
  for (let i = firstCut; i < hardEnd; i += 1) {
    hash = ((hash << 1) + GEAR[bytes[i]]) | 0;
    if ((hash & CHUNK_MASK) === 0) return i + 1 - start;
  }
  return hardEnd - start;
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < view.length; i += 1) out += HEX[view[i]];
  return out;
}

let channel: MessageChannel | null = null;
/** Quien espera su turno, en orden: cada mensaje del canal despierta a UNO (el mas antiguo). */
const waiting: Array<() => void> = [];

/**
 * Cede el hilo principal sin el retraso minimo de 4 ms que `setTimeout` acumula al encadenarse. Varios calculos pueden
 * ceder a la vez (el plan del snapshot nuevo y el del que sale de la ventana): el canal es UNO y cada mensaje despierta
 * a un solo esperador, en orden. (Una version con un `onmessage` por llamada dejaba colgado al primero cuando el segundo
 * lo sustituia: el plan no terminaba nunca y el volcado a disco esperaba su plazo entero.)
 */
function yieldToMain(): Promise<void> {
  try {
    if (typeof MessageChannel !== "undefined") {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => waiting.shift()?.();
        // En Node (pruebas, scripts) un puerto con oyente mantiene vivo el proceso: no debe.
        (channel.port1 as unknown as { unref?: () => void }).unref?.();
      }
      const { port2 } = channel;
      return new Promise((resolve) => {
        waiting.push(resolve);
        port2.postMessage(0);
      });
    }
  } catch {
    channel = null;
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Calcula los trozos y sus hashes. Sin SHA-256 disponible (`crypto.subtle`) rechaza: el llamador guarda entero. */
export async function computeChunkPlan(bytes: Uint8Array): Promise<ChunkPlan> {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (!subtle || typeof subtle.digest !== "function") throw new Error("sin SHA-256 (crypto.subtle)");
  const sizes: number[] = [];
  const hashes: string[] = [];
  let pendingDigests: Promise<string>[] = [];
  let pendingStarts = 0;
  const flushDigests = async () => {
    const batch = pendingDigests;
    pendingDigests = [];
    for (const hash of await Promise.all(batch)) hashes.push(hash);
    pendingStarts = 0;
  };
  let start = 0;
  let sliceStart = now();
  while (start < bytes.byteLength) {
    const length = nextChunkLength(bytes, start);
    sizes.push(length);
    const view = bytes.subarray(start, start + length);
    pendingDigests.push(subtle.digest("SHA-256", view as unknown as BufferSource).then(toHex));
    pendingStarts += 1;
    start += length;
    if (pendingStarts >= 64) await flushDigests();
    if (now() - sliceStart > SLICE_BUDGET_MS) {
      await yieldToMain();
      sliceStart = now();
    }
  }
  await flushDigests();
  return { byteLength: bytes.byteLength, hashes, sizes };
}

const plans = new WeakMap<Uint8Array, Promise<ChunkPlan>>();

/**
 * El plan de ESTOS bytes (inmutables): se calcula una vez por objeto aunque lo pidan a la vez el borrador y el
 * historial. Si el calculo falla, el siguiente intento lo repite.
 */
export function planChunks(bytes: Uint8Array): Promise<ChunkPlan> {
  const known = plans.get(bytes);
  if (known) return known;
  const promise = computeChunkPlan(bytes);
  plans.set(bytes, promise);
  promise.catch(() => {
    if (plans.get(bytes) === promise) plans.delete(bytes);
  });
  return promise;
}

/** Solo para pruebas: olvida el plan recordado de esos bytes. */
export function __forgetChunkPlanForTests(bytes: Uint8Array): void {
  plans.delete(bytes);
}

/** `true` si un snapshot de ese tamaño se guarda troceado. */
export function shouldChunk(byteLength: number, minBytes: number = CHUNK_MIN_TOTAL_BYTES): boolean {
  return byteLength >= minBytes;
}
