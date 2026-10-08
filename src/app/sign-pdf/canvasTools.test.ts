import { describe, expect, it } from "vitest";
import {
  availableTools,
  convertValueForType,
  formatInitials,
  isIsoDate,
  toolFromShortcut,
} from "@/app/sign-pdf/canvasTools";

describe("convertValueForType", () => {
  it("conserva el valor entre texto e iniciales (con el formato de las iniciales)", () => {
    expect(convertValueForType("Ana Maria", "text", "initials")).toEqual({ value: "AM", cleared: false });
    expect(convertValueForType("AMP", "initials", "text")).toEqual({ value: "AMP", cleared: false });
  });

  it("fecha valida -> texto conserva; texto -> fecha solo si ya es una fecha valida", () => {
    expect(convertValueForType("2026-10-08", "date", "text")).toEqual({ value: "2026-10-08", cleared: false });
    expect(convertValueForType("2026-10-08", "text", "date")).toEqual({ value: "2026-10-08", cleared: false });
    expect(convertValueForType("Hola", "text", "date")).toEqual({ value: "", cleared: true });
    expect(convertValueForType("2026-02-31", "text", "date")).toEqual({ value: "", cleared: true });
  });

  it("a casilla solo sobrevive 'true'; de casilla a cualquier otro se borra", () => {
    expect(convertValueForType("true", "checkbox", "checkbox").cleared).toBe(false);
    expect(convertValueForType("Ana", "text", "checkbox")).toEqual({ value: "", cleared: true });
    expect(convertValueForType("true", "checkbox", "text")).toEqual({ value: "", cleared: true });
  });

  it("un valor vacio nunca cuenta como borrado", () => {
    expect(convertValueForType("", "text", "date")).toEqual({ value: "", cleared: false });
  });
});

describe("isIsoDate / formatInitials / atajos", () => {
  it("valida fechas ISO reales", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("08/10/2026")).toBe(false);
  });
  it("formatea iniciales", () => {
    expect(formatInitials("abcdef")).toBe("ABCD");
  });
  it("iniciales: recorta los espacios de los extremos y abrevia varias palabras a sus iniciales", () => {
    expect(formatInitials("  Ana  Maria  ")).toBe("AM");
    expect(formatInitials("Hola mundo")).toBe("HM");
    expect(formatInitials("Hola\tmundo\nfeliz")).toBe("HMF");
    // Una sola palabra: sus primeras letras (ya son iniciales o un nombre suelto).
    expect(formatInitials("  ana ")).toBe("ANA");
    expect(formatInitials("Supercalifragilistico")).toBe("SUPE");
    // Un valor muy largo nunca pasa de 4 letras.
    expect(formatInitials("uno dos tres cuatro cinco seis siete")).toBe("UDTC");
    expect(formatInitials("x".repeat(500))).toBe("XXXX");
    // Vacio o solo espacios: nada.
    expect(formatInitials("")).toBe("");
    expect(formatInitials("   \n ")).toBe("");
    // Unicode completo (no unidades UTF-16 partidas) y mayusculas con acento.
    expect(formatInitials("élan vital")).toBe("ÉV");
    expect(Array.from(formatInitials("😀😀😀😀😀😀")).length).toBe(4);
    // Idempotente: unas iniciales ya hechas se quedan como estan.
    expect(formatInitials("AM")).toBe("AM");
    expect(formatInitials(formatInitials("Hola mundo"))).toBe("HM");
  });
  it("el modo Solo yo ofrece Firma sin firmantes y nunca Iniciales", () => {
    expect(availableTools({ hasSigners: false, richFieldTypes: true, solo: true })).toEqual([
      "select",
      "signature",
      "text",
      "checkbox",
      "date",
    ]);
    // Aunque hubiera firmantes guardados de la otra modalidad.
    expect(availableTools({ hasSigners: true, richFieldTypes: false, solo: true })).toEqual([
      "select",
      "signature",
      "text",
    ]);
    // Sin `solo` todo sigue igual.
    expect(availableTools({ hasSigners: true, richFieldTypes: true })).toEqual([
      "select",
      "signature",
      "initials",
      "text",
      "checkbox",
      "date",
    ]);
  });
  it("atajos y disponibilidad", () => {
    expect(toolFromShortcut("F")).toBe("signature");
    expect(toolFromShortcut("x")).toBeNull();
    expect(availableTools({ hasSigners: false, richFieldTypes: false })).toEqual(["select", "text"]);
  });
});
