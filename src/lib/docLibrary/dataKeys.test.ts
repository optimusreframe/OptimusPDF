import { afterEach, describe, expect, it } from "vitest";
import { DATA_KEY_PATTERN, TODAY_DATA_KEY, __resetDataKeysForTests, getDataKey, getDataKeys, isKnownDataKey, isValidDataKey, registerDataKey, suggestDataKey } from "./dataKeys";

afterEach(() => __resetDataKeysForTests());

describe("registro de orígenes de dato", () => {
  it("trae la lista corta del plan (§3 Fase 2)", () => {
    const keys = getDataKeys().map((definition) => definition.key);
    for (const key of ["insuredName1", "phone", "email", "address", "insurer", "policyNumber", "claimNumber", "claimType", "lossDate", TODAY_DATA_KEY]) {
      expect(keys, key).toContain(key);
    }
    expect(getDataKey("phone")?.label).toEqual({ es: "Teléfono", en: "Phone" });
    expect(getDataKey("today")?.fieldType).toBe("date");
    expect(getDataKey("lossDate")?.fieldType).toBe("date");
  });

  it("cada clave de fábrica tiene la forma válida y etiquetas en los dos idiomas", () => {
    for (const definition of getDataKeys()) {
      expect(DATA_KEY_PATTERN.test(definition.key), definition.key).toBe(true);
      expect(definition.label.es.length).toBeGreaterThan(0);
      expect(definition.label.en.length).toBeGreaterThan(0);
    }
  });

  it("es extensible: registerDataKey añade y reemplaza; una clave inválida lanza", () => {
    expect(isKnownDataKey("vehiclePlate")).toBe(false);
    registerDataKey({ key: "vehiclePlate", label: { es: "Placa", en: "Plate" }, fieldType: "text", hints: [/\bplaca\b/, /\bplate\b/] });
    expect(isKnownDataKey("vehiclePlate")).toBe(true);
    expect(suggestDataKey("Placa del vehículo")).toBe("vehiclePlate");
    registerDataKey({ key: "phone", label: { es: "Celular", en: "Cell" }, fieldType: "text", hints: [] });
    expect(getDataKey("phone")?.label.es).toBe("Celular");
    for (const bad of ["", "Phone", "1abc", "a b", "x".repeat(41), "a-b"]) expect(() => registerDataKey({ key: bad, label: { es: "x", en: "x" }, fieldType: "text", hints: [] }), bad).toThrow(RangeError);
    __resetDataKeysForTests();
    expect(isKnownDataKey("vehiclePlate")).toBe(false);
    expect(getDataKey("phone")?.label.es).toBe("Teléfono");
  });

  it("isValidDataKey solo mira la forma, no el registro", () => {
    expect(isValidDataKey("futureKey")).toBe(true);
    expect(isValidDataKey("Future")).toBe(false);
    expect(isValidDataKey(5)).toBe(false);
    expect(isValidDataKey(undefined)).toBe(false);
  });
});

describe("suggestDataKey (solo una sugerencia, a partir de la etiqueta detectada)", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Claim Number", "claimNumber"],
    ["Claim #", "claimNumber"],
    ["Número de reclamo", "claimNumber"],
    ["N.º de siniestro", "claimNumber"],
    ["Policy Number", "policyNumber"],
    ["Policy No.", "policyNumber"],
    ["Número de póliza", "policyNumber"],
    ["Phone", "phone"],
    ["Teléfono", "phone"],
    ["Cell", "phone"],
    ["Email", "email"],
    ["E-mail address", "email"],
    ["Correo electrónico", "email"],
    ["Address", "address"],
    ["Dirección", "address"],
    ["Insurance Company", "insurer"],
    ["Aseguradora", "insurer"],
    ["Type of Loss", "claimType"],
    ["Tipo de reclamo", "claimType"],
    ["Date of Loss", "lossDate"],
    ["Fecha de pérdida", "lossDate"],
    ["Date", "today"],
    ["Fecha", "today"],
    ["Print Name", "insuredName1"],
    ["Nombre del asegurado", "insuredName1"],
    ["Co-insured name", "insuredName2"],
    ["Nombre del co-asegurado", "insuredName2"],
    ["Zzz", undefined],
    ["", undefined],
    ["   ", undefined],
  ];
  for (const [label, expected] of cases) {
    it(`«${label}» → ${expected ?? "nada"}`, () => expect(suggestDataKey(label)).toBe(expected));
  }

  it("sin etiqueta → nada", () => {
    expect(suggestDataKey(undefined)).toBeUndefined();
  });

  it("las claves específicas ganan a las genéricas («date of loss» no es la fecha de hoy)", () => {
    expect(suggestDataKey("Date of loss")).toBe("lossDate");
    expect(suggestDataKey("Co-insured")).toBe("insuredName2");
  });
});
