import { describe, expect, it } from "vitest";
import { looksLikePersonName, parseNames } from "@/lib/autofill/valueName";

describe("parseNames — un nombre", () => {
  it.each([
    ["Maria Perez", "Maria Perez"],
    ["MARIA PEREZ", "Maria Perez"],
    ["maria perez", "Maria Perez"],
    ["Mr. John Smith", "John Smith"],
    ["Mrs. Jane Smith", "Jane Smith"],
    ["Sra. María Pérez", "María Pérez"],
    ["Sr. Luis Gómez", "Luis Gómez"],
    ["Dr. Emily O'Hara", "Emily O'Hara"],
    ["PEREZ, MARIA", "Maria Perez"],
    ["Perez Gomez, Maria", "Maria Perez Gomez"],
    ["Ana María de los Ángeles Pérez García", "Ana María de los Ángeles Pérez García"],
    ["JOSÉ DE LA CRUZ MUÑOZ", "José de la Cruz Muñoz"],
    ["Maria Perez-Lopez", "Maria Perez-Lopez"],
    ["John A. Smith", "John A. Smith"],
    ["JOHN A SMITH", "John A. Smith"],
    ["John Smith Jr.", "John Smith Jr."],
    ["JOHN SMITH III", "John Smith III"],
    ["Smith, Jr.", "Smith Jr."],
    ["Maria Perez (insured)", "Maria Perez"],
    ["  Maria   Perez  ", "Maria Perez"],
    ["____ Maria Perez ____", "Maria Perez"],
  ])("%s -> %s", (raw, expected) => {
    const parsed = parseNames(raw);
    expect(parsed?.names).toEqual([expected]);
  });

  it("una sola palabra es debil (strength baja)", () => {
    const parsed = parseNames("Perez");
    expect(parsed?.names).toEqual(["Perez"]);
    expect(parsed!.strength).toBeLessThan(0.9);
  });

  it("minusculas se marcan", () => {
    expect(parseNames("maria perez")?.lower).toBe(true);
    expect(parseNames("Maria Perez")?.lower).toBe(false);
  });

  it.each([
    "",
    "N/A",
    "____",
    "Policy Number",
    "123 Main St",
    "maria@example.com",
    "Maria Perez 305",
    "Responsive Claims Group LLC",
    "State Farm Insurance Company",
    "I hereby authorize the company to proceed",
    "Terms and Conditions",
    "see above",
    "A very long sentence about the insured party and the coverage that is described below in detail",
    "Maria Perez: yes",
    "Maria Perez Gomez Lopez Martinez Rodriguez Hernandez Sanchez Fernandez",
    "Insured",
    "Name",
  ])("rechaza «%s»", (raw) => {
    expect(parseNames(raw)).toBeNull();
  });
});

describe("parseNames — dos personas", () => {
  it.each([
    ["Teresa Navarro and Camila Navarro", ["Teresa Navarro", "Camila Navarro"]],
    ["TERESA NAVARRO AND CAMILA NAVARRO", ["Teresa Navarro", "Camila Navarro"]],
    ["María Pérez y José Gómez", ["María Pérez", "José Gómez"]],
    ["John Smith & Jane Smith", ["John Smith", "Jane Smith"]],
    ["John Smith + Jane Smith", ["John Smith", "Jane Smith"]],
    ["John Smith / Jane Smith", ["John Smith", "Jane Smith"]],
    ["John Smith; Jane Smith", ["John Smith", "Jane Smith"]],
  ])("%s", (raw, expected) => {
    const parsed = parseNames(raw);
    expect(parsed?.names).toEqual(expected);
    expect(parsed?.shared).toBe(false);
  });

  it("apellido compartido: «Juan y Maria Perez»", () => {
    const parsed = parseNames("Juan y María Pérez López");
    expect(parsed?.names).toEqual(["Juan Pérez López", "María Pérez López"]);
    expect(parsed?.shared).toBe(true);
    expect(parseNames("John and Jane Smith")?.names).toEqual(["John Smith", "Jane Smith"]);
  });

  it("dos palabras sueltas (sin apellido) no valen", () => {
    expect(parseNames("Maria and Jose")).toBeNull();
  });

  it("si la segunda parte no es un nombre, se rechaza todo", () => {
    expect(parseNames("Maria Perez and her husband")).toBeNull();
    expect(parseNames("Maria Perez and 2 children")).toBeNull();
  });

  it("split=false mantiene «y» como parte del texto (y la rechaza si no es nombre)", () => {
    expect(parseNames("Maria Perez and Jose Perez", false)).toBeNull();
  });

  it("el mismo nombre dos veces es uno", () => {
    expect(parseNames("Maria Perez and Maria Perez")?.names).toEqual(["Maria Perez"]);
  });

  it("tres personas: se toman las dos primeras con fuerza reducida", () => {
    const parsed = parseNames("Ana Ruiz, Luis Ruiz and Eva Ruiz".replace(",", " /"));
    expect(parsed?.names).toHaveLength(2);
    expect(parsed!.strength).toBeLessThanOrEqual(0.8);
  });
});

describe("looksLikePersonName", () => {
  it("nombre y apellido sin otras pistas", () => {
    expect(looksLikePersonName("Maria Perez")).toBe(true);
    expect(looksLikePersonName("MARIA PEREZ")).toBe(true);
    expect(looksLikePersonName("Maria")).toBe(false);
    expect(looksLikePersonName("maria perez")).toBe(false);
    expect(looksLikePersonName("Maria Perez and Jose Perez")).toBe(false);
    expect(looksLikePersonName("Dear Maria Perez")).toBe(false);
  });
});
