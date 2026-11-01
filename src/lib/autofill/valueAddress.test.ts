import { describe, expect, it } from "vitest";
import { findCsz, looksLikeCszLine, looksLikeStreet, looksLikeUnitLine, parseAddress } from "@/lib/autofill/valueAddress";

describe("calles", () => {
  it.each([
    ["123 Main St", "us"],
    ["8561 NW South River Drive", "us"],
    ["1200 Brickell Ave Apt 4B", "us"],
    ["4500 S Dixie Hwy", "us"],
    ["77 Harbor View Ln #12", "us"],
    ["P.O. Box 4410", "po"],
    ["PO Box 12", "po"],
    ["Calle Luna #123", "latam"],
    ["Av. Reforma 123", "latam"],
    ["Urb. Las Flores 5", "latam"],
    ["Carr. 833 Km 4.5", "latam"],
    ["Apartado Postal 55", "po"],
  ])("%s -> %s", (line, kind) => {
    expect(looksLikeStreet(line)).toBe(kind);
  });

  it.each(["Maria Perez", "Policy 12345", "123", "March 14, 2026", "", "Insured: Maria"])("«%s» no es una calle", (line) => {
    expect(looksLikeStreet(line)).toBeNull();
  });
});

describe("ciudad, estado y codigo postal", () => {
  it.each(["Miami, FL 33166", "Miami FL 33166-1234", "San Juan, PR 00901", "Miami, Florida 33166", "St Cloud FL 34772", "06600 Ciudad de México", "C.P. 06600"])("encuentra «%s»", (text) => {
    expect(findCsz(text)).not.toBeNull();
  });

  it.each(["Miami, XX 33166", "in 33166", "Miami fl 33166", "me 12345", "Miami, FL", "33166"])("no confunde «%s»", (text) => {
    expect(findCsz(text)).toBeNull();
  });

  it("looksLikeCszLine solo si la linea ES la ciudad", () => {
    expect(looksLikeCszLine("Miami, FL 33166")).toBe(true);
    expect(looksLikeCszLine("123 Main St Miami, FL 33166")).toBe(false);
    expect(looksLikeUnitLine("Apt 4B")).toBe(true);
    expect(looksLikeUnitLine("Suite 200")).toBe(true);
    expect(looksLikeUnitLine("Miami")).toBe(false);
  });
});

describe("parseAddress", () => {
  it("una linea completa", () => {
    const parsed = parseAddress(["123 Main St, Miami, FL 33166"]);
    expect(parsed).toMatchObject({ value: "123 Main St, Miami, FL 33166", hasCsz: true, strength: 1 });
  });

  it("une dos y tres lineas con coma", () => {
    expect(parseAddress(["123 Main St", "Miami, FL 33166"])?.value).toBe("123 Main St, Miami, FL 33166");
    expect(parseAddress(["123 Main St", "Apt 4B", "Miami, FL 33166"])?.value).toBe("123 Main St, Apt 4B, Miami, FL 33166");
    expect(parseAddress(["123 Main St,", "  Miami, FL 33166"])?.value).toBe("123 Main St, Miami, FL 33166");
  });

  it("sin coma entre la calle y la ciudad", () => {
    expect(parseAddress(["3603 Yellow Bird Ct St Cloud FL 34772"])?.hasCsz).toBe(true);
  });

  it("calle sola: valida pero mas floja", () => {
    const parsed = parseAddress(["123 Main St"]);
    expect(parsed?.hasCsz).toBe(false);
    expect(parsed!.strength).toBeLessThan(1);
  });

  it("MAYUSCULAS pasan a titulo con siglas y direcciones intactas", () => {
    expect(parseAddress(["8561 NW SOUTH RIVER DRIVE, MEDLEY FL 33166"])?.value).toBe("8561 NW South River Drive, Medley FL 33166");
    expect(parseAddress(["1200 SW 5TH AVE APT 4B, MIAMI, FL 33130"])?.value).toBe("1200 SW 5th Ave APT 4B, Miami, FL 33130".replace("APT", "Apt").replace("Apt 4B", "Apt 4B"));
    expect(parseAddress(["P.O. BOX 4410, TAMPA, FL 33601"])?.value).toMatch(/^P\.O\. Box 4410, Tampa, FL 33601$/);
  });

  it("Puerto Rico y Latinoamerica", () => {
    expect(parseAddress(["Calle Luna #123, Urb. Las Flores, San Juan, PR 00901"])?.value).toBe("Calle Luna #123, Urb. Las Flores, San Juan, PR 00901");
    expect(parseAddress(["Av. Reforma 123, Col. Juárez, 06600 Ciudad de México"])?.hasStreet).toBe(true);
    expect(parseAddress(["Urb. Las Flores", "San Juan, PR 00901"], true)?.hasCsz).toBe(true);
  });

  it("calle sin sufijo conocido solo con ciudad al lado y modo laxo", () => {
    expect(parseAddress(["1200 NW 5th", "Miami, FL 33166"])).toBeNull();
    expect(parseAddress(["1200 NW 5th", "Miami, FL 33166"], true)?.value).toBe("1200 NW 5th, Miami, FL 33166");
  });

  it.each([
    "Miami, FL 33166",
    "Maria Perez",
    "We shall pay the insured the sum of 1500 dollars within 30 days of the claim being approved by the company",
    "123 Main St, maria@example.com",
    "http://example.com/123 Main St",
    "",
    "N/A",
    "1234",
  ])("rechaza «%s»", (text) => {
    expect(parseAddress([text])).toBeNull();
  });

  it("mas de tres lineas no es una direccion", () => {
    expect(parseAddress(["1 A St", "2 B St", "3 C St", "Miami, FL 33166"])).toBeNull();
  });
});
