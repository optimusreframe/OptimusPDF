import { describe, expect, it } from "vitest";
import { outputFileName, uniqueNames } from "@/lib/media/image/names";

describe("outputFileName", () => {
  it("cambia la extension y anade el sufijo (patron withSuffix)", () => {
    expect(outputFileName("foto.png", "convertida", "jpg")).toBe("foto-convertida.jpg");
    expect(outputFileName("Vacaciones 2026.HEIC", "converted", "webp")).toBe("Vacaciones 2026-converted.webp");
  });

  it("no se come la parte final de un nombre con puntos", () => {
    expect(outputFileName("informe.v2.png", "convertida", "jpg")).toBe("informe.v2-convertida.jpg");
  });

  it("un nombre sin extension o sin nombre util da uno razonable", () => {
    expect(outputFileName("scan", "convertida", "png")).toBe("scan-convertida.png");
    expect(outputFileName("   ", "convertida", "png")).toBe("imagen-convertida.png");
  });

  it("quita separadores de ruta y caracteres de control (un nombre no puede escribir fuera del ZIP)", () => {
    expect(outputFileName("../../etc/pasa.png", "convertida", "jpg")).toBe("pasa-convertida.jpg");
    expect(outputFileName("a\u0000b\u0001c.png", "convertida", "jpg")).toBe("a b c-convertida.jpg");
    expect(outputFileName("C:\\Users\\yo\\foto.png", "convertida", "jpg")).toBe("foto-convertida.jpg");
  });
});

describe("uniqueNames", () => {
  it("numera los repetidos sin tocar los demas", () => {
    expect(uniqueNames(["a.jpg", "b.jpg", "a.jpg", "a.jpg"])).toEqual(["a.jpg", "b.jpg", "a (2).jpg", "a (3).jpg"]);
  });

  it("no distingue mayusculas (Windows y macOS tampoco)", () => {
    expect(uniqueNames(["Foto.JPG", "foto.jpg"])).toEqual(["Foto.JPG", "foto (2).jpg"]);
  });

  it("no choca con un nombre ya numerado a mano", () => {
    expect(uniqueNames(["a (2).jpg", "a.jpg", "a.jpg"])).toEqual(["a (2).jpg", "a.jpg", "a (3).jpg"]);
  });

  it("nombres sin extension", () => {
    expect(uniqueNames(["x", "x"])).toEqual(["x", "x (2)"]);
  });
});
