import { describe, expect, it } from "vitest";
import { EXPORT_STRINGS, getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { EXPORT_FORMAT_IDS } from "@/app/pdf-pro/export/exportTypes";

/** Textos de la exportacion persistente (Wave 9): nombres cortos, indicador, avisos y confirmaciones, es/en. */

describe("textos de la exportacion persistente", () => {
  it("cada formato tiene nombre corto en los dos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      for (const id of EXPORT_FORMAT_IDS) {
        expect(EXPORT_STRINGS[language].formatsShort[id].trim().length, `${language}.${id}`).toBeGreaterThan(0);
      }
    }
    expect(EXPORT_STRINGS.es.formatsShort.images).toBe("imágenes");
    expect(EXPORT_STRINGS.en.formatsShort.images).toBe("images");
  });

  it("el aviso «cancelledOnLeave» ya no existe (la exportacion no se cancela al salir)", () => {
    for (const language of ["es", "en"] as const) {
      expect(Object.keys(EXPORT_STRINGS[language].card)).not.toContain("cancelledOnLeave");
    }
  });

  it("las frases con parametros los llevan en los dos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      const s = getExportStrings(language);
      expect(s.indicator.running("Word")).toContain("Word");
      expect(s.indicator.percent(42)).toContain("42");
      expect(s.indicator.progressLabel("Word")).toContain("Word");
      expect(s.indicator.cancelLabel("Word")).toContain("Word");
      // «Cancelar» / «Cancel» esta en la etiqueta accesible del boton (WCAG 2.5.3, etiqueta en el nombre).
      expect(s.indicator.cancelLabel("Word")).toContain(s.indicator.cancel);
      expect(s.card.inProgressOther("Excel")).toContain("Excel");
      expect(s.card.runningFrom("Rotar 90°")).toContain("Rotar 90°");
      expect(s.card.result("a.docx", "Rotar 90°")).toContain("a.docx");
      expect(s.card.result("a.docx", "Rotar 90°")).toContain("Rotar 90°");
      expect(s.notices.failedAway("PowerPoint")).toContain("PowerPoint");
      expect(s.notices.closeOnly("CSV")).toContain("CSV");
      expect(s.notices.replaceOnly("CSV")).toContain("CSV");
      expect(s.notices.also("JSON")).toContain("JSON");
    }
  });

  it("el resultado dice la VERSION entre comillas en espanol e ingles", () => {
    expect(EXPORT_STRINGS.es.card.result("a.docx", "Original")).toBe("Exportado desde la versión «Original»: a.docx");
    expect(EXPORT_STRINGS.en.card.result("a.docx", "Original")).toBe("Exported from version “Original”: a.docx");
  });
});
