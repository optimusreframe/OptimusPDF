import { describe, expect, it } from "vitest";
import { findEmails, findPhones, validEmail } from "@/lib/autofill/valuePhone";

describe("findPhones", () => {
  it.each([
    ["305-555-0142", "(305) 555-0142"],
    ["(305) 555-0142", "(305) 555-0142"],
    ["305.555.0142", "(305) 555-0142"],
    ["305 555 0142", "(305) 555-0142"],
    ["3055550142", "(305) 555-0142"],
    ["+1 305 555 0142", "(305) 555-0142"],
    ["1-305-555-0142", "(305) 555-0142"],
    ["(787) 555-0123", "(787) 555-0123"],
    ["Tel: 787-555-0123 ext. 45", "(787) 555-0123 ext. 45"],
    ["+52 55 1234 5678", "+52 55 1234 5678"],
    ["+52 1 55 1234 5678", "+52 55 1234 5678"],
    ["+57 300 123 4567", "+57 300 123 4567"],
  ])("%s -> %s", (raw, expected) => {
    const found = findPhones(raw);
    expect(found[0]?.value).toBe(expected);
  });

  it("varios telefonos en un texto, en orden", () => {
    const found = findPhones("Home 305-555-0142 / Cell (407) 555-0199");
    expect(found.map((phone) => phone.value)).toEqual(["(305) 555-0142", "(407) 555-0199"]);
  });

  it("un telefono pegado a un codigo postal se separa", () => {
    expect(findPhones("Miami FL 33166 305-555-0142")[0]?.value).toBe("(305) 555-0142");
  });

  it("el fax no cuenta", () => {
    expect(findPhones("Fax: 305-555-0189")).toHaveLength(0);
    expect(findPhones("Fax No. (305) 555-0189")).toHaveLength(0);
    expect(findPhones("Tel 305-555-0188 Fax 305-555-0189").map((phone) => phone.value)).toEqual(["(305) 555-0188"]);
  });

  it.each(["2026-03-04", "03/04/2026", "123-45-6789", "1234567890", "000-000-0000", "111-111-1111", "123", "33166-1234", "(055) 555-0142", "305-055-0142", "12345678901234567890"])("rechaza «%s»", (raw) => {
    expect(findPhones(raw)).toHaveLength(0);
  });

  it("7 cifras o 10 mexicanas solo con etiqueta", () => {
    expect(findPhones("555-0142")).toHaveLength(0);
    expect(findPhones("555-0142", true)[0]?.value).toBe("555-0142");
  });

  it("no toma un tramo dentro de un numero mas largo ni de un correo", () => {
    expect(findPhones("A-3055550142-B")).toHaveLength(0);
    expect(findPhones("maria.3055550142@example.com")).toHaveLength(0);
  });
});

describe("findEmails", () => {
  it("encuentra y pasa a minusculas", () => {
    const found = findEmails("Contact: Maria.Perez+claims@Example.COM, thanks");
    expect(found.map((email) => email.value)).toEqual(["maria.perez+claims@example.com"]);
  });

  it("marca los buzones genericos", () => {
    expect(findEmails("info@empresa.com")[0].generic).toBe(true);
    expect(findEmails("maria@empresa.com")[0].generic).toBe(false);
  });

  it.each(["maria@", "@example.com", "maria@example", "maria@@example.com", "maria@example..com", ".maria@example.com", "maria.@example.com", "maria@-example.com", "maria@example.c", "mailto"])("rechaza «%s»", (raw) => {
    expect(findEmails(raw)).toHaveLength(0);
  });

  it("validEmail", () => {
    expect(validEmail("a@b.co")).toBe(true);
    expect(validEmail("a@b")).toBe(false);
    expect(validEmail("a b@c.com")).toBe(false);
  });
});
