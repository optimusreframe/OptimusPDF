import { suggestDataKey } from "@/lib/docLibrary/dataKeys";
import type { ExtractedValue, FillProposal, FillTarget } from "@/lib/autofill/types";

/**
 * Doble de `planFill` para las pruebas de COMPONENTES de la interfaz (Vitest): cumple el contrato de `src/lib/autofill/types.ts`
 * sin depender del motor real. Cada campo recibe el valor de su `dataKey` (si la plantilla lo fijo) o de la clave que sugiere su
 * etiqueta; `overwrites` si el campo ya tenia algo distinto. El motor real tiene sus propias pruebas.
 */
export function planFillDouble(targets: readonly FillTarget[], values: readonly Pick<ExtractedValue, "key" | "value">[]): FillProposal[] {
  const byKey = new Map<string, string>();
  for (const item of values) if (!byKey.has(item.key)) byKey.set(item.key, item.value);
  const out: FillProposal[] = [];
  for (const target of targets) {
    const via: FillProposal["via"] = target.dataKey ? "dataKey" : "label";
    const key = target.dataKey ?? suggestDataKey(target.label);
    if (!key) continue;
    const value = byKey.get(key);
    if (value === undefined) continue;
    const current = target.currentValue.trim();
    out.push({ fieldId: target.fieldId, key, value, via, overwrites: current !== "" && current !== value });
  }
  return out;
}
