import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import * as fontkit from "@pdf-lib/fontkit";
import fs from "node:fs";
import path from "node:path";
import {
  LIBERATION_MONO_RANGES,
  LIBERATION_SANS_RANGES,
  LIBERATION_SERIF_RANGES,
} from "@/lib/pdf/editFontCoverage";
import {
  CATALOG,
  CATALOG_FONT_KEYS,
  CatalogFontLoadError,
  LIBERATION_FONT_FACE,
  catalogFontFaceCss,
  catalogFontFile,
  clearCatalogFontCache,
  cssFontStack,
  effectiveFontKey,
  ensureCatalogFontFaces,
  fontCoversText,
  fontHasCodePoint,
  isCatalogFontNative,
  isEmbeddedFont,
  loadCatalogFont,
  mapSourceFont,
  pickFontForText,
  sanitizeTextForFont,
  setCatalogFontReader,
  sourceFontStyle,
  uncoveredChars,
} from "@/lib/pdf/editFonts";
import type { SourceFontInfo } from "@/lib/pdf/editTypes";

function info(
  pdfName: string,
  overrides: Partial<SourceFontInfo> = {},
): SourceFontInfo {
  return {
    pdfName,
    family: "sans",
    bold: false,
    italic: false,
    subset: false,
    embedded: false,
    symbolic: false,
    type3: false,
    ...overrides,
  };
}

const FONTS_DIR = path.join(process.cwd(), "public", "fonts");

afterEach(() => {
  setCatalogFontReader(null);
  clearCatalogFontCache();
});

describe("mapSourceFont — src/lib/pdf/editFonts.ts", () => {
  it.each([
    ["Arial", "helvetica"],
    ["ArialMT", "helvetica"],
    ["Arial-BoldMT", "helvetica"],
    ["ABCDEF+Arial-ItalicMT", "helvetica"],
    ["Helvetica", "helvetica"],
    ["Helvetica-BoldOblique", "helvetica"],
  ])("%s -> %s (exacta)", (name, key) => {
    expect(mapSourceFont(info(name))).toEqual({ key, exact: true });
  });

  it.each([
    ["TimesNewRomanPSMT", "times"],
    ["TimesNewRomanPS-BoldItalicMT", "times"],
    ["Times-Roman", "times"],
    ["BCDEFG+Times-Bold", "times"],
  ])("%s -> %s (exacta)", (name, key) => {
    expect(mapSourceFont(info(name, { family: "serif" }))).toEqual({
      key,
      exact: true,
    });
  });

  it.each(["CourierNewPSMT", "CourierNewPS-BoldMT", "Courier", "Courier-Bold"])(
    "%s -> courier (exacta)",
    (name) => {
      expect(mapSourceFont(info(name, { family: "mono" }))).toEqual({
        key: "courier",
        exact: true,
      });
    },
  );

  it.each(["Calibri", "Calibri-Bold", "Verdana", "Tahoma", "SegoeUI", "Segoe UI Semibold"])(
    "%s -> liberation-sans (aproximada)",
    (name) => {
      expect(mapSourceFont(info(name))).toEqual({
        key: "liberation-sans",
        exact: false,
      });
    },
  );

  it.each(["Cambria", "Georgia-Bold", "Garamond", "EGaramond-Regular"])(
    "%s -> liberation-serif (aproximada)",
    (name) => {
      const mapped = mapSourceFont(info(name, { family: "serif" }));
      expect(mapped.key).toBe("liberation-serif");
      expect(mapped.exact).toBe(false);
    },
  );

  it("los clones metricos de Liberation son exactos", () => {
    expect(mapSourceFont(info("LiberationSans-Bold"))).toEqual({
      key: "liberation-sans",
      exact: true,
    });
    expect(mapSourceFont(info("Arimo-Regular"))).toEqual({
      key: "liberation-sans",
      exact: true,
    });
    expect(mapSourceFont(info("LiberationSerif", { family: "serif" }))).toEqual({
      key: "liberation-serif",
      exact: true,
    });
  });

  it("variantes que NO son la misma fuente (Arial Narrow, Helvetica Neue) son aproximadas", () => {
    expect(mapSourceFont(info("ArialNarrow"))).toEqual({
      key: "helvetica",
      exact: false,
    });
    expect(mapSourceFont(info("ArialUnicodeMS"))).toEqual({
      key: "helvetica",
      exact: false,
    });
    expect(mapSourceFont(info("HelveticaNeue-Light")).exact).toBe(false);
  });

  it("una fuente desconocida se resuelve por familia y es aproximada", () => {
    expect(mapSourceFont(info("Comfortaa", { family: "sans" }))).toEqual({
      key: "helvetica",
      exact: false,
    });
    expect(mapSourceFont(info("Playfair", { family: "serif" }))).toEqual({
      key: "times",
      exact: false,
    });
    expect(mapSourceFont(info("Consolas", { family: "mono" }))).toEqual({
      key: "courier",
      exact: false,
    });
  });
});

describe("sourceFontStyle", () => {
  it("respeta las banderas de pdf.js", () => {
    expect(sourceFontStyle(info("Arial", { bold: true }))).toEqual({
      bold: true,
      italic: false,
    });
    expect(sourceFontStyle(info("Arial", { italic: true })).italic).toBe(true);
  });

  it("deduce negrita y cursiva del nombre si las banderas faltan", () => {
    expect(sourceFontStyle(info("ABCDEF+Arial-BoldItalicMT"))).toEqual({
      bold: true,
      italic: true,
    });
    expect(sourceFontStyle(info("Helvetica-Oblique")).italic).toBe(true);
    expect(sourceFontStyle(info("Arial")).bold).toBe(false);
  });
});

describe("catalogo", () => {
  it("define las 6 claves del contrato", () => {
    expect([...CATALOG_FONT_KEYS].sort()).toEqual(Object.keys(CATALOG).sort());
    expect(CATALOG_FONT_KEYS).toHaveLength(6);
  });

  it("las tres familias Liberation se dibujan con su propio TTF (ya no hay sustitutos)", () => {
    for (const key of ["liberation-sans", "liberation-serif", "liberation-mono"] as const) {
      expect(effectiveFontKey(key)).toBe(key);
      expect(isCatalogFontNative(key)).toBe(true);
      expect(isEmbeddedFont(key)).toBe(true);
    }
    expect(isCatalogFontNative("helvetica")).toBe(true);
    expect(isEmbeddedFont("helvetica")).toBe(false);
  });

  it("cada TTF declarado existe en public/fonts, es Liberation 2.x y se puede embeber", () => {
    for (const key of ["liberation-sans", "liberation-serif", "liberation-mono"] as const) {
      for (const file of Object.values(CATALOG[key].files!)) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(FONTS_DIR, file)));
        expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
        const font = fontkit.create(bytes);
        expect(font.version).toMatch(/^Version 2\./);
        expect((font as unknown as { getName(key: string): string | null }).getName("licenseURL")).toContain("scripts.sil.org/OFL");
        const fsType = (font as unknown as { "OS/2": { fsType: Record<string, boolean> } })["OS/2"].fsType;
        expect(Object.values(fsType).some(Boolean)).toBe(false);
      }
    }
    const license = fs.readFileSync(path.join(FONTS_DIR, "LICENSE_LIBERATION.txt"), "utf8");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license).toContain("Red Hat");
  });

  it("elige el archivo por negrita/cursiva", () => {
    expect(catalogFontFile("liberation-sans", false, false)).toBe("LiberationSans-Regular.ttf");
    expect(catalogFontFile("liberation-sans", true, false)).toBe("LiberationSans-Bold.ttf");
    expect(catalogFontFile("liberation-sans", false, true)).toBe("LiberationSans-Italic.ttf");
    expect(catalogFontFile("liberation-sans", true, true)).toBe("LiberationSans-BoldItalic.ttf");
    expect(catalogFontFile("helvetica", false, false)).toBeNull();
  });
});

describe("cobertura de glifos", () => {
  it.each([
    ["Sans", LIBERATION_SANS_RANGES],
    ["Serif", LIBERATION_SERIF_RANGES],
    ["Mono", LIBERATION_MONO_RANGES],
  ] as const)("la tabla de rangos de Liberation %s coincide con el cmap real de los 4 TTF", (family, ranges) => {
    const inTable = (code: number) => ranges.some(([start, end]) => code >= start && code <= end);
    let tableCount = 0;
    for (const [start, end] of ranges) tableCount += end - start + 1;
    for (const variant of ["Regular", "Bold", "Italic", "BoldItalic"]) {
      const file = `Liberation${family}-${variant}.ttf`;
      const font = fontkit.create(new Uint8Array(fs.readFileSync(path.join(FONTS_DIR, file))));
      // Se descartan controles, el area de uso privado y U+FFFF, que no son texto.
      const real = font.characterSet.filter(
        (code) =>
          code >= 0x20 &&
          !(code >= 0x7f && code <= 0x9f) &&
          !(code >= 0xe000 && code <= 0xf8ff) &&
          code < 0xfff0,
      );
      for (const code of real) expect(inTable(code), `${file} U+${code.toString(16)}`).toBe(true);
      expect(tableCount).toBe(real.length);
    }
  });

  it("todo el conjunto WinAnsi que declaramos lo codifica pdf-lib en las 3 fuentes base", async () => {
    const document = await PDFDocument.create();
    const fonts = await Promise.all(
      [StandardFonts.Helvetica, StandardFonts.TimesRoman, StandardFonts.Courier].map((f) =>
        document.embedFont(f),
      ),
    );
    for (let code = 0x20; code <= 0x20ac + 0x100; code += 1) {
      if (!fontHasCodePoint("helvetica", code)) continue;
      for (const font of fonts) {
        expect(() => font.encodeText(String.fromCodePoint(code)), `U+${code.toString(16)}`).not.toThrow();
      }
    }
  });

  it("espanol y simbolos WinAnsi estan cubiertos por las fuentes base", () => {
    expect(fontCoversText("helvetica", "Ñandú, ¿qué? ¡Sí! €100 “hola” — fin…")).toBe(true);
    expect(fontCoversText("times", "Año 2026™ ©")).toBe(true);
    expect(fontCoversText("courier", "a\nb\tc")).toBe(true);
  });

  it("cirilico, griego y polaco quedan fuera de WinAnsi pero dentro de cada Liberation", () => {
    expect(fontCoversText("helvetica", "Привет")).toBe(false);
    for (const key of ["liberation-sans", "liberation-serif", "liberation-mono"] as const) {
      expect(fontCoversText(key, "Привет мир Ωμέγα łódź")).toBe(true);
    }
    expect(uncoveredChars("times", "aΩbЖ")).toEqual(["Ω", "Ж"]);
  });

  it("CJK, emoji y arabe no los cubre ninguna fuente", () => {
    for (const key of CATALOG_FONT_KEYS) {
      expect(fontCoversText(key, "日本語")).toBe(false);
      expect(fontCoversText(key, "😀")).toBe(false);
      expect(fontCoversText(key, "مرحبا")).toBe(false);
    }
  });

  it("los controles y las marcas de ancho cero no cuentan como glifo faltante", () => {
    expect(fontCoversText("helvetica", "a​b\u0001c‪d﻿")).toBe(true);
  });

  it("normaliza a NFC: una e + acento combinado se cubre como e acentuada", () => {
    expect(fontCoversText("helvetica", "é")).toBe(true);
  });
});

describe("sanitizeTextForFont / pickFontForText", () => {
  it("sustituye lo imposible por ? y lo lista", () => {
    expect(sanitizeTextForFont("helvetica", "ok 日本 ok")).toEqual({
      text: "ok ?? ok",
      unsupported: ["日", "本"],
    });
  });

  it("normaliza saltos de linea y tabuladores y quita controles", () => {
    expect(sanitizeTextForFont("helvetica", "a\r\nb c\td\u0000").text).toBe(
      "a\nb\nc    d",
    );
  });

  it("si la preferida cubre el texto no cambia nada", () => {
    expect(pickFontForText("times", "Hola")).toEqual({
      key: "times",
      changed: false,
      outsidePreferred: [],
      unsupported: [],
    });
  });

  it("cambia a la Liberation de la MISMA familia cuando la preferida no tiene los glifos", () => {
    const cyrillic = ["П", "р", "и", "в", "е", "т"];
    expect(pickFontForText("courier", "Привет")).toEqual({
      key: "liberation-mono",
      changed: true,
      outsidePreferred: cyrillic,
      unsupported: [],
    });
    expect(pickFontForText("times", "Привет").key).toBe("liberation-serif");
    expect(pickFontForText("helvetica", "Привет").key).toBe("liberation-sans");
    expect(pickFontForText("liberation-serif", "Ωmega").changed).toBe(false);
  });

  it("mezcla soportada y no soportada: usa el respaldo y lista lo imposible", () => {
    const pick = pickFontForText("times", "Привет 日本");
    expect(pick.key).toBe("liberation-serif");
    expect(pick.changed).toBe(true);
    expect(pick.unsupported).toEqual(["日", "本"]);
  });

  it("si el respaldo no mejora, se queda con la preferida y avisa de lo imposible", () => {
    const pick = pickFontForText("helvetica", "日本");
    expect(pick.key).toBe("helvetica");
    expect(pick.changed).toBe(false);
    expect(pick.unsupported).toEqual(["日", "本"]);
  });
});

describe("loadCatalogFont", () => {
  it("lee del disco en Node por defecto y devuelve el TTF completo (las tres familias)", async () => {
    for (const [key, file] of [
      ["liberation-sans", "LiberationSans-Regular.ttf"],
      ["liberation-serif", "LiberationSerif-Bold.ttf"],
      ["liberation-mono", "LiberationMono-Italic.ttf"],
    ] as const) {
      const bytes = await loadCatalogFont(key, file.includes("Bold"), file.includes("Italic"));
      expect(bytes.byteLength).toBe(fs.statSync(path.join(FONTS_DIR, file)).size);
    }
  });

  it("cachea por archivo y no vuelve a leer", async () => {
    const reader = vi.fn(async () => new Uint8Array([1, 2, 3]));
    setCatalogFontReader(reader);
    const a = await loadCatalogFont("liberation-sans", true, false);
    const b = await loadCatalogFont("liberation-sans", true, false);
    await loadCatalogFont("liberation-sans", false, true);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledWith("LiberationSans-Bold.ttf");
    expect(a).toBe(b);
  });

  it("un fallo no se cachea y se puede reintentar", async () => {
    const reader = vi
      .fn<(file: string) => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error("sin red"))
      .mockResolvedValueOnce(new Uint8Array([9]));
    setCatalogFontReader(reader);
    await expect(loadCatalogFont("liberation-sans", false, false)).rejects.toBeInstanceOf(
      CatalogFontLoadError,
    );
    await expect(loadCatalogFont("liberation-sans", false, false)).resolves.toEqual(
      new Uint8Array([9]),
    );
  });

  it("las fuentes estandar no tienen archivo que cargar", async () => {
    for (const key of ["helvetica", "times", "courier"] as const) {
      await expect(loadCatalogFont(key, false, false)).rejects.toBeInstanceOf(CatalogFontLoadError);
    }
  });
});

describe("vista previa CSS", () => {
  it("devuelve pila, peso y estilo", () => {
    expect(cssFontStack("helvetica", false, false)).toEqual({
      fontFamily: 'Helvetica, Arial, "Liberation Sans", sans-serif',
      fontWeight: 400,
      fontStyle: "normal",
    });
    const bold = cssFontStack("times", true, true);
    expect(bold.fontWeight).toBe(700);
    expect(bold.fontStyle).toBe("italic");
    expect(bold.fontFamily).toContain("Times");
    expect(cssFontStack("courier", false, false).fontFamily).toContain("monospace");
  });

  it("Liberation Sans usa la familia @font-face propia", () => {
    expect(cssFontStack("liberation-sans", false, false).fontFamily.startsWith(`"${LIBERATION_FONT_FACE}"`)).toBe(true);
  });

  it("el @font-face apunta a /fonts, 4 estilos por familia, sin recursos externos", () => {
    const css = catalogFontFaceCss();
    expect(css.match(/@font-face/g)).toHaveLength(12);
    expect(css).toContain('url("/fonts/LiberationSans-BoldItalic.ttf")');
    expect(css).toContain('url("/fonts/LiberationSerif-Italic.ttf")');
    expect(css).toContain('font-family:"Optimus Liberation Mono"');
    expect(css).not.toMatch(/https?:/);
  });

  it("ensureCatalogFontFaces inyecta la hoja una sola vez", () => {
    const registry = new Map<string, { id: string; textContent: string }>();
    const head = { appendChild: (el: { id: string; textContent: string }) => registry.set(el.id, el) };
    const fakeDocument = {
      head,
      getElementById: (id: string) => registry.get(id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
    } as unknown as Document;
    ensureCatalogFontFaces(fakeDocument);
    ensureCatalogFontFaces(fakeDocument);
    expect(registry.size).toBe(1);
    expect([...registry.values()][0].textContent).toContain("@font-face");
  });
});
