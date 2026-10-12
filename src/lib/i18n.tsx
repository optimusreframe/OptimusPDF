"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { es, type Dictionary } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

export type Language = "es" | "en";

export const LANGUAGES: readonly Language[] = ["es", "en"] as const;
export const DEFAULT_LANGUAGE: Language = "es";
export const LANGUAGE_STORAGE_KEY = "optimuspdf.language";

const DICTIONARIES: Record<Language, Dictionary> = { es, en };

export type { Dictionary };

function isLanguage(value: string | null): value is Language {
  return value === "es" || value === "en";
}

/* ------------------------------------------------------------------ *
 * Store externo: la preferencia vive en localStorage, no en un efecto.
 * Asi el snapshot del servidor es siempre el idioma por defecto y la
 * hidratacion no diverge.
 * ------------------------------------------------------------------ */

let cachedLanguage: Language | null = null;
const listeners = new Set<() => void>();

/**
 * Detecta el idioma preferido del navegador limitado a los idiomas soportados.
 * Recorre `navigator.languages` en orden de preferencia (o `navigator.language`
 * si el array no existe) y devuelve el primer codigo base ("es-MX" -> "es") que
 * coincida con `LANGUAGES`. Si nada coincide, el fallback sigue siendo español.
 * Solo se usa en la primera visita, cuando no hay preferencia guardada.
 */
function detectBrowserLanguage(): Language {
  try {
    if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;

    const preferred =
      navigator.languages && navigator.languages.length > 0
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];

    for (const tag of preferred) {
      const base = tag.toLowerCase().split("-")[0];
      if (isLanguage(base)) return base;
    }
  } catch {
    // Navegador sin API de idiomas o acceso restringido.
  }
  return DEFAULT_LANGUAGE;
}

function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Modo privado o storage bloqueado: se cae a la deteccion del navegador.
  }
  // Primera visita (o storage inaccesible): autodeteccion del dispositivo.
  // No se persiste aqui a proposito: `readStoredLanguage` corre dentro de
  // `getSnapshot` durante el render, y escribir notificaria a los listeners
  // en fase de render. La deteccion es determinista, asi que repetirla en
  // cada carga da el mismo resultado hasta que el usuario use el toggle.
  return detectBrowserLanguage();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Language {
  cachedLanguage ??= readStoredLanguage();
  return cachedLanguage;
}

function getServerSnapshot(): Language {
  return DEFAULT_LANGUAGE;
}

function writeLanguage(next: Language): void {
  cachedLanguage = next;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // El idioma sigue activo en memoria aunque no se pueda persistir.
  }
  for (const listener of listeners) listener();
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: Dictionary;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setLanguage = useCallback((next: Language) => {
    writeLanguage(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, t: DICTIONARIES[language] }),
    [language, setLanguage],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useI18n(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useI18n debe usarse dentro de <LanguageProvider>");
  }
  return context;
}

/**
 * El idioma activo, o español si el componente se pinta fuera de `<LanguageProvider>` (piezas compartidas que solo
 * necesitan el idioma para un nombre accesible y que se prueban sueltas). No lanza.
 */
export function useOptionalLanguage(): Language {
  return useContext(LanguageContext)?.language ?? "es";
}

/** Atajo para leer solo el diccionario. */
export function useT(): Dictionary {
  return useI18n().t;
}

/** Locale BCP-47 para formateo de numeros y fechas. */
export function localeTag(language: Language): string {
  return language === "es" ? "es-ES" : "en-GB";
}
