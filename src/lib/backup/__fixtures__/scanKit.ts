import { Blob as NodeBlob } from "node:buffer";
import { __resetScanSessionsSizeMemoForTests } from "@/lib/backup/modules/scanSessions";
import {
  __resetScanStagingForTests,
  __resetScanStoreMemoryForTests,
  __setScanStorageModeForTests,
  __setScanStoreLimitsForTests,
  __setScanTabIdForTests,
  clearScanSessions,
  newScanSessionId,
  scanSessionStore,
} from "@/lib/scan/sessionStore";
import { tinyJpegBytes } from "@/lib/scan/testing/testImages";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "@/lib/scan/types";

/**
 * Sesiones de escaneo de PRUEBA para el modulo «Escaneos en curso» del respaldo: se guardan con el almacen REAL
 * (`scanSessionStore.save`) sobre `fake-indexeddb`, con fotos JPEG reales y pequenas (`@napi-rs/canvas`, sinteticas: nunca
 * fotos de clientes). Solo lo usan las pruebas.
 */

let counter = 0;

/**
 * `Blob` de Node: el de jsdom no se puede clonar dentro de fake-indexeddb (en un navegador real no hay esa diferencia). En las
 * pruebas de Node es el mismo que el global.
 */
export const bytesBlob = (bytes: Uint8Array, type = "image/jpeg"): Blob => new NodeBlob([bytes], { type }) as unknown as Blob;

/** Pagina con una foto JPEG REAL distinta para cada `seed` (los mismos bytes en cada ejecucion). */
export function scanPage(seed: number, patch: Partial<ScanPage> = {}): ScanPage {
  counter += 1;
  return {
    id: `p-${seed}-${counter}`,
    createdAt: new Date(Date.UTC(2026, 9, 26, 10, seed % 60)).toISOString(),
    source: "camera",
    original: bytesBlob(tinyJpegBytes(64, 80, seed)),
    originalWidth: 64,
    originalHeight: 80,
    corners: { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.12 }, bottomRight: { x: 0.88, y: 0.9 }, bottomLeft: { x: 0.12, y: 0.88 } },
    rotation: 0,
    filter: "auto",
    adjust: { brightness: 0, contrast: 0 },
    processed: null,
    thumb: bytesBlob(tinyJpegBytes(16, 20, seed + 100)),
    flags: {},
    mode: "document",
    ...patch,
  };
}

export function scanSession(pages: ScanPage[], patch: Partial<ScanSession> = {}): ScanSession {
  return {
    id: newScanSessionId(),
    createdAt: new Date(Date.UTC(2026, 9, 26, 10, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 26, 10, 5)).toISOString(),
    name: "Escaneo de prueba",
    pages,
    settings: { ...DEFAULT_SCAN_SETTINGS },
    ...patch,
  };
}

/** Guarda una sesion con el almacen real y devuelve su id (lanza si no se pudo guardar). */
export async function seedScanSession(session: ScanSession): Promise<string> {
  const saved = await scanSessionStore.save(session);
  if (!saved.ok) throw new Error(`no se pudo sembrar la sesion: ${saved.reason}`);
  return saved.forkedAs ?? session.id;
}

/** Una sesion de `count` paginas distintas (semillas `base`, `base + 1`...), sembrada. */
export async function seedSimpleSession(name: string, count: number, base = 1, patch: Partial<ScanSession> = {}): Promise<{ id: string; session: ScanSession }> {
  const session = scanSession(
    Array.from({ length: count }, (_, index) => scanPage(base + index)),
    { name, ...patch },
  );
  const id = await seedScanSession(session);
  return { id, session };
}

/** Estado limpio entre pruebas: ninguna sesion, ningun recuerdo de pestana ni de tamanos medidos, modo `blob`, limites de fabrica. */
export async function resetScanStore(): Promise<void> {
  __resetScanStagingForTests();
  __setScanStorageModeForTests("blob");
  __resetScanStoreMemoryForTests();
  __setScanTabIdForTests("t-main");
  __setScanStoreLimitsForTests();
  await clearScanSessions();
  __resetScanStoreMemoryForTests();
  __resetScanSessionsSizeMemoForTests();
}

/** Bytes de un Blob. */
export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
