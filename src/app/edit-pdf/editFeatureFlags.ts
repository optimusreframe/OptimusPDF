"use client";

import { useSyncExternalStore } from "react";

/**
 * Interruptores de las funciones nuevas del editor de PDF (Wave 5). Mismo patron
 * que `src/app/sign-pdf/signFeatureFlags.ts`: cada funcion nace detras de su
 * propio flag, configurable por navegador desde Ajustes.
 *
 *  - `editExistingText` (ACTIVO por defecto): editar el texto que ya trae el PDF
 *    (cubrir y redibujar). Apagado, el editor vuelve a solo ANADIR contenido.
 *  - `stripOriginalText` (DESACTIVADO por defecto y NO DISPONIBLE todavia):
 *    limpiar de verdad el texto original del flujo de contenido. La limpieza real
 *    se difiere a una wave posterior; hoy el flag solo queda RESERVADO. Como no
 *    hay funcion detras, `useEditPdfFeatureFlag` devuelve siempre `false` para el
 *    y Ajustes lo muestra deshabilitado y desmarcado, con su motivo.
 */
export type EditPdfFeatureFlag = "editExistingText" | "stripOriginalText";

export const EDIT_PDF_FEATURE_FLAGS: readonly EditPdfFeatureFlag[] = [
  "editExistingText",
  "stripOriginalText",
] as const;

export type EditPdfFeatureFlagState = Record<EditPdfFeatureFlag, boolean>;

export const DEFAULT_EDIT_PDF_FEATURE_FLAGS: EditPdfFeatureFlagState = {
  editExistingText: true,
  stripOriginalText: false,
};

/**
 * Flags con funcion real detras. Un flag NO disponible no se puede activar desde
 * la interfaz y su lectura efectiva es siempre `false`, aunque el almacenamiento
 * diga otra cosa (alguien lo edito a mano).
 */
export const EDIT_PDF_FEATURE_FLAG_AVAILABLE: Readonly<Record<EditPdfFeatureFlag, boolean>> = {
  editExistingText: true,
  stripOriginalText: false,
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

/**
 * Cambia un unico interruptor, preservando el resto. Un flag no disponible
 * (`stripOriginalText`) no se puede ACTIVAR; apagarlo siempre se permite.
 */
export function setEditPdfFeatureFlag(flag: EditPdfFeatureFlag, enabled: boolean): void {
  if (enabled && !EDIT_PDF_FEATURE_FLAG_AVAILABLE[flag]) return;
  const current = getSnapshot();
  if (current[flag] === enabled) return;
  writeFlags({ ...current, [flag]: enabled });
}

/** Valor efectivo: un flag no disponible es siempre `false`. */
function effective(state: EditPdfFeatureFlagState): EditPdfFeatureFlagState {
  if (EDIT_PDF_FEATURE_FLAGS.every((flag) => EDIT_PDF_FEATURE_FLAG_AVAILABLE[flag] || !state[flag])) {
    return state;
  }
  const next = { ...state };
  for (const flag of EDIT_PDF_FEATURE_FLAGS) {
    if (!EDIT_PDF_FEATURE_FLAG_AVAILABLE[flag]) next[flag] = false;
  }
  return next;
}

let lastRaw: EditPdfFeatureFlagState | null = null;
let lastEffective: EditPdfFeatureFlagState | null = null;

function getEffectiveSnapshot(): EditPdfFeatureFlagState {
  const raw = getSnapshot();
  // Misma referencia mientras el estado no cambie: `useSyncExternalStore` lo exige.
  if (raw !== lastRaw || lastEffective === null) {
    lastRaw = raw;
    lastEffective = effective(raw);
  }
  return lastEffective;
}

/** Todos los interruptores (efectivos), reactivo. */
export function useEditPdfFeatureFlags(): EditPdfFeatureFlagState {
  return useSyncExternalStore(subscribe, getEffectiveSnapshot, getServerSnapshot);
}

/** Un unico interruptor (efectivo), reactivo, para gatear una funcion concreta. */
export function useEditPdfFeatureFlag(flag: EditPdfFeatureFlag): boolean {
  return useEditPdfFeatureFlags()[flag];
}

/** Lectura puntual fuera de React (efectiva). En servidor, el valor por defecto. */
export function getEditPdfFeatureFlag(flag: EditPdfFeatureFlag): boolean {
  if (typeof window === "undefined") return DEFAULT_EDIT_PDF_FEATURE_FLAGS[flag];
  return getEffectiveSnapshot()[flag];
}

/** Sin esto, un test que cambia un flag deja el cache en memoria pisado para los siguientes del mismo archivo. */
export function __resetEditPdfFeatureFlagsCacheForTests(): void {
  cachedState = null;
  lastRaw = null;
  lastEffective = null;
}
