import { fieldTypeOf, isSuggestionOnly, type DetectedField, type DetectedFieldType } from "@/lib/pdf/detectFields";
import type { AutoMark } from "@/lib/fieldPropagation";
import { foldText, tagOf } from "@/lib/fieldTags";
import { TODAY_DATA_KEY, isKnownDataKey, suggestDataKey } from "@/lib/docLibrary/dataKeys";
import { memoryKeyOf } from "@/app/sign-pdf/fieldMemory";
import type { ClientProfile } from "@/lib/autofill/types";

/*
 * Modelo PURO del modo «Rellenar» (W3-B2): que campos recorre el asistente, en que orden, cuales faltan y que sugerencias
 * ofrece cada uno. Sin React ni almacenamiento: lo que cambia con el tiempo (la memoria de valores, los perfiles) entra como
 * parametro, asi se razona y se comprueba solo.
 */

/** Lo que el asistente sabe de un campo por su plantilla (si se aplico una): obligatorio, regla «hoy», origen de dato. */
export type FillFieldMeta = { required?: boolean; rule?: "today"; dataKey?: string };

/** Un documento de la ronda tal como lo necesita el asistente. */
export type FillDocInput = {
  id: string;
  name: string;
  textFields: readonly DetectedField[];
  textValues: Readonly<Record<string, string>>;
  autoFilled?: Readonly<Record<string, AutoMark>>;
  meta?: Readonly<Record<string, FillFieldMeta>>;
};

/** Un paso del asistente: un campo de un documento con su valor y su estado de ahora. */
export type FillStep = {
  /** `docId` + `id` del campo: unico en toda la ronda (dos documentos pueden repetir ids). */
  key: string;
  docId: string;
  docName: string;
  field: DetectedField;
  type: DetectedFieldType;
  value: string;
  /** Lo relleno la propagacion por etiqueta y nadie lo ha tocado (se muestra para confirmar). */
  auto: boolean;
  required: boolean;
  rule: "today" | null;
  dataKey: string | null;
};

export function stepKey(docId: string, fieldId: string): string {
  return `${docId}\u0000${fieldId}`;
}

/** Los tipos que el asistente rellena: texto, fecha, casilla e iniciales escritas a mano. */
const FILLABLE_TYPES: readonly DetectedFieldType[] = ["text", "date", "checkbox", "initials"];

/** Una sugerencia de la heuristica que nadie ha tocado no es un campo del documento: el asistente no la recorre. */
export function isFillable(field: DetectedField, value: string | undefined): boolean {
  return FILLABLE_TYPES.includes(fieldTypeOf(field)) && !isSuggestionOnly(field, value);
}

/** Orden de lectura: pagina, de arriba abajo y de izquierda a derecha (con una tolerancia vertical para una misma linea). */
export function readingOrder(a: DetectedField, b: DetectedField): number {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  const rowA = a.rect.y + a.rect.height / 2;
  const rowB = b.rect.y + b.rect.height / 2;
  // Dos campos cuyos centros caen a menos de media altura del mas bajo van en la misma fila: se ordenan por x.
  const tolerance = Math.min(a.rect.height, b.rect.height) / 2;
  if (Math.abs(rowA - rowB) > tolerance) return rowA - rowB;
  return a.rect.x - b.rect.x || a.rect.y - b.rect.y;
}

/** Origen de dato del campo: su etiqueta, el que fijo la plantilla o el que sugiere su rotulo. `null` = ninguno conocido. */
export function dataKeyOfField(field: DetectedField, meta?: FillFieldMeta): string | null {
  const tag = tagOf(field);
  if (tag) return tag;
  if (meta?.dataKey) return meta.dataKey;
  const implied = suggestDataKey(field.label);
  return implied ?? null;
}

/** Los pasos de toda la ronda: los documentos en su orden y, dentro de cada uno, los campos en orden de lectura. */
export function buildFillSteps(docs: readonly FillDocInput[]): FillStep[] {
  const steps: FillStep[] = [];
  for (const doc of docs) {
    const fields = doc.textFields.filter((field) => isFillable(field, doc.textValues[field.id])).sort(readingOrder);
    for (const field of fields) {
      const meta = doc.meta?.[field.id];
      const value = doc.textValues[field.id] ?? "";
      const type = fieldTypeOf(field);
      steps.push({
        key: stepKey(doc.id, field.id),
        docId: doc.id,
        docName: doc.name,
        field,
        type,
        value,
        auto: doc.autoFilled?.[field.id] === "filled" && value.trim() !== "",
        required: meta?.required === true,
        rule: meta?.rule === "today" || meta?.dataKey === TODAY_DATA_KEY ? "today" : null,
        dataKey: dataKeyOfField(field, meta),
      });
    }
  }
  return steps;
}

/** Hay algo escrito (o, en una casilla, nunca "falta": no marcarla tambien es una respuesta). */
export function isEmptyStep(step: Pick<FillStep, "type" | "value">): boolean {
  return step.type !== "checkbox" && step.value.trim() === "";
}

/** El paso necesita que la persona lo mire: vacio, o rellenado solo y pendiente de confirmar (si se pidio revisarlos). */
export function needsAttention(step: FillStep, reviewAuto: boolean): boolean {
  return isEmptyStep(step) || (reviewAuto && step.auto);
}

/** Los pasos que el asistente muestra: con «Revisar los autorrellenados» apagado se saltan, salvo el que tiene el cursor. */
export function visibleSteps(steps: readonly FillStep[], reviewAuto: boolean, currentKey: string | null): FillStep[] {
  return reviewAuto ? [...steps] : steps.filter((step) => !step.auto || step.key === currentKey);
}

/** Posicion del paso `key` dentro de `list` (-1 si no esta). */
export function indexOfStep(list: readonly FillStep[], key: string | null): number {
  return key === null ? -1 : list.findIndex((step) => step.key === key);
}

/**
 * El primer paso que pide atencion a partir de `from` (sin incluirlo) en la direccion dada; con `wrap` da la vuelta. `null` si no
 * queda ninguno. Es lo que usa «Ir al siguiente vacio» y la entrada al asistente.
 */
export function nextAttention(
  list: readonly FillStep[],
  from: number,
  reviewAuto: boolean,
  { direction = 1, wrap = true }: { direction?: 1 | -1; wrap?: boolean } = {},
): FillStep | null {
  const count = list.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const raw = from + direction * offset;
    if (!wrap && (raw < 0 || raw >= count)) return null;
    const step = list[((raw % count) + count) % count];
    if (step && step.key !== list[from]?.key && needsAttention(step, reviewAuto)) return step;
  }
  return null;
}

/** Por donde empieza el asistente: el primer campo que pide atencion o, si no hay ninguno, el primero. */
export function firstStep(list: readonly FillStep[], reviewAuto: boolean): FillStep | null {
  return list.find((step) => needsAttention(step, reviewAuto)) ?? list[0] ?? null;
}

export type FillSummary = {
  total: number;
  /** Campos con algo escrito (o una casilla marcada). */
  filled: number;
  /** Vacios obligatorios, vacios opcionales y autorrellenados aun sin confirmar. */
  requiredMissing: FillStep[];
  optionalMissing: FillStep[];
  autoPending: number;
};

export function summarize(steps: readonly FillStep[]): FillSummary {
  const requiredMissing: FillStep[] = [];
  const optionalMissing: FillStep[] = [];
  let filled = 0;
  let autoPending = 0;
  for (const step of steps) {
    if (isEmptyStep(step)) (step.required ? requiredMissing : optionalMissing).push(step);
    else if (step.type !== "checkbox" || step.value !== "") filled += 1;
    if (step.auto) autoPending += 1;
  }
  return { total: steps.length, filled, requiredMissing, optionalMissing, autoPending };
}

/** Cuantos campos hay por rellenar (vacios de texto, fecha o iniciales): es el numero del boton «Rellenar (N campos)». */
export function fillableCount(steps: readonly FillStep[]): number {
  return steps.length;
}

/* ------------------------------------------------------------------ *
 * Entrada del campo segun su tipo
 * ------------------------------------------------------------------ */

export type InputKind = {
  type: "text" | "tel" | "email" | "date";
  inputMode: "text" | "tel" | "email" | "numeric" | "none";
  autoComplete: string;
  autoCapitalize: "off" | "sentences" | "words" | "characters";
};

/**
 * Teclado y autocompletado del navegador que mejor van con el dato: telefono con teclado numerico, correo con `@`, nombres en
 * mayusculas de palabra, direccion con su `autocomplete`, fecha con el selector nativo. `autocomplete="off"` en lo demas: un
 * numero de poliza no debe ofrecer el correo de la persona.
 */
export function inputKindOf(step: Pick<FillStep, "type" | "dataKey" | "field">): InputKind {
  if (step.type === "date") return { type: "date", inputMode: "none", autoComplete: "off", autoCapitalize: "off" };
  if (step.type === "initials") return { type: "text", inputMode: "text", autoComplete: "off", autoCapitalize: "characters" };
  const key = step.dataKey ?? "";
  if (key === "phone") return { type: "tel", inputMode: "tel", autoComplete: "tel", autoCapitalize: "off" };
  if (key === "email") return { type: "email", inputMode: "email", autoComplete: "email", autoCapitalize: "off" };
  if (key === "address") return { type: "text", inputMode: "text", autoComplete: "street-address", autoCapitalize: "words" };
  if (key === "insuredName1" || key === "insuredName2") return { type: "text", inputMode: "text", autoComplete: "name", autoCapitalize: "words" };
  if (key === "policyNumber" || key === "claimNumber") return { type: "text", inputMode: "text", autoComplete: "off", autoCapitalize: "characters" };
  return { type: "text", inputMode: "text", autoComplete: "off", autoCapitalize: "sentences" };
}

/** `YYYY-MM-DD` de hoy en hora LOCAL (no UTC: a las 22:00 de un martes en America sigue siendo martes). */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/* ------------------------------------------------------------------ *
 * Sugerencias
 * ------------------------------------------------------------------ */

export type SuggestionSource = "memory" | "profile" | "document";

export type FillChip = {
  /** Lo que se escribe en el campo al elegirla. */
  value: string;
  /** Lo que se lee en la pastilla (una fecha ISO se ve como fecha). */
  text: string;
  source: SuggestionSource;
  /** De quien es (perfil de cliente); `null` en la memoria. */
  from: string | null;
  pinned: boolean;
  /** Donde coincide con lo escrito (para resaltarlo); -1 = sin coincidencia que mostrar. */
  matchAt: number;
  matchLength: number;
};

/** Lo que sale de la memoria de valores (`valueHistory.rankedSuggestions`), sin depender de ella aqui. */
export type MemoryHit = { value: string; pinned: boolean; matchAt: number; matchLength: number };

/** Valor del perfil para una clave, si lo tiene y si es de texto/fecha. */
function profileValue(profile: ClientProfile, key: string): { value: string; source: SuggestionSource } | null {
  const entry = profile.values[key];
  if (!entry || entry.value.trim() === "") return null;
  return { value: entry.value, source: entry.source === "extracted" ? "document" : "profile" };
}

/**
 * Las pastillas de un campo, en este orden: memoria (lo escrito antes bajo la misma etiqueta, ya filtrado y ordenado por
 * `rankedSuggestions`), datos del perfil de cliente y los leidos de un documento. Sin duplicados por texto. Con lo escrito, los
 * del perfil solo salen si lo contienen (sin importar mayusculas ni tildes). `formatDate` pone las fechas legibles.
 */
export function buildChips({
  step,
  typed,
  memory,
  profiles,
  limit = 8,
  formatDate = (iso) => iso,
}: {
  step: Pick<FillStep, "type" | "dataKey" | "field">;
  typed: string;
  memory: readonly MemoryHit[];
  profiles: readonly ClientProfile[];
  limit?: number;
  formatDate?: (iso: string) => string;
}): FillChip[] {
  const chips: FillChip[] = [];
  const seen = new Set<string>();
  const needle = foldText(typed.trim());
  const push = (chip: FillChip) => {
    const id = foldText(chip.value);
    if (seen.has(id) || chips.length >= limit) return;
    seen.add(id);
    chips.push(chip);
  };
  // Fechas y casillas no tienen memoria de texto; la fecha puede traer datos del perfil (fecha de perdida, vigencia...).
  if (step.type !== "checkbox" && step.type !== "date") {
    for (const hit of memory) {
      push({ value: hit.value, text: hit.value, source: "memory", from: null, pinned: hit.pinned, matchAt: hit.matchAt, matchLength: hit.matchLength });
    }
  }
  const key = step.dataKey;
  if (key && step.type !== "checkbox" && isProfileKey(key)) {
    for (const profile of profiles) {
      const found = profileValue(profile, key);
      if (!found) continue;
      const iso = step.type === "date";
      if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(found.value)) continue;
      if (!iso && needle !== "") {
        const at = foldText(found.value).indexOf(needle);
        if (at < 0) continue;
        push({ value: found.value, text: found.value, source: found.source, from: profile.name, pinned: false, matchAt: at, matchLength: needle.length });
        continue;
      }
      push({ value: found.value, text: iso ? formatDate(found.value) : found.value, source: found.source, from: profile.name, pinned: false, matchAt: -1, matchLength: 0 });
    }
  }
  return chips;
}

/** Las claves que un perfil de cliente puede traer (las del registro de datos, no las etiquetas propias ni `today`). */
function isProfileKey(key: string): boolean {
  return key !== TODAY_DATA_KEY && (isKnownDataKey(key) || key.startsWith("custom."));
}

/** La clave de la memoria de valores del paso (la de `memoryKeyOf`), o `null` si ese campo no recuerda. */
export function memoryKeyOfStep(step: Pick<FillStep, "field">): string | null {
  return memoryKeyOf(step.field);
}
