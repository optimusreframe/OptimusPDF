"use client";

import { useSyncExternalStore } from "react";

/**
 * Interruptores de PDF Pro (Wave 7 · U1). Mismo patron que `editFeatureFlags.ts` y
 * `signFeatureFlags.ts`: cada funcion nace detras de su propio flag, configurable por
 * navegador desde Ajustes (localStorage + `useSyncExternalStore`; nunca en cuenta ni servidor).
 *
 *  - `proAutosave` (ACTIVO por defecto): guarda un borrador del documento de trabajo en
 *    IndexedDB mientras se trabaja (`proDraftAutosave.ts`). Apagado, no se guarda nada.
 *
 * El interruptor `proContinuousViewer` se ELIMINO (Wave 7 · U8): el visor es siempre continuo y nadie lo leia. Un valor
 * antiguo guardado en este navegador se ignora (las claves desconocidas no se leen).
 */
export type ProFeatureFlag = "proAutosave";

export const PRO_FEATURE_FLAGS: readonly ProFeatureFlag[] = [
  "proAutosave",
] as const;

export type ProFeatureFlagState = Record<ProFeatureFlag, boolean>;

export const DEFAULT_PRO_FEATURE_FLAGS: ProFeatureFlagState = {
  proAutosave: true,
};

export const PRO_FEATURE_FLAGS_STORAGE_KEY = "optimuspdf.pro.featureFlags";

function isProFeatureFlag(value: string): value is ProFeatureFlag {
  return (PRO_FEATURE_FLAGS as readonly string[]).includes(value);
}

/* Store externo: REGLA DURA, el almacenamiento nunca lanza a la UI. */

let cachedState: ProFeatureFlagState | null = null;
const listeners = new Set<() => void>();

function readStoredFlags(): ProFeatureFlagState {
  try {
    const raw = window.localStorage.getItem(PRO_FEATURE_FLAGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRO_FEATURE_FLAGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_PRO_FEATURE_FLAGS };
    }
    const result = { ...DEFAULT_PRO_FEATURE_FLAGS };
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isProFeatureFlag(key) && typeof value === "boolean") result[key] = value;
    }
    return result;
  } catch {
    // Modo privado, storage bloqueado o JSON corrupto: se cae a defaults.
    return { ...DEFAULT_PRO_FEATURE_FLAGS };
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ProFeatureFlagState {
  cachedState ??= readStoredFlags();
  return cachedState;
}

function getServerSnapshot(): ProFeatureFlagState {
  return DEFAULT_PRO_FEATURE_FLAGS;
}

function writeFlags(next: ProFeatureFlagState): void {
  cachedState = next;
  try {
    window.localStorage.setItem(PRO_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // El flag sigue activo en memoria aunque no se pueda persistir.
  }
  notify();
}

/** Cambia un unico interruptor, preservando el resto. */
export function setProFeatureFlag(flag: ProFeatureFlag, enabled: boolean): void {
  const current = getSnapshot();
  if (current[flag] === enabled) return;
  writeFlags({ ...current, [flag]: enabled });
}

/** Todos los interruptores, reactivo. */
export function useProFeatureFlags(): ProFeatureFlagState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Un unico interruptor, reactivo, para gatear una funcion concreta. */
export function useProFeatureFlag(flag: ProFeatureFlag): boolean {
  return useProFeatureFlags()[flag];
}

/** Lectura puntual fuera de React. En servidor, el valor por defecto. */
export function getProFeatureFlag(flag: ProFeatureFlag): boolean {
  if (typeof window === "undefined") return DEFAULT_PRO_FEATURE_FLAGS[flag];
  return getSnapshot()[flag];
}

/** Sin esto, un test que cambia un flag deja el cache en memoria pisado para los siguientes del mismo archivo. */
export function __resetProFeatureFlagsCacheForTests(): void {
  cachedState = null;
}
