import { describe, expect, it } from "vitest";
import { DEFAULT_PDF_TO_CSV_OPTIONS } from "@/lib/pdf/pdfToCsv";
import { DEFAULT_PDF_TO_EXCEL_OPTIONS } from "@/lib/pdf/pdfToExcel";
import { DEFAULT_PDF_TO_IMAGES_OPTIONS, JPG_QUALITY_MAX, JPG_QUALITY_MIN } from "@/lib/pdf/pdfToImages";
import { DEFAULT_PDF_TO_JSON_OPTIONS } from "@/lib/pdf/pdfToJson";
import { DEFAULT_PDF_TO_MARKDOWN_OPTIONS } from "@/lib/pdf/pdfToMarkdown";
import { DEFAULT_PDF_TO_POWERPOINT_OPTIONS } from "@/lib/pdf/pdfToPowerpoint";
import { DEFAULT_PDF_TO_TEXT_OPTIONS } from "@/lib/pdf/pdfToText";
import { DEFAULT_PDF_TO_WORD_OPTIONS } from "@/lib/pdf/pdfToWord";
import {
  DEFAULT_EXPORT_OPTIONS,
  JPG_QUALITY_MAX as OWN_QUALITY_MAX,
  JPG_QUALITY_MIN as OWN_QUALITY_MIN,
  defaultExportOptions,
  exportUsesOcr,
} from "@/app/pdf-pro/export/exportDefaults";
import { EXPORT_FORMAT_IDS } from "@/app/pdf-pro/export/exportTypes";

/**
 * Las opciones por defecto de PDF Pro se COPIAN de los motores para no importarlos (y sus librerias pesadas) en el
 * paquete inicial. Estas pruebas son el pegamento: si un motor cambia su valor por defecto, fallan aqui.
 */
describe("opciones por defecto de la exportacion = las de cada herramienta suelta", () => {
  it("texto", () => expect(DEFAULT_EXPORT_OPTIONS.text).toEqual(DEFAULT_PDF_TO_TEXT_OPTIONS));
  it("word", () => expect(DEFAULT_EXPORT_OPTIONS.word).toEqual(DEFAULT_PDF_TO_WORD_OPTIONS));
  it("excel", () => expect(DEFAULT_EXPORT_OPTIONS.excel).toEqual(DEFAULT_PDF_TO_EXCEL_OPTIONS));
  it("csv", () => expect(DEFAULT_EXPORT_OPTIONS.csv).toEqual(DEFAULT_PDF_TO_CSV_OPTIONS));
  it("markdown", () => expect(DEFAULT_EXPORT_OPTIONS.markdown).toEqual(DEFAULT_PDF_TO_MARKDOWN_OPTIONS));
  it("json", () => expect(DEFAULT_EXPORT_OPTIONS.json).toEqual(DEFAULT_PDF_TO_JSON_OPTIONS));
  it("powerpoint", () => expect(DEFAULT_EXPORT_OPTIONS.powerpoint).toEqual(DEFAULT_PDF_TO_POWERPOINT_OPTIONS));
  it("imagenes: misma calidad y escala que PDF a JPG, en JPG y todas las paginas", () => {
    expect(DEFAULT_EXPORT_OPTIONS.images).toMatchObject({
      format: "jpg",
      quality: DEFAULT_PDF_TO_IMAGES_OPTIONS.quality,
      scale: DEFAULT_PDF_TO_IMAGES_OPTIONS.scale,
      scope: "all",
    });
  });
  it("hay opciones para los ocho formatos", () => {
    expect(Object.keys(DEFAULT_EXPORT_OPTIONS).sort()).toEqual([...EXPORT_FORMAT_IDS].sort());
  });
});

describe("rango de calidad JPEG", () => {
  it("coincide con el del motor (que no se importa para no arrastrar jszip)", () => {
    expect(OWN_QUALITY_MIN).toBe(JPG_QUALITY_MIN);
    expect(OWN_QUALITY_MAX).toBe(JPG_QUALITY_MAX);
  });
});

describe("defaultExportOptions", () => {
  it("devuelve una copia: cambiarla no altera los valores por defecto", () => {
    const first = defaultExportOptions("text");
    first.pageSeparators = true;
    expect(defaultExportOptions("text").pageSeparators).toBe(false);
    expect(DEFAULT_EXPORT_OPTIONS.text.pageSeparators).toBe(false);
  });
});

describe("exportUsesOcr", () => {
  it("texto, Markdown y JSON dependen de su casilla de OCR", () => {
    expect(exportUsesOcr("text", { ocrFallback: true, pageSeparators: false })).toBe(true);
    expect(exportUsesOcr("text", { ocrFallback: false, pageSeparators: false })).toBe(false);
    expect(exportUsesOcr("markdown", { ...DEFAULT_PDF_TO_MARKDOWN_OPTIONS, ocrFallback: false })).toBe(false);
    expect(exportUsesOcr("markdown", DEFAULT_PDF_TO_MARKDOWN_OPTIONS)).toBe(true);
    expect(exportUsesOcr("json", { ocrFallback: true })).toBe(true);
    expect(exportUsesOcr("json", { ocrFallback: false })).toBe(false);
  });

  it("Word usa siempre el OCR de respaldo del motor compartido", () => {
    expect(exportUsesOcr("word", {})).toBe(true);
  });

  it("imagenes, Excel, CSV y PowerPoint nunca necesitan red", () => {
    expect(exportUsesOcr("images", defaultExportOptions("images"))).toBe(false);
    expect(exportUsesOcr("excel", defaultExportOptions("excel"))).toBe(false);
    expect(exportUsesOcr("csv", defaultExportOptions("csv"))).toBe(false);
    expect(exportUsesOcr("powerpoint", defaultExportOptions("powerpoint"))).toBe(false);
  });
});
