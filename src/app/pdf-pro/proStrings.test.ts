import { describe, expect, it } from "vitest";
import { PRO_STRINGS, formatProDate, getProStrings, proOperationLabel, proWarningText } from "@/app/pdf-pro/proStrings";
import { PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { PRO_TAB_IDS } from "@/app/pdf-pro/ProTabs";
import type { ProWarningCode } from "@/app/pdf-pro/proTypes";

/** Textos de PDF Pro: paridad es/en y que cada clave que usa el codigo exista en los dos idiomas. */

/** Aplana un objeto de textos en rutas «a.b.c» (las funciones cuentan como hojas). */
function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}

describe("paridad es/en", () => {
  it("mismas claves en los dos idiomas, a cualquier profundidad", () => {
    expect(paths(PRO_STRINGS.en).sort()).toEqual(paths(PRO_STRINGS.es).sort());
  });

  it("ninguna cadena esta vacia ni es identica entre idiomas por descuido (salvo marcas)", () => {
    const flat = (lang: "es" | "en") =>
      Object.fromEntries(
        paths(PRO_STRINGS[lang]).map((path) => [
          path,
          path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], PRO_STRINGS[lang]),
        ]),
      );
    const es = flat("es");
    const en = flat("en");
    // Marcas y formatos que no se traducen (Wave 7 · U8: nombres de formato, DPI y el ejemplo de rango).
    const sameAllowed = new Set([
      "suite.regionLabel",
      "labels.original",
      "export.formats.word.title",
      "export.formats.markdown.title",
      "export.formats.json.title",
      "export.formats.excel.title",
      "export.formats.powerpoint.title",
      // Wave 9: los mismos nombres de formato en las frases del indicador («Exportando a Word…»).
      "export.formatsShort.word",
      "export.formatsShort.excel",
      "export.formatsShort.csv",
      "export.formatsShort.markdown",
      "export.formatsShort.json",
      "export.formatsShort.powerpoint",
      "export.images.jpg",
      "export.images.png",
      "export.images.dpi.1",
      "export.images.dpi.2",
      "export.images.dpi.3",
      "export.images.rangePlaceholder",
      "export.csv.csv",
      "export.csv.json",
      "create.blank.a4",
      "create.insert.kind.html",
    ]);
    for (const [path, value] of Object.entries(es)) {
      if (typeof value === "string") {
        expect(value.trim().length, path).toBeGreaterThan(0);
        expect((en[path] as string).trim().length, path).toBeGreaterThan(0);
        if (!sameAllowed.has(path)) expect(en[path], `${path} igual en es y en`).not.toBe(value);
      }
    }
  });

  it("las funciones de texto devuelven cadenas con sus parametros en los dos idiomas", () => {
    for (const language of ["es", "en"] as const) {
      const s = PRO_STRINGS[language];
      expect(s.announce.opened("a.pdf")).toContain("a.pdf");
      expect(s.announce.applied("Girar")).toContain("Girar");
      expect(s.announce.undone("Girar")).toContain("Girar");
      expect(s.announce.redone("Girar")).toContain("Girar");
      expect(s.announce.wentTo("Girar")).toContain("Girar");
      expect(s.suite.pageCount(1)).toContain("1");
      expect(s.suite.pageCount(5)).toContain("5");
      expect(s.suite.historyGoTo("Girar")).toContain("Girar");
      expect(s.suite.openedFrom("Unir PDF")).toContain("Unir PDF");
      expect(s.empty.recentOpen("x.pdf")).toContain("x.pdf");
      expect(s.empty.recentDraftNote(2, "11 oct")).toContain("11 oct");
      expect(s.drafts.foundBody(3, "11 oct")).toContain("3");
    }
  });

  it("singular y plural de paginas y cambios", () => {
    expect(PRO_STRINGS.es.suite.pageCount(1)).toBe("1 página");
    expect(PRO_STRINGS.es.suite.pageCount(2)).toBe("2 páginas");
    expect(PRO_STRINGS.en.suite.pageCount(1)).toBe("1 page");
    expect(PRO_STRINGS.es.empty.recentDraftNote(1, "x")).toContain("1 cambio ");
    expect(PRO_STRINGS.es.empty.recentDraftNote(2, "x")).toContain("2 cambios");
    expect(PRO_STRINGS.en.drafts.foundBody(1, "x")).toContain("1 change ");
  });
});

describe("claves que usa el codigo", () => {
  it("cada operacion registrada tiene etiqueta en los dos idiomas", () => {
    for (const operation of PRO_OPERATIONS) {
      for (const language of ["es", "en"] as const) {
        expect(PRO_STRINGS[language].operations[operation.labelKey], `${operation.id}/${language}`).toBeTruthy();
        expect(proOperationLabel(language, operation.labelKey)).toBe(PRO_STRINGS[language].operations[operation.labelKey]);
      }
    }
  });

  it("una clave de etiqueta desconocida devuelve la propia clave (nunca vacio)", () => {
    expect(proOperationLabel("es", "noExiste")).toBe("noExiste");
  });

  it("cada pestana de la suite tiene nombre; las demas pestanas que no son Inicio tienen su aviso", () => {
    for (const language of ["es", "en"] as const) {
      for (const tab of PRO_TAB_IDS) {
        expect(PRO_STRINGS[language].suite.tabs[tab]).toBeTruthy();
        if (tab !== "home") expect(PRO_STRINGS[language].suite.comingSoon[tab]).toBeTruthy();
      }
    }
    expect(PRO_TAB_IDS).toEqual(["home", "pages", "edit", "annotate", "sign", "protect", "convert"]);
  });

  it("cada codigo de aviso (ProWarningCode) tiene texto en los dos idiomas", () => {
    const codes: ProWarningCode[] = [
      "signaturesInvalidated",
      "signaturesUnknown",
      "decryptedCopy",
      "historyTrimmed",
      "unchanged",
      // Wave 7 · U8: limites de tamano y memoria.
      "largeDocument",
      "noDraftTooBig",
      "memoryHigh",
      "historyOffloadUnavailable",
    ];
    for (const language of ["es", "en"] as const) {
      for (const code of codes) expect(proWarningText(language, { code }).length).toBeGreaterThan(10);
      expect(Object.keys(PRO_STRINGS[language].warnings).sort()).toEqual([...codes].sort());
    }
  });

  it("proWarningText sustituye {parametros} y deja intactos los que faltan", () => {
    expect(proWarningText("es", { code: "decryptedCopy", params: { n: 2 } })).toBe(PRO_STRINGS.es.warnings.decryptedCopy);
  });

  it("getProStrings cae al espanol ante un idioma raro", () => {
    expect(getProStrings("xx" as never)).toBe(PRO_STRINGS.es);
  });

  it("el aviso de firmas explica la consecuencia y el de copia descifrada que la contrasena no se guarda", () => {
    expect(PRO_STRINGS.es.warnings.signaturesInvalidated).toMatch(/firmas digitales/);
    expect(PRO_STRINGS.es.warnings.decryptedCopy).toMatch(/contraseña no se guardará/);
    expect(PRO_STRINGS.en.warnings.decryptedCopy).toMatch(/password won't be kept/);
  });
});

describe("formatProDate", () => {
  it("formatea una fecha ISO y un numero, y devuelve vacio ante una fecha invalida", () => {
    expect(formatProDate("2026-10-11T14:32:00.000Z", "es").length).toBeGreaterThan(3);
    expect(formatProDate(Date.UTC(2026, 9, 11, 14, 32), "en").length).toBeGreaterThan(3);
    expect(formatProDate("no es fecha", "es")).toBe("");
  });
});
