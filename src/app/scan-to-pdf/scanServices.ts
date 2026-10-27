import { getScanEngine } from "@/lib/scan/engine";
import { scanSessionStore, scanSessionsSupported } from "@/lib/scan/sessionStore";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { FrameVerdict, ScanEngineApi, ScanMode, ScanPage, ScanSession, ScanSessionStore } from "@/lib/scan/types";

/**
 * PUNTO DE INTEGRACION unico entre la interfaz del Escaner y el motor / almacen.
 *
 * Orden de resolucion:
 *  1. `globalThis.__optimusScanEngine` / `__optimusScanStore`: gancho de PRUEBAS (Vitest y Playwright inyectan aqui el motor y el
 *     almacen falsos de `src/lib/scan/testing`). En produccion nadie lo define, asi que solo cuesta una lectura de propiedad.
 *     (La fachada real tambien respeta `__optimusScanEngine`, metodo a metodo.)
 *  2. La fachada real: `getScanEngine()` (`@/lib/scan/engine`) y `scanSessionStore` (`@/lib/scan/sessionStore`).
 *
 * Si el dueno del motor renombra estos exports, este es el UNICO archivo de la interfaz que hay que tocar.
 *
 * Tambien concentra los campos ADITIVOS del contrato (`ScanPage.mode`, `ScanSession.lostPages`, `nameSuggested.name`,
 * `splitSpread(page)`, `analyzeFrame(..., {mode})`, `save() -> forkedAs`) con lectores tolerantes: funcionan igual si el tipo del
 * contrato aun no los trae o si el motor no los rellena.
 */
declare global {
  var __optimusScanEngine: ScanEngineApi | undefined;
  var __optimusScanStore: ScanSessionStore | undefined;
}

export function resolveScanEngine(): ScanEngineApi {
  return globalThis.__optimusScanEngine ?? getScanEngine();
}

/** `null` si no hay almacen (modo privado sin IndexedDB, por ejemplo): la interfaz sigue y avisa de que no se guarda. */
export function resolveScanStore(): ScanSessionStore | null {
  if (globalThis.__optimusScanStore) return globalThis.__optimusScanStore;
  try {
    return scanSessionsSupported() ? scanSessionStore : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Campos aditivos del contrato (lectores tolerantes)
 * ------------------------------------------------------------------ */

/** `analyzeFrame` con el modo como cuarto argumento (aditivo: el motor ajusta la cobertura esperada; sin el, lo ignora). */
export function analyzeFrameInMode(engine: ScanEngineApi, frame: ImageData, previous: { quad: QuadCorners | null; at: number } | undefined, now: number, mode: ScanMode): FrameVerdict {
  return (engine.analyzeFrame as unknown as (...args: unknown[]) => FrameVerdict)(frame, previous, now, { mode });
}

/** `splitSpread(page)` (aditivo, opcional): parte una foto de libro en dos paginas. `null` si el motor no lo ofrece. */
export function splitSpreadOf(engine: ScanEngineApi): ((source: ScanPage, options?: { signal?: AbortSignal }) => Promise<[ScanPage, ScanPage]>) | null {
  const method = (engine as unknown as { splitSpread?: (source: ScanPage, options?: { signal?: AbortSignal }) => Promise<[ScanPage, ScanPage]> }).splitSpread;
  return typeof method === "function" ? method.bind(engine) : null;
}

/** Paginas que no se pudieron recuperar al cargar una sesion guardada (aditivo). */
export function lostPagesOf(session: ScanSession): number {
  const lost = (session as ScanSession & { lostPages?: unknown }).lostPages;
  return typeof lost === "number" && lost > 0 ? Math.floor(lost) : 0;
}

/** Nombre COMPLETO ya saneado que propone el motor (aditivo en `nameSuggested`), si lo trae. */
export function suggestedFullName(suggested: ScanSession["nameSuggested"] | undefined): string | null {
  const name = (suggested as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

/** Otra pestana modifico esta sesion mas recientemente: la copia de ESTA pestana se guardo con otro id (aditivo en `save`). */
export function forkedAsOf(outcome: { ok: boolean }): string | null {
  const forked = (outcome as { forkedAs?: unknown }).forkedAs;
  return typeof forked === "string" && forked !== "" ? forked : null;
}
