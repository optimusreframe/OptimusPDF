import type { ToolSlug } from "@/lib/tools-registry";

/**
 * Historial de trabajos recientes.
 *
 * REGLA DURA: aqui NUNCA se guarda contenido de archivo. Solo el nombre
 * mostrado, la herramienta usada y la marca de tiempo, en localStorage
 * de este dispositivo.
 */
export type RecentEntry = {
  id: string;
  slug: ToolSlug;
  fileName: string;
  /** ISO 8601 */
  date: string;
};

export const RECENT_STORAGE_KEY = "optimuspdf.recent";
const MAX_ENTRIES = 20;

const EMPTY: RecentEntry[] = [];

/**
 * Cache del snapshot: `useSyncExternalStore` exige que dos lecturas
 * consecutivas sin cambios devuelvan la misma referencia.
 */
let cache: RecentEntry[] | null = null;
const listeners = new Set<() => void>();

function isRecentEntry(value: unknown): value is RecentEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.slug === "string" &&
    typeof entry.fileName === "string" &&
    typeof entry.date === "string"
  );
}

function readStorage(): RecentEntry[] {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const entries = parsed.filter(isRecentEntry).slice(0, MAX_ENTRIES);
    return entries.length === 0 ? EMPTY : entries;
  } catch {
    return EMPTY;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToRecentEntries(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRecentEntries(): RecentEntry[] {
  cache ??= readStorage();
  return cache;
}

export function addRecentEntry(slug: ToolSlug, fileName: string): void {
  if (typeof window === "undefined") return;
  const entry: RecentEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    slug,
    fileName,
    date: new Date().toISOString(),
  };
  const next = [entry, ...getRecentEntries()].slice(0, MAX_ENTRIES);
  cache = next;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage lleno o bloqueado: el historial es prescindible.
  }
  emit();
}

export function clearRecentEntries(): void {
  if (typeof window === "undefined") return;
  cache = EMPTY;
  try {
    window.localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    // Ignorado a proposito.
  }
  emit();
}
