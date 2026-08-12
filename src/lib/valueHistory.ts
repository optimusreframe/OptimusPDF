/**
 * Historial de valores escritos en campos de texto de `/sign-pdf`, para
 * sugerir autocompletado entre documentos.
 *
 * REGLA DURA distinta de `recent.ts`: aqui SI se guarda contenido que
 * puede ser PII (nombres, numeros de poliza, direcciones...) en
 * `localStorage`. Es una decision de producto explicita, no accidental:
 * viene con aviso de privacidad y boton "Borrar datos" siempre visible
 * (`src/app/sign-pdf/PrivacyNotice.tsx`). Nunca guarda el archivo ni su
 * contenido, solo valores de campo sueltos indexados por la etiqueta
 * normalizada del campo (`normalizeFieldLabel` en `src/lib/pdf/sign.ts`).
 */

import { useSyncExternalStore } from "react";

export type ValueHistoryEntry = {
  value: string;
  /** ISO 8601, ultima vez que se escribio/reutilizo este valor. */
  lastUsedAt: string;
};

type Store = Record<string, ValueHistoryEntry[]>;

export const VALUE_HISTORY_STORAGE_KEY = "optimuspdf.valueHistory";
const SCHEMA_VERSION = 1;
/** Entradas distintas que se recuerdan por cada etiqueta de campo. */
const MAX_ENTRIES_PER_KEY = 5;
/** Etiquetas distintas totales antes de expulsar la menos usada. */
const MAX_KEYS = 200;
/** Un valor de 1 caracter no vale la pena recordarlo. */
const MIN_VALUE_LENGTH = 2;

const EMPTY_STORE: Store = {};
const EMPTY_LIST: readonly string[] = [];

let cache: Store | null = null;
/** Se incrementa en cada escritura; lo que consume `useSyncExternalStore`. */
let version = 0;
const listeners = new Set<() => void>();

function isEntry(value: unknown): value is ValueHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.value === "string" && typeof entry.lastUsedAt === "string"
  );
}

function isStore(value: unknown): value is Store {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (list) => Array.isArray(list) && list.every(isEntry),
  );
}

function readStorage(): Store {
  if (typeof window === "undefined") return EMPTY_STORE;
  try {
    const raw = window.localStorage.getItem(VALUE_HISTORY_STORAGE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STORE;
    const { version: storedVersion, entries } = parsed as Record<
      string,
      unknown
    >;
    if (storedVersion !== SCHEMA_VERSION || !isStore(entries)) {
      return EMPTY_STORE;
    }
    return entries;
  } catch {
    return EMPTY_STORE;
  }
}

function writeStorage(store: Store): void {
  try {
    window.localStorage.setItem(
      VALUE_HISTORY_STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, entries: store }),
    );
  } catch {
    // Storage lleno o bloqueado (privado/cuota agotada): las sugerencias
    // son prescindibles, nunca motivo para interrumpir la firma.
  }
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeToValueHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Store {
  cache ??= readStorage();
  return cache;
}

/**
 * Otra pestaña escribio o borro el historial: la cache de este modulo
 * queda obsoleta y hay que releer. Sin esto, borrar datos en una pestaña
 * no evita que la siguiente escritura en OTRA pestaña resucite el PII ya
 * borrado a partir de su propia cache en memoria todavia vieja.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== VALUE_HISTORY_STORAGE_KEY) return;
    cache = null;
    emit();
  });
}

/** Solo para que `useSyncExternalStore` detecte cambios; no expone los datos. */
function getVersion(): number {
  return version;
}

/** Fuerza un re-render cuando el historial cambia (incluida otra pestaña). */
export function useValueHistoryVersion(): number {
  return useSyncExternalStore(subscribeToValueHistory, getVersion, () => 0);
}

/**
 * Guarda `value` bajo `key` (la etiqueta de campo ya normalizada por quien
 * llama). Deduplica, LRU dentro de la propia clave y expulsa la clave
 * menos usada si se supera `MAX_KEYS`. Valores vacios o de 1 caracter no
 * se guardan: no aportan nada a las sugerencias y solo son ruido.
 */
export function recordValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  const trimmed = value.trim();
  if (!key || trimmed.length < MIN_VALUE_LENGTH) return;

  const store = { ...getSnapshot() };
  const existing = store[key] ?? [];
  const withoutDuplicate = existing.filter((entry) => entry.value !== trimmed);
  store[key] = [
    { value: trimmed, lastUsedAt: new Date().toISOString() },
    ...withoutDuplicate,
  ].slice(0, MAX_ENTRIES_PER_KEY);

  const keys = Object.keys(store);
  if (keys.length > MAX_KEYS) {
    const oldestFirst = keys
      .filter((candidate) => candidate !== key)
      .sort((a, b) =>
        (store[a][0]?.lastUsedAt ?? "").localeCompare(
          store[b][0]?.lastUsedAt ?? "",
        ),
      );
    for (const stale of oldestFirst) {
      if (Object.keys(store).length <= MAX_KEYS) break;
      delete store[stale];
    }
  }

  cache = store;
  writeStorage(store);
  emit();
}

/** Quita un unico valor guardado, sin tocar el resto del historial de esa clave. */
export function forgetValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  const existing = getSnapshot()[key];
  if (!existing) return;
  const next = existing.filter((entry) => entry.value !== value);
  const store = { ...getSnapshot() };
  if (next.length === 0) delete store[key];
  else store[key] = next;
  cache = store;
  writeStorage(store);
  emit();
}

/**
 * Sugerencias para autocompletar mientras se escribe: primero lo ya usado
 * bajo la MISMA clave (mas fiable, mismo tipo de campo), y solo si faltan
 * para llegar a `limit` se completa con coincidencias de CUALQUIER otra
 * clave (mas reciente primero) -- nunca al reves, para que un campo nunca
 * empuje fuera a sus propias coincidencias. El valor exacto ya escrito no
 * se sugiere a si mismo.
 */
export function suggestValues(
  key: string,
  partial: string,
  limit = 5,
): readonly string[] {
  if (!key) return EMPTY_LIST;
  const store = getSnapshot();
  const needle = partial.trim().toLowerCase();

  const matchesIn = (entries: readonly ValueHistoryEntry[]): string[] =>
    entries
      .filter((entry) => {
        const lower = entry.value.toLowerCase();
        return (
          lower !== needle && (needle.length === 0 || lower.includes(needle))
        );
      })
      .map((entry) => entry.value);

  const own = matchesIn(store[key] ?? []).slice(0, limit);
  if (own.length >= limit) return own;

  const seen = new Set(own.map((value) => value.toLowerCase()));
  const others = Object.entries(store)
    .filter(([candidate]) => candidate !== key)
    .flatMap(([, entries]) => entries)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

  const fallback: string[] = [];
  for (const value of matchesIn(others)) {
    const lower = value.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    fallback.push(value);
    if (own.length + fallback.length >= limit) break;
  }

  return [...own, ...fallback];
}

/** El valor mas reciente guardado bajo `key`, o `null` si no hay ninguno. */
export function bestMatchForKey(key: string): string | null {
  if (!key) return null;
  const entries = getSnapshot()[key];
  return entries && entries.length > 0 ? entries[0].value : null;
}

export function clearValueHistory(): void {
  if (typeof window === "undefined") return;
  cache = {};
  try {
    window.localStorage.removeItem(VALUE_HISTORY_STORAGE_KEY);
  } catch {
    // Ignorado a proposito, igual que `recent.ts`.
  }
  emit();
}

/** Solo para tests: fuerza a releer `localStorage` en el siguiente acceso. */
export function __resetValueHistoryCacheForTests(): void {
  cache = null;
}
