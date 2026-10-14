import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProHistoryStore } from "@/app/pdf-pro/proHistoryStore";
import { __forgetChunkPlanForTests, peekChunkPlan, planChunks, rememberChunkPlan } from "@/app/pdf-pro/proChunks";
import { __setCopySliceForTests } from "@/app/pdf-pro/proChunkRows";

/**
 * Wave 10 · C-B3: leer de disco un snapshot troceado en frio (deshacer/rehacer/saltar con un PDF grande) cuesta una
 * peticion por trozo (~2100 con 100 MB). Dos pasos consecutivos comparten >90 % de los trozos, asi que la lectura copia de
 * la RAM los que ya tiene un snapshot residente (se identifican por HASH, nunca por posicion) y solo pide a IndexedDB
 * los distintos; el resto de peticiones va con una ventana deslizante. El resultado tiene que ser EXACTO en todos los casos.
 */

const MB = 1024 * 1024;

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

const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const stores: { dispose: () => Promise<void> }[] = [];
function make() {
  const store = createProHistoryStore({ openTimeoutMs: 2000 });
  if (!store) throw new Error("sin IndexedDB en el test");
  stores.push(store);
  return store;
}
afterEach(async () => {
  __setCopySliceForTests(null);
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.dispose();
});

/** Cuenta las filas de TROZOS que se piden a IndexedDB (y la concurrencia maxima de peticiones de lectura). */
function spyChunkReads() {
  const stats = { chunkGets: 0, inFlight: 0, maxInFlight: 0 };
  const original = IDBObjectStore.prototype.get;
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    const request = original.apply(this, args);
    if (typeof args[0] === "string" && args[0].startsWith("~c:")) {
      stats.chunkGets += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      const settle = () => {
        stats.inFlight -= 1;
      };
      request.addEventListener("success", settle);
      request.addEventListener("error", settle);
    }
    return request;
  });
  return stats;
}

/** Dos versiones del mismo «PDF»: la segunda cambia unos pocos bytes sueltos (cada uno toca un trozo). */
function pair(size = 6 * MB, flips = 4) {
  const first = noise(size, 11);
  const second = first.slice();
  for (let i = 1; i <= flips; i += 1) second[Math.floor((size * i) / (flips + 1))] ^= 0xff;
  return { first, second };
}

describe("lectura con origenes en RAM", () => {
  it("copia de la RAM los trozos compartidos y solo lee de disco los distintos; el resultado es EXACTO", async () => {
    const store = make();
    const { first, second } = pair();
    await store.put("a", first);
    await store.put("b", second);
    const plan = await planChunks(first); // el snapshot residente ya tiene su plan (lo calcula el documento al nacer)
    const stats = spyChunkReads();
    const back = await store.get("b", [first]);
    expect(back).not.toBeNull();
    expect(same(back!, second)).toBe(true);
    // 4 bytes distintos = a lo sumo 4 trozos; el resto (>95 %) no se pide a disco.
    expect(stats.chunkGets).toBeGreaterThan(0);
    expect(stats.chunkGets).toBeLessThanOrEqual(8);
    expect(plan.hashes.length).toBeGreaterThan(80);
  });

  it("sin origenes (o con origenes sin plan calculado) se lee TODO de disco y el resultado es el mismo", async () => {
    const store = make();
    const { first, second } = pair();
    await store.put("a", first);
    await store.put("b", second);
    const total = (await planChunks(second)).hashes.length;
    const stats = spyChunkReads();
    expect(same((await store.get("b"))!, second)).toBe(true);
    expect(stats.chunkGets).toBe(total);
    // Un residente SIN plan conocido no se usa: ni se calcula (lento) ni se fia uno de el.
    const stranger = first.slice();
    expect(peekChunkPlan(stranger)).toBeUndefined();
    stats.chunkGets = 0;
    expect(same((await store.get("b", [stranger]))!, second)).toBe(true);
    expect(stats.chunkGets).toBe(total);
  });

  it("nunca mezcla contenidos: un residente con trozos de la MISMA longitud pero otro contenido no se copia", async () => {
    const store = make();
    const { first, second } = pair(6 * MB, 6);
    await store.put("b", second);
    await planChunks(first);
    // El residente es `first` (mismos cortes, 6 trozos con otro contenido): el resultado debe ser `second`, no una mezcla.
    const back = await store.get("b", [first]);
    expect(same(back!, second)).toBe(true);
    expect(same(back!, first)).toBe(false);
  });

  it("varios origenes: cada trozo sale del que lo tiene y el resultado sigue siendo exacto", async () => {
    const store = make();
    const base = noise(6 * MB, 21);
    const left = base.slice();
    left[1 * MB] ^= 1;
    const right = base.slice();
    right[4 * MB] ^= 1;
    const target = base.slice();
    target[1 * MB] ^= 1;
    target[4 * MB] ^= 1; // combina el cambio de `left` y el de `right`
    await store.put("t", target);
    await planChunks(left);
    await planChunks(right);
    const stats = spyChunkReads();
    const back = await store.get("t", [left, right]);
    expect(same(back!, target)).toBe(true);
    // Cada fuente aporta el trozo que la otra no tiene: solo falta leer ese cambio comun.
    expect(stats.chunkGets).toBeLessThanOrEqual(2);
  });

  it("un cambio que DESPLAZA lo de detras (insertar bytes) se reconstruye exacto: lo compartido se copia a su nueva posicion", async () => {
    const store = make();
    const first = noise(6 * MB, 31);
    const insertAt = 200_000;
    const extra = noise(9_000, 77);
    const target = new Uint8Array(first.byteLength + extra.byteLength);
    target.set(first.subarray(0, insertAt), 0);
    target.set(extra, insertAt);
    target.set(first.subarray(insertAt), insertAt + extra.byteLength);
    await store.put("t", target);
    await planChunks(first);
    const total = (await planChunks(target)).hashes.length;
    const stats = spyChunkReads();
    const back = await store.get("t", [first]);
    expect(same(back!, target)).toBe(true);
    // El troceado por contenido se resincroniza justo despues del cambio: casi todo el documento se copia de la RAM, pero a
    // otra posicion (origen y destino ya no coinciden).
    expect(stats.chunkGets).toBeLessThan(total / 10);
    // Y al reves: quitar esos bytes (los trozos se desplazan hacia atras).
    await store.put("f", first);
    await planChunks(target);
    stats.chunkGets = 0;
    expect(same((await store.get("f", [target]))!, first)).toBe(true);
    expect(stats.chunkGets).toBeLessThan(total / 10);
  });

  it("copiar desde la RAM cediendo el hilo entre copias: el resultado se entrega cuando TODO esta en su sitio", async () => {
    const store = make();
    const { first, second } = pair(6 * MB, 3);
    await store.put("b", second);
    await planChunks(first);
    // Cada copia (4 KB) cede el hilo: la lectura de disco acaba mucho antes que las copias y la promesa no puede resolverse antes.
    __setCopySliceForTests(0, 4096);
    const back = await store.get("b", [first]);
    expect(same(back!, second)).toBe(true);
  });

  it("un residente cuyos bytes ya no existen (transferidos: longitud 0) no se usa y se lee de disco", async () => {
    const store = make();
    const { first, second } = pair();
    await store.put("b", second);
    const detachable = first.slice();
    await planChunks(detachable);
    structuredClone(detachable.buffer, { transfer: [detachable.buffer] });
    expect(detachable.byteLength).toBe(0);
    const back = await store.get("b", [detachable]);
    expect(same(back!, second)).toBe(true);
  });

  it("lo recuperado de disco recuerda su plan: sirve de origen para el siguiente y no recalcula el SHA-256", async () => {
    const store = make();
    const { first, second } = pair();
    await store.put("a", first);
    await store.put("b", second);
    const fromDisk = (await store.get("a"))!;
    const remembered = peekChunkPlan(fromDisk);
    expect(remembered).toBeDefined();
    expect(remembered!.byteLength).toBe(first.byteLength);
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect((await planChunks(fromDisk)).hashes).toEqual(remembered!.hashes);
    expect(digest).not.toHaveBeenCalled();
    // Y se usa de origen: `b` se reconstruye casi sin leer de disco.
    const stats = spyChunkReads();
    expect(same((await store.get("b", [fromDisk]))!, second)).toBe(true);
    expect(stats.chunkGets).toBeLessThanOrEqual(8);
  });

  it("un plan que no encaja con los bytes (otra longitud) se ignora al recordarlo", () => {
    const bytes = noise(1000, 3);
    rememberChunkPlan(bytes, { byteLength: 999, hashes: ["x"], sizes: [999] });
    expect(peekChunkPlan(bytes)).toBeUndefined();
    __forgetChunkPlanForTests(bytes);
  });

  it("la ventana de lectura mantiene una cola sin hueco pero acotada (no pide los ~2000 trozos de golpe)", async () => {
    const store = make();
    const big = noise(12 * MB, 5);
    await store.put("big", big);
    const total = (await planChunks(big)).hashes.length;
    expect(total).toBeGreaterThan(200);
    const stats = spyChunkReads();
    expect(same((await store.get("big"))!, big)).toBe(true);
    expect(stats.chunkGets).toBe(total);
    expect(stats.maxInFlight).toBeGreaterThan(8); // en paralelo...
    expect(stats.maxInFlight).toBeLessThanOrEqual(64); // ...pero acotado
  });

  it("un trozo que falta o tiene otra longitud sigue dando `null` (no se completa con lo que haya en RAM de otro snapshot)", async () => {
    const store = make();
    const { first, second } = pair();
    await store.put("b", second);
    await planChunks(first);
    // Borra de disco un trozo que SOLO tiene `second` (el residente `first` no lo tiene): hay que leerlo y no esta.
    const plan = await planChunks(second);
    const onlySecond = plan.hashes.find((hash) => !(first.length > 0 && (peekChunkPlan(first)?.hashes ?? []).includes(hash)));
    expect(onlySecond).toBeDefined();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(store.name);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").delete(`~c:${onlySecond}`);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(await store.get("b", [first])).toBeNull();
  });
});
