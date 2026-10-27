import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_START_TIMEOUT_MS,
  createPrepareSession,
  setPrepareWorkerFactory,
  warmPrepareWorker,
} from "@/lib/image/prepareBrowser";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";
import { toPdfError } from "@/lib/pdf/core";

/**
 * Sin conexion: el worker de preparacion (y los trozos de codigo que no se precargaron) pueden no llegar. La preparacion de
 * fotos NUNCA se queda colgada sin mensaje: degrada al hilo principal / a no recomprimir (los bytes de la foto tal cual), y si
 * ningun trozo llega el error es «offline».
 */

type Listener = (event: { data?: unknown }) => void;

/** Worker de mentira: `behavior` decide que hace al crearse y al recibir el primer mensaje. */
function fakeWorkerFactory(behavior: { onCreate?: (emit: (type: "message" | "error", data?: unknown) => void) => void; onPost?: (emit: (type: "message" | "error", data?: unknown) => void, request: { id: number }) => void }) {
  const created: Array<{ terminated: boolean }> = [];
  const factory = () => {
    const listeners: Record<string, Set<Listener>> = { message: new Set(), error: new Set() };
    const emit = (type: "message" | "error", data?: unknown): void => {
      for (const listener of [...listeners[type]]) listener({ data });
    };
    const state = { terminated: false };
    created.push(state);
    queueMicrotask(() => behavior.onCreate?.(emit));
    return {
      addEventListener: (type: string, listener: Listener) => listeners[type]?.add(listener),
      removeEventListener: (type: string, listener: Listener) => listeners[type]?.delete(listener),
      postMessage: (request: { id: number }) => behavior.onPost?.(emit, request),
      terminate: () => {
        state.terminated = true;
      },
    } as unknown as Worker;
  };
  return { factory, created };
}

const bigJpeg = (): Blob => new Blob([new Uint8Array(makeSyntheticJpeg({ width: 3200, height: 2400, seed: 12, quality: 95 }))], { type: "image/jpeg" });

afterEach(() => {
  vi.useRealTimers();
  setPrepareWorkerFactory(null, { disabled: true });
});

describe("preparar fotos sin que el worker llegue", () => {
  it("un worker cuyo script falla (evento error) no cuelga: la foto sigue y se conserva tal cual", async () => {
    const { factory, created } = fakeWorkerFactory({ onCreate: (emit) => emit("error") });
    setPrepareWorkerFactory(factory);
    const session = createPrepareSession();
    const blob = bigJpeg();
    const original = new Uint8Array(await blob.arrayBuffer());
    const prepared = await session.prepare(blob, "balanced");
    session.dispose();
    expect(prepared.changed).toBe(false);
    expect(prepared.bytes).toEqual(original);
    expect(created[0].terminated).toBe(true);
  });

  it("un worker que nunca avisa de que arranco (sin red, script sin descargar) se da por muerto a los 10 s y la foto sigue", async () => {
    vi.useFakeTimers();
    const { factory } = fakeWorkerFactory({});
    setPrepareWorkerFactory(factory);
    const session = createPrepareSession();
    const blob = bigJpeg();
    let done = false;
    const pending = session.prepare(blob, "balanced").then((result) => {
      done = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(WORKER_START_TIMEOUT_MS - 500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const prepared = await pending;
    session.dispose();
    expect(prepared.changed).toBe(false);
    expect(WORKER_START_TIMEOUT_MS).toBe(10_000);
  });

  it("si el worker avisa de que esta listo, una foto lenta NO se da por perdida", async () => {
    vi.useFakeTimers();
    const { factory } = fakeWorkerFactory({
      onCreate: (emit) => emit("message", { ready: true }),
      onPost: (emit, request) => {
        setTimeout(() => emit("message", { id: request.id, ok: true, result: null }), 30_000);
      },
    });
    setPrepareWorkerFactory(factory);
    const session = createPrepareSession();
    const pending = session.prepare(bigJpeg(), "balanced");
    await vi.advanceTimersByTimeAsync(31_000);
    const prepared = await pending;
    session.dispose();
    // El worker contesto «no pude decodificar» (null) tras 30 s: la foto se conserva, sin que el temporizador de arranque estorbe.
    expect(prepared.changed).toBe(false);
  });
});

describe("warmPrepareWorker (precarga para el modo sin conexion)", () => {
  it("true cuando el worker avisa de que esta listo, y lo cierra", async () => {
    const { factory, created } = fakeWorkerFactory({ onCreate: (emit) => emit("message", { ready: true }) });
    setPrepareWorkerFactory(factory);
    expect(await warmPrepareWorker()).toBe(true);
    expect(created[0].terminated).toBe(true);
  });

  it("false si el script falla o no arranca a tiempo, y tambien lo cierra", async () => {
    const failing = fakeWorkerFactory({ onCreate: (emit) => emit("error") });
    setPrepareWorkerFactory(failing.factory);
    expect(await warmPrepareWorker()).toBe(false);
    expect(failing.created[0].terminated).toBe(true);

    vi.useFakeTimers();
    const silent = fakeWorkerFactory({});
    setPrepareWorkerFactory(silent.factory);
    const pending = warmPrepareWorker(2000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toBe(false);
    expect(silent.created[0].terminated).toBe(true);
  });

  it("false sin soporte de workers (nunca lanza)", async () => {
    setPrepareWorkerFactory(null, { disabled: true });
    expect(await warmPrepareWorker()).toBe(false);
  });
});

describe("un trozo de codigo que no llega es «sin conexion»", () => {
  it("el fallo de carga de Turbopack (“Failed to load chunk …”) y el de import() se traducen a offline", () => {
    expect(toPdfError(new Error("Failed to load chunk /_next/static/chunks/2-abc.js from module 473035")).code).toBe("offline");
    expect(toPdfError(new TypeError("Failed to fetch dynamically imported module: http://x/y.js")).code).toBe("offline");
  });
});

describe("las rutas con imagenes cargan sus piezas con UN solo import() (nada diminuto que nadie precargue)", () => {
  const read = (path: string): string => readFileSync(path, "utf8");

  it("«Nuevo PDF desde imagenes» e «Insertar paginas desde imagenes» no importan aparte la calidad ni la preparacion", () => {
    for (const path of ["src/app/pdf-pro/create/fromImages.ts", "src/lib/pdf/pageAssembly.ts"]) {
      const source = read(path);
      expect(source, path).not.toMatch(/import\(\s*["']@\/lib\/image\/imageQualityPref["']\s*\)/);
      expect(source, path).not.toMatch(/import\(\s*["']@\/lib\/image\/prepareBrowser["']\s*\)/);
      expect(source, path).toMatch(/readStoredImagePreset[^]*import\(\s*["']@\/lib\/pdf\/imagesToPdf["']\s*\)/);
    }
  });

  it("PDF Pro precarga con la pagina el motor de imagenes, la calidad recordada y el worker de preparacion", () => {
    const source = read("src/app/pdf-pro/ProToolClient.tsx");
    expect(source).toContain('import("@/lib/pdf/imagesToPdf")');
    expect(source).toContain('import("@/lib/image/imageQualityPref")');
    expect(source).toContain("warmPrepareWorker");
    expect(source).toContain('"data-pro-warm"');
  });
});
