"use client";

import { useSyncExternalStore } from "react";

/**
 * Interruptores individuales para las funciones nuevas de Sign PDF.
 * Cada una nace detras de su propio flag para que la experiencia sea
 * configurable por navegador (ver Ajustes) sin tocar codigo ni esperar
 * a que las 7 esten "terminadas" a la vez.
 */
export type SignPdfFeatureFlag =
  | "keyboardNav"
  | "fieldsCompleteNotice"
  | "undoDelete"
  | "reusableTemplates"
  | "richFieldTypes"
  | "completionCertificate"
  | "pinchZoom";

export const SIGN_PDF_FEATURE_FLAGS: readonly SignPdfFeatureFlag[] = [
  "keyboardNav",
  "fieldsCompleteNotice",
  "undoDelete",
  "reusableTemplates",
  "richFieldTypes",
  "completionCertificate",
  "pinchZoom",
] as const;

export type SignPdfFeatureFlagState = Record<SignPdfFeatureFlag, boolean>;

export const DEFAULT_SIGN_PDF_FEATURE_FLAGS: SignPdfFeatureFlagState = {
  keyboardNav: true,
  fieldsCompleteNotice: true,
  undoDelete: true,
  reusableTemplates: true,
  richFieldTypes: true,
  completionCertificate: true,
  pinchZoom: true,
};

export const SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY =
  "optimuspdf.signPdf.featureFlags";

function isSignPdfFeatureFlag(value: string): value is SignPdfFeatureFlag {
  return (SIGN_PDF_FEATURE_FLAGS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Store externo, mismo patron que src/lib/theme.tsx y src/lib/i18n.tsx:
 * el estado vive en localStorage (por navegador/sesion, nunca en
 * cuenta ni servidor) y el snapshot del servidor son los defaults, asi
 * la hidratacion no diverge.
 * ------------------------------------------------------------------ */

let cachedState: SignPdfFeatureFlagState | null = null;
const listeners = new Set<() => void>();

function readStoredFlags(): SignPdfFeatureFlagState {
  try {
    const raw = window.localStorage.getItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
    );
    if (!raw) return { ...DEFAULT_SIGN_PDF_FEATURE_FLAGS };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_SIGN_PDF_FEATURE_FLAGS };
    }

    const result = { ...DEFAULT_SIGN_PDF_FEATURE_FLAGS };
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (isSignPdfFeatureFlag(key) && typeof value === "boolean") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    // Modo privado, storage bloqueado o JSON corrupto: se cae a defaults.
    return { ...DEFAULT_SIGN_PDF_FEATURE_FLAGS };
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

function getSnapshot(): SignPdfFeatureFlagState {
  cachedState ??= readStoredFlags();
  return cachedState;
}

function getServerSnapshot(): SignPdfFeatureFlagState {
  return DEFAULT_SIGN_PDF_FEATURE_FLAGS;
}

function writeFlags(next: SignPdfFeatureFlagState): void {
  cachedState = next;
  try {
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // El flag sigue activo en memoria aunque no se pueda persistir.
  }
  notify();
}

/** Cambia un unico interruptor, preservando el resto. */
export function setSignPdfFeatureFlag(
  flag: SignPdfFeatureFlag,
  enabled: boolean,
): void {
  const current = getSnapshot();
  if (current[flag] === enabled) return;
  writeFlags({ ...current, [flag]: enabled });
}

/** Todos los interruptores, reactivo (para el panel de Ajustes). */
export function useSignPdfFeatureFlags(): SignPdfFeatureFlagState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Un unico interruptor, reactivo (para gatear una funcion concreta). */
export function useSignPdfFeatureFlag(flag: SignPdfFeatureFlag): boolean {
  return useSignPdfFeatureFlags()[flag];
}

/** Mismo patron que `__resetValueHistoryCacheForTests`: sin esto, un test que cambia un flag deja el cache en memoria pisado para los que corran despues en el mismo archivo, aunque limpien `localStorage`. */
export function __resetSignPdfFeatureFlagsCacheForTests(): void {
  cachedState = null;
}
