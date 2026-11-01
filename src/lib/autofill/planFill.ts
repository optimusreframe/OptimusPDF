/**
 * Plan de rellenado: que valor va a que campo de texto del documento. Puro y determinista (sin efectos, sin reloj): la misma
 * entrada da siempre el mismo plan. NO escribe nada ni pisa lo que la persona ya tecleo: marca `overwrites` y la interfaz pide
 * confirmacion.
 *
 * Reglas:
 *   - la clave del campo sale de su `dataKey` (la fijo la plantilla y GANA); si no la tiene, de la etiqueta (`suggestDataKey`);
 *   - el campo `today` (fecha de firma) no se rellena aqui;
 *   - un mismo valor puede ir a varios campos de la misma clave (el nombre se repite por documento);
 *   - con varios valores para una clave se usa el de mayor confianza `high`; si ninguno lo es, el primero de la lista (la interfaz
 *     pasa los valores en el orden en que la persona los acepto);
 *   - un campo de tipo fecha solo recibe claves de fecha, y uno de texto recibe cualquier clave.
 */

import { TODAY_DATA_KEY, getDataKey, suggestDataKey } from "@/lib/docLibrary/dataKeys";
import type { ExtractedValue, FillProposal, FillTarget } from "@/lib/autofill/types";

export type PlanFillOptions = {
  /** Reservado: el formato de las fechas ya viene aplicado en cada valor (segun el idioma con que se extrajo). */
  locale?: "es" | "en";
};

function chooseValue(candidates: readonly ExtractedValue[]): ExtractedValue | undefined {
  let best: ExtractedValue | undefined;
  for (const value of candidates) {
    if (value.tier !== "high") continue;
    if (!best || value.confidence > best.confidence) best = value;
  }
  return best ?? candidates[0];
}

const plain = (text: string): string => text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

export function planFill(targets: readonly FillTarget[], values: readonly ExtractedValue[], options: PlanFillOptions = {}): FillProposal[] {
  const byKey = new Map<string, ExtractedValue[]>();
  for (const value of values) {
    if (value.value.trim() === "") continue;
    const list = byKey.get(value.key);
    if (list) list.push(value);
    else byKey.set(value.key, [value]);
  }
  const chosen = new Map<string, ExtractedValue | undefined>();
  const proposals: FillProposal[] = [];
  for (const target of targets) {
    const fixed = target.dataKey?.trim();
    const key = fixed ? fixed : suggestDataKey(target.label);
    if (!key || key === TODAY_DATA_KEY) continue;
    const via: FillProposal["via"] = fixed ? "dataKey" : "label";
    if (!chosen.has(key)) chosen.set(key, chooseValue(byKey.get(key) ?? []));
    const value = chosen.get(key);
    if (!value) continue;
    // Un campo de fecha solo recibe claves de fecha (un nombre en un campo de fecha seria un error).
    const definition = getDataKey(key);
    if (target.type === "date" && definition && definition.fieldType !== "date") continue;
    const current = target.currentValue ?? "";
    if (plain(current) === plain(value.value)) continue;
    proposals.push({ fieldId: target.fieldId, key, value: value.value, via, overwrites: current.trim() !== "" });
  }
  // `options` queda en la firma para que la interfaz pueda pasar el idioma sin romper el contrato; el motor no lo necesita hoy.
  void options;
  return proposals;
}
