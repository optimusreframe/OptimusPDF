import { describe, expect, it } from "vitest";
import {
  IMAGE_PAGE_COVERAGE,
  MIN_CHARS_FOR_TEXT_PAGE,
  countLegibleChars,
  decidePageSource,
  imageCoverage,
} from "@/lib/pdf/pageTextKind";

describe("countLegibleChars", () => {
  it("cuenta como legible todo lo imprimible (letras, cifras, signos, simbolos) y no los blancos", () => {
    expect(countLegibleChars("&")).toEqual({ legible: 1, illegible: 0 });
    expect(countLegibleChars("é")).toEqual({ legible: 1, illegible: 0 });
    expect(countLegibleChars("Fin.")).toEqual({ legible: 4, illegible: 0 });
    expect(countLegibleChars("—")).toEqual({ legible: 1, illegible: 0 });
    expect(countLegibleChars("1")).toEqual({ legible: 1, illegible: 0 });
    expect(countLegibleChars("Año 2024 ñandú")).toEqual({ legible: 12, illegible: 0 });
    expect(countLegibleChars("密码 😀")).toEqual({ legible: 3, illegible: 0 });
    expect(countLegibleChars("   ")).toEqual({ legible: 0, illegible: 0 });
  });

  it("control, formato, uso privado, sin asignar y U+FFFD son ilegibles", () => {
    expect(countLegibleChars("\u0001\u0007")).toEqual({ legible: 0, illegible: 2 });
    expect(countLegibleChars("\uE000\uF8FF")).toEqual({ legible: 0, illegible: 2 });
    expect(countLegibleChars("\uFFFD\uFFFDx")).toEqual({ legible: 1, illegible: 2 });
    expect(countLegibleChars("\u200B")).toEqual({ legible: 0, illegible: 1 });
  });
});

describe("decidePageSource", () => {
  const page = (text: string, ocrFallback = true) => {
    const { legible, illegible } = countLegibleChars(text);
    return decidePageSource({ chars: text.trim().length, legibleChars: legible, illegibleChars: illegible, ocrFallback });
  };

  it("24 caracteres o mas: texto, igual que siempre", () => {
    expect(page("x".repeat(MIN_CHARS_FOR_TEXT_PAGE))).toBe("text");
    expect(page("x".repeat(500))).toBe("text");
  });

  // Regresion (W6-D): una pagina que solo dice «&» (u otro simbolo) se mandaba al OCR, que la leia «8».
  it("cualquier texto legible corto («&», «é», «Fin.», «—», «1») se conserva: solo se mira si la pagina es una imagen", () => {
    for (const text of ["&", "é", "Fin.", "—", "1", "Fin del texto"]) {
      expect(page(text), text).toBe("checkImage");
      expect(page(text, false), text).toBe("text");
    }
  });

  it("sin nada legible (vacia, blancos o basura): OCR si esta activado; si no, texto o vacia", () => {
    expect(page("")).toBe("ocr");
    expect(page("\u0001\u0002")).toBe("ocr");
    expect(page("", false)).toBe("empty");
    expect(page("\uFFFD", false)).toBe("text");
  });

  it("mayoria de caracteres ilegibles: no se fia de la capa de texto", () => {
    expect(page("\uFFFD\uFFFD\uFFFDx")).toBe("ocr");
    expect(page("\uFFFDxxx")).toBe("checkImage");
  });
});

describe("imageCoverage", () => {
  const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5 };

  it("una imagen que ocupa toda la pagina cubre 1; una pequena, casi nada", () => {
    const area = 600 * 800;
    expect(imageCoverage([OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], [null, [600, 0, 0, 800, 0, 0], ["i"], null], OPS, area)).toBeCloseTo(1);
    expect(imageCoverage([OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], [null, [60, 0, 0, 40, 0, 0], ["i"], null], OPS, area)).toBeLessThan(0.01);
  });

  it("respeta save/restore y compone matrices (la imagen girada 90 grados sigue ocupando lo mismo)", () => {
    const area = 600 * 800;
    const fn = [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.restore, OPS.paintImageXObject];
    const args = [null, [2, 0, 0, 2, 0, 0], null, [0, 300, -400, 0, 0, 0], ["i"], null, null, ["i"]];
    // 1.a imagen: matriz 2x · giro (300 x 400) = area 4 * 120000 / ... = 480000 -> 1.0 de la pagina; la 2.a, sin matriz, ~0.
    expect(imageCoverage(fn, args, OPS, area)).toBeCloseTo(1, 1);
  });

  it(`el umbral de «pagina-imagen» es ${IMAGE_PAGE_COVERAGE}`, () => {
    expect(IMAGE_PAGE_COVERAGE).toBe(0.5);
  });

  it("area de pagina 0 o sin imagenes: 0", () => {
    expect(imageCoverage([], [], OPS, 100)).toBe(0);
    expect(imageCoverage([OPS.paintImageXObject], [["i"]], OPS, 0)).toBe(0);
  });
});
