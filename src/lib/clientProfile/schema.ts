import type { ClientProfile, ClientProfileValue } from "@/lib/autofill/types";
import { DATA_KEY_PATTERN } from "@/lib/docLibrary/dataKeys";

/**
 * Esquema y validacion de los PERFILES DE CLIENTE (autorrelleno desde documentos, F3): los datos de un cliente (nombre,
 * telefono, direccion, poliza, reclamo…) guardados en ESTE dispositivo para reutilizarlos entre documentos.
 *
 * Lo comparten el almacen (`store.ts`, lee `localStorage`) y el modulo de respaldo (`@/lib/backup/modules/clientProfiles`,
 * lee un paquete de fuera): ambos pasan por `checkClientProfiles`, asi que lo que llega de un paquete hostil y lo que hay en
 * el navegador se sanea con las MISMAS reglas. Puro: sin `window`, sin React.
 *
 * REGLA DURA (igual que `valueHistory.ts`): AQUI SI se guarda contenido que es PII. Es una decision de producto explicita, con
 * aviso de privacidad y «Borrar datos» siempre alcanzable. Nada de esto se escribe en logs, consola ni nombres de archivo.
 */

/** Version del formato guardado (`localStorage`) y del JSON del respaldo: `{ version, profiles: [...] }`. */
export const CLIENT_PROFILES_SCHEMA = 1;
/** Perfiles que se guardan como maximo. Pasar de aqui no es un uso normal: se pide borrar uno antes. */
export const MAX_CLIENT_PROFILES = 20;
/** Claves de dato distintas por perfil (el registro de fabrica tiene 11). */
export const MAX_PROFILE_VALUES = 40;
export const MAX_PROFILE_NAME_CHARS = 80;
export const MAX_PROFILE_VALUE_CHARS = 500;
/** Un valor de 1 caracter no identifica nada: no se guarda. */
export const MIN_PROFILE_VALUE_CHARS = 2;
/** Forma de un id de perfil (`cp-…`): lo genera el almacen; un paquete puede traer cualquiera que cumpla esto. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Marcas de direccion de texto (bidi): no tienen sitio en un nombre ni en una direccion y sirven para disfrazar texto. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Texto libre: sin controles ni marcas bidi, con los espacios recortados y acotado. `null` si no es texto, esta vacio o se pasa. */
export function cleanProfileText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max * 2) return null;
  const clean = value.replace(CONTROLS, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
  return clean.length > 0 && clean.length <= max ? clean : null;
}

export function cleanProfileIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** ¿Es una clave de dato que se puede guardar? Forma valida y que no choque con el prototipo (`constructor`, `toString`…). */
export function isStorableProfileKey(key: unknown): key is string {
  return typeof key === "string" && DATA_KEY_PATTERN.test(key) && !(key in Object.prototype) && key !== "prototype";
}

/** Un valor suelto saneado, o `null` si no vale. */
export function parseProfileValue(raw: unknown): ClientProfileValue | null {
  if (!isRecord(raw)) return null;
  const value = cleanProfileText(raw.value, MAX_PROFILE_VALUE_CHARS);
  const updatedAt = cleanProfileIso(raw.updatedAt);
  const source = raw.source;
  if (value === null || value.length < MIN_PROFILE_VALUE_CHARS || updatedAt === null) return null;
  if (source !== "extracted" && source !== "typed") return null;
  return { value, updatedAt, source };
}

export type ClientProfilesCheck =
  | {
      ok: true;
      profiles: ClientProfile[];
      /** Perfiles o valores del origen que no valian y se descartaron (sin tumbar el resto). */
      dropped: number;
    }
  | { ok: false };

/**
 * `{ version: 1, profiles: [...] }` -> perfiles saneados. La ESTRUCTURA de arriba es estricta (version, lista, <= 20
 * perfiles, <= 40 valores por perfil: pasar de ahi es un origen hostil o corrupto y se rechaza entero). Dentro, un perfil o un
 * valor que no vale se DESCARTA (`dropped`) sin tumbar los demas: ids repetidos o con mala forma, nombres vacios, claves ajenas
 * al registro con forma invalida, valores demasiado largos, fechas o `source` invalidos. Un perfil sin ningun valor valido se
 * descarta (no hay nada que reutilizar). El orden se conserva.
 */
export function checkClientProfiles(raw: unknown): ClientProfilesCheck {
  if (!isRecord(raw) || raw.version !== CLIENT_PROFILES_SCHEMA || !Array.isArray(raw.profiles)) return { ok: false };
  if (raw.profiles.length > MAX_CLIENT_PROFILES) return { ok: false };
  const profiles: ClientProfile[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of raw.profiles) {
    if (!isRecord(item) || !isRecord(item.values)) {
      dropped += 1;
      continue;
    }
    const keys = Object.keys(item.values);
    if (keys.length > MAX_PROFILE_VALUES) return { ok: false };
    const id = typeof item.id === "string" && PROFILE_ID_PATTERN.test(item.id) ? item.id : null;
    const name = cleanProfileText(item.name, MAX_PROFILE_NAME_CHARS);
    const updatedAt = cleanProfileIso(item.updatedAt);
    if (id === null || name === null || updatedAt === null || seen.has(id)) {
      dropped += 1;
      continue;
    }
    const values: Record<string, ClientProfileValue> = {};
    for (const key of keys) {
      const value = isStorableProfileKey(key) ? parseProfileValue(item.values[key]) : null;
      if (value === null) dropped += 1;
      else values[key] = value;
    }
    if (Object.keys(values).length === 0) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    profiles.push({ id, name, values, updatedAt });
  }
  return { ok: true, profiles, dropped };
}

/** El JSON canonico de una lista de perfiles (claves en orden, para comparar y para firmar el contenido). */
export function clientProfilesJson(profiles: readonly ClientProfile[]): string {
  return JSON.stringify({
    version: CLIENT_PROFILES_SCHEMA,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      updatedAt: profile.updatedAt,
      values: Object.fromEntries(
        Object.keys(profile.values)
          .sort()
          .map((key) => [key, { value: profile.values[key].value, updatedAt: profile.values[key].updatedAt, source: profile.values[key].source }]),
      ),
    })),
  });
}

/** ¿Dos perfiles tienen el mismo contenido (nombre y valores)? La fecha de cada valor cuenta: es parte de lo que se guardo. */
export function sameClientProfile(a: ClientProfile, b: ClientProfile): boolean {
  return clientProfilesJson([{ ...a, id: "x" }]) === clientProfilesJson([{ ...b, id: "x" }]);
}
