import { describe, expect, it } from "vitest";
import { findDates, formatDateForLocale, parseLeadingDate } from "@/lib/autofill/valueDate";

const iso = (text: string): string | null => {
  const found = parseLeadingDate(text);
  return found ? `${found.year}-${String(found.month).padStart(2, "0")}-${String(found.day).padStart(2, "0")}${found.ambiguous ? "?" : ""}` : null;
};

describe("fechas no ambiguas", () => {
  it.each([
    ["March 14, 2026", "2026-03-14"],
    ["March 14 2026", "2026-03-14"],
    ["Mar. 14, 2026", "2026-03-14"],
    ["14 March 2026", "2026-03-14"],
    ["14th of March, 2026", "2026-03-14"],
    ["14-Mar-2026", "2026-03-14"],
    ["14-mar-26", "2026-03-14"],
    ["14 de marzo de 2026", "2026-03-14"],
    ["14 de Marzo del 2026", "2026-03-14"],
    ["marzo 14, 2026", "2026-03-14"],
    ["14 mar 2026", "2026-03-14"],
    ["1ro de septiembre de 2025", "2025-09-01"],
    ["3 de sept. de 2025", "2025-09-03"],
    ["Sept. 3rd, 2025", "2025-09-03"],
    ["December 25, 2025", "2025-12-25"],
    ["25 de diciembre de 2025", "2025-12-25"],
    ["2026-03-14", "2026-03-14"],
    ["2026/03/14", "2026-03-14"],
    ["03/14/2026", "2026-03-14"],
    ["14/03/2026", "2026-03-14"],
    ["14.03.2026", "2026-03-14"],
    ["3/25/26", "2026-03-25"],
    ["25/3/99", "1999-03-25"],
    ["02/29/2024", "2024-02-29"],
    ["03/03/2026", "2026-03-03"],
    ["on March 14, 2026", "2026-03-14"],
    ["el 14 de marzo de 2026", "2026-03-14"],
  ])("%s -> %s", (raw, expected) => {
    expect(iso(raw)).toBe(expected);
  });
});

describe("fechas ambiguas e invalidas", () => {
  it("dia y mes intercambiables se marcan ambiguas y conservan el texto", () => {
    const found = parseLeadingDate("03/04/2026");
    expect(found?.ambiguous).toBe(true);
    expect(found?.source).toBe("03/04/2026");
    expect(iso("3-4-26")).toBe("2026-03-04?");
  });

  it.each(["02/30/2026", "13/13/2026", "00/10/2026", "32/01/2026", "2026-13-01", "03/04/1960", "March 32, 2026", "14 de marzo de 3026", "hello", "", "12345"])("rechaza «%s»", (raw) => {
    expect(parseLeadingDate(raw)).toBeNull();
  });

  it("2/29 solo en bisiestos", () => {
    expect(iso("02/29/2023")).toBeNull();
    expect(iso("02/29/2024")).toBe("2024-02-29");
    expect(iso("02/29/2100")).toBeNull();
  });

  it("la fecha debe abrir el valor, no perderse en una frase", () => {
    expect(parseLeadingDate("sometime after the storm, probably 03/14/2026")).toBeNull();
    expect(parseLeadingDate("(03/14/2026)")?.day).toBe(14);
  });

  it("findDates halla varias, en orden, sin solapes", () => {
    const found = findDates("From 01/15/2024 until March 3, 2025 and 2026-04-20");
    expect(found.map((d) => `${d.year}-${d.month}-${d.day}`)).toEqual(["2024-1-15", "2025-3-3", "2026-4-20"]);
  });
});

describe("formato de salida", () => {
  it("dd/mm/aaaa en espanol y mm/dd/aaaa en ingles", () => {
    expect(formatDateForLocale({ year: 2026, month: 3, day: 4 }, "es")).toBe("04/03/2026");
    expect(formatDateForLocale({ year: 2026, month: 3, day: 4 }, "en")).toBe("03/04/2026");
  });
});
