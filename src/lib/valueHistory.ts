/**
 * Memoria de valores escritos en campos de texto de `/sign-pdf` y de PDF Pro, para sugerir autocompletado entre documentos.
 *
 * REGLA DURA distinta de `recent.ts`: aqui SI se guarda contenido que
 * puede ser PII (nombres, numeros de poliza, direcciones...) en
 * `localStorage`. Es una decision de producto explicita, no accidental:
 * viene con aviso de privacidad y boton "Borrar datos" siempre visible
 * (`src/app/sign-pdf/PrivacyNotice.tsx`). Nunca guarda el archivo ni su
 * contenido, solo valores de campo sueltos.
 *
 * CLAVE = la ETIQUETA («tag») del campo (`lib/fieldTags.ts`: Dirección, Nombre, Teléfono... o una propia `custom.*`), no el
 * texto del rótulo del PDF, que cambia de un contrato a otro. Los campos sin etiqueta usan la clave que da
 * `app/sign-pdf/fieldMemory.ts` (la etiqueta que sugiere su rótulo o, si no hay, el rótulo normalizado de siempre).
 *
 * Formato (el de siempre, `version: 1`, solo con campos nuevos OPCIONALES): `{ version, entries, tags? }`.
 *  - `entries[clave]` = lista por orden de uso reciente; cada valor con `lastUsedAt`, y opcionalmente `uses` (veces usado) y
 *    `pinned` (fijado: va arriba y no se expulsa por antiguedad).
 *  - `tags` = nombre visible de las etiquetas propias (`custom.*`), porque la clave no admite espacios ni tildes.
 * Un almacen anterior (sin `uses`/`pinned`/`tags`, hasta 5 valores por rótulo) se sigue leyendo: al leer, cada rótulo que
 * `suggestDataKey` reconoce se funde en su etiqueta (en memoria; se guarda asi en la siguiente escritura) y el que no se
 * reconoce se queda como clave antigua y sigue funcionando.
 */

import { useSyncExternalStore } from "react";
import { TODAY_DATA_KEY, suggestDataKey } from "@/lib/docLibrary/dataKeys";
import { MAX_CUSTOM_TAGS, customTagKeyFor, foldText, isCustomTag, isTagKey, isValidTag } from "@/lib/fieldTags";

export type ValueHistoryEntry = {
  value: string;
  /** ISO 8601, ultima vez que se escribio/reutilizo este valor. */
  lastUsedAt: string;
  /** Veces que se uso (ausente en el almacen anterior = 1). */
  uses?: number;
  /** Fijado por la persona: va arriba de la lista y no se expulsa por antiguedad. */
  pinned?: boolean;
};

type Store = Record<string, ValueHistoryEntry[]>;
type TagNames = Record<string, string>;

export const VALUE_HISTORY_STORAGE_KEY = "optimuspdf.valueHistory";
const SCHEMA_VERSION = 1;
/** Entradas distintas que se recuerdan por cada etiqueta de campo (antes 5, por rótulo). */
export const MAX_ENTRIES_PER_KEY = 30;
/** Valores fijados por etiqueta (el resto de la lista sigue siendo expulsable). */
export const MAX_PINNED_PER_KEY = 10;
/** Etiquetas distintas totales antes de expulsar la menos usada. */
export const MAX_KEYS = 200;
/** Un valor de 1 caracter no vale la pena recordarlo. */
const MIN_VALUE_LENGTH = 2;
/** Mismo tope que el paquete de respaldo (`backup/modules/settings.ts`): un valor mas largo no viajaria. */
export const MAX_VALUE_LENGTH = 500;

const EMPTY_LIST: readonly string[] = [];

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}
const EMPTY_STORE: Store = {};

type Data = { entries: Store; tags: TagNames };
const EMPTY_DATA: Data = { entries: EMPTY_STORE, tags: {} };

let cache: Data | null = null;
/** Se incrementa en cada escritura; lo que consume `useSyncExternalStore`. */
let version = 0;
const listeners = new Set<() => void>();

function isEntry(value: unknown): value is ValueHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.value === "string" && typeof entry.lastUsedAt === "string";
}

function isStore(value: unknown): value is Store {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (list) => Array.isArray(list) && list.every(isEntry),
  );
}

/** Una entrada leida, con los campos nuevos normalizados (un `uses` o `pinned` raro se ignora). */
function normalizeEntry(entry: ValueHistoryEntry): ValueHistoryEntry {
  const uses = Number.isInteger(entry.uses) && (entry.uses as number) > 0 ? Math.min(entry.uses as number, 1_000_000) : undefined;
  return {
    value: entry.value,
    lastUsedAt: entry.lastUsedAt,
    ...(uses !== undefined && uses > 1 ? { uses } : {}),
    ...(entry.pinned === true ? { pinned: true } : {}),
  };
}

function usesOf(entry: ValueHistoryEntry): number {
  return entry.uses ?? 1;
}

/** Une dos listas de la misma clave: sin repetidos exactos, sumando usos, fijado si alguno lo estaba, mas reciente primero. */
function mergeLists(...lists: readonly (readonly ValueHistoryEntry[])[]): ValueHistoryEntry[] {
  const byValue = new Map<string, ValueHistoryEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const known = byValue.get(entry.value);
      if (!known) {
        byValue.set(entry.value, entry);
        continue;
      }
      const uses = usesOf(known) + usesOf(entry);
      byValue.set(entry.value, {
        value: entry.value,
        lastUsedAt: known.lastUsedAt >= entry.lastUsedAt ? known.lastUsedAt : entry.lastUsedAt,
        ...(uses > 1 ? { uses } : {}),
        ...(known.pinned || entry.pinned ? { pinned: true } : {}),
      });
    }
  }
  return capList([...byValue.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)));
}

/** Deja `MAX_ENTRIES_PER_KEY`: expulsa los mas antiguos que NO esten fijados. */
function capList(list: ValueHistoryEntry[]): ValueHistoryEntry[] {
  if (list.length <= MAX_ENTRIES_PER_KEY) return list;
  const result = [...list];
  for (let index = result.length - 1; index >= 0 && result.length > MAX_ENTRIES_PER_KEY; index -= 1) {
    if (!result[index].pinned) result.splice(index, 1);
  }
  return result.slice(0, MAX_ENTRIES_PER_KEY);
}

/**
 * La clave con la que se guarda y se busca de verdad: una etiqueta se queda como esta; un rótulo antiguo que `suggestDataKey`
 * reconoce («Nombre», «póliza»...) pasa a su etiqueta (asi lo escrito con la clave de siempre y lo que se busca por etiqueta
 * son lo mismo, tambien dentro de una misma sesion, sin esperar a que se relea el almacen); el resto se queda como clave antigua.
 */
function canonicalKey(key: string): string {
  if (!key || isTagKey(key)) return key;
  const mapped = suggestDataKey(key);
  return mapped && mapped !== TODAY_DATA_KEY ? mapped : key;
}

/**
 * Funde en su etiqueta los rótulos antiguos que `suggestDataKey` reconoce. Los que no se reconocen (y los que ya son una
 * etiqueta) se quedan tal cual. Devuelve el MISMO objeto si no habia nada que fundir.
 */
function migrateLegacyKeys(entries: Store): Store {
  let changed = false;
  const out: Store = {};
  const moved = new Map<string, ValueHistoryEntry[][]>();
  for (const [key, list] of Object.entries(entries)) {
    if (isTagKey(key)) {
      out[key] = list;
      continue;
    }
    const mapped = canonicalKey(key);
    if (mapped !== key) {
      changed = true;
      const bucket = moved.get(mapped) ?? [];
      bucket.push(list);
      moved.set(mapped, bucket);
    } else {
      out[key] = list;
    }
  }
  if (!changed) return entries;
  for (const [tag, lists] of moved) out[tag] = mergeLists(out[tag] ?? [], ...lists);
  return out;
}

function isTagNames(value: unknown): value is TagNames {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, name]) => isValidTag(key) && typeof name === "string");
}

function readStorage(): Data {
  if (typeof window === "undefined") return EMPTY_DATA;
  try {
    const raw = window.localStorage.getItem(VALUE_HISTORY_STORAGE_KEY);
    if (!raw) return EMPTY_DATA;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_DATA;
    const { version: storedVersion, entries, tags } = parsed as Record<string, unknown>;
    if (storedVersion !== SCHEMA_VERSION || !isStore(entries)) {
      return EMPTY_DATA;
    }
    const normalized: Store = {};
    for (const [key, list] of Object.entries(entries)) normalized[key] = list.map(normalizeEntry);
    return {
      entries: migrateLegacyKeys(normalized),
      tags: isTagNames(tags) ? { ...tags } : {},
    };
  } catch {
    return EMPTY_DATA;
  }
}

function writeStorage(data: Data): void {
  try {
    window.localStorage.setItem(
      VALUE_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        entries: data.entries,
        ...(Object.keys(data.tags).length > 0 ? { tags: data.tags } : {}),
      }),
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

function getData(): Data {
  cache ??= readStorage();
  return cache;
}

function commit(next: Data): void {
  cache = next;
  writeStorage(next);
  emit();
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

/* ------------------------------------------------------------------ *
 * Escribir
 * ------------------------------------------------------------------ */

/**
 * Guarda `value` bajo `key` (la etiqueta del campo, o la clave antigua del rótulo). Deduplica, cuenta el uso, ordena por
 * uso reciente dentro de la propia clave (los fijados no se expulsan por antiguedad) y expulsa la clave menos usada si se
 * supera `MAX_KEYS`. Valores vacios, de 1 caracter o demasiado largos no se guardan.
 */
export function recordValue(rawKey: string, value: string): void {
  if (typeof window === "undefined") return;
  const key = canonicalKey(rawKey);
  const trimmed = value.trim();
  if (!key || trimmed.length < MIN_VALUE_LENGTH || trimmed.length > MAX_VALUE_LENGTH) return;

  const data = getData();
  const entries = { ...data.entries };
  const existing = entries[key] ?? [];
  const previous = existing.find((entry) => entry.value === trimmed);
  const uses = previous ? usesOf(previous) + 1 : 1;
  const fresh: ValueHistoryEntry = {
    value: trimmed,
    lastUsedAt: new Date().toISOString(),
    ...(uses > 1 ? { uses } : {}),
    ...(previous?.pinned ? { pinned: true } : {}),
  };
  entries[key] = capList([fresh, ...existing.filter((entry) => entry.value !== trimmed)]);

  const keys = Object.keys(entries);
  if (keys.length > MAX_KEYS) {
    const oldestFirst = keys
      .filter((candidate) => candidate !== key)
      .sort((a, b) => (entries[a][0]?.lastUsedAt ?? "").localeCompare(entries[b][0]?.lastUsedAt ?? ""));
    for (const stale of oldestFirst) {
      if (Object.keys(entries).length <= MAX_KEYS) break;
      delete entries[stale];
    }
  }
  commit({ entries, tags: data.tags });
}

/** Quita un unico valor guardado, sin tocar el resto del historial de esa clave. */
export function forgetValue(rawKey: string, value: string): void {
  if (typeof window === "undefined") return;
  const key = canonicalKey(rawKey);
  const data = getData();
  const existing = data.entries[key];
  if (!existing) return;
  const next = existing.filter((entry) => entry.value !== value);
  if (next.length === existing.length) return;
  const entries = { ...data.entries };
  if (next.length === 0) delete entries[key];
  else entries[key] = next;
  commit({ entries, tags: data.tags });
}

/** Quita TODOS los valores de una etiqueta (y, si es propia, su nombre). */
export function forgetKey(rawKey: string): void {
  if (typeof window === "undefined") return;
  const key = canonicalKey(rawKey);
  const data = getData();
  const hasName = hasOwn(data.tags, key);
  if (!(key in data.entries) && !hasName) return;
  const entries = { ...data.entries };
  delete entries[key];
  const tags = { ...data.tags };
  delete tags[key];
  commit({ entries, tags });
}

/**
 * Cambia el TEXTO de un valor guardado (corregir un error de escritura). Conserva sus usos y si estaba fijado; si el texto
 * nuevo ya existia bajo esa clave, los dos se funden. `false` si no cambia nada (valor inexistente o texto no valido).
 */
export function editValue(rawKey: string, oldValue: string, newValue: string): boolean {
  if (typeof window === "undefined") return false;
  const key = canonicalKey(rawKey);
  const trimmed = newValue.trim();
  if (trimmed.length < MIN_VALUE_LENGTH || trimmed.length > MAX_VALUE_LENGTH) return false;
  const data = getData();
  const existing = data.entries[key];
  const target = existing?.find((entry) => entry.value === oldValue);
  if (!existing || !target || trimmed === oldValue) return false;
  const entries = { ...data.entries };
  entries[key] = mergeLists(
    existing.filter((entry) => entry.value !== oldValue),
    [{ ...target, value: trimmed }],
  );
  commit({ entries, tags: data.tags });
  return true;
}

/** Fija (o suelta) un valor: los fijados van arriba de las sugerencias y no se expulsan. `false` si ya hay `MAX_PINNED_PER_KEY` fijados. */
export function setPinned(rawKey: string, value: string, pinned: boolean): boolean {
  if (typeof window === "undefined") return false;
  const key = canonicalKey(rawKey);
  const data = getData();
  const existing = data.entries[key];
  const target = existing?.find((entry) => entry.value === value);
  if (!existing || !target || Boolean(target.pinned) === pinned) return false;
  if (pinned && existing.filter((entry) => entry.pinned).length >= MAX_PINNED_PER_KEY) return false;
  const entries = { ...data.entries };
  entries[key] = existing.map((entry) => {
    if (entry.value !== value) return entry;
    const { pinned: previous, ...rest } = entry;
    void previous;
    return pinned ? { ...rest, pinned: true } : rest;
  });
  commit({ entries, tags: data.tags });
  return true;
}

/* ------------------------------------------------------------------ *
 * Etiquetas propias
 * ------------------------------------------------------------------ */

/** Nombres visibles de las etiquetas propias (`custom.*`). */
export function customTagNames(): Readonly<Record<string, string>> {
  return getData().tags;
}

/**
 * Crea la etiqueta propia `name` y devuelve su clave. Si ya hay una con ese nombre (sin importar mayusculas ni tildes)
 * devuelve la existente. `null` si el nombre no vale o ya hay `MAX_CUSTOM_TAGS`.
 */
export function addCustomTag(name: string): string | null {
  if (typeof window === "undefined") return null;
  const data = getData();
  const found = customTagKeyFor(name, data.tags);
  if (!found) return null;
  if (!found.created) return found.key;
  const label = name.replace(/\s+/g, " ").trim().slice(0, 40).trim();
  commit({ entries: data.entries, tags: { ...data.tags, [found.key]: label } });
  return found.key;
}

/** Cambia el nombre visible de una etiqueta propia. `false` si no existe o el nombre ya lo lleva otra. */
export function renameCustomTag(key: string, name: string): boolean {
  if (typeof window === "undefined") return false;
  const data = getData();
  if (!isCustomTag(key) || !hasOwn(data.tags, key)) return false;
  const label = name.replace(/\s+/g, " ").trim().slice(0, 40).trim();
  if (label === "") return false;
  const clash = Object.entries(data.tags).some(([other, existing]) => other !== key && foldText(existing) === foldText(label));
  if (clash) return false;
  commit({ entries: data.entries, tags: { ...data.tags, [key]: label } });
  return true;
}

/** Cuantas etiquetas propias caben todavia. */
export function customTagRoom(): number {
  return Math.max(0, MAX_CUSTOM_TAGS - Object.keys(getData().tags).length);
}

/* ------------------------------------------------------------------ *
 * Leer
 * ------------------------------------------------------------------ */

/** Una sugerencia con lo que hace falta para pintarla: el texto, si esta fijada y donde coincide con lo escrito. */
export type RankedSuggestion = {
  value: string;
  pinned: boolean;
  /** Posicion (en el texto de `value`) donde empieza la coincidencia con lo escrito; -1 = sin coincidencia que resaltar. */
  matchAt: number;
  matchLength: number;
};

/** `foldText` conserva las posiciones solo si el texto no cambia de largo; si no, no se resalta (mejor sin resaltar que mal). */
function matchPosition(value: string, needle: string): { at: number; length: number } | null {
  const folded = foldText(value);
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  return folded.length === value.length ? { at, length: needle.length } : { at: -1, length: 0 };
}

/**
 * Sugerencias para autocompletar mientras se escribe, ya ordenadas:
 *  1. las que EMPIEZAN igual que lo escrito, 2. las que lo CONTIENEN (sin importar mayusculas ni tildes);
 *  dentro de cada grupo, primero las fijadas y luego por uso reciente (a igualdad, las mas usadas).
 *  Con el campo vacio: las fijadas y las ultimas usadas de esa clave.
 * El valor exacto ya escrito no se sugiere a si mismo. Solo si la clave es un rótulo antiguo (no una etiqueta) y no llega
 * a `limit`, se completa con coincidencias de otras claves; una etiqueta nunca sugiere el dato de otra.
 */
export function rankedSuggestions(rawKey: string, partial: string, limit = 5): readonly RankedSuggestion[] {
  const key = canonicalKey(rawKey);
  if (!key) return [];
  const data = getData();
  const needle = foldText(partial.trim());

  const rank = (entries: readonly ValueHistoryEntry[]): RankedSuggestion[] => {
    const prefix: { entry: ValueHistoryEntry; at: number; length: number }[] = [];
    const inside: { entry: ValueHistoryEntry; at: number; length: number }[] = [];
    for (const entry of entries) {
      if (needle.length === 0) {
        prefix.push({ entry, at: -1, length: 0 });
        continue;
      }
      if (foldText(entry.value) === needle) continue;
      const found = matchPosition(entry.value, needle);
      if (!found) continue;
      (found.at === 0 ? prefix : inside).push({ entry, at: found.at, length: found.length });
    }
    const order = (a: { entry: ValueHistoryEntry }, b: { entry: ValueHistoryEntry }): number =>
      Number(Boolean(b.entry.pinned)) - Number(Boolean(a.entry.pinned)) ||
      b.entry.lastUsedAt.localeCompare(a.entry.lastUsedAt) ||
      usesOf(b.entry) - usesOf(a.entry);
    return [...prefix.sort(order), ...inside.sort(order)].map(({ entry, at, length }) => ({
      value: entry.value,
      pinned: entry.pinned === true,
      matchAt: at,
      matchLength: length,
    }));
  };

  const own = rank(data.entries[key] ?? []).slice(0, limit);
  if (own.length >= limit || needle.length === 0 || isTagKey(key)) return own;

  const seen = new Set(own.map((item) => item.value.toLowerCase()));
  const others = Object.entries(data.entries)
    .filter(([candidate]) => candidate !== key)
    .flatMap(([, entries]) => entries)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  const fallback: RankedSuggestion[] = [];
  for (const item of rank(others)) {
    const lower = item.value.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    fallback.push(item);
    if (own.length + fallback.length >= limit) break;
  }
  return [...own, ...fallback];
}

/** Lo mismo que `rankedSuggestions`, solo los textos. */
export function suggestValues(key: string, partial: string, limit = 5): readonly string[] {
  const ranked = rankedSuggestions(key, partial, limit);
  return ranked.length === 0 ? EMPTY_LIST : ranked.map((item) => item.value);
}

/** El valor mas reciente guardado bajo `key`, o `null` si no hay ninguno. */
export function bestMatchForKey(rawKey: string): string | null {
  const key = canonicalKey(rawKey);
  if (!key) return null;
  const entries = getData().entries[key];
  return entries && entries.length > 0 ? entries[0].value : null;
}

/** Cuantos valores hay guardados bajo `key`. */
export function countForKey(rawKey: string): number {
  return getData().entries[canonicalKey(rawKey)]?.length ?? 0;
}

/** Una etiqueta (o rótulo antiguo) con sus valores, para la hoja «Datos recordados». */
export type RememberedGroup = {
  key: string;
  entries: readonly ValueHistoryEntry[];
};

/** Todo lo guardado: las etiquetas con valores, mas reciente primero. Las que solo tienen nombre (propias sin valores) tambien salen. */
export function listRemembered(): readonly RememberedGroup[] {
  const data = getData();
  const keys = new Set([...Object.keys(data.entries), ...Object.keys(data.tags)]);
  return [...keys]
    .map((key) => ({ key, entries: data.entries[key] ?? [] }))
    .sort((a, b) => (b.entries[0]?.lastUsedAt ?? "").localeCompare(a.entries[0]?.lastUsedAt ?? "") || a.key.localeCompare(b.key));
}

/** Hay algo guardado (valores o nombres de etiquetas propias). */
export function hasRememberedData(): boolean {
  const data = getData();
  return Object.keys(data.entries).length > 0 || Object.keys(data.tags).length > 0;
}

export function clearValueHistory(): void {
  if (typeof window === "undefined") return;
  cache = { entries: {}, tags: {} };
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
