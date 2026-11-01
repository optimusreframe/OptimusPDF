import { describe, expect, it } from "vitest";
import type { ClientProfile, ExtractedValue, FillProposal } from "@/lib/autofill/types";
import type { DetectedField } from "@/lib/pdf/detectFields";
import {
  acceptedValues,
  applyPatch,
  buildPatch,
  buildTargets,
  checkedCount,
  comparable,
  dataKeyLabel,
  defaultChecked,
  defaultSelection,
  effectiveValue,
  fillableFields,
  groupItems,
  overwritesText,
  planRows,
  profileItems,
  profilePayload,
  suggestProfileName,
  toFieldDate,
  undoPatch,
  unmatchedKeys,
  withUniqueIds,
  type ReviewItem,
} from "@/app/sign-pdf/autofill/model";
import { planFillDouble } from "@/app/sign-pdf/autofill/testing/planFillDouble";

/** Logica pura de la hoja de autorrelleno. Datos INVENTADOS. */

let seq = 0;
function item(key: string, value: string, extra: Partial<ReviewItem> = {}): ReviewItem {
  seq += 1;
  return { id: `v${seq}`, key, value, confidence: 0.9, tier: "high", reason: "r", evidence: { sourceIndex: 0, pageIndex: 0, snippet: "s", origin: "text-layer" }, ...extra };
}
function field(id: string, label: string | undefined, extra: Partial<DetectedField> = {}): DetectedField {
  return { id, pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.03 }, ...(label ? { label } : {}), source: "acroform", confidence: "high", ...extra };
}

describe("agrupar", () => {
  it("por clave, en el orden del registro, con las claves desconocidas al final y su etiqueta legible", () => {
    const groups = groupItems([item("futureKey", "zzz"), item("claimNumber", "C-1"), item("insuredName1", "Ana"), item("phone", "555-0100")], "es");
    expect(groups.map((g) => g.key)).toEqual(["insuredName1", "phone", "claimNumber", "futureKey"]);
    expect(groups.map((g) => g.label)).toEqual(["Nombre del asegurado 1", "Teléfono", "N.º de reclamo", "futureKey"]);
    expect(groupItems([item("phone", "1")], "en")[0].label).toBe("Phone");
    expect(dataKeyLabel("nope", "es")).toBe("nope");
  });

  it("junta el mismo valor (sin tildes, mayusculas ni puntuacion) y deja el mas fiable; ordena alto antes que revisar", () => {
    const groups = groupItems([item("phone", "(555) 0100", { tier: "review", confidence: 0.4 }), item("phone", "555-0100", { confidence: 0.99 }), item("phone", "555 0199", { tier: "review", confidence: 0.6 })], "es");
    expect(groups[0].items.map((i) => [i.value, i.tier])).toEqual([["555-0100", "high"], ["555 0199", "review"]]);
    expect(groups[0].multiple).toBe(true);
    expect(groups[0].ambiguous).toBe(false);
  });

  it("el nivel manda sobre el numero: un «alta» de 0,6 va antes que un «revisar» de 0,99", () => {
    const [group] = groupItems([item("phone", "555-0199", { tier: "review", confidence: 0.99 }), item("phone", "555-0100", { tier: "high", confidence: 0.6 })], "es");
    expect(group.items.map((i) => i.tier)).toEqual(["high", "review"]);
  });

  it("ambiguo = mas de un valor de confianza ALTA distinto", () => {
    const [group] = groupItems([item("phone", "555-0100"), item("phone", "555-0199")], "es");
    expect(group.ambiguous).toBe(true);
  });

  it("ignora claves o valores vacios", () => {
    expect(groupItems([item("", "x"), item("phone", "   ")], "es")).toEqual([]);
  });

  it("comparable quita tildes, mayusculas y signos", () => {
    expect(comparable("  María-PÉREZ, S. ")).toBe("maria perez s");
  });
});

describe("que viene marcado (precision primero)", () => {
  it("solo un candidato de confianza alta sin otro alto distinto; revisar y ambiguos quedan en ninguno", () => {
    const groups = groupItems(
      [
        item("insuredName1", "Ana"),
        item("phone", "555-0100", { tier: "review" }),
        item("policyNumber", "P-1"),
        item("policyNumber", "P-2"),
        item("email", "a@ejemplo.test"),
        item("email", "b@ejemplo.test", { tier: "review" }),
      ],
      "es",
    );
    const selection = defaultSelection(groups);
    const idOf = (key: string, value: string) => groups.find((g) => g.key === key)?.items.find((i) => i.value === value)?.id;
    expect(selection.insuredName1).toBe(idOf("insuredName1", "Ana"));
    expect(selection.phone).toBeNull();
    expect(selection.policyNumber).toBeNull();
    expect(selection.email).toBe(idOf("email", "a@ejemplo.test"));
  });

  it("acceptedValues devuelve lo elegido con el texto corregido y descarta lo que quedo vacio", () => {
    const groups = groupItems([item("insuredName1", "Ana"), item("phone", "555-0100")], "es");
    const selection = defaultSelection(groups);
    const nameId = groups[0].items[0].id;
    expect(acceptedValues(groups, selection, { [nameId]: "  Ana   Pérez " }).map((i) => [i.key, i.value])).toEqual([["insuredName1", "Ana Pérez"], ["phone", "555-0100"]]);
    expect(acceptedValues(groups, selection, { [nameId]: "   " }).map((i) => i.key)).toEqual(["phone"]);
    expect(effectiveValue(groups[0].items[0], {})).toBe("Ana");
    expect(acceptedValues(groups, { insuredName1: null, phone: "no-existe" }, {})).toEqual([]);
  });
});

describe("fechas: lo que da el motor y lo que guarda un campo de fecha", () => {
  it("espanol dd/mm/aaaa e ingles mm/dd/aaaa se guardan como AAAA-MM-DD; el ISO pasa tal cual", () => {
    expect(toFieldDate("12/03/2026", "es")).toBe("2026-03-12");
    expect(toFieldDate("03/12/2026", "en")).toBe("2026-03-12");
    expect(toFieldDate("1/2/2026", "es")).toBe("2026-02-01");
    expect(toFieldDate("1-2-2026", "en")).toBe("2026-01-02");
    expect(toFieldDate("30.09.2026", "es")).toBe("2026-09-30");
    expect(toFieldDate("2026-09-30", "es")).toBe("2026-09-30");
    expect(toFieldDate(" 2026-09-30 ", "en")).toBe("2026-09-30");
  });

  it("no se adivina: fechas que no existen o con otro aspecto no se escriben", () => {
    for (const text of ["31/02/2026", "2026-02-30", "13/13/2026", "00/01/2026", "12 de marzo de 2026", "pronto", "12/03/26", "2026/03/12", ""]) expect(toFieldDate(text, "es"), text).toBeNull();
    expect(toFieldDate("30/09/2026", "en")).toBeNull();
    expect(toFieldDate("29/02/2024", "es")).toBe("2024-02-29");
    expect(toFieldDate("29/02/2026", "es")).toBeNull();
  });

  it("en una fila de campo de fecha se muestra el texto del motor pero se GUARDA el ISO (y no hay fila si el campo ya tiene esa fecha)", () => {
    const fields = [field("d", "Date of Loss", { type: "date" })];
    const proposal: FillProposal[] = [{ fieldId: "d", key: "lossDate", value: "30/09/2026", via: "label", overwrites: false }];
    const [row] = planRows(proposal, fields, {}, "es");
    expect(row).toMatchObject({ invalidDate: false, writeValue: "2026-09-30" });
    expect(row.proposal.value).toBe("30/09/2026");
    expect(buildPatch([row], { d: true }, {}).written).toEqual({ d: "2026-09-30" });
    expect(planRows(proposal, fields, { d: "2026-09-30" }, "es")).toEqual([]);
    // La misma fecha escrita con otro valor SI pisaria.
    const [other] = planRows(proposal, fields, { d: "2026-01-01" }, "es");
    expect(overwritesText(other)).toBe(true);
    expect(defaultChecked([other])).toEqual({ d: false });
    // Un campo de TEXTO conserva el valor tal cual.
    expect(planRows([{ fieldId: "t", key: "lossDate", value: "30/09/2026", via: "label", overwrites: false }], [field("t", "Texto")], {})[0].writeValue).toBe("30/09/2026");
  });
});

describe("ids unicos", () => {
  it("dos candidatos con el mismo id del motor quedan con ids distintos y el resto no cambia", () => {
    const a = item("phone", "1");
    const b = { ...item("email", "2"), id: a.id };
    const c = item("address", "3");
    const out = withUniqueIds([a, b, c]);
    expect(new Set(out.map((i) => i.id)).size).toBe(3);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(c);
    expect(out[1].key).toBe("email");
  });
});

describe("campos destino", () => {
  it("solo texto y fecha; con la etiqueta, el dataKey de la plantilla y lo ya escrito", () => {
    const fields = [field("a", "Insured"), field("b", undefined, { type: "date" }), field("c", "Acepto", { type: "checkbox" }), field("d", "Iniciales", { type: "initials" })];
    expect(fillableFields(fields).map((f) => f.id)).toEqual(["a", "b"]);
    expect(buildTargets(fields, { a: "ya escrito" }, { b: "today" })).toEqual([
      { fieldId: "a", label: "Insured", type: "text", currentValue: "ya escrito" },
      { fieldId: "b", dataKey: "today", type: "date", currentValue: "" },
    ]);
  });

  it("el dataKey no se toma de la cadena de prototipos", () => {
    expect(buildTargets([field("constructor", "x")], {}, {})[0]).not.toHaveProperty("dataKey");
  });
});

describe("filas de «Donde se escribira»", () => {
  const fields = [field("f1", "Insured Name"), field("f2", "Phone", { pageIndex: 1 }), field("f3", "Policy Number", { source: "heuristic-vector" }), field("f4", "Date of Loss", { type: "date" })];
  const proposals = (values: Record<string, string>) => planFillDouble(buildTargets(fields, values, undefined), [{ key: "insuredName1", value: "Ana" }, { key: "phone", value: "555-0100" }, { key: "policyNumber", value: "P-1" }, { key: "lossDate", value: "2026-03-12" }]);

  it("una fila por propuesta, en orden de lectura, con pagina 1-based y marca de sugerido", () => {
    const rows = planRows(proposals({}), fields, {});
    expect(rows.map((r) => [r.field.id, r.page, r.suggested, r.invalidDate])).toEqual([["f1", 1, false, false], ["f3", 1, true, false], ["f4", 1, false, false], ["f2", 2, false, false]]);
  });

  it("un campo con texto distinto pisaria: sin marcar; con el mismo texto no hay fila; fecha no ISO: no escribible", () => {
    const values = { f1: "Escrito", f2: "555-0100" };
    const rows = planRows(proposals(values), fields, values);
    expect(rows.map((r) => r.field.id)).toEqual(["f1", "f3", "f4"]);
    const checked = defaultChecked(rows);
    expect(checked).toEqual({ f1: false, f3: true, f4: true });
    expect(overwritesText(rows[0])).toBe(true);
    const bad: FillProposal[] = [{ fieldId: "f4", key: "lossDate", value: "el 12 de marzo", via: "label", overwrites: false }];
    const [row] = planRows(bad, fields, {});
    expect(row.invalidDate).toBe(true);
    expect(defaultChecked([row])).toEqual({ f4: false });
    expect(checkedCount([row], { f4: true })).toBe(0);
    expect(buildPatch([row], { f4: true }, {}).written).toEqual({});
  });

  it("no se fia solo de `overwrites` del motor: si el campo tiene texto distinto tambien cuenta como pisado", () => {
    const [row] = planRows([{ fieldId: "f1", key: "insuredName1", value: "Ana", via: "label", overwrites: false }], fields, { f1: "Otro" });
    expect(overwritesText(row)).toBe(true);
    expect(defaultChecked([row])).toEqual({ f1: false });
  });

  it("ignora propuestas de campos que ya no existen, vacias o repetidas para el mismo campo", () => {
    const rows = planRows(
      [
        { fieldId: "nope", key: "phone", value: "1", via: "label", overwrites: false },
        { fieldId: "f1", key: "insuredName1", value: "  ", via: "label", overwrites: false },
        { fieldId: "f1", key: "insuredName1", value: "Ana", via: "label", overwrites: false },
        { fieldId: "f1", key: "insuredName1", value: "Beto", via: "label", overwrites: false },
      ],
      fields,
      {},
    );
    expect(rows.map((r) => [r.field.id, r.proposal.value])).toEqual([["f1", "Ana"]]);
  });

  it("claves marcadas sin ningun campo donde ir", () => {
    const accepted = [item("insuredName1", "Ana"), item("claimNumber", "C-1")];
    const rows = planRows(planFillDouble(buildTargets(fields, {}, undefined), accepted), fields, {});
    expect(unmatchedKeys(accepted, rows)).toEqual(["claimNumber"]);
  });
});

describe("escribir y deshacer un paso", () => {
  const fields = [field("f1", "Insured Name"), field("f2", "Phone")];
  const accepted: ExtractedValue[] = [item("insuredName1", "Ana"), item("phone", "555-0100")];

  it("buildPatch guarda lo que escribe y lo que habia; solo filas marcadas y escribibles", () => {
    const values = { f2: "viejo" };
    const rows = planRows(planFillDouble(buildTargets(fields, values, undefined), accepted), fields, values);
    const patch = buildPatch(rows, { f1: true, f2: true }, values);
    expect(patch).toEqual({ written: { f1: "Ana", f2: "555-0100" }, previous: { f1: undefined, f2: "viejo" } });
    expect(applyPatch(values, patch)).toEqual({ f1: "Ana", f2: "555-0100" });
    expect(buildPatch(rows, { f1: true, f2: false }, values).written).toEqual({ f1: "Ana" });
    expect(buildPatch(rows, {}, values).written).toEqual({});
  });

  it("deshacer devuelve lo anterior, quita lo que no existia y respeta lo que la persona cambio despues", () => {
    const patch = { written: { f1: "Ana", f2: "555-0100" }, previous: { f1: undefined, f2: "viejo" } };
    const alive = new Set(["f1", "f2"]);
    expect(undoPatch({ f1: "Ana", f2: "555-0100", f3: "otro" }, patch, alive)).toEqual({ f2: "viejo", f3: "otro" });
    // La persona edito f1 despues del relleno: su cambio manda.
    expect(undoPatch({ f1: "Ana Pérez", f2: "555-0100" }, patch, alive)).toEqual({ f1: "Ana Pérez", f2: "viejo" });
    // Un campo borrado no se resucita.
    expect(undoPatch({ f1: "Ana", f2: "555-0100" }, patch, new Set(["f1"]))).toEqual({ f2: "555-0100" });
  });
});

describe("perfil", () => {
  it("nombre propuesto: el del asegurado marcado", () => {
    expect(suggestProfileName([item("phone", "1"), item("insuredName1", "Ana Pérez")])).toBe("Ana Pérez");
    expect(suggestProfileName([item("phone", "1")])).toBe("");
  });

  it("el origen de cada valor: corregido = typed, leido tal cual = extracted", () => {
    const items = [item("insuredName1", "Ana"), item("phone", "555-0100")];
    const groups = groupItems(items, "es");
    const accepted = acceptedValues(groups, defaultSelection(groups), { [groups[1].items[0].id]: "555-0111" });
    const payload = profilePayload(accepted, items, { [groups[1].items[0].id]: "555-0111" });
    expect(payload.values).toEqual({ insuredName1: "Ana", phone: "555-0111" });
    expect(payload.sources).toEqual({ insuredName1: "extracted", phone: "typed" });
    // Cambiar solo mayusculas o espacios no cuenta como correccion.
    const same = profilePayload(acceptedValues(groups, defaultSelection(groups), { [groups[0].items[0].id]: " ANA " }), items, { [groups[0].items[0].id]: " ANA " });
    expect(same.sources.insuredName1).toBe("extracted");
  });

  it("un perfil se vuelve candidatos de confianza alta con su origen, en orden de registro", () => {
    const profile: ClientProfile = {
      id: "cp-1",
      name: "Pérez",
      updatedAt: "2026-10-20T10:00:00.000Z",
      values: {
        zzz: { value: "z", updatedAt: "2026-10-20T10:00:00.000Z", source: "typed" },
        phone: { value: "555", updatedAt: "2026-10-20T10:00:00.000Z", source: "typed" },
        insuredName1: { value: "Ana", updatedAt: "2026-10-20T10:00:00.000Z", source: "extracted" },
      },
    };
    const items = profileItems(profile);
    expect(items.map((i) => [i.key, i.tier, i.fromProfile?.name])).toEqual([["insuredName1", "high", "Pérez"], ["phone", "high", "Pérez"], ["zzz", "high", "Pérez"]]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });
});
