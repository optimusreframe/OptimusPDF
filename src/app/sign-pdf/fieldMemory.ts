import { TODAY_DATA_KEY, suggestDataKey } from "@/lib/docLibrary/dataKeys";
import { fieldTypeOf, type DetectedField } from "@/lib/pdf/detectFields";
import { normalizeFieldLabel } from "@/lib/pdf/sign";
import { isMemoryTag, tagOf } from "@/lib/fieldTags";

/**
 * Con que clave de la memoria de valores (`lib/valueHistory.ts`) se lee y se guarda lo que se escribe en un campo.
 *
 * 1. Con etiqueta: la etiqueta (salvo la fecha de hoy, que no se recuerda).
 * 2. Sin etiqueta pero con rótulo detectado (AcroForm, plantilla, heuristica): la etiqueta que `suggestDataKey` reconoce en
 *    ese rótulo; asi el mismo dato escrito en un campo con etiqueta y en uno sin ella comparte memoria. Si no se reconoce, el
 *    rótulo normalizado de siempre (el almacen antiguo sigue sirviendo).
 * 3. Sin etiqueta ni rótulo (un campo dibujado a mano): ninguna, no hay con que relacionarlo.
 * Solo texto e iniciales; la fecha usa su selector nativo y la casilla no tiene texto.
 */
export function memoryKeyOf(field: Pick<DetectedField, "type" | "label" | "tag">): string | null {
  const type = fieldTypeOf(field as DetectedField);
  if (type !== "text" && type !== "initials") return null;
  const tag = tagOf(field);
  if (tag) return isMemoryTag(tag) ? tag : null;
  if (!field.label) return null;
  const implied = type === "text" ? suggestDataKey(field.label) : undefined;
  if (implied && implied !== TODAY_DATA_KEY) return implied;
  const legacy = normalizeFieldLabel(field.label);
  return legacy === "" ? null : legacy;
}

/** La etiqueta que sugiere el rótulo de un campo SIN etiqueta (para ofrecerla preseleccionada), o `null`. */
export function impliedTagOf(field: Pick<DetectedField, "type" | "label" | "tag">): string | null {
  if (tagOf(field) || !field.label) return null;
  const type = fieldTypeOf(field as DetectedField);
  if (type !== "text" && type !== "date") return null;
  const implied = suggestDataKey(field.label);
  return implied && isMemoryTag(implied) ? implied : null;
}
