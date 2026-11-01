import type { ClientProfile } from "@/lib/autofill/types";
import { CLIENT_PROFILES_STORAGE_KEY, __resetClientProfilesCacheForTests } from "@/lib/clientProfile/store";
import { clientProfilesJson } from "@/lib/clientProfile/schema";

/** Utilidades de las pruebas del modulo «Perfiles de cliente» del respaldo (no las importa codigo de produccion). Datos INVENTADOS. */

export const KIT_AT = "2026-10-20T10:00:00.000Z";

export function kitProfile(id: string, name: string, values: Record<string, string> = {}, at: string = KIT_AT): ClientProfile {
  const base: Record<string, string> = { insuredName1: name, phone: "555-0100", ...values };
  return {
    id,
    name,
    updatedAt: at,
    values: Object.fromEntries(Object.entries(base).map(([key, value]) => [key, { value, updatedAt: at, source: "extracted" as const }])),
  };
}

/** Deja exactamente estos perfiles guardados (y la cache de la app al dia). */
export function seedProfiles(profiles: readonly ClientProfile[]): void {
  window.localStorage.removeItem(CLIENT_PROFILES_STORAGE_KEY);
  if (profiles.length > 0) window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, clientProfilesJson(profiles));
  __resetClientProfilesCacheForTests();
}

export function wipeProfiles(): void {
  seedProfiles([]);
}

/** Lo guardado ahora, ya como texto para comparar. */
export function storedProfilesRaw(): string | null {
  return window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY);
}
