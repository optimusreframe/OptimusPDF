/**
 * Punto de entrada que Vite empaqueta (IIFE) para inyectar el MOTOR FALSO de «Extraer elementos» en la build de
 * produccion (F7 · U7.4): el spec lo carga con `addInitScript`, que crea `globalThis.__optimusExtractEngine` ANTES de que
 * arranque la pagina; `src/lib/pdf/extractAssets/index.ts` lo lee en cada llamada (gancho inerte si nadie lo define).
 * El motor falso solo trae `extractAssets` y `renderAsset`: `cropRegion` (recorte manual) es el REAL, con pdf.js.
 * Solo para las pruebas E2E; no forma parte del producto.
 */
import { createFakeEngine, type FakeEngineOptions } from "../../src/lib/pdf/extractAssets/testing/fakeEngine";

export { createFakeEngine };
export type { FakeEngineOptions };

/** Instala el motor falso (sin `cropRegion`) y deja su control en `globalThis.__fakeExtract`. */
export function installFakeEngine(options: FakeEngineOptions = {}): void {
  const fake = createFakeEngine(options);
  const target = globalThis as Record<string, unknown>;
  target.__optimusExtractEngine = { extractAssets: fake.extractAssets, renderAsset: fake.renderAsset };
  target.__fakeExtract = fake;
}
