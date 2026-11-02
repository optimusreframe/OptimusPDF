import { describe, expect, it } from "vitest";
import {
  CATEGORY_ORDER,
  GROUP_ICON,
  GROUP_ORDER,
  SECTION_ORDER,
  SUITE_ICON,
  SUITE_ORDER,
  TOOLS,
  TOOL_SLUGS,
  getFeaturedTools,
  getLiveTools,
  getRelatedTools,
  getTool,
  getToolsByCategory,
  getToolsByGroup,
  getToolsBySuite,
  isToolLive,
  toolHref,
  type ToolSlug,
} from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/** Suites (pdf | scan | tools) y grupos de OptimusTOOLS en el registro (docs/PLAN-OPTIMUSTOOLS.md). */

const slugs = (tools: { slug: ToolSlug }[]) => tools.map((tool) => tool.slug);

describe("registro — suites", () => {
  it("hay tres suites en este orden y cada herramienta pertenece a una sola", () => {
    expect(SUITE_ORDER).toEqual(["pdf", "scan", "tools"]);
    for (const tool of TOOLS) expect(SUITE_ORDER).toContain(tool.suite);
    const bySuite = SUITE_ORDER.flatMap((suite) => slugs(TOOLS.filter((tool) => tool.suite === suite)));
    expect(bySuite.sort()).toEqual([...TOOL_SLUGS].sort());
  });

  it("scan-to-pdf es la unica de OptimusSCAN: sigue viva, con su ruta, y ya no sale en «Convertir a PDF»", () => {
    const scan = getTool("scan-to-pdf");
    expect(scan.suite).toBe("scan");
    expect(scan.group).toBeUndefined();
    expect(scan.status).toBe("live");
    expect(toolHref("scan-to-pdf")).toBe("/scan-to-pdf");
    expect(slugs(getToolsBySuite("scan"))).toEqual(["scan-to-pdf"]);
    expect(slugs(getToolsByCategory("convert-to"))).not.toContain("scan-to-pdf");
    expect(slugs(getToolsByCategory("convert-to"))).toEqual([
      "jpg-to-pdf",
      "word-to-pdf",
      "powerpoint-to-pdf",
      "excel-to-pdf",
      "html-to-pdf",
    ]);
    expect(getLiveTools().map((tool) => tool.slug)).toContain("scan-to-pdf");
  });

  it("las seis categorias de PDF reparten SOLO herramientas de la suite pdf (sin las de scan ni tools)", () => {
    for (const category of CATEGORY_ORDER) {
      for (const tool of getToolsByCategory(category)) expect(tool.suite).toBe("pdf");
    }
    expect(CATEGORY_ORDER).toHaveLength(6);
    // Las herramientas PDF no cambian de categoria: solo se ha movido scan-to-pdf.
    expect(slugs(getToolsByCategory("organize"))).toHaveLength(7);
    expect(slugs(getToolsByCategory("security"))).toEqual(["protect-pdf", "unlock-pdf", "redact-pdf"]);
  });

  it("PDF Pro sigue destacada, en la suite pdf, y no sale en ninguna lista de suite", () => {
    expect(getFeaturedTools().map((tool) => tool.slug)).toEqual(["pdf-pro"]);
    expect(getTool("pdf-pro").suite).toBe("pdf");
    for (const suite of SUITE_ORDER) expect(slugs(getToolsBySuite(suite))).not.toContain("pdf-pro");
  });

  it("todas las suites y grupos tienen icono y texto en ES y EN", () => {
    for (const suite of SUITE_ORDER) {
      expect(SUITE_ICON[suite]).toBeTruthy();
      for (const dictionary of [es, en]) {
        expect(dictionary.suites[suite].label.trim().length).toBeGreaterThan(0);
        expect(dictionary.suites[suite].description.trim().length).toBeGreaterThan(0);
      }
    }
    expect(es.suites.pdf.label).toBe("OptimusPDF");
    expect(es.suites.scan.label).toBe("OptimusSCAN");
    expect(es.suites.tools.label).toBe("OptimusTOOLS");
  });
});

describe("registro — grupos de OptimusTOOLS", () => {
  it("tres grupos en orden: downloader, audio-studio, converter", () => {
    expect(GROUP_ORDER).toEqual(["downloader", "audio-studio", "converter"]);
  });

  it("downloader = Downloader; audio-studio = extraer audio + Audio Studio; converter = imagen, audio y video", () => {
    expect(slugs(getToolsByGroup("downloader"))).toEqual(["downloader"]);
    expect(slugs(getToolsByGroup("audio-studio"))).toEqual(["audio-extractor", "audio-studio"]);
    expect(slugs(getToolsByGroup("converter"))).toEqual(["audio-converter", "image-converter", "video-converter"]);
    expect(slugs(getToolsBySuite("tools")).sort()).toEqual(
      ["audio-converter", "audio-extractor", "audio-studio", "downloader", "image-converter", "video-converter"].sort(),
    );
  });

  it("solo la suite tools tiene grupos, y todas sus herramientas tienen uno", () => {
    for (const tool of TOOLS) {
      if (tool.suite === "tools") expect(GROUP_ORDER).toContain(tool.group);
      else expect(tool.group).toBeUndefined();
    }
  });

  it("los seis slugs nuevos nacen «soon» y sus rutas existen (paginas provisionales); isToolLive lo refleja", () => {
    for (const slug of ["image-converter", "audio-converter", "video-converter", "audio-studio", "audio-extractor", "downloader"] as const) {
      expect(isToolLive(slug)).toBe(getTool(slug).status === "live");
      expect(toolHref(slug)).toBe(`/${slug}`);
    }
    // El Downloader no se construye (decision del usuario): siempre «soon».
    expect(getTool("downloader").status).toBe("soon");
  });

  it("cada grupo tiene icono y texto en ES y EN", () => {
    for (const group of GROUP_ORDER) {
      expect(GROUP_ICON[group]).toBeTruthy();
      for (const dictionary of [es, en]) {
        expect(dictionary.groups[group].label.trim().length).toBeGreaterThan(0);
        expect(dictionary.groups[group].description.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("registro — secciones de Inicio y relacionadas", () => {
  it("las secciones ancladas son las 6 categorias, scan y los 3 grupos, sin ids repetidos", () => {
    expect(SECTION_ORDER).toEqual([...CATEGORY_ORDER, "scan", ...GROUP_ORDER]);
    expect(new Set(SECTION_ORDER).size).toBe(SECTION_ORDER.length);
    // Un id de seccion no puede ser el de una ruta de otra cosa que no sea la herramienta homonima.
    for (const id of SECTION_ORDER) expect(["pdf-pro", "recent", "documents", "settings"]).not.toContain(id);
  });

  it("las relacionadas de una herramienta de OptimusTOOLS empiezan por las de su grupo", () => {
    expect(getRelatedTools("image-converter", 2).map((tool) => tool.slug)).toEqual(["audio-converter", "video-converter"]);
    expect(getRelatedTools("audio-extractor", 1).map((tool) => tool.slug)).toEqual(["audio-studio"]);
  });

  it("scan-to-pdf conserva su afinidad con «Convertir a PDF» en las relacionadas", () => {
    expect(getRelatedTools("scan-to-pdf", 2).map((tool) => tool.slug)).toEqual(["jpg-to-pdf", "word-to-pdf"]);
  });

  it("siguen sin salir PDF Pro ni la propia herramienta, y siempre se rellena el limite", () => {
    for (const tool of TOOLS) {
      const related = getRelatedTools(tool.slug, 3).map((candidate) => candidate.slug);
      expect(related).not.toContain("pdf-pro");
      expect(related).not.toContain(tool.slug);
      expect(related).toHaveLength(3);
    }
  });
});
