import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_MIN_TOTAL_BYTES,
  MAX_CHUNK,
  __forgetChunkPlanForTests,
  computeChunkPlan,
  nextChunkLength,
  planChunks,
  shouldChunk,
} from "@/app/pdf-pro/proChunks";

/** Troceado por contenido (Wave 9): determinista, con tamaños acotados y que RESINCRONIZA tras un cambio. */

const MB = 1024 * 1024;

/** Bytes pseudoaleatorios deterministas (xorshift32): las pruebas no pueden depender de `Math.random`. */
function noise(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 255;
  }
  return out;
}

/** Bytes de `plan` que NO estaban en `before` (por hash). */
function freshBytes(before: { hashes: readonly string[] }, after: { hashes: readonly string[]; sizes: readonly number[] }): number {
  const have = new Set(before.hashes);
  const counted = new Set<string>();
  let total = 0;
  after.hashes.forEach((hash, index) => {
    if (have.has(hash) || counted.has(hash)) return;
    counted.add(hash);
    total += after.sizes[index];
  });
  return total;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proChunks · plan de trozos", () => {
  it("mismos bytes, mismo plan; las longitudes suman el total y respetan el maximo", async () => {
    const bytes = noise(3 * MB, 7);
    const a = await computeChunkPlan(bytes);
    const b = await computeChunkPlan(bytes.slice());
    expect(b.hashes).toEqual(a.hashes);
    expect(b.sizes).toEqual(a.sizes);
    expect(a.byteLength).toBe(bytes.byteLength);
    expect(a.sizes.reduce((sum, size) => sum + size, 0)).toBe(bytes.byteLength);
    expect(a.hashes).toHaveLength(a.sizes.length);
    for (const size of a.sizes) expect(size).toBeLessThanOrEqual(MAX_CHUNK);
    // Todos menos el ultimo superan el salto minimo: no hay migas.
    for (const size of a.sizes.slice(0, -1)) expect(size).toBeGreaterThan(16 * 1024);
    // Los hashes son SHA-256 hex.
    for (const hash of a.hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el hash de un trozo es el SHA-256 real de sus bytes", async () => {
    const bytes = noise(600 * 1024, 3);
    const plan = await computeChunkPlan(bytes);
    let offset = 0;
    for (let index = 0; index < plan.sizes.length; index += 1) {
      const slice = bytes.subarray(offset, offset + plan.sizes[index]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", slice as unknown as BufferSource));
      expect(plan.hashes[index]).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
      offset += plan.sizes[index];
    }
  });

  it("cambiar UN byte altera solo uno o dos trozos", async () => {
    const bytes = noise(4 * MB, 11);
    const before = await computeChunkPlan(bytes);
    const changed = bytes.slice();
    changed[2 * MB + 123] ^= 0xff;
    const after = await computeChunkPlan(changed);
    expect(after.hashes).toHaveLength(before.hashes.length);
    const differing = after.hashes.filter((hash, index) => hash !== before.hashes[index]).length;
    expect(differing).toBeGreaterThanOrEqual(1);
    expect(differing).toBeLessThanOrEqual(2);
    expect(freshBytes(before, after)).toBeLessThanOrEqual(2 * MAX_CHUNK);
  });

  it("insertar bytes AL PRINCIPIO (todo lo demas se desplaza) sigue compartiendo casi todo: los cortes vuelven a coincidir", async () => {
    const bytes = noise(4 * MB, 21);
    const before = await computeChunkPlan(bytes);
    const shifted = new Uint8Array(bytes.byteLength + 37);
    shifted.set(noise(37, 99), 0);
    shifted.set(bytes, 37);
    const after = await computeChunkPlan(shifted);
    const fresh = freshBytes(before, after);
    // Solo se pierden los primeros trozos hasta resincronizar: mucho menos del 5 %.
    expect(fresh / shifted.byteLength).toBeLessThan(0.05);
  });

  it("insertar en MEDIO y borrar un tramo tambien comparten el resto", async () => {
    const bytes = noise(4 * MB, 31);
    const before = await computeChunkPlan(bytes);
    const mid = 2 * MB;
    const edited = new Uint8Array(bytes.byteLength - 1000 + 500);
    edited.set(bytes.subarray(0, mid), 0);
    edited.set(noise(500, 5), mid);
    edited.set(bytes.subarray(mid + 1000), mid + 500);
    const after = await computeChunkPlan(edited);
    expect(freshBytes(before, after) / edited.byteLength).toBeLessThan(0.05);
  });

  it("bytes distintos dan hashes distintos (no hay trozos compartidos por azar)", async () => {
    const a = await computeChunkPlan(noise(2 * MB, 1));
    const b = await computeChunkPlan(noise(2 * MB, 2));
    const shared = a.hashes.filter((hash) => b.hashes.includes(hash));
    expect(shared).toHaveLength(0);
  });

  it("vacio y diminuto: sin trozos o con uno solo", async () => {
    const empty = await computeChunkPlan(new Uint8Array(0));
    expect(empty).toEqual({ byteLength: 0, hashes: [], sizes: [] });
    const tiny = await computeChunkPlan(noise(100, 4));
    expect(tiny.sizes).toEqual([100]);
    expect(tiny.hashes).toHaveLength(1);
  });

  it("datos degenerados (todo ceros): se parten en trozos del maximo, iguales entre si, y suman el total", async () => {
    const zeros = new Uint8Array(1 * MB + 5);
    const plan = await computeChunkPlan(zeros);
    expect(plan.sizes.reduce((sum, size) => sum + size, 0)).toBe(zeros.byteLength);
    expect(plan.sizes[0]).toBe(MAX_CHUNK);
    expect(new Set(plan.hashes.slice(0, -1)).size).toBe(1);
  });

  it("nextChunkLength nunca devuelve 0 mientras queden bytes y nunca se pasa del final", () => {
    const bytes = noise(300 * 1024, 8);
    let start = 0;
    while (start < bytes.byteLength) {
      const length = nextChunkLength(bytes, start);
      expect(length).toBeGreaterThan(0);
      expect(start + length).toBeLessThanOrEqual(bytes.byteLength);
      start += length;
    }
    expect(start).toBe(bytes.byteLength);
  });

  it("varios calculos a la vez terminan todos (ceder el hilo no deja a ninguno colgado)", async () => {
    // Cada paso gasta mas que la tajada (8 ms): TODOS ceden el hilo en cada trozo y se solapan.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 10));
    const inputs = [1, 2, 3, 4, 5, 6].map((seed) => noise(3 * MB, seed));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("un calculo se quedo colgado")), 8000));
    const plans = await Promise.race([Promise.all(inputs.map((bytes) => computeChunkPlan(bytes))), timeout]);
    expect(plans).toHaveLength(6);
    for (const plan of plans) expect(plan.sizes.reduce((sum, size) => sum + size, 0)).toBe(3 * MB);
    // Y cada uno es el plan de SUS bytes (no se mezclan entre calculos concurrentes).
    const alone = await computeChunkPlan(inputs[3]);
    expect(plans[3].hashes).toEqual(alone.hashes);
  });

  it("planChunks recuerda el plan POR OBJETO (borrador e historial lo piden y solo se calcula una vez)", async () => {
    const bytes = noise(1 * MB, 5);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const first = planChunks(bytes);
    const second = planChunks(bytes);
    expect(second).toBe(first);
    const plan = await first;
    const calls = digest.mock.calls.length;
    expect(calls).toBe(plan.hashes.length);
    await planChunks(bytes);
    expect(digest.mock.calls.length).toBe(calls);
    // Otro objeto con el mismo contenido SI se vuelve a calcular (el recuerdo es por identidad, no por contenido).
    await planChunks(bytes.slice());
    expect(digest.mock.calls.length).toBeGreaterThan(calls);
  });

  it("un calculo que falla no se queda recordado: el siguiente intento lo repite", async () => {
    const bytes = noise(300 * 1024, 6);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("fallo del navegador"));
    await expect(planChunks(bytes)).rejects.toThrow("fallo del navegador");
    digest.mockImplementation(original);
    const plan = await planChunks(bytes);
    expect(plan.byteLength).toBe(bytes.byteLength);
    __forgetChunkPlanForTests(bytes);
  });

  it("sin crypto.subtle rechaza con un error claro (los almacenes guardan entero)", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await expect(computeChunkPlan(noise(100, 1))).rejects.toThrow(/SHA-256/);
  });

  it("shouldChunk: solo desde el umbral", () => {
    expect(shouldChunk(CHUNK_MIN_TOTAL_BYTES - 1)).toBe(false);
    expect(shouldChunk(CHUNK_MIN_TOTAL_BYTES)).toBe(true);
    expect(shouldChunk(10, 5)).toBe(true);
    expect(shouldChunk(4, 5)).toBe(false);
  });
});
