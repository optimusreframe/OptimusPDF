import { describe, expect, it } from "vitest";
import { findInsurerName, parseClaimType, parseIdValue, parseInsurer } from "@/lib/autofill/valueOther";

describe("parseIdValue — poliza y reclamo", () => {
  it.each([
    ["12-AB-3456", "12-AB-3456"],
    ["12-ab-3456", "12-AB-3456"],
    ["HO3-0042817", "HO3-0042817"],
    ["FL-HO-2026-004721", "FL-HO-2026-004721"],
    ["CLM-2026-118342", "CLM-2026-118342"],
    ["# 6296814669", "6296814669"],
    ["No. 12345678", "12345678"],
    ["Nº 12-345-678", "12-345-678"],
    ["12345678.", "12345678"],
    ["12345678, issued", "12345678"],
    ["96-284-674 (pending review)", "96-284-674"],
    ["P-8812-4403", "P-8812-4403"],
    ["0042817/2026", "0042817/2026"],
  ])("%s -> %s", (raw, expected) => {
    expect(parseIdValue(raw)?.value).toBe(expected);
  });

  it.each([
    "",
    "____",
    "N/A",
    "TBD",
    "Policy",
    "none",
    "abc",
    "12",
    "2026",
    "03/04/2026",
    "2026-03-04",
    "name@example.com",
    "Page2",
    "E1",
    "12345 was issued on the date shown below in the declarations",
    "(305) 555-0142",
  ])("rechaza «%s»", (raw) => {
    expect(parseIdValue(raw)).toBeNull();
  });

  it("solo digitos largos valen mas que unos pocos", () => {
    expect(parseIdValue("123456")!.strength).toBeGreaterThan(parseIdValue("1234")!.strength);
  });
});

describe("parseInsurer", () => {
  it.each([
    ["State Farm", "State Farm"],
    ["STATE FARM FLORIDA INSURANCE COMPANY", "State Farm Florida Insurance Company"],
    ["Citizens Property Insurance Corporation", "Citizens Property Insurance Corporation"],
    ["Universal Property & Casualty Insurance Company", "Universal Property & Casualty Insurance Company"],
    ["Seguros Atlas del Caribe", "Seguros Atlas del Caribe"],
    ["SEGUROS MONTERREY", "Seguros Monterrey"],
    ["Allstate", "Allstate"],
    ["GEICO", "GEICO"],
    ["Liberty Mutual Insurance Co.", "Liberty Mutual Insurance Co."],
  ])("%s -> %s", (raw, expected) => {
    expect(parseInsurer(raw, true)?.value).toBe(expected);
  });

  it("conocida = fuerza 1; desconocida con etiqueta = fuerza baja", () => {
    expect(parseInsurer("State Farm", true)!.strength).toBe(1);
    expect(parseInsurer("Frontline", true)!.strength).toBeLessThan(0.7);
    expect(parseInsurer("Frontline", false)).toBeNull();
  });

  it.each(["", "N/A", "____", "as set forth below", "The insurer shall pay all claims", "12345", "maria@example.com", "a b c d e f g h i j k l m n"])("rechaza «%s»", (raw) => {
    expect(parseInsurer(raw, true)).toBeNull();
  });

  it("findInsurerName (membrete): solo nombres conocidos o con sufijo, lineas cortas", () => {
    expect(findInsurerName("State Farm")?.value).toBe("State Farm");
    expect(findInsurerName("Palmetto Mutual Insurance Company")?.value).toBe("Palmetto Mutual Insurance Company");
    expect(findInsurerName("Maria Perez")).toBeNull();
    expect(findInsurerName("Dear Maria Perez, thank you for your claim with State Farm and for your patience in this matter")).toBeNull();
  });
});

describe("parseClaimType", () => {
  it.each([
    ["Wind", "Wind", true],
    ["WIND/HAIL", "Wind/Hail", true],
    ["Water Damage", "Water Damage", true],
    ["Hurricane", "Hurricane", true],
    ["Daño por agua", "Daño por agua", true],
    ["FILTRACIÓN EN EL TECHO", "Filtración en el Techo", true],
    ["Incendio", "Incendio", true],
    ["Kitchen", "Kitchen", false],
  ])("%s", (raw, expected, peril) => {
    const parsed = parseClaimType(raw);
    expect(parsed?.value).toBe(expected);
    expect(parsed?.perilFound).toBe(peril);
  });

  it("una descripcion sin causa conocida es floja", () => {
    expect(parseClaimType("Kitchen")!.strength).toBeLessThan(0.7);
    expect(parseClaimType("Wind")!.strength).toBe(1);
  });

  it.each(["", "N/A", "____", "see attached documentation for the full description of every item that was damaged in the loss", "12345678", "a@b.com"])("rechaza «%s»", (raw) => {
    expect(parseClaimType(raw)).toBeNull();
  });
});
