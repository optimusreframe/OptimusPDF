import { describe, expect, it } from "vitest";
import { INK_COLORS } from "@/lib/pdf/core";
import { colorName } from "@/lib/colorNames";

const HEX = /^#[0-9a-f]{3,8}$/i;

describe("colorName", () => {
  it("todas las tintas del documento tienen nombre propio, en español e ingles, y ninguno es un codigo", () => {
    for (const color of INK_COLORS) {
      for (const language of ["es", "en"] as const) {
        const name = colorName(color, language);
        expect(name, `${color} ${language}`).not.toMatch(HEX);
        expect(name.length).toBeGreaterThan(2);
      }
    }
    expect(colorName("#0d4bff", "es")).toBe("Azul");
    expect(colorName("#0d4bff", "en")).toBe("Blue");
    expect(colorName("#e11d48", "es")).toBe("Rojo");
    expect(colorName("#ffffff", "en")).toBe("White");
  });

  it("las tintas de la firma tienen nombre", () => {
    expect(colorName("#0b0b0c", "es")).toBe("Negro");
    expect(colorName("#12327d", "es")).toBe("Azul marino");
    expect(colorName("#3d3d42", "en")).toBe("Dark grey");
  });

  it("los nombres de una misma paleta son distintos (cada muestra se distingue por su nombre)", () => {
    const document = INK_COLORS.map((color) => colorName(color, "es"));
    expect(new Set(document).size).toBe(document.length);
    const signature = ["#0b0b0c", "#12327d", "#3d3d42"].map((color) => colorName(color, "es"));
    expect(new Set(signature).size).toBe(3);
  });

  it("no distingue mayusculas ni espacios", () => {
    expect(colorName(" #0D4BFF ", "es")).toBe("Azul");
  });

  it("un color que no esta en las paletas recibe un nombre aproximado (nunca el codigo)", () => {
    expect(colorName("#ff0000", "es")).toBe("Rojo");
    expect(colorName("#00ff00", "en")).toBe("Green");
    expect(colorName("#fff176", "es")).toBe("Amarillo");
    expect(colorName("#808080", "es")).toBe("Gris");
    expect(colorName("#fff", "es")).toBe("Blanco");
    expect(colorName("#000", "en")).toBe("Black");
  });

  it("un valor que no es un color se devuelve tal cual", () => {
    expect(colorName("transparent", "es")).toBe("transparent");
  });
});
