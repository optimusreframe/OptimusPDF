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

function readStoredLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    // Modo privado o storage bloqueado.
    return DEFAULT_LANGUAGE;
  }
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

/** Atajo para leer solo el diccionario. */
export function useT(): Dictionary {
  return useI18n().t;
}

/** Locale BCP-47 para formateo de numeros y fechas. */
export function localeTag(language: Language): string {
  return language === "es" ? "es-ES" : "en-GB";
}
