import { ImageDown } from "lucide-react";
import { describe, expect, it } from "vitest";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import {
  CATEGORY_ORDER,
  TOOLS,
  TOOL_SLUGS,
  getRelatedTools,
  getTool,
  getToolsByCategory,
  toolHref,
} from "@/lib/tools-registry";
import { metadata } from "@/app/extract-assets/page";

/** «Extraer elementos» en el registro, los textos y la pagina (F7 · U7.4/U7.6). */

describe("registro", () => {
  it("slug, categoria «Editar y analizar», icono ImageDown, solo PDF y un unico archivo", () => {
    expect(TOOL_SLUGS).toContain("extract-assets");
    const tool = getTool("extract-assets");
    expect(tool).toMatchObject({ slug: "extract-assets", category: "edit", status: "live", multiple: false, accept: ["application/pdf"], extensions: [".pdf"] });
    expect(tool.icon).toBe(ImageDown);
    expect(tool.accent).toBe("edit");
    expect(tool.featured).toBeUndefined();
    expect(toolHref("extract-assets")).toBe("/extract-assets");
  });

  it("aparece en su categoria, junto a «Comparar PDF», y el orden del resto no cambia", () => {
    expect(getToolsByCategory("edit").map((tool) => tool.slug)).toEqual([
      "add-page-numbers", "add-watermark", "crop-pdf", "edit-pdf", "sign-pdf", "compare-pdf", "extract-assets", "pdf-summarizer", "translate-pdf",
    ]);
    expect(CATEGORY_ORDER).toContain(getTool("extract-assets").category);
    expect(TOOL_SLUGS[TOOL_SLUGS.length - 1]).toBe("redact-pdf");
    expect(new Set(TOOL_SLUGS).size).toBe(TOOL_SLUGS.length);
    expect(TOOLS).toHaveLength(TOOL_SLUGS.length);
  });

  it("su icono no lo usa otra herramienta y no se confunde con «Extraer páginas»", () => {
    const others = TOOLS.filter((tool) => tool.slug !== "extract-assets");
    expect(others.some((tool) => tool.icon === ImageDown)).toBe(false);
    expect(getTool("extract-assets")).not.toBe(getTool("extract-pages"));
    for (const dictionary of [es, en]) {
      expect(dictionary.tools["extract-assets"].name).not.toBe(dictionary.tools["extract-pages"].name);
    }
  });

  it("se ofrece como relacionada de otras herramientas de su categoria", () => {
    expect(getRelatedTools("compare-pdf", 8).map((tool) => tool.slug)).toContain("extract-assets");
  });
});

describe("textos", () => {
  it("nombre, descripcion y nombre del archivo de salida en los dos idiomas", () => {
    expect(es.tools["extract-assets"].name).toBe("Extraer elementos");
    expect(en.tools["extract-assets"].name).toBe("Extract elements");
    expect(es.tools["extract-assets"].description.length).toBeGreaterThan(30);
    expect(en.tools["extract-assets"].description.length).toBeGreaterThan(30);
    expect(es.filenames["extract-assets"]).toBe("elementos-extraidos");
    expect(en.filenames["extract-assets"]).toBe("extracted-elements");
  });

  it("el bloque `extract` tiene las mismas claves en espanol e ingles y ninguna vacia", () => {
    expect(Object.keys(en.extract).sort()).toEqual(Object.keys(es.extract).sort());
    for (const dictionary of [es, en]) {
      for (const [key, value] of Object.entries(dictionary.extract)) expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("los marcadores {clave} coinciden entre idiomas (nada se pierde al traducir)", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(es.extract) as (keyof typeof es.extract)[]) {
      expect(placeholders(en.extract[key]), key).toEqual(placeholders(es.extract[key]));
    }
  });

  it("la nota de uso es UNA linea estatica y no pide nada", () => {
    expect(es.extract.note).toBe("Úsalo solo con firmas propias o con autorización de su titular.");
    expect(en.extract.note).not.toMatch(/\n/);
    expect(JSON.stringify(es.extract)).not.toMatch(/Tengo autorización/);
  });
});

describe("pagina (SEO)", () => {
  it("titulo, descripcion y canonica", () => {
    expect(metadata.title).toBe("Extraer elementos de un PDF");
    expect(String(metadata.description)).toContain("navegador");
    expect(String(metadata.description).length).toBeLessThanOrEqual(300);
    expect(metadata.alternates?.canonical).toBe("/extract-assets");
  });
});
