import type { ClientProfile } from "@/lib/autofill/types";
import { CURRENT_CLIENT_PROFILES_SCHEMA, migrateClientProfiles } from "@/lib/backup/migrations/clientProfiles";
import { CLIENT_PROFILES_MODULE, MAX_CLIENT_PROFILES_JSON_BYTES } from "@/lib/backup/modules/moduleSpecs";
import { parseStrictJson } from "@/lib/backup/strictJson";
import { NEWER_VERSION_MESSAGE, PackageError, type PackageModuleInput, type PackageReadResult } from "@/lib/backup/types";
import {
  CLIENT_PROFILES_SCHEMA,
  MAX_CLIENT_PROFILES,
  MAX_PROFILE_NAME_CHARS,
  checkClientProfiles,
  clientProfilesJson,
  hasOwn,
  sameClientProfile,
} from "@/lib/clientProfile/schema";
import { clientProfilesAvailable, newProfileId, readClientProfilesRaw, refreshClientProfiles, replaceClientProfiles } from "@/lib/clientProfile/store";

/**
 * Modulo «Perfiles de cliente» del respaldo (autorrelleno desde documentos, F3): los datos de cada cliente que la persona
 * guardo en este dispositivo (`optimuspdf.clientProfiles`) para reutilizarlos entre documentos.
 *
 * ```
 * client-profiles/profiles.json   { "version": 1, "profiles": [ { id, name, updatedAt, values: { "<clave de dato>": { value, updatedAt, source } } } ] }
 * ```
 *
 * Es PII (nombres, telefonos, direcciones, polizas): la vista previa de exportar lo dice y recomienda cifrar. Importar es
 * «Importar / Reemplazar / Conservar ambos / Omitir» por perfil, y atomico en efecto: un unico guardado de la lista
 * completa, que solo se hace si lo guardado sigue igual que en la vista previa (`changed`) y se deshace si el navegador no
 * deja escribir (cuota). Todo lo que llega pasa por `checkClientProfiles` (el MISMO saneado del almacen): claves ajenas con
 * mala forma, valores largos, fechas o `source` invalidos y ids repetidos se descartan sin tumbar el resto; mas de 20 perfiles
 * o mas de 40 valores en uno es un origen hostil y se rechaza entero.
 */

const PROFILES_PATH = "client-profiles/profiles.json";
export { CLIENT_PROFILES_MODULE, CLIENT_PROFILES_MODULE_SPEC, MAX_CLIENT_PROFILES_JSON_BYTES } from "@/lib/backup/modules/moduleSpecs";
export { MAX_CLIENT_PROFILES };

/* ------------------------------------------------------------------ *
 * Resumen y exportar
 * ------------------------------------------------------------------ */

export type ClientProfileInfo = { id: string; name: string; valueCount: number; updatedAt: string };

export type ClientProfilesSummary = { ok: true; profiles: ClientProfileInfo[]; count: number; values: number } | { ok: false };

/** Los perfiles de este navegador (sin sus valores) para la vista previa de exportar. Sin `localStorage`: `{ ok: false }`. */
export function summarizeClientProfiles(): ClientProfilesSummary {
  if (!clientProfilesAvailable()) return { ok: false };
  const profiles = refreshClientProfiles().map((profile) => ({ id: profile.id, name: profile.name, valueCount: Object.keys(profile.values).length, updatedAt: profile.updatedAt }));
  return { ok: true, profiles, count: profiles.length, values: profiles.reduce((sum, profile) => sum + profile.valueCount, 0) };
}

const encoder = new TextEncoder();

export type ExportClientProfilesOptions = {
  /** Ids de los perfiles que viajan. Sin esto, todos. */
  ids?: readonly string[];
};

/** Modulo del paquete a partir de perfiles ya saneados (puro, sin `localStorage`). */
export function clientProfilesModuleFromProfiles(profiles: readonly ClientProfile[]): PackageModuleInput {
  return {
    name: CLIENT_PROFILES_MODULE,
    schemaVersion: CURRENT_CLIENT_PROFILES_SCHEMA,
    meta: { count: profiles.length, values: profiles.reduce((sum, profile) => sum + Object.keys(profile.values).length, 0) },
    files: [
      {
        path: PROFILES_PATH,
        // copia al Uint8Array del dominio actual (en jsdom el de TextEncoder es ajeno)
        data: new Uint8Array(encoder.encode(clientProfilesJson(profiles))),
        type: "application/json",
      },
    ],
  };
}

/** Modulo con lo que hay ahora en este navegador. Sin `localStorage` lanza `PackageError("unavailable")`. */
export async function exportClientProfiles(options: ExportClientProfilesOptions = {}): Promise<PackageModuleInput> {
  if (!clientProfilesAvailable()) throw new PackageError("unavailable");
  const wanted = options.ids ? new Set(options.ids) : null;
  const profiles = refreshClientProfiles().filter((profile) => (wanted ? wanted.has(profile.id) : true));
  return clientProfilesModuleFromProfiles(profiles);
}

/* ------------------------------------------------------------------ *
 * Planificar la importacion
 * ------------------------------------------------------------------ */

export type ClientProfileItemStatus = "new" | "identical" | "different";
export type ClientProfileDecision = "import" | "replace" | "keepBoth" | "omit";
export type ClientProfilesPlanState = "ok" | "absent" | "newerVersion" | "damaged";

export type ClientProfileImportItem = {
  /** Clave de la decision: `profile:<id>`. */
  key: string;
  id: string;
  status: ClientProfileItemStatus;
  name: string;
  valueCount: number;
  updatedAt: string;
  /** `different`/`identical`: el perfil local con el mismo id. */
  conflictWith?: { id: string; name: string; updatedAt: string; valueCount: number; newer: boolean };
  /** Siempre se puede «Conservar ambos»: la copia entra con un id nuevo. */
  canKeepBoth: boolean;
  /** Lo que se escribiria (ya saneado). */
  payload: ClientProfile;
};

export type ClientProfilesImportPlan = {
  module: typeof CLIENT_PROFILES_MODULE;
  state: ClientProfilesPlanState;
  message?: string;
  items: ClientProfileImportItem[];
  /** `invalid` = perfiles o valores del paquete que no valian y se descartaron. */
  counts: { new: number; identical: number; different: number; invalid: number };
  /** Perfiles guardados hoy y el texto exacto que habia al planificar (la importacion comprueba que sigue igual). */
  local: { count: number; raw: string | null | undefined };
};

function emptyPlan(state: ClientProfilesPlanState, message?: string): ClientProfilesImportPlan {
  return {
    module: CLIENT_PROFILES_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
    local: { count: 0, raw: null },
  };
}

/** Vista previa de importar el modulo «Perfiles de cliente» de un paquete ya leido (`readPackage`). No escribe nada. */
export function planClientProfilesImport(read: PackageReadResult): ClientProfilesImportPlan {
  const data = read.modules.find((module) => module.name === CLIENT_PROFILES_MODULE);
  if (!data) return emptyPlan("absent");
  if (data.status === "newerVersion") return emptyPlan("newerVersion", data.message ?? NEWER_VERSION_MESSAGE);

  const file = data.files.get(PROFILES_PATH);
  let checked: ReturnType<typeof checkClientProfiles>;
  try {
    if (!file || file.status !== "ok" || !file.bytes) throw new PackageError("invalidJson");
    checked = checkClientProfiles(migrateClientProfiles(parseStrictJson(file.bytes, MAX_CLIENT_PROFILES_JSON_BYTES), data.declaredSchemaVersion));
  } catch {
    return emptyPlan("damaged");
  }
  if (!checked.ok) return emptyPlan("damaged");

  const local = refreshClientProfiles();
  const plan = emptyPlan("ok");
  plan.local = { count: local.length, raw: readClientProfilesRaw() };
  plan.counts.invalid = checked.dropped;
  for (const profile of checked.profiles) {
    const mine = local.find((candidate) => candidate.id === profile.id);
    const status: ClientProfileItemStatus = !mine ? "new" : sameClientProfile(mine, profile) ? "identical" : "different";
    plan.items.push({
      key: `profile:${profile.id}`,
      id: profile.id,
      status,
      name: profile.name,
      valueCount: Object.keys(profile.values).length,
      updatedAt: profile.updatedAt,
      ...(mine
        ? { conflictWith: { id: mine.id, name: mine.name, updatedAt: mine.updatedAt, valueCount: Object.keys(mine.values).length, newer: mine.updatedAt > profile.updatedAt } }
        : {}),
      canKeepBoth: true,
      payload: profile,
    });
    plan.counts[status] += 1;
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * Decisiones y limites
 * ------------------------------------------------------------------ */

/**
 * Decision sugerida: lo nuevo se importa; lo identico se omite; lo distinto se REEMPLAZA solo si el del paquete es MAS NUEVO
 * que el local, y si el local es igual de nuevo o mas se CONSERVAN AMBOS. Jamas se pisa un perfil mas nuevo sin una decision
 * explicita.
 */
export function defaultClientProfileDecisions(plan: ClientProfilesImportPlan): Record<string, ClientProfileDecision> {
  const out: Record<string, ClientProfileDecision> = {};
  for (const item of plan.items) {
    if (item.status === "new") out[item.key] = "import";
    else if (item.status === "different") out[item.key] = item.conflictWith && !item.conflictWith.newer ? "replace" : "keepBoth";
    else out[item.key] = "omit";
  }
  return out;
}

type Approved = { item: ClientProfileImportItem; decision: "import" | "replace" | "keepBoth" };

function approvedItems(plan: ClientProfilesImportPlan, decisions: Record<string, ClientProfileDecision | undefined>): Approved[] {
  const out: Approved[] = [];
  for (const item of plan.items) {
    const decision = hasOwn(decisions, item.key) ? decisions[item.key] : undefined;
    if (item.status === "new" && decision === "import") out.push({ item, decision });
    else if (item.status === "different" && item.conflictWith && (decision === "replace" || decision === "keepBoth")) out.push({ item, decision });
  }
  return out;
}

export type ClientProfilesLimitCheck = {
  /** Perfiles aprobados que se escribirian. */
  wanted: number;
  /** Cuantos perfiles habria despues de importar y el maximo. */
  total: number;
  max: number;
  ok: boolean;
};

/** ¿Caben los aprobados? Hoy + los que ENTRAN (importar y conservar ambos; reemplazar no suma) <= 20. */
export function checkClientProfilesLimits(plan: ClientProfilesImportPlan, decisions: Record<string, ClientProfileDecision | undefined>): ClientProfilesLimitCheck {
  const approved = approvedItems(plan, decisions);
  const entering = approved.filter(({ decision }) => decision !== "replace").length;
  const total = plan.local.count + entering;
  return { wanted: approved.length, total, max: MAX_CLIENT_PROFILES, ok: total <= MAX_CLIENT_PROFILES };
}

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

export type ApplyClientProfilesResult =
  | {
      ok: true;
      /** Perfiles guardados (nuevos, sustituidos y conservados aparte). */
      written: number;
      replaced: number;
      keptBoth: number;
      /** Elementos del plan que no se escribieron por decision. */
      skipped: number;
    }
  | { ok: false; reason: "blocked" | "invalid" | "limit" | "changed" | "quota" | "unavailable"; limits?: ClientProfilesLimitCheck };

export type ApplyClientProfilesOptions = {
  /** Texto que se anade al nombre de una copia «Conservar ambos» (p. ej. «(importado)»). */
  copySuffix?: string;
  /** Solo para pruebas: ocurre justo antes de escribir (para provocar cambios concurrentes). */
  beforeWrite?: () => void;
};

/**
 * Escribe SOLO lo que `decisions` aprueba. Todo se REVALIDA aqui con `checkClientProfiles` (la interfaz no puede colar
 * perfiles ni valores): lo que se escribe nunca es el objeto recibido sino lo saneado. Si lo guardado cambio desde la vista
 * previa (otra pestana), no se toca nada (`changed`); si el navegador no deja escribir se deja como estaba (`quota`).
 */
export async function applyClientProfilesImport(
  plan: ClientProfilesImportPlan,
  decisions: Record<string, ClientProfileDecision | undefined>,
  options: ApplyClientProfilesOptions = {},
): Promise<ApplyClientProfilesResult> {
  if (!plan || plan.state !== "ok" || !Array.isArray(plan.items)) return { ok: false, reason: "blocked" };
  const approved = approvedItems(plan, decisions ?? {});
  if (approved.length === 0) return { ok: true, written: 0, replaced: 0, keptBoth: 0, skipped: plan.items.length };
  const limits = checkClientProfilesLimits(plan, decisions ?? {});
  if (!limits.ok) return { ok: false, reason: "limit", limits };

  // Revalidar cada perfil recibido: se reconstruye con el saneado del almacen.
  const clean = new Map<string, ClientProfile>();
  for (const { item } of approved) {
    const checked = checkClientProfiles({ version: CLIENT_PROFILES_SCHEMA, profiles: [item.payload] });
    if (!checked.ok || checked.profiles.length !== 1 || checked.profiles[0].id !== item.id) return { ok: false, reason: "invalid" };
    clean.set(item.key, checked.profiles[0]);
  }

  const current = refreshClientProfiles();
  const next: ClientProfile[] = [...current];
  let replaced = 0;
  let keptBoth = 0;
  for (const { item, decision } of approved) {
    const profile = clean.get(item.key) as ClientProfile;
    if (decision === "replace") {
      const index = next.findIndex((candidate) => candidate.id === profile.id);
      if (index < 0) return { ok: false, reason: "changed" };
      next[index] = profile;
      replaced += 1;
    } else if (decision === "keepBoth") {
      const suffix = options.copySuffix?.trim();
      const name = suffix ? `${profile.name} ${suffix}`.slice(0, MAX_PROFILE_NAME_CHARS).trim() : profile.name;
      next.push({ ...profile, id: newProfileId(), name });
      keptBoth += 1;
    } else {
      if (next.some((candidate) => candidate.id === profile.id)) return { ok: false, reason: "changed" };
      next.push(profile);
    }
  }
  if (next.length > MAX_CLIENT_PROFILES) return { ok: false, reason: "limit" };

  options.beforeWrite?.();
  const outcome = replaceClientProfiles(next, plan.local.raw);
  if (outcome !== "ok") return { ok: false, reason: outcome };
  return { ok: true, written: approved.length, replaced, keptBoth, skipped: plan.items.length - approved.length };
}
