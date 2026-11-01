import { useSyncExternalStore } from "react";
import type { ClientProfile, ClientProfileValue } from "@/lib/autofill/types";
import {
  CLIENT_PROFILES_SCHEMA,
  MAX_CLIENT_PROFILES,
  MAX_PROFILE_NAME_CHARS,
  MAX_PROFILE_VALUES,
  MAX_PROFILE_VALUE_CHARS,
  MIN_PROFILE_VALUE_CHARS,
  checkClientProfiles,
  cleanProfileText,
  clientProfilesJson,
  isStorableProfileKey,
} from "@/lib/clientProfile/schema";

/**
 * Almacen de PERFILES DE CLIENTE del autorrelleno (F3), en `localStorage` de ESTE dispositivo.
 *
 * Por que `localStorage` y no IndexedDB (como las sesiones del Escaner): son pocos datos (<= 20 perfiles x <= 40 valores de <=
 * 500 caracteres: ~100 KB en el peor caso, ~2 KB en uso normal), se leen de forma SINCRONA al abrir la hoja (la lista de
 * perfiles aparece en el mismo pintado, sin estado de carga), «Borrar datos» no puede fallar a medias por una transaccion
 * bloqueada por otra pestana y el precedente ya existe: `valueHistory.ts` guarda PII del mismo modo, con aviso de privacidad. El
 * coste: un navegador sin `localStorage` (modo privado de algunos) no guarda perfiles; la interfaz lo dice (`unavailable`), nunca
 * lo calla.
 *
 * Datos: `{ version: 1, profiles: ClientProfile[] }` bajo `optimuspdf.clientProfiles`. Todo lo que se lee pasa por
 * `checkClientProfiles` (el mismo saneado que el respaldo): un valor ajeno o roto no entra en la interfaz.
 */

export const CLIENT_PROFILES_STORAGE_KEY = "optimuspdf.clientProfiles";

export type ProfileWriteFailure = "unavailable" | "full" | "empty" | "notFound";
export type ProfileWriteResult = { ok: true; profile: ClientProfile } | { ok: false; reason: ProfileWriteFailure };

const EMPTY: readonly ClientProfile[] = Object.freeze([]);

let cache: readonly ClientProfile[] | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Los perfiles guardados, ya saneados y de los mas recientes a los mas antiguos. */
function readStored(): readonly ClientProfile[] {
  const store = storage();
  if (!store) return EMPTY;
  try {
    const raw = store.getItem(CLIENT_PROFILES_STORAGE_KEY);
    if (!raw) return EMPTY;
    const checked = checkClientProfiles(JSON.parse(raw));
    if (!checked.ok) return EMPTY;
    return sortRecent(checked.profiles);
  } catch {
    return EMPTY;
  }
}

function sortRecent(profiles: readonly ClientProfile[]): ClientProfile[] {
  return [...profiles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function emit(): void {
  for (const listener of listeners) listener();
}

function snapshot(): readonly ClientProfile[] {
  cache ??= readStored();
  return cache;
}

export function subscribeToClientProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Otra pestana guardo o borro: la cache de esta queda vieja. Sin esto, una escritura aqui resucitaria perfiles ya borrados alla. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== CLIENT_PROFILES_STORAGE_KEY) return;
    cache = null;
    emit();
  });
}

/** Escribe la lista completa. `false` si el navegador no deja (cuota, bloqueado): la cache no cambia. */
function persist(profiles: readonly ClientProfile[]): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (profiles.length === 0) store.removeItem(CLIENT_PROFILES_STORAGE_KEY);
    else store.setItem(CLIENT_PROFILES_STORAGE_KEY, clientProfilesJson(profiles));
  } catch {
    return false;
  }
  cache = sortRecent(profiles);
  emit();
  return true;
}

/** El texto crudo guardado ahora (`null` = nada): el respaldo lo compara con el que vio en su vista previa antes de escribir. */
export function readClientProfilesRaw(): string | null | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    return store.getItem(CLIENT_PROFILES_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

/** Hay donde guardar perfiles en este navegador. */
export function clientProfilesAvailable(): boolean {
  // Con el almacenamiento bloqueado, `window.localStorage` lanza al leerse o lanza cada llamada: las dos cosas cuentan.
  return storage() !== null && readClientProfilesRaw() !== undefined;
}

export function listClientProfiles(): readonly ClientProfile[] {
  return snapshot();
}

/** Relee `localStorage` sin fiarse de la cache (el respaldo decide con lo que hay AHORA, no con lo que esta pestana recuerda). */
export function refreshClientProfiles(): readonly ClientProfile[] {
  cache = null;
  return snapshot();
}

export function getClientProfile(id: string): ClientProfile | undefined {
  return snapshot().find((profile) => profile.id === id);
}

/** Los perfiles guardados, en vivo (otra pestana, importar un respaldo o borrar datos tambien los cambian). */
export function useClientProfiles(): readonly ClientProfile[] {
  return useSyncExternalStore(subscribeToClientProfiles, snapshot, () => EMPTY);
}

/* ------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------ */

export function newProfileId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `cp-${uuid}`;
  } catch {
    // Sin `crypto.randomUUID` (contexto no seguro): se cae al azar simple.
  }
  return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Valores a guardar saneados: solo claves guardables y valores con texto; los demas se descartan. */
export function cleanValuesForProfile(
  values: Readonly<Record<string, string>>,
  source: ClientProfileValue["source"] | Readonly<Record<string, ClientProfileValue["source"]>>,
  at: string,
): Record<string, ClientProfileValue> {
  const out: Record<string, ClientProfileValue> = {};
  for (const key of Object.keys(values)) {
    if (!isStorableProfileKey(key)) continue;
    const value = cleanProfileText(values[key], MAX_PROFILE_VALUE_CHARS);
    if (value === null || value.length < MIN_PROFILE_VALUE_CHARS) continue;
    const own = typeof source === "string" ? source : Object.prototype.hasOwnProperty.call(source, key) ? source[key] : "extracted";
    out[key] = { value, updatedAt: at, source: own };
    if (Object.keys(out).length >= MAX_PROFILE_VALUES) break;
  }
  return out;
}

function nameKey(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** El perfil con ese nombre (sin distinguir mayusculas ni tildes), si existe. */
export function findClientProfileByName(name: string): ClientProfile | undefined {
  const wanted = cleanProfileText(name, MAX_PROFILE_NAME_CHARS);
  if (wanted === null) return undefined;
  return snapshot().find((profile) => nameKey(profile.name) === nameKey(wanted));
}

export type SaveProfileInput = {
  name: string;
  /** clave de dato -> texto. */
  values: Readonly<Record<string, string>>;
  /** De donde viene cada valor: uno para todos o uno por clave (por defecto `extracted`). */
  source?: ClientProfileValue["source"] | Readonly<Record<string, ClientProfileValue["source"]>>;
  now?: Date;
};

/**
 * Guarda los valores como perfil. Si ya hay un perfil con ese nombre se ACTUALIZA (los valores nuevos pisan a los viejos de la
 * misma clave, los demas se conservan): asi guardar «Perez, Maria» dos veces no duplica. Nuevo perfil con 20 ya guardados: `full`
 * (nunca se borra uno por su cuenta). Sin ningun valor guardable: `empty`.
 */
export function saveClientProfile(input: SaveProfileInput): ProfileWriteResult {
  const name = cleanProfileText(input.name, MAX_PROFILE_NAME_CHARS);
  const at = (input.now ?? new Date()).toISOString();
  const values = cleanValuesForProfile(input.values, input.source ?? "extracted", at);
  if (name === null || Object.keys(values).length === 0) return { ok: false, reason: "empty" };
  const current = snapshot();
  const existing = current.find((profile) => nameKey(profile.name) === nameKey(name));
  if (existing) {
    const merged = { ...existing.values, ...values };
    if (Object.keys(merged).length > MAX_PROFILE_VALUES) return { ok: false, reason: "full" };
    const profile: ClientProfile = { ...existing, name, values: merged, updatedAt: at };
    return persist(current.map((candidate) => (candidate.id === existing.id ? profile : candidate))) ? { ok: true, profile } : { ok: false, reason: "unavailable" };
  }
  if (current.length >= MAX_CLIENT_PROFILES) return { ok: false, reason: "full" };
  const profile: ClientProfile = { id: newProfileId(), name, values, updatedAt: at };
  return persist([profile, ...current]) ? { ok: true, profile } : { ok: false, reason: "unavailable" };
}

function replaceOne(id: string, change: (profile: ClientProfile) => ClientProfile | null): ProfileWriteResult {
  const current = snapshot();
  const profile = current.find((candidate) => candidate.id === id);
  if (!profile) return { ok: false, reason: "notFound" };
  const next = change(profile);
  if (next === null) return { ok: false, reason: "empty" };
  return persist(current.map((candidate) => (candidate.id === id ? next : candidate))) ? { ok: true, profile: next } : { ok: false, reason: "unavailable" };
}

/** Cambia el nombre. Un nombre vacio o demasiado largo no se acepta (`empty`). */
export function renameClientProfile(id: string, name: string, now: Date = new Date()): ProfileWriteResult {
  const clean = cleanProfileText(name, MAX_PROFILE_NAME_CHARS);
  if (clean === null) return { ok: false, reason: "empty" };
  return replaceOne(id, (profile) => ({ ...profile, name: clean, updatedAt: now.toISOString() }));
}

/** Corrige (o anade) UN valor del perfil; queda como escrito a mano (`typed`). Valor vacio o de 1 caracter: `empty`, no cambia nada. */
export function setClientProfileValue(id: string, key: string, value: string, now: Date = new Date()): ProfileWriteResult {
  const clean = cleanProfileText(value, MAX_PROFILE_VALUE_CHARS);
  if (!isStorableProfileKey(key) || clean === null || clean.length < MIN_PROFILE_VALUE_CHARS) return { ok: false, reason: "empty" };
  return replaceOne(id, (profile) => {
    const at = now.toISOString();
    const values = { ...profile.values, [key]: { value: clean, updatedAt: at, source: "typed" as const } };
    if (Object.keys(values).length > MAX_PROFILE_VALUES) return null;
    return { ...profile, values, updatedAt: at };
  });
}

/** Quita UN valor. Si era el ultimo, el perfil entero se borra (un perfil sin datos no sirve de nada). */
export function removeClientProfileValue(id: string, key: string, now: Date = new Date()): { ok: boolean; profileDeleted: boolean } {
  const profile = getClientProfile(id);
  if (!profile || !Object.prototype.hasOwnProperty.call(profile.values, key)) return { ok: false, profileDeleted: false };
  const rest = Object.fromEntries(Object.entries(profile.values).filter(([name]) => name !== key));
  if (Object.keys(rest).length === 0) return { ok: deleteClientProfile(id), profileDeleted: true };
  const result = replaceOne(id, (current) => ({ ...current, values: rest, updatedAt: now.toISOString() }));
  return { ok: result.ok, profileDeleted: false };
}

export function deleteClientProfile(id: string): boolean {
  const current = snapshot();
  if (!current.some((profile) => profile.id === id)) return false;
  return persist(current.filter((profile) => profile.id !== id));
}

/** Borra TODOS los perfiles («Borrar datos»). `false` si el navegador no dejo quitar la clave (los perfiles siguen ahi). */
export function clearClientProfiles(): boolean {
  const store = storage();
  if (!store) return true;
  try {
    store.removeItem(CLIENT_PROFILES_STORAGE_KEY);
  } catch {
    return false;
  }
  cache = EMPTY;
  emit();
  return true;
}

/* ------------------------------------------------------------------ *
 * Para el respaldo (importar) y las pruebas
 * ------------------------------------------------------------------ */

/**
 * Sustituye TODA la lista (lo usa el respaldo al importar). `expectRaw` es el texto que la vista previa vio guardado: si ahora
 * hay otro (otra pestana escribio), no se toca nada (`changed`). Si la escritura falla se deja como estaba.
 */
export function replaceClientProfiles(profiles: readonly ClientProfile[], expectRaw: string | null | undefined): "ok" | "changed" | "quota" | "unavailable" {
  const store = storage();
  if (!store) return "unavailable";
  const before = readClientProfilesRaw();
  if (before === undefined) return "unavailable";
  if (expectRaw !== undefined && before !== expectRaw) return "changed";
  // Lo que se escribe es lo saneado, nunca el objeto recibido.
  const checked = checkClientProfiles(JSON.parse(clientProfilesJson(profiles)));
  if (!checked.ok || checked.profiles.length !== profiles.length) return "unavailable";
  const clean = checked.profiles;
  try {
    if (clean.length === 0) store.removeItem(CLIENT_PROFILES_STORAGE_KEY);
    else store.setItem(CLIENT_PROFILES_STORAGE_KEY, clientProfilesJson(clean));
  } catch (error) {
    try {
      if (before === null) store.removeItem(CLIENT_PROFILES_STORAGE_KEY);
      else store.setItem(CLIENT_PROFILES_STORAGE_KEY, before);
    } catch {
      // Nada mas que hacer.
    }
    const named = typeof error === "object" && error !== null ? (error as { name?: unknown; code?: unknown }) : {};
    return named.name === "QuotaExceededError" || named.name === "NS_ERROR_DOM_QUOTA_REACHED" || named.code === 22 || named.code === 1014 ? "quota" : "unavailable";
  }
  cache = sortRecent(clean);
  emit();
  return "ok";
}

/** Solo para pruebas: fuerza a releer `localStorage` en el siguiente acceso. */
export function __resetClientProfilesCacheForTests(): void {
  cache = null;
}

export { CLIENT_PROFILES_SCHEMA, MAX_CLIENT_PROFILES, MAX_PROFILE_NAME_CHARS, MAX_PROFILE_VALUES, MAX_PROFILE_VALUE_CHARS };
