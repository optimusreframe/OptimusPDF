"use client";

import { useSyncExternalStore } from "react";

/**
 * Interruptores de las funciones del editor de PDF. Mismo patron que
 * `src/app/sign-pdf/signFeatureFlags.ts`: cada funcion vive detras de su propio
 * flag, configurable por navegador desde Ajustes.
 *
 *  - `editExistingText` (ACTIVO por defecto): editar el texto que ya trae el PDF.
 *    Al exportar se QUITA el texto original del archivo (si no se puede, se avisa
 *    con `original-text-remains`). Apagado, el editor vuelve a solo ANADIR contenido.
 *
 * La limpieza del texto original ya no es un interruptor: es parte de la
 * exportacion y esta siempre activa. Un `stripOriginalText` guardado por una
 * version anterior en localStorage se ignora (y se descarta en la siguiente escritura).
 */
export type EditPdfFeatureFlag = "editExistingText";

export const EDIT_PDF_FEATURE_FLAGS: readonly EditPdfFeatureFlag[] = ["editExistingText"] as const;

export type EditPdfFeatureFlagState = Record<EditPdfFeatureFlag, boolean>;

export const DEFAULT_EDIT_PDF_FEATURE_FLAGS: EditPdfFeatureFlagState = {
  editExistingText: true,
};

export const EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY = "optimuspdf.editPdf.featureFlags";

function isEditPdfFeatureFlag(value: string): value is EditPdfFeatureFlag {
  return (EDIT_PDF_FEATURE_FLAGS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Store externo: el estado vive en localStorage (por navegador, nunca en
 * cuenta ni servidor) y el snapshot del servidor son los defaults, asi la
 * hidratacion no diverge. REGLA DURA: el almacenamiento nunca lanza a la UI.
 * ------------------------------------------------------------------ */

let cachedState: EditPdfFeatureFlagState | null = null;
const listeners = new Set<() => void>();

function readStoredFlags(): EditPdfFeatureFlagState {
  try {
    const raw = window.localStorage.getItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EDIT_PDF_FEATURE_FLAGS };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_EDIT_PDF_FEATURE_FLAGS };
    }

    const result = { ...DEFAULT_EDIT_PDF_FEATURE_FLAGS };
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEditPdfFeatureFlag(key) && typeof value === "boolean") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    // Modo privado, storage bloqueado o JSON corrupto: se cae a defaults.
    return { ...DEFAULT_EDIT_PDF_FEATURE_FLAGS };
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

function getSnapshot(): EditPdfFeatureFlagState {
  cachedState ??= readStoredFlags();
  return cachedState;
}

function getServerSnapshot(): EditPdfFeatureFlagState {
  return DEFAULT_EDIT_PDF_FEATURE_FLAGS;
}

function writeFlags(next: EditPdfFeatureFlagState): void {
  cachedState = next;
  try {
    window.localStorage.setItem(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // El flag sigue activo en memoria aunque no se pueda persistir.
  }
  notify();
}

/** Cambia un unico interruptor, preservando el resto. */
export function setEditPdfFeatureFlag(flag: EditPdfFeatureFlag, enabled: boolean): void {
  const current = getSnapshot();
  if (current[flag] === enabled) return;
  writeFlags({ ...current, [flag]: enabled });
}

/** Todos los interruptores, reactivo. */
export function useEditPdfFeatureFlags(): EditPdfFeatureFlagState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Un unico interruptor, reactivo, para gatear una funcion concreta. */
export function useEditPdfFeatureFlag(flag: EditPdfFeatureFlag): boolean {
  return useEditPdfFeatureFlags()[flag];
}

/** Lectura puntual fuera de React. En servidor, el valor por defecto. */
export function getEditPdfFeatureFlag(flag: EditPdfFeatureFlag): boolean {
  if (typeof window === "undefined") return DEFAULT_EDIT_PDF_FEATURE_FLAGS[flag];
  return getSnapshot()[flag];
}

/** Sin esto, un test que cambia un flag deja el cache en memoria pisado para los siguientes del mismo archivo. */
export function __resetEditPdfFeatureFlagsCacheForTests(): void {
  cachedState = null;
}
