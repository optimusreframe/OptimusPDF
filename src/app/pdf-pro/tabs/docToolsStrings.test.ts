import { describe, expect, it } from "vitest";
import { DOC_TOOLS_STRINGS, DOC_TOOL_IDS, getDocToolsStrings } from "@/app/pdf-pro/tabs/docToolsStrings";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";

/** Textos de las herramientas de documento: paridad es/en, funciones con sus parametros y nada vacio. */

function leaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

describe("DOC_TOOLS_STRINGS", () => {
  it("mismas claves en es y en, a cualquier profundidad", () => {
    expect(leaves(DOC_TOOLS_STRINGS.en).map(([k]) => k).sort()).toEqual(leaves(DOC_TOOLS_STRINGS.es).map(([k]) => k).sort());
  });

  it("ningun texto vacio y ninguno identico entre idiomas por descuido", () => {
    const en = new Map(leaves(DOC_TOOLS_STRINGS.en));
    for (const [path, value] of leaves(DOC_TOOLS_STRINGS.es)) {
      if (typeof value !== "string") continue;
      expect(value.trim().length, path).toBeGreaterThan(0);
      expect((en.get(path) as string).trim().length, path).toBeGreaterThan(0);
      expect(en.get(path), `${path} igual en es y en`).not.toBe(value);
    }
  });

  it("esta colgado de PRO_STRINGS en los dos idiomas", () => {
    expect(PRO_STRINGS.es.docTools).toBe(DOC_TOOLS_STRINGS.es);
    expect(PRO_STRINGS.en.docTools).toBe(DOC_TOOLS_STRINGS.en);
  });

  it("getDocToolsStrings cae al espanol ante un idioma raro", () => {
    expect(getDocToolsStrings("xx" as never)).toBe(DOC_TOOLS_STRINGS.es);
  });

  it("cada id de herramienta tiene su texto", () => {
    for (const id of DOC_TOOL_IDS) expect(Object.keys(DOC_TOOLS_STRINGS.es.tools)).toContain(id);
    expect(Object.keys(DOC_TOOLS_STRINGS.es.tools).sort()).toEqual([...DOC_TOOL_IDS].sort());
  });

  it("las funciones de texto incluyen sus parametros en los dos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      const s = DOC_TOOLS_STRINGS[language];
      expect(s.launcher.open("Marca")).toContain("Marca");
      expect(s.launcher.looseNewTab("Unir")).toContain("Unir");
      expect(s.labels.watermarkText("SECRETO")).toContain("SECRETO");
      expect(s.labels.compress("x")).toContain("x");
      expect(s.labels.rotate(180, "y")).toContain("180");
      expect(s.labels.ocr("Francés")).toContain("Francés");
      expect(s.labels.rotateScopeRange(2, 5)).toMatch(/2.*5/);
      expect(s.crop.pageSize("100", "200")).toMatch(/100.*200/);
      expect(s.protect.saved("a.pdf")).toContain("a.pdf");
      expect(s.convert.openTool("PDF a JPG")).toContain("PDF a JPG");
      expect(s.summary.historyValue(3)).toContain("3");
      expect(s.metadata.customNote(4)).toContain("4");
      expect(s.runner.previewAlt(1)).toContain("1");
    }
  });

  it("singular y plural", () => {
    expect(DOC_TOOLS_STRINGS.es.summary.historyValue(0)).toBe("Sin cambios");
    expect(DOC_TOOLS_STRINGS.es.summary.historyValue(1)).toBe("1 cambio");
    expect(DOC_TOOLS_STRINGS.es.summary.historyValue(2)).toBe("2 cambios");
    expect(DOC_TOOLS_STRINGS.en.summary.historyValue(1)).toBe("1 change");
    expect(DOC_TOOLS_STRINGS.es.metadata.customNote(1)).toContain("1 dato");
    expect(DOC_TOOLS_STRINGS.es.labels.rotateScopeRange(3, 3)).toBe("página 3");
    expect(DOC_TOOLS_STRINGS.en.labels.rotateScopeRange(3, 3)).toBe("page 3");
  });

  it("la etiqueta pedida por el contrato: «Marca de agua “CONFIDENCIAL”»", () => {
    expect(DOC_TOOLS_STRINGS.es.labels.watermarkText("CONFIDENCIAL")).toBe("Marca de agua “CONFIDENCIAL”");
  });
});
