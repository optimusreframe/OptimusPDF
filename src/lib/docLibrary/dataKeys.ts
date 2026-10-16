/**
 * Registro de «orígenes de dato» (`dataKey`) de los campos de texto de una plantilla (Fase 2, U2.2).
 *
 * Una plantilla solo GUARDA el `dataKey` como dato: de dónde saldrá el valor (Nombre del asegurado, teléfono…). Quien lo
 * USA es la Fase 3 (autollenado). Por eso la validación de una plantilla NO exige que la clave esté en este registro
 * (solo que tenga forma de clave): así el registro puede crecer sin invalidar plantillas ya guardadas, y una plantilla
 * exportada con una clave de una versión futura se conserva tal cual.
 *
 * El registro es extensible: `registerDataKey` añade (o reemplaza) una definición; la lista de fábrica no se pierde.
 */

export type DataKeyDefinition = {
  /** Clave estable (la que se guarda en la plantilla). */
  key: string;
  /** Texto para la interfaz. */
  label: { es: string; en: string };
  /** Tipo de campo con el que suele rellenarse. */
  fieldType: "text" | "date";
  /** Expresiones (minúsculas, sin tildes) que, dentro de la etiqueta detectada de un campo, sugieren esta clave. */
  hints: readonly RegExp[];
};

/** Forma válida de una clave: empieza con letra, luego letras, cifras, `_` o `.`; hasta 40 caracteres. */
export const DATA_KEY_PATTERN = /^[a-z][A-Za-z0-9_.]{0,39}$/;

/** Clave de la fecha de firma (se rellena sola con `rule: "today"`). */
export const TODAY_DATA_KEY = "today";

const BUILT_IN: readonly DataKeyDefinition[] = [
  { key: "insuredName1", label: { es: "Nombre del asegurado 1", en: "Insured name 1" }, fieldType: "text", hints: [/\b(insured|policy ?holder|client|customer|owner|print(ed)? name)\b/, /\b(asegurado|cliente|propietario|nombre completo|nombre)\b/] },
  { key: "insuredName2", label: { es: "Nombre del asegurado 2", en: "Insured name 2" }, fieldType: "text", hints: [/\b(co-?insured|co-?client|second insured|spouse)\b/, /\b(co-?asegurado|segundo asegurado|conyuge)\b/] },
  { key: "phone", label: { es: "Teléfono", en: "Phone" }, fieldType: "text", hints: [/\b(phone|tel|telephone|cell|mobile)\b/, /\b(telefono|celular|movil)\b/] },
  { key: "email", label: { es: "Correo electrónico", en: "Email" }, fieldType: "text", hints: [/\be-?mail\b/, /\bcorreo\b/] },
  { key: "address", label: { es: "Dirección", en: "Address" }, fieldType: "text", hints: [/\b(address|street|property|loss location)\b/, /\b(direccion|domicilio|calle|propiedad)\b/] },
  { key: "insurer", label: { es: "Aseguradora", en: "Insurance company" }, fieldType: "text", hints: [/\b(insurer|insurance (company|carrier)|carrier)\b/, /\b(aseguradora|compania de seguros)\b/] },
  { key: "policyNumber", label: { es: "N.º de póliza", en: "Policy number" }, fieldType: "text", hints: [/\bpolic(y)? ?(no|number|#)/, /\b(poliza|no\.? de poliza)\b/] },
  { key: "claimNumber", label: { es: "N.º de reclamo", en: "Claim number" }, fieldType: "text", hints: [/\bclaim ?(no|number|#)/, /\b(reclamo|siniestro)\b.*\b(no|numero|n)\b/, /\bn(\.?\s?[º°o]\.?|umero)? de (reclamo|siniestro)\b/] },
  { key: "claimType", label: { es: "Tipo de reclamo", en: "Claim type" }, fieldType: "text", hints: [/\b(type of (loss|claim)|claim type|cause of loss)\b/, /\b(tipo de (reclamo|perdida|siniestro))\b/] },
  { key: "lossDate", label: { es: "Fecha de pérdida", en: "Date of loss" }, fieldType: "date", hints: [/\b(date of loss|loss date|d\.?o\.?l\.?)\b/, /\bfecha de (la )?(perdida|siniestro)\b/] },
  { key: TODAY_DATA_KEY, label: { es: "Fecha de hoy", en: "Today's date" }, fieldType: "date", hints: [/\b(date|dated|date signed)\b/, /\bfecha\b/] },
];

const registry = new Map<string, DataKeyDefinition>(BUILT_IN.map((definition) => [definition.key, definition]));

/** Las definiciones registradas, en orden de alta (primero las de fábrica). */
export function getDataKeys(): DataKeyDefinition[] {
  return [...registry.values()];
}

export function getDataKey(key: string): DataKeyDefinition | undefined {
  return registry.get(key);
}

export function isKnownDataKey(key: string): boolean {
  return registry.has(key);
}

export function isValidDataKey(key: unknown): key is string {
  return typeof key === "string" && DATA_KEY_PATTERN.test(key);
}

/** Añade o reemplaza una definición. Lanza si la clave no tiene forma válida. */
export function registerDataKey(definition: DataKeyDefinition): void {
  if (!DATA_KEY_PATTERN.test(definition.key)) throw new RangeError("dataKey inválida");
  registry.set(definition.key, definition);
}

/** Solo para pruebas: deja el registro de fábrica. */
export function __resetDataKeysForTests(): void {
  registry.clear();
  for (const definition of BUILT_IN) registry.set(definition.key, definition);
}

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Sugiere la clave de un campo a partir de la etiqueta detectada en el documento. Solo es una SUGERENCIA (la Fase 3 la
 * confirma con su diccionario): `undefined` si nada encaja con claridad. Las claves más específicas se prueban primero
 * (p. ej. «co-insured» antes que «insured»; «date of loss» antes que «date»).
 */
export function suggestDataKey(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const text = plain(label).trim();
  if (text === "") return undefined;
  const order = ["insuredName2", "lossDate", "claimNumber", "policyNumber", "claimType", "email", "phone", "insurer", "address", "insuredName1", TODAY_DATA_KEY];
  const ordered = [...order.map((key) => registry.get(key)), ...registry.values()].filter((definition): definition is DataKeyDefinition => Boolean(definition));
  const seen = new Set<string>();
  for (const definition of ordered) {
    if (seen.has(definition.key)) continue;
    seen.add(definition.key);
    if (definition.hints.some((hint) => hint.test(text))) return definition.key;
  }
  return undefined;
}
