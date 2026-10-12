import {
  embeddedValueFor,
  fieldTypeOf,
  type DetectedField,
} from "@/lib/pdf/detectFields";
import { unsupportedCharacters, type FillWrite, type FormFieldInfo } from "@/lib/pdf/fillForm";
import type { SignPlacement } from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { buildTextPlacements } from "@/app/sign-pdf/soloSignature";

/**
 * Plan de escritura del modo Rellenar (Wave 7 · U7): de lo que la persona hizo en el lienzo (campos con valor)
 * y en el panel de opciones a DOS cosas separadas, puras y comprobables:
 *
 *  - `writes`: valores que se escriben en los CAMPOS REALES del formulario (`/V` + apariencia, `fillForm.ts`).
 *    Solo los que CAMBIARON respecto del PDF abierto: un campo que no se toco no se reescribe.
 *  - `placements`: texto que se DIBUJA sobre la pagina (`signPdfMulti`, como Firmar): las sugerencias, el texto
 *    libre y los campos reales que la persona movio de sitio (ya no coinciden con su widget).
 */

export type FillPlan = {
  writes: FillWrite[];
  placements: SignPlacement[];
  /** Cuantos campos se rellenan en total (escritos + dibujados). */
  fieldCount: number;
  /** Caracteres que la apariencia estandar no puede pintar (se ven como «?»). */
  unsupported: string[];
  /** Valores mas largos que el maximo de su campo (se recortaran al escribir). */
  truncated: number;
};

const MOVED_EPSILON = 0.002;

/** El rectangulo del lienzo ya no es el del widget del PDF (la persona lo movio o lo redimensiono). */
export function rectMoved(a: NormalizedRect, b: NormalizedRect): boolean {
  return (
    Math.abs(a.x - b.x) > MOVED_EPSILON ||
    Math.abs(a.y - b.y) > MOVED_EPSILON ||
    Math.abs(a.width - b.width) > MOVED_EPSILON ||
    Math.abs(a.height - b.height) > MOVED_EPSILON
  );
}

/** El campo del lienzo representa a este campo real del PDF (mismo id, origen AcroForm, mismo sitio y tipo). */
export function isBoundToForm(field: DetectedField, info: FormFieldInfo | undefined): info is FormFieldInfo {
  if (!info || field.source !== "acroform") return false;
  if (rectMoved(field.rect, info.rect)) return false;
  const type = fieldTypeOf(field);
  if (info.kind === "text") return type === "text" || type === "date" || type === "initials";
  if (info.kind === "checkbox") return type === "checkbox";
  return false;
}

export function buildFillPlan({
  textFields,
  textValues,
  formFields,
  choiceValues,
  language,
}: {
  textFields: readonly DetectedField[];
  textValues: Readonly<Record<string, string>>;
  formFields: readonly FormFieldInfo[];
  choiceValues: Readonly<Record<string, string>>;
  language: "es" | "en";
}): FillPlan {
  const byId = new Map(formFields.map((info) => [info.id, info]));
  const writes: FillWrite[] = [];
  const unbound: DetectedField[] = [];
  const typed: string[] = [];
  let truncated = 0;

  for (const field of textFields) {
    const info = byId.get(field.id);
    if (!isBoundToForm(field, info)) {
      unbound.push(field);
      continue;
    }
    if (info.readOnly) continue;
    const raw = textValues[field.id] ?? "";
    const value =
      info.kind === "checkbox" ? (raw ? "true" : "") : embeddedValueFor(field, raw, language);
    if (value !== info.value) {
      writes.push({ id: field.id, value });
      if (info.kind === "text") {
        typed.push(value);
        if (info.maxLength !== undefined && [...value].length > info.maxLength) truncated += 1;
      }
    }
  }

  for (const info of formFields) {
    if (info.kind === "text" || info.kind === "checkbox" || info.readOnly) continue;
    const value = choiceValues[info.id];
    if (value !== undefined && value !== info.value) {
      writes.push({ id: info.id, value });
      if (info.kind === "dropdown") typed.push(value);
    }
  }

  const placements = buildTextPlacements(unbound, textValues, language);
  for (const placement of placements) if (placement.kind === "text") typed.push(placement.value);

  return {
    writes,
    placements,
    fieldCount: writes.length + placements.length,
    unsupported: unsupportedCharacters(typed),
    truncated,
  };
}

/** Los campos del lienzo para los casilleros reales del PDF (la deteccion de Firmar solo trae los de texto). */
export function checkboxFieldsFrom(formFields: readonly FormFieldInfo[]): DetectedField[] {
  return formFields
    .filter((info) => info.kind === "checkbox" && !info.readOnly)
    .map((info) => ({
      id: info.id,
      pageIndex: info.pageIndex,
      rect: info.rect,
      label: info.name,
      source: "acroform" as const,
      confidence: "high" as const,
      type: "checkbox" as const,
    }));
}

/** Valores iniciales de los campos del lienzo (texto y casillas con valor en el PDF). */
export function seedValuesFrom(formFields: readonly FormFieldInfo[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const info of formFields) {
    if ((info.kind === "text" || info.kind === "checkbox") && info.value) values[info.id] = info.value;
  }
  return values;
}

/** Valores iniciales de los campos que el lienzo no edita (radios, desplegables, listas). */
export function choiceSeedFrom(formFields: readonly FormFieldInfo[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const info of formFields) {
    if (info.kind === "radio" || info.kind === "dropdown" || info.kind === "list") values[info.id] = info.value;
  }
  return values;
}

/** Los campos reales de solo lectura no se ofrecen en el lienzo (no se escribirian). */
export function readOnlyIds(formFields: readonly FormFieldInfo[]): Set<string> {
  return new Set(formFields.filter((info) => info.readOnly).map((info) => info.id));
}
