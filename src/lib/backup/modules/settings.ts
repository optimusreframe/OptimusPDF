import { isCustomTag, isValidTag } from "@/lib/fieldTags";
import { VALUE_HISTORY_STORAGE_KEY } from "@/lib/valueHistory";
import { BIDI_CONTROLS } from "@/app/sign-pdf/signVault";
import { CURRENT_SETTINGS_SCHEMA, migrateSettings } from "@/lib/backup/migrations/settings";
import {
  MAX_SETTINGS_JSON_BYTES,
  MAX_VALUE_HISTORY_JSON_BYTES,
  SETTINGS_MODULE,
} from "@/lib/backup/modules/moduleSpecs";
import {
  SETTINGS_REGISTRY,
  settingDef,
  settingValuesEqual,
  type SettingGroup,
  type SettingValue,
} from "@/lib/backup/settingsRegistry";
import { parseStrictJson } from "@/lib/backup/strictJson";
import {
  NEWER_VERSION_MESSAGE,
  PackageError,
  type PackageFileRead,
  type PackageModuleInput,
  type PackageReadResult,
} from "@/lib/backup/types";

/**
 * Modulo «Ajustes» del respaldo (`docs/PLAN-FIRMA-AGIL.md` §9.3, U4.6): las preferencias de ESTE navegador (tema, idioma,
 * interruptores de Firmar/Editar/PDF Pro, diseno de PDF Pro, avisos vistos) y, solo si se pide, el historial de valores.
 *
 * ```
 * settings/settings.json        { "settings": { "<clave de localStorage de la lista blanca>": <valor> } }
 * settings/value-history.json   OPCIONAL, desmarcado por defecto (contiene PII): { "version": 1, "entries": { "<etiqueta>": [{ value, lastUsedAt, uses?, pinned? }] }, "tags"?: { "custom.x": "Nombre" } }
 * ```
 *
 * LISTA BLANCA (`settingsRegistry.ts`): lo que no esta en ella no se exporta ni se escribe jamas; cada clave tiene su
 * validador. Las claves ajenas del paquete se IGNORAN y solo se cuentan (`ignoredKeys`): su nombre no se muestra ni se
 * toca. `optimuspdf.lastBackup` NO viaja. Un valor invalido para una clave conocida aísla SOLO ese ajuste (`invalid`).
 *
 * Importar es «Reemplazar / Omitir» y atomico en efecto: se validan y recomputan TODAS las escrituras antes de tocar
 * nada, se comprueba que `localStorage` no cambio desde la vista previa (`changed`) y, si una escritura falla (cuota),
 * se restauran los valores anteriores. Los almacenes en memoria de la app (tema, idioma, interruptores) leen
 * `localStorage` una sola vez: tras importar hay que RECARGAR la pagina (`reloadRequired`).
 *
 * `value-history.json`: el historial de valores YA existe en la app (`src/lib/valueHistory.ts`, clave
 * `optimuspdf.valueHistory`), asi que el campo esta implementado de verdad, no solo previsto. Se exporta unicamente con
 * `includeValueHistory: true`, se valida con los mismos topes que el almacen (200 etiquetas, 30 valores por etiqueta) y se
 * escribe con SU formato `{ version: 1, entries, tags? }`. Importar su contenido exige una decision propia (`valueHistory:
 * "replace"`), que `defaultSettingsDecisions` deja en «omitir».
 *
 * W3-A1 (memoria por ETIQUETA): la clave de `entries` es la etiqueta del campo (o un rotulo antiguo); cada valor puede traer
 * `uses` (veces usado) y `pinned` (fijado), y `tags` guarda el nombre visible de las etiquetas propias (`custom.*`). Los tres
 * son OPCIONALES: un paquete anterior (sin ellos, hasta 5 valores por etiqueta) se sigue leyendo igual, y uno nuevo que
 * lea una version anterior solo pierde esos campos.
 */

const SETTINGS_PATH = "settings/settings.json";
const HISTORY_PATH = "settings/value-history.json";
export {
  MAX_SETTINGS_JSON_BYTES,
  MAX_VALUE_HISTORY_JSON_BYTES,
  SETTINGS_MODULE,
  SETTINGS_MODULE_SPEC,
} from "@/lib/backup/modules/moduleSpecs";

/* ------------------------------------------------------------------ *
 * Historial de valores: validacion (los topes son los del almacen `valueHistory.ts`)
 * ------------------------------------------------------------------ */

const VALUE_HISTORY_SCHEMA = 1;
/** Etiquetas distintas totales (`MAX_KEYS` de `valueHistory.ts`). */
export const VALUE_HISTORY_MAX_KEYS = 200;
/** Valores por etiqueta (`MAX_ENTRIES_PER_KEY` de `valueHistory.ts`; hasta W3-A1 eran 5). */
export const VALUE_HISTORY_MAX_PER_KEY = 30;
/** Nombre visible de una etiqueta propia (`MAX_CUSTOM_TAG_NAME` de `fieldTags.ts`) y cuantas se guardan (`MAX_CUSTOM_TAGS`). */
const VALUE_HISTORY_MAX_TAG_NAME = 40;
const VALUE_HISTORY_MAX_TAGS = 30;
const VALUE_HISTORY_MIN_VALUE = 2;
const VALUE_HISTORY_MAX_LABEL = 200;
const VALUE_HISTORY_MAX_VALUE = 500;
/** Nombres que, como clave de un objeto normal, pueden tocar el prototipo (`store[key] = ...`): se rechazan. */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** Tope de lo que se lee del `localStorage` local antes de parsear. */
const MAX_LOCAL_VALUE_HISTORY_CHARS = 2 * 1024 * 1024;

export type ValueHistoryEntry = { value: string; lastUsedAt: string; uses?: number; pinned?: boolean };
export type ValueHistoryEntries = Record<string, ValueHistoryEntry[]>;
/** Nombre visible de cada etiqueta propia (`custom.*`). */
export type ValueHistoryTags = Record<string, string>;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max * 2) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(BIDI_CONTROLS, "").trim();
  return clean.length > 0 && clean.length <= max ? clean : null;
}

function cleanIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export type ValueHistoryCheck =
  | { ok: true; entries: ValueHistoryEntries; tags: ValueHistoryTags; labels: number; values: number; dropped: number }
  | { ok: false };

/** Etiquetas propias del paquete: clave `custom.*` con forma de clave y nombre limpio; lo que no vale se descarta. */
function checkTagNames(raw: unknown): ValueHistoryTags {
  const out: ValueHistoryTags = {};
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (Object.keys(out).length >= VALUE_HISTORY_MAX_TAGS) break;
    const name = cleanText(raw[key], VALUE_HISTORY_MAX_TAG_NAME);
    if (name === null || FORBIDDEN_LABELS.has(key) || !isCustomTag(key) || !isValidTag(key)) continue;
    out[key] = name;
  }
  return out;
}

/**
 * `{ version: 1, entries }` -> historial saneado. La estructura de arriba es estricta (version, objeto, <= 200
 * etiquetas, <= 30 valores por etiqueta); dentro, un valor o una etiqueta que no vale se DESCARTA (`dropped`) sin tumbar
 * el resto. Etiquetas `__proto__`/`constructor`/`prototype` y valores demasiado largos no entran.
 */
export function checkValueHistory(raw: unknown): ValueHistoryCheck {
  if (!isRecord(raw) || raw.version !== VALUE_HISTORY_SCHEMA || !isRecord(raw.entries)) return { ok: false };
  const labels = Object.keys(raw.entries);
  if (labels.length > VALUE_HISTORY_MAX_KEYS) return { ok: false };
  const entries: ValueHistoryEntries = {};
  let values = 0;
  let dropped = 0;
  for (const label of labels) {
    const list = raw.entries[label];
    if (!Array.isArray(list) || list.length > VALUE_HISTORY_MAX_PER_KEY) return { ok: false };
    const cleanLabel = cleanText(label, VALUE_HISTORY_MAX_LABEL);
    if (cleanLabel === null || FORBIDDEN_LABELS.has(cleanLabel) || hasOwn(entries, cleanLabel)) {
      dropped += list.length || 1;
      continue;
    }
    const kept: ValueHistoryEntry[] = [];
    for (const item of list) {
      const value = isRecord(item) ? cleanText(item.value, VALUE_HISTORY_MAX_VALUE) : null;
      const lastUsedAt = isRecord(item) ? cleanIso(item.lastUsedAt) : null;
      if (value === null || value.length < VALUE_HISTORY_MIN_VALUE || lastUsedAt === null || kept.some((k) => k.value === value)) {
        dropped += 1;
        continue;
      }
      // `uses` y `pinned` son opcionales (W3-A1): un valor raro se ignora, no tumba la entrada.
      const uses = isRecord(item) && Number.isInteger(item.uses) && (item.uses as number) > 1 ? Math.min(item.uses as number, 1_000_000) : undefined;
      const pinned = isRecord(item) && item.pinned === true;
      kept.push({ value, lastUsedAt, ...(uses !== undefined ? { uses } : {}), ...(pinned ? { pinned: true } : {}) });
    }
    if (kept.length > 0) {
      entries[cleanLabel] = kept;
      values += kept.length;
    }
  }
  return { ok: true, entries, tags: checkTagNames(raw.tags), labels: Object.keys(entries).length, values, dropped };
}

function valueHistoryJson(entries: ValueHistoryEntries, tags: ValueHistoryTags = {}): string {
  const sorted: ValueHistoryEntries = {};
  for (const label of Object.keys(entries).sort()) sorted[label] = entries[label];
  const sortedTags: ValueHistoryTags = {};
  for (const key of Object.keys(tags).sort()) sortedTags[key] = tags[key];
  return JSON.stringify({ version: VALUE_HISTORY_SCHEMA, entries: sorted, ...(Object.keys(sortedTags).length > 0 ? { tags: sortedTags } : {}) });
}

function sameValueHistory(a: ValueHistoryEntries, aTags: ValueHistoryTags, b: ValueHistoryEntries, bTags: ValueHistoryTags): boolean {
  return valueHistoryJson(a, aTags) === valueHistoryJson(b, bTags);
}

/* ------------------------------------------------------------------ *
 * Almacen
 * ------------------------------------------------------------------ */

export type SettingsStorageOptions = {
  /** `Storage` a usar (pruebas); por defecto `window.localStorage`. */
  storage?: Storage;
};

function getStorage(options: SettingsStorageOptions): Storage | null {
  if (options.storage) return options.storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: Storage, key: string): string | null | undefined {
  try {
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

function jsonBytes(text: string): Uint8Array {
  // copia al Uint8Array del dominio actual (en jsdom el de TextEncoder es ajeno)
  return new Uint8Array(encoder.encode(text));
}

/** Modulo del paquete a partir de valores ya saneados (puro, sin `localStorage`). */
export function settingsModuleFromValues(
  values: Readonly<Record<string, SettingValue>>,
  valueHistory?: ValueHistoryEntries,
  valueHistoryTags?: ValueHistoryTags,
): PackageModuleInput {
  const ordered: Record<string, SettingValue> = {};
  for (const def of SETTINGS_REGISTRY) {
    if (!hasOwn(values, def.key)) continue;
    const valid = def.validate(values[def.key]);
    if (valid !== undefined) ordered[def.key] = valid;
  }
  const files = [
    {
      path: SETTINGS_PATH,
      data: jsonBytes(JSON.stringify({ settings: ordered })),
      type: "application/json",
    },
  ];
  const includesValueHistory = valueHistory !== undefined && Object.keys(valueHistory).length > 0;
  if (includesValueHistory) {
    files.push({
      path: HISTORY_PATH,
      data: jsonBytes(valueHistoryJson(valueHistory as ValueHistoryEntries, valueHistoryTags)),
      type: "application/json",
    });
  }
  return {
    name: SETTINGS_MODULE,
    schemaVersion: CURRENT_SETTINGS_SCHEMA,
    meta: { count: Object.keys(ordered).length, includesValueHistory },
    files,
  };
}

/** Lo que hay hoy en `localStorage` de la lista blanca, ya validado (una clave ausente o rota no aparece). */
export function readLocalSettings(storage: Storage): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const def of SETTINGS_REGISTRY) {
    const raw = readRaw(storage, def.key);
    const value = raw === undefined ? undefined : def.fromStorage(raw);
    if (value !== undefined) out[def.key] = value;
  }
  return out;
}

function readLocalValueHistory(storage: Storage): { entries: ValueHistoryEntries; tags: ValueHistoryTags; raw: string | null } {
  const raw = readRaw(storage, VALUE_HISTORY_STORAGE_KEY) ?? null;
  if (raw === null || raw.length > MAX_LOCAL_VALUE_HISTORY_CHARS) return { entries: {}, tags: {}, raw };
  try {
    const checked = checkValueHistory(JSON.parse(raw));
    return { entries: checked.ok ? checked.entries : {}, tags: checked.ok ? checked.tags : {}, raw };
  } catch {
    return { entries: {}, tags: {}, raw };
  }
}

export type ExportSettingsOptions = SettingsStorageOptions & {
  /** Incluir `value-history.json` (PII: nombres, polizas, direcciones). DESMARCADO por defecto. */
  includeValueHistory?: boolean;
};

/**
 * Modulo «Ajustes» con lo que hay ahora en este navegador. Sin `localStorage` lanza `PackageError("unavailable")`.
 * Solo viajan las claves de la lista blanca que estan guardadas y son validas; el historial de valores, solo con
 * `includeValueHistory: true`.
 */
export async function exportSettings(options: ExportSettingsOptions = {}): Promise<PackageModuleInput> {
  const storage = getStorage(options);
  if (!storage) throw new PackageError("unavailable");
  const values = readLocalSettings(storage);
  const history = options.includeValueHistory === true ? readLocalValueHistory(storage) : undefined;
  return settingsModuleFromValues(values, history?.entries, history?.tags);
}

/** Resumen previo a exportar (sin leer el contenido de los valores de PII): cuantas claves y cuantas etiquetas de historial. */
export function summarizeSettings(options: SettingsStorageOptions = {}): {
  ok: boolean;
  keys: number;
  valueHistoryLabels: number;
  valueHistoryValues: number;
} {
  const storage = getStorage(options);
  if (!storage) return { ok: false, keys: 0, valueHistoryLabels: 0, valueHistoryValues: 0 };
  const { entries } = readLocalValueHistory(storage);
  return {
    ok: true,
    keys: Object.keys(readLocalSettings(storage)).length,
    valueHistoryLabels: Object.keys(entries).length,
    valueHistoryValues: Object.values(entries).reduce((sum, list) => sum + list.length, 0),
  };
}

/* ------------------------------------------------------------------ *
 * Planificar la importacion
 * ------------------------------------------------------------------ */

export type SettingsItemStatus = "new" | "identical" | "different" | "invalid";
export type SettingsPlanState = "ok" | "absent" | "newerVersion" | "damaged";

export type SettingsImportItem = {
  /** Clave de la lista blanca (nunca una clave del paquete que no este en ella). */
  key: string;
  group: SettingGroup;
  status: SettingsItemStatus;
  reason?: "invalidValue";
  /** Lo que se escribiria (validado); ausente si `invalid`. */
  value?: SettingValue;
  /** Valor actual, si hay y es valido. */
  local?: SettingValue;
  /** Texto de `localStorage` al planificar: aplicar comprueba que sigue igual. */
  localRaw: string | null;
};

export type ValueHistoryPlan = {
  status: "absent" | "new" | "identical" | "different" | "invalid";
  labels: number;
  values: number;
  dropped: number;
  /** Lo que se escribiria; ausente si `absent`/`invalid`. */
  entries?: ValueHistoryEntries;
  /** Nombres de las etiquetas propias que traeria (W3-A1); ausente si no trae ninguna. */
  tags?: ValueHistoryTags;
  localRaw: string | null;
};

export type SettingsImportPlan = {
  module: typeof SETTINGS_MODULE;
  state: SettingsPlanState;
  message?: string;
  items: SettingsImportItem[];
  /** Claves del paquete que no estan en la lista blanca: se ignoran (solo se cuentan). */
  ignoredKeys: number;
  valueHistory: ValueHistoryPlan;
  counts: { new: number; identical: number; different: number; invalid: number };
};

function emptyPlan(state: SettingsPlanState, message?: string): SettingsImportPlan {
  return {
    module: SETTINGS_MODULE,
    state,
    ...(message ? { message } : {}),
    items: [],
    ignoredKeys: 0,
    valueHistory: { status: "absent", labels: 0, values: 0, dropped: 0, localRaw: null },
    counts: { new: 0, identical: 0, different: 0, invalid: 0 },
  };
}

function fileOk(read: PackageReadResult["modules"][number], path: string): PackageFileRead | null {
  const file = read.files.get(path);
  return file && file.status === "ok" && file.bytes ? file : null;
}

/**
 * Vista previa de importar el modulo «Ajustes» de un paquete ya leido (`readPackage`). No escribe nada. Cada clave de la
 * lista blanca queda «Nuevo» (no esta guardada hoy), «Ya lo tienes (idéntico)», «Distinto» o `invalid`.
 */
export function planSettingsImport(read: PackageReadResult, options: SettingsStorageOptions = {}): SettingsImportPlan {
  const data = read.modules.find((m) => m.name === SETTINGS_MODULE);
  if (!data) return emptyPlan("absent");
  if (data.status === "newerVersion") return emptyPlan("newerVersion", data.message ?? NEWER_VERSION_MESSAGE);

  const storage = getStorage(options);
  const file = fileOk(data, SETTINGS_PATH);
  let packed: Record<string, unknown>;
  try {
    if (!file?.bytes) throw new PackageError("invalidJson");
    const migrated = migrateSettings(parseStrictJson(file.bytes, MAX_SETTINGS_JSON_BYTES), data.declaredSchemaVersion);
    if (!isRecord(migrated) || !isRecord(migrated.settings)) throw new PackageError("invalidJson");
    packed = migrated.settings;
  } catch {
    return emptyPlan("damaged");
  }

  const plan = emptyPlan("ok");
  const known = new Set<string>();
  for (const key of Object.keys(packed)) {
    if (!settingDef(key)) plan.ignoredKeys += 1;
  }
  for (const def of SETTINGS_REGISTRY) {
    if (!hasOwn(packed, def.key)) continue;
    known.add(def.key);
    const localRaw = storage ? (readRaw(storage, def.key) ?? null) : null;
    const local = localRaw === null ? undefined : def.fromStorage(localRaw);
    const value = def.validate(packed[def.key]);
    if (value === undefined) {
      plan.items.push({
        key: def.key,
        group: def.group,
        status: "invalid",
        reason: "invalidValue",
        ...(local !== undefined ? { local } : {}),
        localRaw,
      });
      continue;
    }
    plan.items.push({
      key: def.key,
      group: def.group,
      status: local === undefined ? "new" : settingValuesEqual(local, value) ? "identical" : "different",
      value,
      ...(local !== undefined ? { local } : {}),
      localRaw,
    });
  }

  // Historial de valores (opcional)
  const historyFile = data.files.get(HISTORY_PATH);
  if (historyFile) {
    const localRaw = storage ? (readRaw(storage, VALUE_HISTORY_STORAGE_KEY) ?? null) : null;
    let checked: ValueHistoryCheck = { ok: false };
    if (historyFile.status === "ok" && historyFile.bytes) {
      try {
        const migrated = migrateSettings(
          parseStrictJson(historyFile.bytes, MAX_VALUE_HISTORY_JSON_BYTES),
          data.declaredSchemaVersion,
        );
        checked = checkValueHistory(migrated);
      } catch {
        checked = { ok: false };
      }
    }
    if (!checked.ok) {
      plan.valueHistory = { status: "invalid", labels: 0, values: 0, dropped: 0, localRaw };
    } else if (checked.labels === 0) {
      plan.valueHistory = { status: "absent", labels: 0, values: 0, dropped: checked.dropped, localRaw };
    } else {
      const local = storage ? readLocalValueHistory(storage) : { entries: {}, tags: {} };
      const hasLocal = Object.keys(local.entries).length > 0;
      plan.valueHistory = {
        status: !hasLocal ? "new" : sameValueHistory(local.entries, local.tags, checked.entries, checked.tags) ? "identical" : "different",
        labels: checked.labels,
        values: checked.values,
        dropped: checked.dropped,
        entries: checked.entries,
        ...(Object.keys(checked.tags).length > 0 ? { tags: checked.tags } : {}),
        localRaw,
      };
    }
  }

  for (const item of plan.items) plan.counts[item.status] += 1;
  return plan;
}

/** `QuotaExceededError` de `localStorage` (con los nombres y codigos que usan los navegadores). */
function isStorageQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

export type SettingsDecisions = {
  /** Decisión de TODOS los ajustes que cambiarían (salvo los que `rows` decida aparte). */
  settings: "replace" | "omit";
  valueHistory?: "replace" | "omit";
  /** Decisión por ajuste (`SettingsRow.id`); lo que no esté aquí sigue a `settings`. */
  rows?: Record<string, "replace" | "omit">;
};

/**
 * Una fila de la vista previa: UN ajuste que cambiaría (la clave entera, o un interruptor suelto de un ajuste de objeto
 * como los de Firmar). Se deriva siempre de los `items` del plan (nunca se confía en una lista aparte que pudiera venir
 * manipulada de la interfaz).
 */
export type SettingsRow = {
  /** `clave` o `clave#interruptor`: es lo que se usa en `SettingsDecisions.rows`. */
  id: string;
  key: string;
  flag?: string;
  group: SettingGroup;
  /** `new`: hoy no está guardado; `different`: está guardado con otro valor. */
  status: "new" | "different";
  /** Valor de ahora (el guardado o, si no hay, el de por defecto) y si de verdad está guardado. */
  local: SettingValue;
  localStored: boolean;
  /** Lo que traería el paquete. */
  value: SettingValue;
  /** Afecta a la privacidad (guardar firmas, avisos de privacidad…): por defecto se OMITE. */
  sensitive: boolean;
};

function isObjectValue(value: SettingValue | undefined): value is { [name: string]: boolean | number } {
  return typeof value === "object" && value !== null;
}

/** Las filas de UN ajuste del plan que cambiarían (vacío si no cambia nada visible, p. ej. valores ya iguales al de por defecto). */
function rowsOfItem(item: SettingsImportItem): SettingsRow[] {
  if (item.status !== "new" && item.status !== "different") return [];
  const def = typeof item.key === "string" ? settingDef(item.key) : undefined;
  if (!def || item.value === undefined) return [];
  const sensitiveWhole = def.sensitive === true;
  if (def.flags && isObjectValue(item.value)) {
    const rows: SettingsRow[] = [];
    const localObject = isObjectValue(item.local) ? item.local : undefined;
    const defaults = isObjectValue(def.defaultValue) ? def.defaultValue : {};
    for (const flag of def.flags) {
      if (!hasOwn(item.value, flag)) continue;
      const wanted = item.value[flag];
      const stored = localObject !== undefined && hasOwn(localObject, flag);
      const current = stored ? (localObject as Record<string, boolean | number>)[flag] : defaults[flag];
      if (current === wanted) continue;
      rows.push({
        id: `${item.key}#${flag}`,
        key: item.key,
        flag,
        group: item.group,
        status: stored ? "different" : "new",
        local: current ?? false,
        localStored: stored,
        value: wanted,
        sensitive: sensitiveWhole || (def.sensitiveFlags?.includes(flag) ?? false),
      });
    }
    return rows;
  }
  return [
    {
      id: item.key,
      key: item.key,
      group: item.group,
      status: item.status,
      local: item.local ?? def.defaultValue,
      localStored: item.local !== undefined,
      value: item.value,
      sensitive: sensitiveWhole,
    },
  ];
}

/** Todos los ajustes que cambiarían, uno por fila (para la vista previa «clave legible → valor actual → valor del paquete»). */
export function settingsRows(plan: Pick<SettingsImportPlan, "items">): SettingsRow[] {
  return plan.items.flatMap(rowsOfItem);
}

/**
 * Decisión sugerida: los ajustes se reemplazan si hay algo nuevo o distinto (si no, nada que hacer), SALVO los que afectan
 * a la privacidad (guardar firmas, avisos de privacidad «ya vistos»), que se OMITEN hasta que la persona los pida; y el
 * historial de valores se OMITE siempre (PII: hay que pedirlo a propósito).
 */
export function defaultSettingsDecisions(plan: SettingsImportPlan): SettingsDecisions {
  const changes = plan.items.some((item) => item.status === "new" || item.status === "different");
  const sensitive = settingsRows(plan).filter((row) => row.sensitive);
  return {
    settings: changes ? "replace" : "omit",
    valueHistory: "omit",
    ...(sensitive.length > 0 ? { rows: Object.fromEntries(sensitive.map((row) => [row.id, "omit" as const])) } : {}),
  };
}

/** Lo que se escribiría de cada ajuste con estas decisiones (por fila; `replace` de todas las filas = el valor del paquete tal cual). */
function resolveSettingWrites(plan: Pick<SettingsImportPlan, "items">, decisions: SettingsDecisions | undefined): Array<{ item: SettingsImportItem; value: unknown }> {
  const out: Array<{ item: SettingsImportItem; value: unknown }> = [];
  if (!decisions) return out;
  const rowDecisions = decisions.rows !== undefined && typeof decisions.rows === "object" && decisions.rows !== null ? decisions.rows : {};
  const decide = (id: string): "replace" | "omit" => {
    const own = hasOwn(rowDecisions, id) ? rowDecisions[id] : undefined;
    return own === "replace" || own === "omit" ? own : decisions.settings;
  };
  for (const item of plan.items) {
    if (item.status !== "new" && item.status !== "different") continue;
    const rows = rowsOfItem(item);
    if (rows.length === 0) {
      // Sin filas visibles (todo igual al valor de ahora o al de por defecto): sigue la decisión general.
      // Un objeto de interruptores del paquete que trae menos claves que los de ahora no debe borrar los demas: se fusiona.
      if (decisions.settings === "replace") out.push({ item, value: isObjectValue(item.local) && isObjectValue(item.value) ? { ...item.local, ...item.value } : item.value });
      continue;
    }
    const chosen = rows.filter((row) => decide(row.id) === "replace");
    if (chosen.length === 0) continue;
    if (chosen.length === rows.length || rows[0].flag === undefined) {
      out.push({ item, value: item.value });
      continue;
    }
    // Ajuste de interruptores con solo ALGUNOS elegidos: lo de ahora más los elegidos (nunca se pisan los demás).
    const base = isObjectValue(item.local) ? { ...item.local } : {};
    for (const row of chosen) (base as Record<string, boolean | number>)[row.flag as string] = (item.value as Record<string, boolean | number>)[row.flag as string];
    out.push({ item, value: base });
  }
  return out;
}

/** Cuántos ajustes (claves) se escribirían con estas decisiones: lo que cuenta el botón «Importar N elementos». */
export function countSettingWrites(plan: Pick<SettingsImportPlan, "items">, decisions: SettingsDecisions): number {
  return resolveSettingWrites(plan, decisions).length;
}

/* ------------------------------------------------------------------ *
 * Aplicar
 * ------------------------------------------------------------------ */

export type ApplySettingsResult =
  | {
      ok: true;
      /** Ajustes de la lista blanca escritos (nuevos o distintos). */
      written: number;
      /** Ajustes del paquete que no se escribieron (identicos, invalidos u omitidos). */
      skipped: number;
      /** Se escribio el historial de valores. */
      valueHistory: boolean;
      /** Los almacenes en memoria (tema, idioma, interruptores) no se enteran: hay que recargar la pagina. */
      reloadRequired: boolean;
    }
  | { ok: false; reason: "blocked" | "invalid" | "changed" | "quota" | "unavailable" };

type Write = { key: string; text: string; /** Texto que debe tener ahora `localStorage` (el de la vista previa); `undefined` = no se comprueba. */ expectRaw?: { raw: string | null } };

function announceValueHistoryChange(): void {
  // `valueHistory.ts` escucha `storage` para releer su cache: este aviso sintetico solo llega a esta pestana.
  try {
    if (typeof window !== "undefined" && typeof StorageEvent === "function") {
      window.dispatchEvent(new StorageEvent("storage", { key: VALUE_HISTORY_STORAGE_KEY }));
    }
  } catch {
    // Sin eventos: la cache se refresca al recargar.
  }
}

/**
 * Escribe SOLO lo que `decisions` aprueba (`replace`; `omit` o ausencia = no se toca). Todo se revalida AQUI con los
 * validadores de la lista blanca (la interfaz no puede colar claves ni valores), se comprueba que `localStorage` sigue
 * como en la vista previa y, ante un fallo de escritura, se restauran los valores anteriores.
 */
export async function applySettingsImport(
  plan: SettingsImportPlan,
  decisions: SettingsDecisions,
  options: SettingsStorageOptions = {},
): Promise<ApplySettingsResult> {
  if (!plan || plan.state !== "ok" || !Array.isArray(plan.items)) return { ok: false, reason: "blocked" };
  const storage = getStorage(options);
  if (!storage) return { ok: false, reason: "unavailable" };

  const writes: Write[] = [];
  const settingKeys = new Set<string>();
  let settingsWritten = 0;
  {
    for (const { item, value: wanted } of resolveSettingWrites(plan, decisions)) {
      const def = typeof item.key === "string" ? settingDef(item.key) : undefined;
      if (!def || settingKeys.has(item.key)) return { ok: false, reason: "invalid" };
      const value = def.validate(wanted);
      if (value === undefined) return { ok: false, reason: "invalid" };
      settingKeys.add(item.key);
      settingsWritten += 1;
      const pairs = def.toStorage(value);
      pairs.forEach(([key, text], index) => {
        // Solo la clave PROPIA se compara con la vista previa; los acompanantes fijos (version) se reescriben sin mas.
        writes.push({ key, text, ...(index === 0 ? { expectRaw: { raw: item.localRaw } } : {}) });
      });
    }
  }
  let writesHistory = false;
  if (decisions?.valueHistory === "replace") {
    const history = plan.valueHistory;
    if (history && (history.status === "new" || history.status === "different")) {
      const checked = checkValueHistory({ version: VALUE_HISTORY_SCHEMA, entries: history.entries, tags: history.tags });
      if (!checked.ok || checked.labels === 0) return { ok: false, reason: "invalid" };
      writesHistory = true;
      writes.push({
        key: VALUE_HISTORY_STORAGE_KEY,
        text: valueHistoryJson(checked.entries, checked.tags),
        expectRaw: { raw: history.localRaw },
      });
    }
  }
  const skipped = plan.items.length - settingsWritten;
  if (writes.length === 0) {
    return { ok: true, written: 0, skipped, valueHistory: false, reloadRequired: false };
  }

  // Los valores guardados deben ser los que vio la vista previa (otra pestana pudo cambiarlos).
  const previous = new Map<string, string | null>();
  for (const write of writes) {
    const now = readRaw(storage, write.key);
    if (now === undefined) return { ok: false, reason: "unavailable" };
    if (write.expectRaw !== undefined && now !== write.expectRaw.raw) return { ok: false, reason: "changed" };
    if (!previous.has(write.key)) previous.set(write.key, now);
  }

  const touched: string[] = [];
  try {
    for (const write of writes) {
      touched.push(write.key);
      storage.setItem(write.key, write.text);
    }
  } catch (error) {
    // Cuota llena o almacenamiento bloqueado: se deja todo como estaba.
    for (const key of touched) {
      const before = previous.get(key) ?? null;
      try {
        if (before === null) storage.removeItem(key);
        else storage.setItem(key, before);
      } catch {
        // Nada mas que hacer con esta clave.
      }
    }
    return { ok: false, reason: isStorageQuotaError(error) ? "quota" : "unavailable" };
  }
  if (writesHistory) announceValueHistoryChange();
  return { ok: true, written: settingsWritten, skipped, valueHistory: writesHistory, reloadRequired: true };
}
