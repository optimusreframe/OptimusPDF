import { describe, expect, it } from "vitest";
import { filterTools, foldText } from "@/components/tool/ToolCatalogGrid";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { TOOLS } from "@/lib/tools-registry";

/**
 * Filtro del buscador de Home: logica pura, independiente del DOM. Lo que
 * importa es que encuentre sin acentos ni mayusculas, que busque tambien en
 * descripcion y categoria, que ordene por relevancia y que una consulta
 * vacia devuelva el catalogo entero en su orden.
 */
describe("filterTools", () => {
  it("consulta vacia o solo espacios -> catalogo completo en orden", () => {
    expect(filterTools("", es)).toEqual(TOOLS);
    expect(filterTools("   ", es)).toEqual(TOOLS);
  });

  it("ignora acentos y mayusculas en ambas direcciones", () => {
    const withAccent = filterTools("Páginas", es).map((t) => t.slug);
    const without = filterTools("paginas", es).map((t) => t.slug);
    expect(withAccent).toEqual(without);
    expect(withAccent).toContain("remove-pages");
    expect(withAccent).toContain("extract-pages");
  });

  it("pone primero las que empiezan por la consulta en el nombre, luego las que la contienen", () => {
    const slugs = filterTools("pdf a", es).map((t) => t.slug);
    expect(slugs[0]).toBe("pdf-to-jpg");
    // "Unir PDF" no empieza por "pdf a" ni lo contiene en el nombre, pero
    // su descripcion/categoria puede coincidir: nunca por delante de "PDF a JPG".
    expect(slugs.indexOf("pdf-to-jpg")).toBeLessThan(
      Math.max(slugs.indexOf("merge-pdf"), 0) || slugs.length,
    );
  });

  it("busca tambien en la descripcion y en la etiqueta de categoria", () => {
    // "seguridad" es la etiqueta de categoria, no aparece en los nombres.
    const bySecurity = filterTools("seguridad", es).map((t) => t.slug);
    expect(bySecurity).toEqual(
      expect.arrayContaining(["protect-pdf", "unlock-pdf", "redact-pdf"]),
    );
    // "contraseña" solo aparece en descripciones.
    const byDescription = filterTools("contraseña", es).map((t) => t.slug);
    expect(byDescription).toContain("protect-pdf");
  });

  it("todas las palabras deben coincidir (AND), en cualquier orden", () => {
    const slugs = filterTools("word pdf", es).map((t) => t.slug);
    expect(slugs).toContain("word-to-pdf");
    expect(slugs).toContain("pdf-to-word");
    expect(filterTools("word zzzz", es)).toEqual([]);
  });

  it("devuelve vacio cuando nada coincide", () => {
    expect(filterTools("qwxyz", es)).toEqual([]);
  });

  it("funciona con el diccionario ingles", () => {
    const slugs = filterTools("merge", en).map((t) => t.slug);
    expect(slugs[0]).toBe("merge-pdf");
  });
});

describe("foldText", () => {
  it("quita diacriticos, baja a minusculas y recorta", () => {
    expect(foldText("  Próximamente ")).toBe("proximamente");
    expect(foldText("Ñandú")).toBe("nandu");
  });
});
