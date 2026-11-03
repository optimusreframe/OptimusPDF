import { DATA_KEY_PATTERN, TODAY_DATA_KEY, getDataKey, isKnownDataKey } from "@/lib/docLibrary/dataKeys";
import type { Language } from "@/lib/i18n";

/**
 * Etiquetas («tags») de los campos de texto de Firmar y de PDF Pro: el MODELO, puro y sin React ni almacenamiento.
 *
 * Una etiqueta dice QUE dato lleva un campo (Dirección, Nombre, Teléfono...). Con ella, los campos que repiten un dato se
 * rellenan solos entre si (`fieldPropagation.ts`) y la memoria de valores (`valueHistory.ts`) sugiere lo que ya se escribio
 * bajo esa misma etiqueta, no bajo el texto del rótulo del PDF (que cambia de un contrato a otro).
 *
 * Dos familias de etiquetas, ambas con forma de `DATA_KEY_PATTERN` para que una plantilla las guarde tal cual como `dataKey`:
 *  - las del registro `docLibrary/dataKeys.ts` (`address`, `insuredName1`, `phone`...);
 *  - las PROPIAS de la persona: `custom.` + un identificador sacado de su nombre (`custom.codigo_de_zona`). El nombre que
 *    ve la persona se guarda aparte (`valueHistory.ts`, `tags`), porque la clave no admite espacios ni tildes.
 *
 * La fecha de hoy (`today`) existe como clave pero NO participa: su valor lo pone la regla `today` de la plantilla y no es
 * un dato de la persona, asi que ni se recuerda ni se propaga.
 */

export const CUSTOM_TAG_PREFIX = "custom.";
/** Largo maximo del nombre visible de una etiqueta propia. */
export const MAX_CUSTOM_TAG_NAME = 40;
/** Etiquetas propias que se guardan. */
export const MAX_CUSTOM_TAGS = 30;

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export function isValidTag(value: unknown): value is string {
  return typeof value === "string" && DATA_KEY_PATTERN.test(value);
}

export function isCustomTag(tag: string): boolean {
  return tag.startsWith(CUSTOM_TAG_PREFIX) && tag.length > CUSTOM_TAG_PREFIX.length;
}

/** Una clave que SI es una etiqueta (del registro o propia); las demas claves del almacen son rótulos antiguos. */
export function isTagKey(key: string): boolean {
  return isKnownDataKey(key) || (isValidTag(key) && isCustomTag(key));
}

/** Lo que se lee de un borrador, una configuracion o un paquete: una etiqueta con forma de clave, o `undefined`. */
export function sanitizeTag(value: unknown): string | undefined {
  return isValidTag(value) ? value : undefined;
}

/** Etiqueta de un campo (`field.tag`) ya saneada. Acepta cualquier cosa con la forma minima de un campo. */
export function tagOf(field: { tag?: unknown } | null | undefined): string | undefined {
  return sanitizeTag(field?.tag);
}

/** La fecha de hoy no se recuerda ni se propaga (la rellena la regla `today`). */
export function isMemoryTag(tag: string): boolean {
  return tag !== TODAY_DATA_KEY;
}

/** Quita `tag` de los campos que lo traen invalido (lectores de borradores y paquetes). Misma lista si no hay nada que quitar. */
export function sanitizeFieldTags<T extends { tag?: unknown }>(fields: readonly T[]): T[] {
  let changed = false;
  const out = fields.map((field) => {
    if (field.tag === undefined || isValidTag(field.tag)) return field;
    changed = true;
    const { tag, ...rest } = field;
    void tag;
    return rest as T;
  });
  return changed ? out : (fields as T[]);
}

/* ------------------------------------------------------------------ *
 * Nombres
 * ------------------------------------------------------------------ */

type Names = { es: string; en: string };

/** Nombres CORTOS de las etiquetas de fabrica (para los chips y la pastilla de la barra). */
const SHORT_NAMES: Readonly<Record<string, Names>> = {
  address: { es: "Dirección", en: "Address" },
  insuredName1: { es: "Nombre", en: "Name" },
  insuredName2: { es: "Nombre 2", en: "Name 2" },
  phone: { es: "Teléfono", en: "Phone" },
  email: { es: "Correo", en: "Email" },
  policyNumber: { es: "N.º de póliza", en: "Policy no." },
  claimNumber: { es: "N.º de reclamo", en: "Claim no." },
  insurer: { es: "Aseguradora", en: "Insurer" },
  claimType: { es: "Tipo de reclamo", en: "Claim type" },
  lossDate: { es: "Fecha de pérdida", en: "Date of loss" },
  [TODAY_DATA_KEY]: { es: "Fecha de hoy", en: "Today's date" },
};

/** Etiquetas que se ofrecen con un toque, en este orden (los chips). */
export const CHIP_TAGS: readonly string[] = [
  "address",
  "insuredName1",
  "phone",
  "email",
  "policyNumber",
  "claimNumber",
  "insurer",
  "lossDate",
];

/** Tipo de campo al que se le puede poner etiqueta con los chips (los demas la traen de una plantilla o no la llevan). */
export type TaggableType = "text" | "date";

/** Un campo de fecha solo admite la fecha de pérdida; uno de texto admite todas (un «Fecha de pérdida: ____» suele ser de texto). */
export function chipTagsFor(type: TaggableType): readonly string[] {
  return type === "date" ? ["lossDate"] : CHIP_TAGS;
}

/** Marcas combinadas (tildes) y caracteres de control o de direccion de texto: construidos por codigo para que no sean invisibles en el fuente. */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const CONTROL_CHARS = new RegExp(
  `[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x200e, 0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`,
  "g",
);

/** Texto aproximado del identificador de una etiqueta propia sin nombre guardado (`custom.codigo_de_zona` -> `codigo de zona`). */
function nameFromKey(tag: string): string {
  return tag.slice(CUSTOM_TAG_PREFIX.length).replace(/[_.]+/g, " ").trim() || tag;
}

/** Nombre visible de una etiqueta. `custom` = los nombres de las propias (`valueHistory.customTagNames`). */
export function tagLabel(tag: string, language: Language, custom: Readonly<Record<string, string>> = {}): string {
  const short = SHORT_NAMES[tag];
  if (short) return short[language];
  const named = custom[tag];
  if (named) return named;
  const registered = getDataKey(tag);
  if (registered) return registered.label[language];
  return isCustomTag(tag) ? nameFromKey(tag) : tag;
}

/** Texto en minusculas y sin tildes, para comparar nombres. */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase();
}

/** Limpia el nombre que escribe la persona: sin controles, espacios colapsados, recortado. `null` si no queda nada. */
export function cleanTagName(raw: string): string | null {
  const clean = raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_TAG_NAME)
    .trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Clave de una etiqueta propia a partir de su nombre: `custom.` + el nombre sin tildes, en minusculas y con `_`
 * (`Código de zona` -> `custom.codigo_de_zona`). Si el nombre ya esta (sin importar mayusculas ni tildes) devuelve la
 * clave que ya tiene; si el identificador choca con el de OTRO nombre, le anade `_2`, `_3`... `null` si el nombre no
 * deja nada (solo simbolos) o ya hay `MAX_CUSTOM_TAGS`.
 */
export function customTagKeyFor(
  name: string,
  existing: Readonly<Record<string, string>>,
): { key: string; created: boolean } | null {
  const clean = cleanTagName(name);
  if (clean === null) return null;
  const wanted = foldText(clean);
  for (const [key, label] of Object.entries(existing)) {
    if (foldText(label) === wanted) return { key, created: false };
  }
  if (Object.keys(existing).length >= MAX_CUSTOM_TAGS) return null;
  const slug = wanted
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40 - CUSTOM_TAG_PREFIX.length - 3)
    .replace(/_+$/g, "");
  if (slug === "") return null;
  const base = `${CUSTOM_TAG_PREFIX}${slug}`;
  let key = base;
  for (let n = 2; hasOwn(existing, key); n += 1) key = `${base}_${n}`;
  return isValidTag(key) ? { key, created: true } : null;
}
