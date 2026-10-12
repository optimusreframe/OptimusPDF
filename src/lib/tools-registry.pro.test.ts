import { describe, expect, it } from "vitest";
import {
  ACCENT_BG_SOFT,
  ACCENT_RING,
  ACCENT_TEXT,
  CATEGORY_ORDER,
  PRO_SLUG,
  TOOLS,
  TOOL_SLUGS,
  getFeaturedTools,
  getLiveTools,
  getRelatedTools,
  getTool,
  getToolsByCategory,
  toolHref,
} from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/** Registro con PDF Pro (Wave 7 · U1): primera, destacada, sin categoria nueva. */

describe("registro — PDF Pro es la primera herramienta", () => {
  it("es el primer slug y el primer elemento de TOOLS", () => {
    expect(TOOL_SLUGS[0]).toBe("pdf-pro");
    expect(TOOLS[0].slug).toBe("pdf-pro");
    expect(PRO_SLUG).toBe("pdf-pro");
  });

  it("el orden del resto de herramientas no cambia (merge-pdf sigue siendo la primera de Organizar)", () => {
    expect(TOOL_SLUGS[1]).toBe("merge-pdf");
    expect(TOOL_SLUGS[TOOL_SLUGS.length - 1]).toBe("redact-pdf");
    expect(new Set(TOOL_SLUGS).size).toBe(TOOL_SLUGS.length);
    expect(TOOL_SLUGS).toHaveLength(37);
  });

  it("esta disponible (live), acepta PDF y un solo archivo", () => {
    const tool = getTool("pdf-pro");
    expect(tool.status).toBe("live");
    expect(tool.accept).toEqual(["application/pdf"]);
    expect(tool.extensions).toEqual([".pdf"]);
    expect(tool.multiple).toBe(false);
  });

  it("tiene icono y acento propios (ninguna categoria usa el acento pro)", () => {
    const tool = getTool("pdf-pro");
    expect(tool.icon).toBeTruthy();
    expect(tool.accent).toBe("pro");
    const others = TOOLS.filter((candidate) => candidate.slug !== "pdf-pro");
    expect(others.some((candidate) => candidate.accent === "pro")).toBe(false);
    expect(new Set(others.map((candidate) => candidate.icon)).has(tool.icon)).toBe(false);
  });

  it("los mapas de clases por acento cubren el acento pro con literales de Tailwind", () => {
    expect(ACCENT_TEXT.pro).toBe("text-accent-pro");
    expect(ACCENT_BG_SOFT.pro).toBe("bg-accent-pro/12");
    expect(ACCENT_RING.pro).toBe("ring-accent-pro/25");
  });

  it("no hay categoria nueva: la lista de categorias sigue siendo de seis", () => {
    expect(CATEGORY_ORDER).toEqual(["organize", "optimize", "convert-to", "convert-from", "edit", "security"]);
    expect(CATEGORY_ORDER).toContain(getTool("pdf-pro").category);
  });

  it("esta marcada como destacada y es la unica", () => {
    expect(getTool("pdf-pro").featured).toBe(true);
    expect(getFeaturedTools().map((tool) => tool.slug)).toEqual(["pdf-pro"]);
    expect(TOOLS.filter((tool) => tool.featured)).toHaveLength(1);
  });

  it("no pertenece a ninguna seccion de categoria", () => {
    for (const category of CATEGORY_ORDER) {
      expect(getToolsByCategory(category).map((tool) => tool.slug)).not.toContain("pdf-pro");
    }
  });

  it("el catalogo por categorias suma todas las herramientas MENOS las destacadas", () => {
    const grouped = CATEGORY_ORDER.flatMap((category) => getToolsByCategory(category));
    expect(grouped).toHaveLength(TOOLS.length - getFeaturedTools().length);
    expect(grouped.map((tool) => tool.slug).sort()).toEqual(
      TOOLS.filter((tool) => !tool.featured)
        .map((tool) => tool.slug)
        .sort(),
    );
  });

  it("cuenta como live y su ruta es /pdf-pro", () => {
    expect(getLiveTools().map((tool) => tool.slug)).toContain("pdf-pro");
    expect(toolHref("pdf-pro")).toBe("/pdf-pro");
  });

  it("nunca aparece en «Sigue con estas» (ya se ofrece con «Abrir en PDF Pro»)", () => {
    for (const tool of TOOLS) {
      const related = getRelatedTools(tool.slug, 36).map((candidate) => candidate.slug);
      expect(related).not.toContain("pdf-pro");
    }
  });

  it("getRelatedTools sigue devolviendo tres cuando se piden tres", () => {
    expect(getRelatedTools("merge-pdf", 3)).toHaveLength(3);
    expect(getRelatedTools("pdf-pro", 3)).toHaveLength(3);
  });

  it("las demas herramientas conservan su estado: solo powerpoint-to-pdf esta en camino", () => {
    expect(TOOLS.filter((tool) => tool.status === "soon").map((tool) => tool.slug)).toEqual([
      "powerpoint-to-pdf",
    ]);
  });
});

describe("registro — textos de PDF Pro", () => {
  it("nombre y descripcion en espanol", () => {
    expect(es.tools["pdf-pro"].name).toBe("PDF Pro");
    expect(es.tools["pdf-pro"].description).toBe(
      "Todo en uno: organiza, edita, firma, protege y convierte tu PDF sin salir de la página",
    );
  });

  it("nombre y descripcion en ingles", () => {
    expect(en.tools["pdf-pro"].name).toBe("PDF Pro");
    expect(en.tools["pdf-pro"].description).toMatch(/^All in one: organize, edit, sign, protect and convert/);
  });

  it("todas las herramientas tienen copia en ambos idiomas, sin textos vacios", () => {
    for (const slug of TOOL_SLUGS) {
      for (const dictionary of [es, en]) {
        expect(dictionary.tools[slug].name.trim().length).toBeGreaterThan(0);
        expect(dictionary.tools[slug].description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("el nombre de archivo de salida existe en es y en", () => {
    expect(es.filenames["pdf-pro"]).toBe("documento-pro");
    expect(en.filenames["pdf-pro"]).toBe("pro-document");
  });

  it("los textos nuevos de Home y ToolShell existen en ambos idiomas", () => {
    for (const dictionary of [es, en]) {
      expect(dictionary.home.featuredBadge).toBeTruthy();
      expect(dictionary.home.featuredCta).toBeTruthy();
      expect(dictionary.home.featuredLabel).toBeTruthy();
      expect(dictionary.tool.openInPro).toBeTruthy();
      expect(dictionary.tool.continueInPro).toBeTruthy();
    }
    expect(es.tool.openInPro).toBe("Abrir en PDF Pro");
    expect(es.tool.continueInPro).toBe("Seguir en PDF Pro");
  });

  it("el nombre «PDF Pro» no se confunde con el de ninguna otra herramienta", () => {
    for (const dictionary of [es, en]) {
      const names = TOOL_SLUGS.map((slug) => dictionary.tools[slug].name);
      expect(names.filter((name) => name === "PDF Pro")).toHaveLength(1);
    }
  });
});
