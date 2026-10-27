/**
 * Punto de entrada que Playwright compila a un IIFE (`e2e/helpers/scan-ui.ts`) y ejecuta con `addInitScript` ANTES de la pagina:
 * deja el motor y el almacen falsos en los ganchos `globalThis.__optimusScanEngine` / `__optimusScanStore` que lee la interfaz
 * (`src/app/scan-to-pdf/scanServices.ts`). No esta en el build de produccion: nada de `src/app` lo importa.
 *
 * Config opcional en `globalThis.__scanFakeConfig` (la pone el test antes de este script):
 *   { store?: { backend, quotaBytes, latencyMs }, controls?: Partial<FakeControls> }
 */
import { createFakeEngine, createFakeOcr, newControls, type FakeControls, type FakeEngine } from "@/lib/scan/testing/fakeEngine";
import { createFakeStore, type FakeStore, type FakeStoreOptions } from "@/lib/scan/testing/fakeStore";

type Config = { store?: FakeStoreOptions; controls?: Partial<FakeControls> };

export type ScanFakeHandle = { engine: FakeEngine; store: FakeStore; controls: FakeControls };

declare global {
  var __scanFakeConfig: Config | undefined;
  var __scanFake: ScanFakeHandle | undefined;
}

export function installFakes(config: Config = globalThis.__scanFakeConfig ?? {}): ScanFakeHandle {
  const controls = Object.assign(newControls(), config.controls ?? {});
  const engine = createFakeEngine(controls);
  const store = createFakeStore({ backend: "indexeddb", ...(config.store ?? {}) });
  globalThis.__optimusScanEngine = engine;
  globalThis.__optimusScanStore = store;
  globalThis.__optimusScanOcr = createFakeOcr(controls);
  const handle = { engine, store, controls };
  globalThis.__scanFake = handle;
  return handle;
}

installFakes();
