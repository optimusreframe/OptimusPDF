import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCAN_DB_NAME,
  __resetBlobProbeForTests,
  __resetScanStagingForTests,
  __resetScanStoreMemoryForTests,
  clearScanSessions,
  __setSaveGuardMsForTests,
  __setScanStorageModeForTests,
  __setStageSaveMsForTests,
  __setTxGuardMsForTests,
  newScanSessionId,
  scanStorageMode,
  scanSessionStore,
} from "@/lib/scan/sessionStore";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "@/lib/scan/types";

/**
 * Al irse de la pagina (`pagehide`, `beforeunload`, `visibilitychange` oculto) lo apuntado con `stage` se escribe SIN esperar al
 * autoguardado de la interfaz: girar y recargar a los 200 ms no pierde el giro. jsdom + fake-indexeddb.
 */

const NOW = "2026-10-26T14:32:00.000Z";
let seed = 0;

function page(rotation: 0 | 90 | 180 | 270 = 0): ScanPage {
  seed += 1;
  return {
    id: `p-leave-${seed}-aaaa`,
    createdAt: NOW,
    source: "camera",
    // Blob de Node: el Blob de jsdom no se puede clonar dentro de fake-indexeddb (en un navegador real no hay esa diferencia).
    original: new NodeBlob([new Uint8Array([seed, 2, 3])], { type: "image/jpeg" }) as unknown as Blob,
    originalWidth: 10,
    originalHeight: 10,
    corners: null,
    rotation,
    filter: "auto",
    adjust: { brightness: 0, contrast: 0 },
    processed: null,
    thumb: new NodeBlob([new Uint8Array([9])], { type: "image/jpeg" }) as unknown as Blob,
    flags: {},
  };
}

const session = (pages: ScanPage[]): ScanSession => ({ id: newScanSessionId(), createdAt: NOW, updatedAt: NOW, name: "Al irse", pages, settings: { ...DEFAULT_SCAN_SETTINGS } });

async function storedRotation(id: string): Promise<number | null> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open(SCAN_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const rows: Array<{ sid: string; rotation: number }> = await new Promise((resolve) => {
      const request = db.transaction("pages", "readonly").objectStore("pages").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    return rows.find((row) => row.sid === id)?.rotation ?? null;
  } finally {
    db.close();
  }
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  // El guardado anticipado de `stage` se desactiva (salvo en sus propias pruebas): aqui se mide solo el volcado al irse la pagina.
  __setStageSaveMsForTests(null);
  __resetBlobProbeForTests();
  __resetScanStagingForTests();
  __resetScanStoreMemoryForTests();
  await clearScanSessions();
});

describe("volcado al irse de la pagina — src/lib/scan/sessionStore.ts", () => {
  for (const [label, fire] of [
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    ["beforeunload", () => window.dispatchEvent(new Event("beforeunload"))],
    [
      "visibilitychange (oculta)",
      () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ] as const) {
    it(`${label}: el cambio apuntado y aun sin autoguardar queda escrito, con la transaccion empezada en el acto`, async () => {
      const base = session([page(0)]);
      expect((await scanSessionStore.save(base)).ok).toBe(true);
      const changed = { ...base, pages: [{ ...base.pages[0], rotation: 90 as const }] };
      scanSessionStore.stage?.(changed);
      // El autoguardado (500 ms) aun no ha tocado: lo escrito sigue siendo el giro anterior.
      await tick();
      expect(await storedRotation(base.id)).toBe(0);
      fire();
      await tick();
      expect(await storedRotation(base.id)).toBe(90);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });
  }

  it("una sesion NUEVA apuntada y nunca guardada tambien se vuelca al irse (se crea entera)", async () => {
    const fresh = session([page(180), page(0)]);
    scanSessionStore.stage?.(fresh);
    await tick(60);
    window.dispatchEvent(new Event("pagehide"));
    await tick(60);
    const loaded = await scanSessionStore.load(fresh.id);
        expect(loaded?.pages.map((p) => p.rotation)).toEqual([180, 0]);
  });

  it("WebKit sin Blob en IndexedDB (modo bytes): el volcado al irse tambien empieza la transaccion EN EL ACTO y el giro queda escrito", async () => {
    __setScanStorageModeForTests("bytes");
    try {
      const base = session([page(0), page(0)]);
      expect((await scanSessionStore.save(base)).ok).toBe(true);
      scanSessionStore.stage?.({ ...base, pages: base.pages.map((p, i) => (i === 1 ? { ...p, rotation: 90 as const } : p)) });
      await tick(60);
      const original = IDBDatabase.prototype.transaction;
      let started = 0;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
        started += 1;
        return original.apply(this, args);
      } as typeof original;
      try {
        window.dispatchEvent(new Event("pagehide"));
        // Una pagina que se va no espera a nada: la transaccion tiene que estar creada ya, no tras un await.
        expect(started).toBeGreaterThan(0);
      } finally {
        IDBDatabase.prototype.transaction = original;
      }
      await tick(60);
      const loaded = await scanSessionStore.load(base.id);
      expect(loaded?.pages.map((p) => p.rotation)).toEqual([0, 90]);
      expect(loaded?.pages[1].thumb?.size).toBeGreaterThan(0);
    } finally {
      __setScanStorageModeForTests("blob");
    }
  });

  it("WebKit (modo bytes): una pagina con miniatura NUEVA (sin leer: la acaba de regenerar un giro) se escribe igualmente, sin miniatura, y el giro no se pierde", async () => {
    __setScanStorageModeForTests("bytes");
    try {
      const base = session([page(0), page(0)]);
      expect((await scanSessionStore.save(base)).ok).toBe(true);
      const regenerated = new NodeBlob([new Uint8Array([7, 7, 7])], { type: "image/jpeg" }) as unknown as Blob;
      scanSessionStore.stage?.({ ...base, pages: base.pages.map((p, i) => (i === 1 ? { ...p, rotation: 90 as const, thumb: regenerated } : p)) });
      window.dispatchEvent(new Event("pagehide"));
      await tick(60);
      const loaded = await scanSessionStore.load(base.id);
      expect(loaded?.pages.map((p) => p.rotation)).toEqual([0, 90]);
      // Sin miniatura (la interfaz la vuelve a generar al restaurar); la otra pagina conserva la suya.
      expect(loaded?.pages[1].thumb ?? null).toBeNull();
      expect(loaded?.pages[0].thumb?.size).toBeGreaterThan(0);
    } finally {
      __setScanStorageModeForTests("blob");
    }
  });

  it("WebKit (modo bytes): borrar una pagina de una sesion YA restaurada (miniaturas nuevas sin leer) y recargar al instante deja la otra pagina", async () => {
    __setScanStorageModeForTests("bytes");
    try {
      const base = session([page(0), page(90)]);
      expect((await scanSessionStore.save(base)).ok).toBe(true);
      // Como tras una recarga: la sesion se LEE del almacen (miniaturas nuevas) y se sigue desde ahi.
      const restored = await scanSessionStore.load(base.id);
      expect(restored?.pages).toHaveLength(2);
      scanSessionStore.stage?.({ ...(restored as ScanSession), pages: (restored as ScanSession).pages.slice(0, 1) });
      // Sin lecturas dentro de la transaccion de volcado en bytes: cada ida y vuelta retrasa el commit de una pagina que se va (WebKit).
      const originalGet = IDBObjectStore.prototype.get;
      let reads = 0;
      IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["get"]>) {
        reads += 1;
        return originalGet.apply(this, args);
      } as typeof originalGet;
      try {
        window.dispatchEvent(new Event("pagehide"));
      } finally {
        IDBObjectStore.prototype.get = originalGet;
      }
      expect(reads).toBe(0);
      await tick(80);
      const loaded = await scanSessionStore.load(base.id);
      expect(loaded?.pages.map((p) => p.id)).toEqual([base.pages[0].id]);
      // La miniatura de la pagina que se queda y la portada de Recientes (restauradas en bytes) se escriben igual: no se pierden.
      expect(loaded?.pages[0].thumb?.size).toBeGreaterThan(0);
      expect((await scanSessionStore.list())[0].thumb?.size).toBeGreaterThan(0);
    } finally {
      __setScanStorageModeForTests("blob");
    }
  });

  it("modo blob sin ningun guardado normal terminado en esta carga y con una FOTO NUEVA (lleva un Blob nuevo): el volcado al irse NO arriesga una transaccion (WebKit se quedaria colgado): usa el guardado normal", async () => {
    const fresh = session([page(0)]);
    scanSessionStore.stage?.(fresh);
    await tick(60);
    const original = IDBDatabase.prototype.transaction;
    let started = 0;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      started += 1;
      return original.apply(this, args);
    } as typeof original;
    try {
      window.dispatchEvent(new Event("pagehide"));
      expect(started).toBe(0);
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
    await tick(80);
    expect((await scanSessionStore.load(fresh.id))?.pages).toHaveLength(1);
  });

  it("si en esta pestana ya se vio que no se guardan Blob, al recargar el almacen EMPIEZA en modo bytes", async () => {
    sessionStorage.setItem("optimuspdf.scan.bytesMode", "1");
    try {
      vi.resetModules();
      const fresh = await import("@/lib/scan/sessionStore");
      expect(fresh.scanStorageMode()).toBe("bytes");
    } finally {
      sessionStorage.removeItem("optimuspdf.scan.bytesMode");
      vi.resetModules();
    }
  });

  /**
   * Como una pagina que MUERE al irse: tras el evento nada asincrono continua. Se simula dejando sin respuesta `indexedDB.open` (el
   * guardado normal, que abre la base despues de un `await`, ya no puede avanzar) y mirando lo escrito desde otra conexion.
   */
  async function dyingPage<T>(run: () => void, afterwards: () => Promise<T>): Promise<T> {
    const realOpen = indexedDB.open.bind(indexedDB);
    let blocked = true;
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(((name: string, version?: number) => {
      if (blocked) return {} as IDBOpenDBRequest;
      return realOpen(name, version);
    }) as typeof indexedDB.open);
    try {
      run();
      await tick(60);
      blocked = false;
      return await afterwards();
    } finally {
      blocked = false;
      spy.mockRestore();
    }
  }

  async function reloaded(base: ScanSession): Promise<ScanSession> {
    // Como tras recargar: se olvida lo que la pestana creia haber escrito y el estado de la carga (sin guardado normal terminado).
    __resetScanStagingForTests();
    __resetScanStoreMemoryForTests();
    const restored = await scanSessionStore.load(base.id);
    expect(restored).not.toBeNull();
    // La conexion de volcado se abre en segundo plano al cargar.
    await tick(60);
    return restored as ScanSession;
  }

  it("REGRESION (scan-ui-persist:185): recargar sin guardado con Blob y borrar una pagina: el volcado al irse escribe el borrado EN EL ACTO aunque la pagina muera sin guardado normal", async () => {
    const base = session([page(0), page(90)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    const restored = await reloaded(base);
    scanSessionStore.stage?.({ ...restored, pages: restored.pages.slice(0, 1) });
    const original = IDBDatabase.prototype.transaction;
    let started = 0;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      started += 1;
      return original.apply(this, args);
    } as typeof original;
    try {
      const loaded = await dyingPage(
        () => {
          window.dispatchEvent(new Event("pagehide"));
          expect(started).toBeGreaterThan(0);
        },
        () => scanSessionStore.load(base.id),
      );
      expect(loaded?.pages.map((p) => p.id)).toEqual([base.pages[0].id]);
      // La miniatura y la portada que ya estaban guardadas se conservan (no se dejan en blanco por escribir sin Blob).
      expect(loaded?.pages[0].thumb?.size).toBeGreaterThan(0);
      expect((await scanSessionStore.list())[0].thumb?.size).toBeGreaterThan(0);
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
  });

  it("REGRESION: recargar sin guardado con Blob, girar una pagina (miniatura NUEVA sin leer) y irse: el giro queda escrito (sin miniatura nueva, se regenera) y la otra pagina conserva la suya", async () => {
    const base = session([page(0), page(0)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    const restored = await reloaded(base);
    const regenerated = new NodeBlob([new Uint8Array([7, 7, 7])], { type: "image/jpeg" }) as unknown as Blob;
    scanSessionStore.stage?.({ ...restored, pages: restored.pages.map((p, i) => (i === 1 ? { ...p, rotation: 90 as const, thumb: regenerated } : p)) });
    const loaded = await dyingPage(
      () => window.dispatchEvent(new Event("pagehide")),
      () => scanSessionStore.load(base.id),
    );
    expect(loaded?.pages.map((p) => p.rotation)).toEqual([0, 90]);
    expect(loaded?.pages[1].thumb ?? null).toBeNull();
    expect(loaded?.pages[0].thumb?.size).toBeGreaterThan(0);
  });

  it("recargar sin guardado con Blob y cambiar un parametro de una pagina SIN regenerar su miniatura (filtro): se escribe el cambio y se conserva la miniatura ya guardada", async () => {
    const base = session([page(0), page(0)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    const restored = await reloaded(base);
    scanSessionStore.stage?.({ ...restored, pages: restored.pages.map((p, i) => (i === 0 ? { ...p, filter: "bw" as const } : p)) });
    const loaded = await dyingPage(
      () => window.dispatchEvent(new Event("pagehide")),
      () => scanSessionStore.load(base.id),
    );
    expect(loaded?.pages.map((p) => p.filter)).toEqual(["bw", "auto"]);
    expect(loaded?.pages[0].thumb?.size).toBeGreaterThan(0);
    expect((await scanSessionStore.list())[0].thumb?.size).toBeGreaterThan(0);
  });

  it("recargar sin guardado con Blob y cambiar la PRIMERA pagina (otra portada): se escribe el cambio y la portada pasa a ser la de la nueva primera pagina", async () => {
    const base = session([page(0), page(0)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    const restored = await reloaded(base);
    scanSessionStore.stage?.({ ...restored, pages: [restored.pages[1], restored.pages[0]] });
    const loaded = await dyingPage(
      () => window.dispatchEvent(new Event("pagehide")),
      () => scanSessionStore.load(base.id),
    );
    expect(loaded?.pages.map((p) => p.id)).toEqual([base.pages[1].id, base.pages[0].id]);
    // La portada pasa a ser la miniatura de la nueva primera pagina (ya guardada, restaurada de la base): se escribe tal cual.
    expect((await scanSessionStore.list())[0].thumb?.size).toBeGreaterThan(0);
  });

  it("sin nada apuntado el evento no escribe nada", async () => {
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(await scanSessionStore.list()).toEqual([]);
  });

});

/**
 * WebKit: una transaccion con un Blob que no se puede preparar emite `error` pero NUNCA `abort` ni `complete`; el guardado se
 * quedaba esperando para siempre («Guardando…» eterno). Se simula tragando `oncomplete`/`onabort` de la primera transaccion de
 * escritura y disparando solo `onerror`; y, en el otro caso, sin disparar nada.
 */
describe("guardado que no termina (WebKit) — src/lib/scan/sessionStore.ts", () => {
  type Mutable = { transaction: IDBDatabase["transaction"] };
  const proto = IDBDatabase.prototype as unknown as Mutable;
  const original = proto.transaction;
  afterEach(() => {
    proto.transaction = original;
    __setTxGuardMsForTests(null);
    __setSaveGuardMsForTests(null);
    __setScanStorageModeForTests("blob");
    sessionStorage.removeItem("optimuspdf.scan.bytesMode");
  });

  function hangFirstWrite(options: { fireError: boolean; every?: boolean; database?: string }): { calls: () => number } {
    let writes = 0;
    proto.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      const tx = original.apply(this, args);
      if (args[1] !== "readwrite") return tx;
      // `database`: solo las transacciones de esa base (la de pruebas de Blob, o la de sesiones).
      if (options.database && this.name !== options.database) return tx;
      writes += 1;
      if (writes > 1 && !options.every) return tx;
      return new Proxy(tx, {
        set(target, property, value) {
          if (property === "oncomplete" || property === "onabort") return true;
          if (property === "onerror") {
            if (options.fireError) setTimeout(() => (value as (event: unknown) => void)({ target: { error: new Error("UnknownError: Error preparing Blob/File data to be stored in object store") } }), 5);
            return true;
          }
          (target as unknown as Record<string | symbol, unknown>)[property] = value;
          return true;
        },
        get(target, property) {
          const value = (target as unknown as Record<string | symbol, unknown>)[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } as typeof original;
    return { calls: () => writes };
  }

  it("`error` sin `abort` ni `complete`: se da por fallida, cae al modo bytes, REINTENTA y el guardado termina bien", async () => {
    __setStageSaveMsForTests(null);
    __setScanStorageModeForTests("blob");
    const hang = hangFirstWrite({ fireError: true, database: SCAN_DB_NAME });
    const base = session([page(0)]);
    const started = Date.now();
    const result = await scanSessionStore.save(base);
    // Rapido: el `error` basta (sin esperar al plazo de guardia de 8 s).
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.ok).toBe(true);
    expect(scanStorageMode()).toBe("bytes");
    expect(hang.calls()).toBeGreaterThanOrEqual(2);
    expect((await scanSessionStore.load(base.id))?.pages).toHaveLength(1);
  });

  it("sin NINGUN evento: el plazo de guardia la da por fallida, reintenta en bytes y termina", async () => {
    __setTxGuardMsForTests(60);
    __setScanStorageModeForTests("blob");
    hangFirstWrite({ fireError: false, database: SCAN_DB_NAME });
    const base = session([page(0)]);
    const started = Date.now();
    const result = await scanSessionStore.save(base);
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(scanStorageMode()).toBe("bytes");
  });

  it("si TODO se cuelga, el guardado devuelve un fallo (`unavailable`) a tiempo en vez de esperar para siempre", async () => {
    __setTxGuardMsForTests(40);
    __setSaveGuardMsForTests(300);
    __setScanStorageModeForTests("blob");
    hangFirstWrite({ fireError: false, every: true, database: SCAN_DB_NAME });
    const result = await scanSessionStore.save(session([page(0)]));
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("guardado anticipado: tras `stage` el cambio queda escrito a los ~100 ms SIN pagehide ni autoguardado de la interfaz", async () => {
    __setStageSaveMsForTests(30);
    const base = session([page(0), page(0)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    scanSessionStore.stage?.({ ...base, pages: [base.pages[1], base.pages[0]] });
    await tick(25);
    expect((await scanSessionStore.load(base.id))?.pages.map((p) => p.id)).toEqual(base.pages.map((p) => p.id));
    await tick(150);
    expect((await scanSessionStore.load(base.id))?.pages.map((p) => p.id)).toEqual([base.pages[1].id, base.pages[0].id]);
  });

  it("guardado anticipado con cambios sin parar: no espera al silencio mas alla de ~90 ms desde el primero", async () => {
    __setStageSaveMsForTests(50);
    const base = session([page(0)]);
    expect((await scanSessionStore.save(base)).ok).toBe(true);
    const turn = (rotation: 0 | 90 | 180 | 270) => scanSessionStore.stage?.({ ...base, pages: [{ ...base.pages[0], rotation }] });
    turn(90);
    for (let k = 0; k < 6; k += 1) {
      await tick(40);
      turn(k % 2 ? 180 : 270);
    }
    // Pasaron ~240 ms con un cambio cada 40 ms (el silencio nunca llego a 60 ms): aun asi ya hay algo escrito.
    expect((await storedRotation(base.id)) !== 0).toBe(true);
  });

  it("PRUEBA de Blob en una base APARTE: si falla como en WebKit (error sin abort ni complete), el almacen pasa a bytes SIN tocar la base de sesiones y guarda", async () => {
    __setScanStorageModeForTests("blob");
    const hang = hangFirstWrite({ fireError: true, database: "optimuspdf-scan-probe" });
    const base = session([page(0)]);
    const result = await scanSessionStore.save(base);
    expect(result.ok).toBe(true);
    expect(scanStorageMode()).toBe("bytes");
    expect(hang.calls()).toBe(1);
    expect((await scanSessionStore.load(base.id))?.pages).toHaveLength(1);
    // El navegador queda marcado: una recarga de la pestana empieza ya en bytes (no se vuelve a probar).
    expect(sessionStorage.getItem("optimuspdf.scan.bytesMode")).toBe("1");
    sessionStorage.removeItem("optimuspdf.scan.bytesMode");
  });

  it("la prueba de Blob sin ningun evento se da por fallida al agotar su plazo (nunca espera para siempre)", async () => {
    __resetBlobProbeForTests(60);
    __setScanStorageModeForTests("blob");
    hangFirstWrite({ fireError: false, database: "optimuspdf-scan-probe" });
    const started = Date.now();
    const result = await scanSessionStore.save(session([page(0)]));
    expect(result.ok).toBe(true);
    expect(scanStorageMode()).toBe("bytes");
    expect(Date.now() - started).toBeLessThan(2000);
    sessionStorage.removeItem("optimuspdf.scan.bytesMode");
  });

  it("si el navegador SI guarda Blob, la prueba se hace una sola vez y el modo sigue siendo blob", async () => {
    __setScanStorageModeForTests("blob");
    const open = vi.spyOn(indexedDB, "open");
    expect((await scanSessionStore.save(session([page(0)]))).ok).toBe(true);
    expect((await scanSessionStore.save(session([page(0)]))).ok).toBe(true);
    expect(scanStorageMode()).toBe("blob");
    expect(open.mock.calls.filter(([name]) => name === "optimuspdf-scan-probe")).toHaveLength(1);
    open.mockRestore();
  });

  it("un guardado que se cuelga FUERA de las transacciones (la lectura previa no contesta) devuelve el fallo a tiempo: la guardia del guardado entero", async () => {
    __setSaveGuardMsForTests(200);
    __setStageSaveMsForTests(null);
    const getter = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function () {
      return {} as IDBRequest;
    } as typeof getter;
    try {
      const started = Date.now();
      const result = await scanSessionStore.save(session([page(0)]));
      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      IDBObjectStore.prototype.get = getter;
    }
  });

  it("si la base de PRUEBAS no se puede abrir no se concluye que falten Blob: el modo sigue siendo blob", async () => {
    __setScanStorageModeForTests("blob");
    const real = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(((name: string, version?: number) => {
      if (name !== "optimuspdf-scan-probe") return real(name, version);
      const request = {} as IDBOpenDBRequest;
      setTimeout(() => (request.onerror as (() => void) | null)?.(), 5);
      return request;
    }) as typeof indexedDB.open);
    try {
      expect((await scanSessionStore.save(session([page(0)]))).ok).toBe(true);
      expect(scanStorageMode()).toBe("blob");
    } finally {
      spy.mockRestore();
    }
  });
});
