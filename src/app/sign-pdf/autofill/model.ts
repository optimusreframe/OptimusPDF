import type { ClientProfile, ClientProfileValue, ExtractedValue, FillProposal, FillTarget } from "@/lib/autofill/types";
import { getDataKey, getDataKeys } from "@/lib/docLibrary/dataKeys";
import { fieldTypeOf, isSuggestedField, type DetectedField } from "@/lib/pdf/detectFields";

/**
 * Logica PURA (sin React) de la hoja «Rellenar con datos del cliente»: agrupar lo que encontro el motor por clave, decidir
 * que viene marcado, armar los campos destino, calcular que se escribiria y que se podria deshacer. Aparte de la interfaz para
 * probarla (y mutarla) con precision.
 *
 * PRECISION PRIMERO: nada se marca solo si hay duda (dos valores de confianza alta distintos para la misma clave, o ninguno de
 * confianza alta), y un campo que ya tiene texto NUNCA viene marcado para sustituirlo.
 */

/** Un dato para revisar: lo que dijo el motor, o un valor de un perfil guardado (`fromProfile`). */
export type ReviewItem = ExtractedValue & { fromProfile?: { id: string; name: string } };

export type ReviewGroup = {
  key: string;
  /** Etiqueta del registro de claves (o la propia clave si no se conoce). */
  label: string;
  /** Candidatos sin repetir (mismo valor = uno solo), el mas fiable primero. */
  items: ReviewItem[];
  /** Mas de un valor distinto: la persona elige uno. */
  multiple: boolean;
  /** Mas de un valor de confianza ALTA distinto: nada se marca solo. */
  ambiguous: boolean;
};

/** Clave -> id del candidato elegido (`null` = ninguno). */
export type Selection = Record<string, string | null>;
/** Id del candidato -> texto corregido por la persona. */
export type Edits = Record<string, string>;

export function dataKeyLabel(key: string, locale: "es" | "en"): string {
  return getDataKey(key)?.label[locale] ?? key;
}

/** Texto comparable: sin tildes, sin mayusculas, sin espacios de mas ni puntuacion suelta. */
export function comparable(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** El valor tal como se escribiria: sin espacios dobles ni a los lados. */
export function cleanValue(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const TIER_RANK = { high: 0, review: 1 } as const;

function betterFirst(a: ReviewItem, b: ReviewItem): number {
  return TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.confidence - a.confidence;
}

/** Ids unicos: el motor promete ids estables dentro de un resultado, pero la interfaz los usa de clave (casillas, correcciones) y no se fia. */
export function withUniqueIds<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    let id = item.id;
    while (seen.has(id)) id = `${item.id}#${index}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/** Agrupa por clave (en el orden del registro; las claves desconocidas, al final) y junta los candidatos que son el mismo valor. */
export function groupItems(items: readonly ReviewItem[], locale: "es" | "en"): ReviewGroup[] {
  const byKey = new Map<string, ReviewItem[]>();
  for (const item of items) {
    if (typeof item.key !== "string" || item.key === "" || cleanValue(item.value) === "") continue;
    const list = byKey.get(item.key) ?? [];
    list.push(item);
    byKey.set(item.key, list);
  }
  const known = getDataKeys().map((definition) => definition.key);
  const order = [...known.filter((key) => byKey.has(key)), ...[...byKey.keys()].filter((key) => !known.includes(key))];
  return order.map((key) => {
    const unique: ReviewItem[] = [];
    for (const item of [...(byKey.get(key) as ReviewItem[])].sort(betterFirst)) {
      if (!unique.some((other) => comparable(other.value) === comparable(item.value))) unique.push(item);
    }
    const highs = unique.filter((item) => item.tier === "high");
    return { key, label: dataKeyLabel(key, locale), items: unique, multiple: unique.length > 1, ambiguous: highs.length > 1 };
  });
}

/**
 * Lo que viene marcado: SOLO un candidato de confianza alta y sin otro de confianza alta que lo contradiga. Todo lo demas
 * (`review`, o dos valores altos distintos) queda sin marcar para que la persona lo decida.
 */
export function defaultSelection(groups: readonly ReviewGroup[]): Selection {
  const out: Selection = {};
  for (const group of groups) {
    const highs = group.items.filter((item) => item.tier === "high");
    out[group.key] = highs.length === 1 ? highs[0].id : null;
  }
  return out;
}

/** El valor que se usaria de un candidato: el corregido por la persona, o el del motor. */
export function effectiveValue(item: ReviewItem, edits: Edits): string {
  return cleanValue(Object.prototype.hasOwnProperty.call(edits, item.id) ? edits[item.id] : item.value);
}

/** Lo que la persona dejo marcado, con los valores ya corregidos. Un valor que quedo vacio no cuenta. */
export function acceptedValues(groups: readonly ReviewGroup[], selection: Selection, edits: Edits): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const group of groups) {
    const id = Object.prototype.hasOwnProperty.call(selection, group.key) ? selection[group.key] : null;
    const item = id === null ? undefined : group.items.find((candidate) => candidate.id === id);
    if (!item) continue;
    const value = effectiveValue(item, edits);
    if (value !== "") out.push({ ...item, value });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Campos destino
 * ------------------------------------------------------------------ */

/** Los campos que se pueden rellenar con texto: de texto y de fecha (no casillas ni iniciales). */
export function fillableFields(fields: readonly DetectedField[]): DetectedField[] {
  return fields.filter((field) => {
    const type = fieldTypeOf(field);
    return type === "text" || type === "date";
  });
}

export function buildTargets(
  fields: readonly DetectedField[],
  values: Readonly<Record<string, string>>,
  dataKeys: Readonly<Record<string, string>> | undefined,
): FillTarget[] {
  return fillableFields(fields).map((field) => {
    const dataKey = dataKeys && Object.prototype.hasOwnProperty.call(dataKeys, field.id) ? dataKeys[field.id] : undefined;
    return {
      fieldId: field.id,
      ...(field.label ? { label: field.label } : {}),
      ...(dataKey ? { dataKey } : {}),
      type: fieldTypeOf(field) === "date" ? "date" : "text",
      currentValue: values[field.id] ?? "",
    } satisfies FillTarget;
  });
}

export type PlannedRow = {
  proposal: FillProposal;
  field: DetectedField;
  /** Pagina 1-based. */
  page: number;
  /** El campo es una sugerencia de la deteccion (no un campo del PDF ni puesto a mano). */
  suggested: boolean;
  /** Campo de fecha y el valor no es una fecha que se pueda escribir (ver `toFieldDate`): no se escribe nunca. */
  invalidDate: boolean;
  /** Lo que se GUARDA en el campo: el valor tal cual, o en un campo de fecha su `AAAA-MM-DD`. */
  writeValue: string;
  /** Texto que tiene ahora (para avisar de que se sustituiria). */
  current: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

function isoOf(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || year < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * El valor de un campo de FECHA (`AAAA-MM-DD`, lo que guarda y formatea la herramienta) a partir de lo que dio el motor. El motor
 * entrega las fechas en el formato del idioma con el que leyo («dd/mm/aaaa» en espanol, «mm/dd/aaaa» en ingles) o en ISO: esas
 * tres formas y solo si son fechas de calendario de verdad (31/02 no lo es). Cualquier otra cosa («12 de marzo», «pronto») no se
 * escribe: nunca se adivina un formato.
 */
export function toFieldDate(value: string, locale: "es" | "en"): string | null {
  const text = value.trim();
  if (ISO_DATE.test(text)) return isoOf(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)));
  const match = NUMERIC_DATE.exec(text);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return isoOf(Number(match[3]), locale === "es" ? second : first, locale === "es" ? first : second);
}

/** Orden de lectura: pagina, luego de arriba abajo y de izquierda a derecha. */
function documentOrder(a: DetectedField, b: DetectedField): number {
  return a.pageIndex - b.pageIndex || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
}

/**
 * Las filas de «Dónde se escribirá»: una por propuesta del motor sobre un campo que existe. Una propuesta que dejaria el campo
 * igual (el mismo texto) no es una fila. Si un mismo campo recibe dos propuestas, solo cuenta la primera.
 */
export function planRows(proposals: readonly FillProposal[], fields: readonly DetectedField[], values: Readonly<Record<string, string>>, locale: "es" | "en" = "es"): PlannedRow[] {
  const byId = new Map(fields.map((field) => [field.id, field] as const));
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];
  for (const proposal of proposals) {
    const field = byId.get(proposal.fieldId);
    const value = cleanValue(proposal.value);
    if (!field || value === "" || seen.has(field.id)) continue;
    const current = (values[field.id] ?? "").trim();
    const isDate = fieldTypeOf(field) === "date";
    const iso = isDate ? toFieldDate(value, locale) : null;
    const writeValue = isDate ? (iso ?? value) : value;
    if (comparable(current) === comparable(writeValue) && current !== "") continue;
    seen.add(field.id);
    rows.push({
      proposal: { ...proposal, value },
      field,
      page: field.pageIndex + 1,
      suggested: isSuggestedField(field),
      invalidDate: isDate && iso === null,
      writeValue,
      // Lo que cuenta es que el campo tenga texto: el motor dice `overwrites`, pero la interfaz no se fia de un solo dato.
      current,
    });
  }
  return rows.sort((a, b) => documentOrder(a.field, b.field));
}

/** Un campo que ya tiene texto distinto del propuesto (lo dice el motor o se ve en el campo). */
export function overwritesText(row: Pick<PlannedRow, "proposal" | "current" | "writeValue">): boolean {
  return row.proposal.overwrites || (row.current !== "" && comparable(row.current) !== comparable(row.writeValue));
}

/** Que filas vienen marcadas: las de campos vacios con un valor escribible. Las que pisarian texto, NUNCA. */
export function defaultChecked(rows: readonly PlannedRow[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of rows) out[row.field.id] = !overwritesText(row) && !row.invalidDate;
  return out;
}

/** Cuantas filas se escribirian con estas casillas. */
export function checkedCount(rows: readonly PlannedRow[], checked: Readonly<Record<string, boolean>>): number {
  return rows.filter((row) => !row.invalidDate && checked[row.field.id] === true).length;
}

/** Claves marcadas que no tienen ningun campo donde ir en este documento. */
export function unmatchedKeys(accepted: readonly ReviewItem[], rows: readonly PlannedRow[]): string[] {
  const used = new Set(rows.map((row) => row.proposal.key));
  return [...new Set(accepted.map((item) => item.key))].filter((key) => !used.has(key));
}

/* ------------------------------------------------------------------ *
 * Escribir y deshacer
 * ------------------------------------------------------------------ */

export type FillPatch = {
  /** id de campo -> texto que se escribe. */
  written: Record<string, string>;
  /** id de campo -> texto que tenia antes (`undefined` = no tenia valor). */
  previous: Record<string, string | undefined>;
};

export function buildPatch(rows: readonly PlannedRow[], checked: Readonly<Record<string, boolean>>, values: Readonly<Record<string, string>>): FillPatch {
  const written: Record<string, string> = {};
  const previous: Record<string, string | undefined> = {};
  for (const row of rows) {
    if (row.invalidDate || checked[row.field.id] !== true) continue;
    written[row.field.id] = row.writeValue;
    previous[row.field.id] = Object.prototype.hasOwnProperty.call(values, row.field.id) ? values[row.field.id] : undefined;
  }
  return { written, previous };
}

export function applyPatch(values: Readonly<Record<string, string>>, patch: FillPatch): Record<string, string> {
  return { ...values, ...patch.written };
}

/**
 * Deshace UN relleno: cada campo vuelve a lo que tenia, pero SOLO si sigue diciendo lo que el relleno escribio (si la persona
 * lo cambio despues, su cambio manda) y solo si el campo sigue existiendo (no se resucita un valor de un campo borrado).
 */
export function undoPatch(values: Readonly<Record<string, string>>, patch: FillPatch, aliveFieldIds: ReadonlySet<string>): Record<string, string> {
  const next = { ...values };
  for (const [id, wrote] of Object.entries(patch.written)) {
    if (!aliveFieldIds.has(id) || next[id] !== wrote) continue;
    const before = patch.previous[id];
    if (before === undefined) delete next[id];
    else next[id] = before;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Perfil
 * ------------------------------------------------------------------ */

/** Nombre propuesto para el perfil: el del asegurado, si se marco. */
export function suggestProfileName(accepted: readonly ReviewItem[]): string {
  return accepted.find((item) => item.key === "insuredName1")?.value ?? "";
}

/** Los valores marcados listos para guardar (la fecha de pérdida, en ISO), con su procedencia: `typed` si la persona los corrigio, `extracted` si no. */
export function profilePayload(accepted: readonly ReviewItem[], items: readonly ReviewItem[], edits: Edits, locale: "es" | "en"): { values: Record<string, string>; sources: Record<string, ClientProfileValue["source"]> } {
  const values: Record<string, string> = {};
  const sources: Record<string, ClientProfileValue["source"]> = {};
  for (const item of accepted) {
    // La fecha del perfil se guarda en ISO: el perfil no recuerda el idioma y «05/03/2026» cambia de dia segun el orden de lectura.
    values[item.key] = item.key === "lossDate" ? (toFieldDate(item.value, locale) ?? item.value) : item.value;
    const original = items.find((candidate) => candidate.id === item.id);
    const corrected = original !== undefined && Object.prototype.hasOwnProperty.call(edits, item.id) && comparable(edits[item.id]) !== comparable(original.value);
    sources[item.key] = corrected ? "typed" : "extracted";
  }
  return { values, sources };
}

/** Los valores de un perfil guardado como candidatos de confianza alta (la persona ya los dio por buenos al guardarlos). */
export function profileItems(profile: ClientProfile): ReviewItem[] {
  const known = getDataKeys().map((definition) => definition.key);
  const keys = Object.keys(profile.values).sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  return keys.map((key) => ({
    id: `profile:${profile.id}:${key}`,
    key,
    value: profile.values[key].value,
    confidence: 1,
    tier: "high" as const,
    reason: "",
    evidence: { sourceIndex: -1, pageIndex: 0, snippet: "", origin: "pasted" as const },
    fromProfile: { id: profile.id, name: profile.name },
  }));
}
