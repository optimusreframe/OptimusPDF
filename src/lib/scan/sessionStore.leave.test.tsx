import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCAN_DB_NAME,
  __resetScanStagingForTests,
  __resetScanStoreMemoryForTests,
  clearScanSessions,
  __setScanStorageModeForTests,
  newScanSessionId,
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

  it("sin nada apuntado el evento no escribe nada", async () => {
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(await scanSessionStore.list()).toEqual([]);
  });
});
