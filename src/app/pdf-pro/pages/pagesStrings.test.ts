import { describe, expect, it } from "vitest";
import { PAGES_STRINGS, describePlanLabel, pagesWarningText } from "@/app/pdf-pro/pages/pagesStrings";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import type { PlanSummary } from "@/lib/pdf/pageAssemblyPlan";
import type { PageAssemblyWarningCode } from "@/lib/pdf/pageAssembly";

const ES = PAGES_STRINGS.es;
const EN = PAGES_STRINGS.en;

const summary = (patch: Partial<PlanSummary>): PlanSummary => ({
  moved: 0,
  rotated: 0,
  deleted: 0,
  duplicated: 0,
  blanks: 0,
  external: 0,
  images: 0,
  identity: false,
  ...patch,
});

const WARNING_CODES: PageAssemblyWarningCode[] = [
  "outlinesRemoved",
  "linksRemoved",
  "namedDestinationsRemoved",
  "pageLabelsRemoved",
  "structureRemoved",
  "formFieldsRemoved",
  "fieldsRenamed",
  "signatureFieldsRemoved",
  "largeInsert",
];

function shape(value: unknown): unknown {
  if (typeof value === "function") return "fn";
  if (typeof value === "string") return "str";
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]));
  }
  return typeof value;
}

describe("textos del organizador de paginas", () => {
  it("es y en tienen exactamente las mismas claves y tipos", () => {
    expect(shape(ES)).toEqual(shape(EN));
  });

  it("estan colgados de PRO_STRINGS en los dos idiomas", () => {
    expect(PRO_STRINGS.es.pages).toBe(ES);
    expect(PRO_STRINGS.en.pages).toBe(EN);
  });

  it("no hay cadenas vacias (salvo las que lo son a proposito)", () => {
    const empty: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (typeof value === "string" && value.trim() === "") empty.push(path);
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    };
    visit(ES, "es");
    visit(EN, "en");
    expect(empty).toEqual([]);
  });

  it("hay un texto de aviso por cada codigo del motor, con su cantidad", () => {
    for (const code of WARNING_CODES) {
      expect(ES.warnings[code]).toBeTruthy();
      expect(EN.warnings[code]).toBeTruthy();
    }
    expect(Object.keys(ES.warnings).sort()).toEqual([...WARNING_CODES].sort());
  });

  it("`pagesWarningText` sustituye la cantidad", () => {
    expect(pagesWarningText(ES, { code: "outlinesRemoved", count: 3 })).toContain("3");
    expect(pagesWarningText(EN, { code: "linksRemoved", count: 12 })).toContain("12");
    expect(pagesWarningText(ES, { code: "pageLabelsRemoved", count: 1 })).not.toContain("{n}");
  });

  it("singular y plural correctos", () => {
    expect(ES.status.changes(1)).toBe("1 cambio sin aplicar");
    expect(ES.status.changes(3)).toBe("3 cambios sin aplicar");
    expect(EN.status.changes(1)).toBe("1 unapplied change");
    expect(EN.status.changes(2)).toBe("2 unapplied changes");
    expect(ES.label.remove(1)).toBe("eliminar 1 página");
    expect(ES.label.remove(2)).toBe("eliminar 2 páginas");
    expect(EN.label.images(1)).toBe("insert 1 image");
  });
});

describe("describePlanLabel (etiqueta del snapshot)", () => {
  it("«Reordenar 3 páginas, eliminar 2»", () => {
    expect(describePlanLabel(ES, summary({ moved: 3, deleted: 2 }))).toBe("Reordenar 3 páginas, eliminar 2 páginas");
    expect(describePlanLabel(EN, summary({ moved: 3, deleted: 2 }))).toBe("Reorder 3 pages, delete 2 pages");
  });

  it("un solo tipo de cambio", () => {
    expect(describePlanLabel(ES, summary({ rotated: 1 }))).toBe("Girar 1 página");
    expect(describePlanLabel(ES, summary({ duplicated: 4 }))).toBe("Duplicar 4 páginas");
  });

  it("combinaciones de insercion", () => {
    expect(describePlanLabel(ES, summary({ blanks: 2, external: 3, images: 1 }))).toBe(
      "Insertar 2 páginas en blanco, insertar 3 páginas de otros PDF, insertar 1 imagen",
    );
  });

  it("el orden es siempre el mismo: mover, girar, eliminar, duplicar, insertar", () => {
    const label = describePlanLabel(ES, summary({ images: 1, deleted: 1, moved: 1, rotated: 1, duplicated: 1 }));
    expect(label.indexOf("reordenar") === -1 ? 0 : label.toLowerCase().indexOf("reordenar")).toBe(0);
    const positions = ["reordenar", "girar", "eliminar", "duplicar", "insertar"].map((word) => label.toLowerCase().indexOf(word));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("empieza con mayuscula", () => {
    expect(describePlanLabel(ES, summary({ moved: 1 })).charAt(0)).toBe("R");
    expect(describePlanLabel(EN, summary({ moved: 1 })).charAt(0)).toBe("R");
  });

  it("sin cambios reconocibles da la etiqueta generica", () => {
    expect(describePlanLabel(ES, summary({}))).toBe(ES.label.generic);
  });

  it("unir documentos tiene su propia descripcion", () => {
    expect(ES.label.merge(2)).toBe("unir 2 documentos");
  });
});
