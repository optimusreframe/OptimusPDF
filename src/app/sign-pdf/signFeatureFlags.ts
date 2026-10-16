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
  | "signingRecordFile"
  | "pinchZoom"
  | "signatureVault"
  | "signaturesInDraft"
  | "multiDocument";

/**
 * Interruptores de las plantillas de documento (Fase 2 · U2.4). Van aparte de `SignPdfFeatureFlag`: su texto vive en
 * `strings.template.flags` (no en el diccionario general de Ajustes) y Ajustes los pinta en su propio bloque.
 */
export type SignTemplateFlag = "autoApplyTemplates" | "autoDetectFields";
export const SIGN_TEMPLATE_FLAGS: readonly SignTemplateFlag[] = ["autoApplyTemplates", "autoDetectFields"] as const;

export const SIGN_PDF_FEATURE_FLAGS: readonly SignPdfFeatureFlag[] = [
  "keyboardNav",
  "fieldsCompleteNotice",
  "undoDelete",
  "reusableTemplates",
  "richFieldTypes",
  "completionCertificate",
  "signingRecordFile",
  "pinchZoom",
  "signatureVault",
  "signaturesInDraft",
  "multiDocument",
] as const;

export type SignPdfFeatureFlagState = Record<SignPdfFeatureFlag | SignTemplateFlag, boolean>;

export const DEFAULT_SIGN_PDF_FEATURE_FLAGS: SignPdfFeatureFlagState = {
  keyboardNav: true,
  fieldsCompleteNotice: true,
  undoDelete: true,
  reusableTemplates: true,
  richFieldTypes: true,
  // Desde la version 2 de los ajustes (ver `SIGN_PDF_FEATURE_FLAGS_VERSION`) la hoja «Registro de firmas» y el registro
  // `.json` aparte nacen APAGADOS: el PDF firmado tiene exactamente las paginas del original.
  completionCertificate: false,
  signingRecordFile: false,
  pinchZoom: true,
  signatureVault: true,
  // Los borradores guardan tambien los trazos de las firmas recogidas (solo en este dispositivo, 7 dias: U0.4). Apagado,
  // guardan todo menos los trazos y al retomarlos se piden de nuevo.
  signaturesInDraft: true,
  multiDocument: true,
  // Plantillas de documento (Fase 2): aplicar solas las ya configuradas y detectar campos en un PDF desconocido.
  autoApplyTemplates: true,
  autoDetectFields: true,
};

export const SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY =
  "optimuspdf.signPdf.featureFlags";

/**
 * Version de los ajustes guardados. `writeFlags` guarda TODOS los interruptores, asi que quien toco CUALQUIER ajuste
 * tiene grabado el valor que `completionCertificate` tenia por defecto (`true` hasta la version 1). Cambiar el valor por
 * defecto no basta: hay que migrar lo ya guardado, UNA sola vez. Sin clave de version = version 1.
 */
export const SIGN_PDF_FEATURE_FLAGS_VERSION_KEY =
  "optimuspdf.signPdf.featureFlags.v";
export const SIGN_PDF_FEATURE_FLAGS_VERSION = 2;

function isSignPdfFeatureFlag(value: string): value is SignPdfFeatureFlag | SignTemplateFlag {
  return (SIGN_PDF_FEATURE_FLAGS as readonly string[]).includes(value) || (SIGN_TEMPLATE_FLAGS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Store externo, mismo patron que src/lib/theme.tsx y src/lib/i18n.tsx:
 * el estado vive en localStorage (por navegador/sesion, nunca en
 * cuenta ni servidor) y el snapshot del servidor son los defaults, asi
 * la hidratacion no diverge.
 * ------------------------------------------------------------------ */

let cachedState: SignPdfFeatureFlagState | null = null;
const listeners = new Set<() => void>();

function readStoredVersion(): number {
  try {
    const raw = window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_VERSION_KEY);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  } catch {
    return 1;
  }
}

function persistFlags(state: SignPdfFeatureFlagState): void {
  try {
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify(state),
    );
    window.localStorage.setItem(
      SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
      String(SIGN_PDF_FEATURE_FLAGS_VERSION),
    );
  } catch {
    // Sin almacenamiento el valor sigue en memoria; la migracion se repetira al recargar.
  }
}

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

    // Migracion unica a la version 2: lo que hubiera grabado la version 1 para `completionCertificate` (casi siempre
    // `true`, por haber sido el valor por defecto) no es una eleccion de la persona. Se fuerza a `false` y se
    // persiste junto con la version: desde entonces, si lo activa, se respeta en cada recarga.
    if (readStoredVersion() < SIGN_PDF_FEATURE_FLAGS_VERSION) {
      result.completionCertificate = false;
      persistFlags(result);
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
  // El flag sigue activo en memoria aunque no se pueda persistir. Siempre se graba tambien la version: sin ella, la
  // siguiente carga creeria que son ajustes antiguos y volveria a apagar el registro que la persona acaba de encender.
  persistFlags(next);
  notify();
}

/** Cambia un unico interruptor, preservando el resto. */
export function setSignPdfFeatureFlag(
  flag: SignPdfFeatureFlag | SignTemplateFlag,
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

/**
 * ¿Los borradores guardan tambien los trazos de las firmas? Lectura puntual (fuera de React) para quien escribe el
 * borrador: es lo que decide, en el momento de guardar, si los trazos entran en IndexedDB.
 */
export function readSignaturesInDraft(): boolean {
  return getSnapshot().signaturesInDraft;
}

/** Un unico interruptor, reactivo (para gatear una funcion concreta). */
export function useSignPdfFeatureFlag(flag: SignPdfFeatureFlag | SignTemplateFlag): boolean {
  return useSignPdfFeatureFlags()[flag];
}

/** Mismo patron que `__resetValueHistoryCacheForTests`: sin esto, un test que cambia un flag deja el cache en memoria pisado para los que corran despues en el mismo archivo, aunque limpien `localStorage`. */
export function __resetSignPdfFeatureFlagsCacheForTests(): void {
  cachedState = null;
}
