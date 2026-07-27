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

/** Preferencia que el usuario guarda. */
export type ThemeChoice = "light" | "dark" | "system";
/** Tema realmente pintado (nunca "system"). */
export type ResolvedTheme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = [
  "light",
  "dark",
  "system",
] as const;
export const DEFAULT_THEME: ThemeChoice = "system";
export const DEFAULT_RESOLVED_THEME: ResolvedTheme = "dark";
export const THEME_STORAGE_KEY = "optimuspdf.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/* ------------------------------------------------------------------ *
 * Store externo, mismo patron que src/lib/i18n.tsx: la preferencia vive
 * en localStorage y el snapshot del servidor es un valor fijo, asi la
 * hidratacion no diverge. El snapshot se serializa como
 * "<preferencia>:<resuelto>" para que siga siendo un primitivo estable
 * (useSyncExternalStore compara por identidad) y para que un cambio del
 * tema del sistema operativo produzca un snapshot distinto.
 * ------------------------------------------------------------------ */

type Snapshot = `${ThemeChoice}:${ResolvedTheme}`;

const SERVER_SNAPSHOT: Snapshot = `${DEFAULT_THEME}:${DEFAULT_RESOLVED_THEME}`;

let cachedSnapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;

function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : DEFAULT_THEME;
  } catch {
    // Modo privado o storage bloqueado.
    return DEFAULT_THEME;
  }
}

/** Tema que pide el sistema operativo ahora mismo. */
function readSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return DEFAULT_RESOLVED_THEME;
  }
}

function buildSnapshot(choice: ThemeChoice): Snapshot {
  const resolved: ResolvedTheme =
    choice === "system" ? readSystemTheme() : choice;
  return `${choice}:${resolved}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * El SO cambio de tema. Solo repercute si la preferencia guardada es
 * "system": en cualquier otro caso buildSnapshot devuelve lo mismo y no
 * se notifica a nadie.
 */
function handleSystemChange(): void {
  const next = buildSnapshot(readStoredTheme());
  if (next === cachedSnapshot) return;
  cachedSnapshot = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !mediaQuery) {
    try {
      mediaQuery = window.matchMedia(DARK_QUERY);
      mediaQuery.addEventListener("change", handleSystemChange);
    } catch {
      mediaQuery = null;
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && mediaQuery) {
      mediaQuery.removeEventListener("change", handleSystemChange);
      mediaQuery = null;
    }
  };
}

function getSnapshot(): Snapshot {
  cachedSnapshot ??= buildSnapshot(readStoredTheme());
  return cachedSnapshot;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

function writeTheme(next: ThemeChoice): void {
  cachedSnapshot = buildSnapshot(next);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // El tema sigue activo en memoria aunque no se pueda persistir.
  }
  notify();
}

type ThemeContextValue = {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeChoice) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const separator = snapshot.indexOf(":");
  const theme = snapshot.slice(0, separator) as ThemeChoice;
  const resolvedTheme = snapshot.slice(separator + 1) as ResolvedTheme;

  const setTheme = useCallback((next: ThemeChoice) => {
    writeTheme(next);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme debe usarse dentro de <ThemeProvider>");
  }
  return context;
}
