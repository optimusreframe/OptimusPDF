import {
  DEFAULT_SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
  SIGN_TEMPLATE_FLAGS,
} from "@/app/sign-pdf/signFeatureFlags";
import {
  DEFAULT_EDIT_PDF_FEATURE_FLAGS,
  EDIT_PDF_FEATURE_FLAGS,
  EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY,
} from "@/app/edit-pdf/editFeatureFlags";
import {
  DEFAULT_PRO_FEATURE_FLAGS,
  PRO_FEATURE_FLAGS,
  PRO_FEATURE_FLAGS_STORAGE_KEY,
} from "@/app/pdf-pro/proFeatureFlags";
import {
  CONTEXT_WIDTH,
  DEFAULT_LAYOUT_PREFS,
  PRO_LAYOUT_STORAGE_KEY,
  THUMBS_WIDTH,
} from "@/app/pdf-pro/shell/proLayout";
import { REMEMBERED_SIGNERS_KEY } from "@/app/sign-pdf/templatePrefs";

/*
 * Las claves y los valores de tema, idioma y avisos se repiten AQUI (en vez de importarlos de `theme.tsx`, `i18n.tsx` y
 * `EditPrivacyNotice.tsx`) para que esta lista no arrastre los diccionarios ni componentes de interfaz al paquete que la
 * carga. `settingsRegistry.test.ts` comprueba que siguen siendo identicos a los de su dueno: si alguien anade un idioma o
 * un tema y olvida esta lista, esa prueba falla.
 */
const THEME_STORAGE_KEY = "optimuspdf.theme";
const THEME_CHOICES = ["light", "dark", "system"] as const;
const DEFAULT_THEME = "system";
const LANGUAGE_STORAGE_KEY = "optimuspdf.language";
const LANGUAGES = ["es", "en"] as const;
const DEFAULT_LANGUAGE = "es";
const SIGN_PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";
const EDIT_PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.edit-pdf.privacyNoticeSeen";
const SIDEBAR_STORAGE_KEY = "optimuspdf.sidebarCollapsed";

/**
 * Lista blanca de claves de `localStorage` que viajan en el modulo «Ajustes» del paquete (`docs/PLAN-FIRMA-AGIL.md` §9.3,
 * U4.6). Es la UNICA puerta: lo que no esta aqui ni se exporta ni se importa, y nunca se escribe una clave arbitraria.
 * Cada entrada trae su VALIDADOR (tipo, enumerado, rango, longitud), su valor por defecto y la forma exacta en la que
 * se escribe en `localStorage` (con sus claves acompanantes FIJAS, p. ej. la version de los ajustes de Firmar).
 *
 * Fuera de la lista A PROPOSITO (nunca viajan, aunque esten en `localStorage`):
 *  - `optimuspdf.lastBackup` (la fecha del ultimo respaldo es de CADA dispositivo: importar no debe fingir un respaldo);
 *  - `optimuspdf.recent` (nombres de archivos del cliente), `optimuspdf.valueHistory` (PII: tiene su propio archivo
 *    opcional, `value-history.json`), `optimuspdf.clientProfiles` (PII: tiene su propio modulo, `client-profiles`), `optimuspdf.signTemplates` (plantillas antiguas: las lleva el modulo de la
 *    biblioteca), `optimuspdf.pro.historyHotBytes` / `optimuspdf.pro.viewerRangeMinBytes` (diagnostico y pruebas),
 *    `optimuspdf.pro.panHintSeen` (aviso de una vez de PDF Pro, de cada dispositivo),
 *    las senales entre pestanas (`*.signal`) y todo lo de `sessionStorage`.
 */

export type SettingValue = string | number | boolean | { [name: string]: boolean | number };

export type SettingGroup = "appearance" | "sign" | "edit" | "pro" | "notices";

export type SettingDef = {
  /** Clave de `localStorage` = identificador en el paquete. */
  readonly key: string;
  readonly group: SettingGroup;
  readonly defaultValue: SettingValue;
  /**
   * Interruptores sueltos de un ajuste que es un OBJETO de interruptores (`featureFlags`): la vista previa de la
   * importacion los lista (y decide) uno a uno. Ausente en los demas ajustes (una sola fila).
   */
  readonly flags?: readonly string[];
  /** Todo el ajuste afecta a la privacidad (p. ej. un aviso de privacidad «ya visto»): se omite por defecto al importar. */
  readonly sensitive?: boolean;
  /** Interruptores de un ajuste de objeto que afectan a la privacidad (guardar firmas, trazos en el borrador…). */
  readonly sensitiveFlags?: readonly string[];
  /** Valida lo que viene de un PAQUETE: devuelve el valor saneado y canonico, o `undefined` si no vale. */
  readonly validate: (value: unknown) => SettingValue | undefined;
  /** Valor guardado hoy en `localStorage` (texto) o `undefined` si falta o no vale. */
  readonly fromStorage: (raw: string | null) => SettingValue | undefined;
  /** Pares `[clave, texto]` que se escriben (la clave propia y sus acompanantes fijos). Solo claves de esta lista. */
  readonly toStorage: (value: SettingValue) => ReadonlyArray<readonly [string, string]>;
};

/** Longitud maxima del texto guardado de un ajuste que se lee de `localStorage` (cualquier cosa mayor se ignora). */
export const MAX_STORED_SETTING_LENGTH = 4096;
/** Claves maximas que se miran dentro del objeto de un ajuste (un paquete hostil no hace trabajo de mas). */
const MAX_OBJECT_KEYS = 64;

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string | null): unknown {
  if (raw === null || raw.length === 0 || raw.length > MAX_STORED_SETTING_LENGTH) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function enumDef<T extends string>(
  key: string,
  group: SettingGroup,
  choices: readonly T[],
  defaultValue: T,
): SettingDef {
  const validate = (value: unknown): SettingValue | undefined =>
    typeof value === "string" && (choices as readonly string[]).includes(value) ? value : undefined;
  return {
    key,
    group,
    defaultValue,
    validate,
    fromStorage: (raw) => validate(raw),
    toStorage: (value) => [[key, String(value)]],
  };
}

/** Objeto `{ nombre: booleano }` con SOLO los nombres conocidos; un valor de otro tipo invalida todo el ajuste. */
function flagsDef(
  key: string,
  group: SettingGroup,
  known: readonly string[],
  defaults: Record<string, boolean>,
  companions: (json: string) => ReadonlyArray<readonly [string, string]> = () => [],
  sensitiveFlags: readonly string[] = [],
): SettingDef {
  const validate = (value: unknown): SettingValue | undefined => {
    if (!isPlainRecord(value)) return undefined;
    const names = Object.keys(value);
    if (names.length > MAX_OBJECT_KEYS) return undefined;
    const out: Record<string, boolean> = {};
    for (const name of known) {
      if (!hasOwn(value, name)) continue;
      const flag = value[name];
      if (typeof flag !== "boolean") return undefined;
      out[name] = flag;
    }
    // Los nombres desconocidos se ignoran (un paquete de una version futura puede traer interruptores nuevos).
    return Object.keys(out).length > 0 ? out : undefined;
  };
  return {
    key,
    group,
    defaultValue: { ...defaults },
    flags: known,
    ...(sensitiveFlags.length > 0 ? { sensitiveFlags } : {}),
    validate,
    fromStorage: (raw) => validate(parseJson(raw)),
    toStorage: (value) => {
      const json = JSON.stringify(value);
      return [[key, json], ...companions(json)];
    },
  };
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

const layoutDef: SettingDef = (() => {
  const validate = (value: unknown): SettingValue | undefined => {
    if (!isPlainRecord(value)) return undefined;
    const thumbsWidth = integerInRange(value.thumbsWidth, THUMBS_WIDTH.min, THUMBS_WIDTH.max);
    const contextWidth = integerInRange(value.contextWidth, CONTEXT_WIDTH.min, CONTEXT_WIDTH.max);
    if (
      thumbsWidth === undefined ||
      contextWidth === undefined ||
      typeof value.thumbsOpen !== "boolean" ||
      typeof value.contextOpen !== "boolean"
    ) {
      return undefined;
    }
    return { thumbsWidth, contextWidth, thumbsOpen: value.thumbsOpen, contextOpen: value.contextOpen };
  };
  return {
    key: PRO_LAYOUT_STORAGE_KEY,
    group: "pro",
    defaultValue: { ...DEFAULT_LAYOUT_PREFS },
    validate,
    fromStorage: (raw) => validate(parseJson(raw)),
    toStorage: (value) => [[PRO_LAYOUT_STORAGE_KEY, JSON.stringify(value)]],
  };
})();

/** Interruptor guardado como `"1"` / `"0"` (la barra lateral plegada). */
function oneZeroDef(key: string, group: SettingGroup, defaultValue: boolean): SettingDef {
  return {
    key,
    group,
    defaultValue,
    validate: (value) => (typeof value === "boolean" ? value : undefined),
    fromStorage: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined),
    toStorage: (value) => [[key, value === true ? "1" : "0"]],
  };
}

/** Aviso «ya visto»: solo existe el valor `"1"`; «no visto» es la ausencia de la clave, asi que `false` no se exporta ni se importa. */
function noticeSeenDef(key: string): SettingDef {
  return {
    key,
    group: "notices",
    sensitive: true,
    defaultValue: false,
    validate: (value) => (value === true ? true : undefined),
    fromStorage: (raw) => (raw === "1" ? true : undefined),
    toStorage: () => [[key, "1"]],
  };
}

const signFlagNames: readonly string[] = [...SIGN_PDF_FEATURE_FLAGS, ...SIGN_TEMPLATE_FLAGS];
/** Interruptores de Firmar que afectan a la privacidad (la vista previa de importar los marca y los deja en «Omitir»). */
export const SENSITIVE_SIGN_FLAGS: readonly string[] = ["signaturesInDraft", "signatureVault"];

export const SETTINGS_REGISTRY: readonly SettingDef[] = [
  enumDef(THEME_STORAGE_KEY, "appearance", THEME_CHOICES, DEFAULT_THEME),
  enumDef(LANGUAGE_STORAGE_KEY, "appearance", LANGUAGES, DEFAULT_LANGUAGE),
  oneZeroDef(SIDEBAR_STORAGE_KEY, "appearance", false),
  // «Aplicar plantillas automaticamente» (`autoApplyTemplates`) y «Detectar campos automaticamente» (`autoDetectFields`)
  // viajan con el resto de los interruptores de Firmar. Se escribe tambien la VERSION de los ajustes: sin ella la
  // siguiente carga creeria que son ajustes antiguos y volveria a apagar `completionCertificate`.
  flagsDef(
    SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
    "sign",
    signFlagNames,
    DEFAULT_SIGN_PDF_FEATURE_FLAGS,
    () => [[SIGN_PDF_FEATURE_FLAGS_VERSION_KEY, String(SIGN_PDF_FEATURE_FLAGS_VERSION)]],
    // Guardar firmas en el navegador y guardar los trazos de las firmas recogidas en el borrador: afectan a la privacidad.
    SENSITIVE_SIGN_FLAGS,
  ),
  {
    key: REMEMBERED_SIGNERS_KEY,
    group: "sign",
    defaultValue: 1,
    validate: (value) => (value === 1 || value === 2 ? value : undefined),
    fromStorage: (raw) => (raw === "1" ? 1 : raw === "2" ? 2 : undefined),
    toStorage: (value) => [[REMEMBERED_SIGNERS_KEY, String(value)]],
  },
  flagsDef(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY, "edit", EDIT_PDF_FEATURE_FLAGS, DEFAULT_EDIT_PDF_FEATURE_FLAGS),
  flagsDef(PRO_FEATURE_FLAGS_STORAGE_KEY, "pro", PRO_FEATURE_FLAGS, DEFAULT_PRO_FEATURE_FLAGS),
  layoutDef,
  noticeSeenDef(SIGN_PRIVACY_NOTICE_SEEN_KEY),
  noticeSeenDef(EDIT_PRIVACY_NOTICE_SEEN_KEY),
];

const BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS_REGISTRY.map((def) => [def.key, def]));

/** La definicion de una clave de la lista blanca, o `undefined` (se busca en un `Map`: `__proto__` y compania no existen). */
export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** Claves exportables/importables, en el orden del registro. */
export const SETTINGS_KEYS: readonly string[] = SETTINGS_REGISTRY.map((def) => def.key);

/**
 * TODAS las claves de `localStorage` que `applySettingsImport` puede llegar a escribir: las del registro mas sus
 * acompanantes fijos. Es lo que comprueban las pruebas de «nunca se escribe una clave arbitraria».
 */
export const SETTINGS_WRITABLE_KEYS: readonly string[] = Array.from(
  new Set(
    SETTINGS_REGISTRY.flatMap((def) => def.toStorage(def.defaultValue).map(([key]) => key)),
  ),
);

/** Claves de `localStorage` que existen en la app y que A PROPOSITO no viajan en «Ajustes» (documentado arriba). */
export const SETTINGS_NEVER_EXPORTED_KEYS: readonly string[] = [
  "optimuspdf.lastBackup",
  // F4-fix (H2): la última vez que viajó cada parte del paquete (de cada dispositivo, como `lastBackup`).
  "optimuspdf.lastBackupParts",
  // U4.7: contador de cambios y «Recordármelo luego» del recordatorio de respaldo (de cada dispositivo).
  "optimuspdf.backupReminder",
  "optimuspdf.recent",
  "optimuspdf.valueHistory",
  // Autorrelleno (F3): los perfiles de cliente (PII) tienen su propio modulo del paquete («Perfiles de cliente»).
  "optimuspdf.clientProfiles",
  "optimuspdf.signTemplates",
  "optimuspdf.pro.historyHotBytes",
  "optimuspdf.pro.viewerRangeMinBytes",
  // M5 (GE-01): el aviso de una vez «Para mover la página, activa Desplazar o usa dos dedos» de PDF Pro (de cada dispositivo).
  "optimuspdf.pro.panHintSeen",
  "optimuspdf.sign-drafts.signal",
  // «Calidad de imagen» de Imagenes a PDF / Escanear a PDF: preferencia de CADA dispositivo (pantalla, espacio, red), no viaja.
  "optimuspdf.imageQuality",
  // Escanear a PDF: captura automatica, rafaga y ultimo modo (de CADA dispositivo: camara y pantalla distintas), no viaja.
  "optimuspdf.scan.prefs",
];

/** Comparacion estable de dos valores de ajuste (el objeto con las claves en cualquier orden). */
export function settingValuesEqual(a: SettingValue, b: SettingValue): boolean {
  return canonicalSettingJson(a) === canonicalSettingJson(b);
}

export function canonicalSettingJson(value: SettingValue): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const body = Object.keys(value)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${JSON.stringify(value[name])}`);
  return `{${body.join(",")}}`;
}
