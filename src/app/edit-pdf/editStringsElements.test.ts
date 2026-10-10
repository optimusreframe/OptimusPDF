import { describe, expect, it } from "vitest";
import { EDIT_STRINGS, type EditInlineStrings } from "@/app/edit-pdf/strings";
import { INK_COLORS } from "@/lib/pdf/core";
import { HIGHLIGHT_COLORS } from "@/lib/pdf/editPdf";

/** Textos es/en de imagen, formas y navegacion (W5-U4b). */

const LANGS = ["es", "en"] as const;

describe("textos de imagen, formas y navegacion", () => {
  it("cada herramienta armada tiene su pista en los dos idiomas (Seleccionar, vacia)", () => {
    for (const lang of LANGS) {
      const hints = EDIT_STRINGS[lang].inline.toolHints;
      expect(hints.select).toBe("");
      for (const key of ["text", "image", "rect", "ellipse", "line", "highlight", "check"] as const) {
        expect(hints[key].length, `${lang}.${key}`).toBeGreaterThan(20);
        expect(hints[key], `${lang}.${key}`).toMatch(/Esc/);
      }
    }
  });

  it("las pistas de es y en son distintas (no se copio el texto)", () => {
    for (const key of ["image", "rect", "ellipse", "line", "highlight", "check"] as const) {
      expect(EDIT_STRINGS.es.inline.toolHints[key]).not.toBe(EDIT_STRINGS.en.inline.toolHints[key]);
    }
  });

  it("los colores del documento (tintas y resaltados) tienen nombre accesible en los dos idiomas", () => {
    for (const lang of LANGS) {
      const names = EDIT_STRINGS[lang].inline.colorNames;
      for (const hex of [...INK_COLORS, ...HIGHLIGHT_COLORS]) expect(names[hex], `${lang} ${hex}`).toBeTruthy();
    }
  });

  it("los avisos de imagen dicen el limite que se interpolo", () => {
    expect(EDIT_STRINGS.es.inline.imageTooLarge(15)).toContain("15 MB");
    expect(EDIT_STRINGS.en.inline.imageTooLarge(15)).toContain("15 MB");
    expect(EDIT_STRINGS.es.inline.imageTooManyPixels(40)).toContain("40");
    expect(EDIT_STRINGS.en.inline.imageTooManyPixels(40)).toContain("40");
  });

  it("los mensajes de imagen son amables: sin codigos ni jerga y con una salida", () => {
    for (const lang of LANGS) {
      const s = EDIT_STRINGS[lang].inline;
      for (const text of [s.imageWrongType, s.imageUnreadable, s.imageEmpty, s.imageTooLarge(15), s.imageTooManyPixels(40)]) {
        expect(text).not.toMatch(/undefined|NaN|\[object|Error|error code/i);
        expect(text.length).toBeGreaterThan(15);
      }
    }
  });

  it("la etiqueta de cada elemento lleva su posicion", () => {
    expect(EDIT_STRINGS.es.inline.elementLabel("Elipse", 2, 5)).toBe("Elipse (2 de 5)");
    expect(EDIT_STRINGS.en.inline.elementLabel("Ellipse", 2, 5)).toBe("Ellipse (2 of 5)");
  });

  it("el aviso de pagina concuerda en singular y plural", () => {
    const es = EDIT_STRINGS.es.inline;
    expect(es.pageStatus(3, 10, 0)).toBe("Página 3 de 10. Sin cambios.");
    expect(es.pageStatus(3, 10, 1)).toBe("Página 3 de 10. 1 cambio.");
    expect(es.pageStatus(3, 10, 4)).toBe("Página 3 de 10. 4 cambios.");
    const en = EDIT_STRINGS.en.inline;
    expect(en.pageStatus(3, 10, 0)).toBe("Page 3 of 10. No changes.");
    expect(en.pageStatus(3, 10, 1)).toBe("Page 3 of 10. 1 change.");
    expect(en.pageStatus(3, 10, 4)).toBe("Page 3 of 10. 4 changes.");
  });

  it("el nombre de cada miniatura dice la pagina y, si hay, sus cambios", () => {
    expect(EDIT_STRINGS.es.inline.thumbLabel(2, 0)).toBe("Ir a la página 2");
    expect(EDIT_STRINGS.es.inline.thumbLabel(2, 3)).toBe("Ir a la página 2 (3 cambios)");
    expect(EDIT_STRINGS.en.inline.thumbLabel(2, 1)).toBe("Go to page 2 (1 change)");
  });

  it("los anuncios de anadir, duplicar y borrar llevan el nombre del elemento", () => {
    for (const lang of LANGS) {
      const s = EDIT_STRINGS[lang].inline;
      for (const text of [s.elementAdded("Línea"), s.elementDeleted("Línea"), s.elementDuplicated("Línea")]) {
        expect(text).toContain("Línea");
      }
    }
  });

  it("no falta ni sobra ninguna clave entre es y en", () => {
    const keys = (lang: (typeof LANGS)[number]) => Object.keys(EDIT_STRINGS[lang].inline).sort();
    expect(keys("en")).toEqual(keys("es"));
    const a: (keyof EditInlineStrings)[] = ["toolHints", "barShortcuts", "pageFailed"];
    for (const key of a) expect(EDIT_STRINGS.es.inline[key]).toBeTruthy();
  });

  it("las opacidades se leen con su porcentaje en cada idioma", () => {
    expect(EDIT_STRINGS.es.inline.opacityOption(30)).toBe("Opacidad 30 %");
    expect(EDIT_STRINGS.en.inline.opacityOption(30)).toBe("Opacity 30%");
  });
});
