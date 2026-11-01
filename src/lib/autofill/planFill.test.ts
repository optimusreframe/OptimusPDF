import { describe, expect, it } from "vitest";
import { planFill } from "@/lib/autofill/planFill";
import type { ExtractedValue, FillTarget } from "@/lib/autofill/types";

function value(key: string, text: string, tier: "high" | "review" = "high", confidence = 0.9): ExtractedValue {
  return { id: `${key}-${text}`, key, value: text, confidence, tier, reason: "", evidence: { sourceIndex: 0, pageIndex: 0, snippet: "", origin: "text-layer" } };
}

const target = (fieldId: string, partial: Partial<FillTarget> = {}): FillTarget => ({ fieldId, type: "text", currentValue: "", ...partial });

describe("planFill", () => {
  it("el dataKey del campo gana sobre su etiqueta", () => {
    const plan = planFill([target("f1", { dataKey: "insuredName1", label: "Phone" })], [value("insuredName1", "Maria Perez"), value("phone", "(305) 555-0142")]);
    expect(plan).toEqual([{ fieldId: "f1", key: "insuredName1", value: "Maria Perez", via: "dataKey", overwrites: false }]);
  });

  it("sin dataKey se usa la etiqueta (ES y EN)", () => {
    const plan = planFill(
      [target("a", { label: "Cliente:" }), target("b", { label: "Fecha de pérdida" }), target("c", { label: "Email Address" }), target("d", { label: "Co-insured" })],
      [value("insuredName1", "Maria Perez"), value("lossDate", "14/03/2026"), value("email", "m@x.com"), value("insuredName2", "Jose Perez")],
    );
    expect(plan.map((p) => [p.fieldId, p.key, p.via])).toEqual([
      ["a", "insuredName1", "label"],
      ["b", "lossDate", "label"],
      ["c", "email", "label"],
      ["d", "insuredName2", "label"],
    ]);
  });

  it("el campo «today» no se rellena aqui, ni por dataKey ni por etiqueta", () => {
    expect(planFill([target("f", { dataKey: "today", type: "date" }), target("g", { label: "Date", type: "date" })], [value("today", "x")])).toEqual([]);
  });

  it("un mismo valor va a varios campos de la misma clave", () => {
    const plan = planFill([target("p1", { dataKey: "insuredName1" }), target("p2", { label: "Insured" }), target("p3", { dataKey: "insuredName1" })], [value("insuredName1", "Maria Perez")]);
    expect(plan.map((p) => p.fieldId)).toEqual(["p1", "p2", "p3"]);
  });

  it("con varios valores: el `high` de mayor confianza; si ninguno, el primero", () => {
    const high = planFill([target("f", { dataKey: "phone" })], [value("phone", "A", "review", 0.8), value("phone", "B", "high", 0.86), value("phone", "C", "high", 0.95)]);
    expect(high[0].value).toBe("C");
    const none = planFill([target("f", { dataKey: "phone" })], [value("phone", "A", "review", 0.6), value("phone", "B", "review", 0.8)]);
    expect(none[0].value).toBe("A");
  });

  it("overwrites: el campo ya tenia texto distinto; si es igual no hay propuesta", () => {
    const plan = planFill(
      [target("a", { dataKey: "phone", currentValue: "555" }), target("b", { dataKey: "phone", currentValue: "  (305) 555-0142 " }), target("c", { dataKey: "phone", currentValue: "   " })],
      [value("phone", "(305) 555-0142")],
    );
    expect(plan).toEqual([
      { fieldId: "a", key: "phone", value: "(305) 555-0142", via: "dataKey", overwrites: true },
      { fieldId: "c", key: "phone", value: "(305) 555-0142", via: "dataKey", overwrites: false },
    ]);
  });

  it("sin valor para la clave, sin etiqueta conocida o con valor vacio: nada", () => {
    expect(planFill([target("a", { dataKey: "email" }), target("b", { label: "Random thing" }), target("c", { dataKey: "phone" })], [value("phone", "   ")])).toEqual([]);
  });

  it("un dataKey fijado SIN valor no cae a la etiqueta", () => {
    expect(planFill([target("a", { dataKey: "email", label: "Phone" })], [value("phone", "(305) 555-0142")])).toEqual([]);
  });

  it("un campo de fecha solo recibe claves de fecha", () => {
    const plan = planFill([target("a", { dataKey: "insuredName1", type: "date" }), target("b", { dataKey: "lossDate", type: "date" })], [value("insuredName1", "Maria"), value("lossDate", "14/03/2026")]);
    expect(plan.map((p) => p.fieldId)).toEqual(["b"]);
  });

  it("una clave personalizada (que no esta en el registro) se respeta", () => {
    expect(planFill([target("a", { dataKey: "custom.key" })], [value("custom.key", "abc")])).toEqual([{ fieldId: "a", key: "custom.key", value: "abc", via: "dataKey", overwrites: false }]);
  });

  it("es determinista y no modifica sus entradas", () => {
    const targets = [target("a", { dataKey: "phone" }), target("b", { label: "Insured" })];
    const values = [value("phone", "x"), value("insuredName1", "Maria Perez")];
    const snapshot = JSON.stringify([targets, values]);
    const first = planFill(targets, values, { locale: "es" });
    expect(planFill(targets, values, { locale: "en" })).toEqual(first);
    expect(JSON.stringify([targets, values])).toBe(snapshot);
  });
});
