import { TOOLS, type Tool } from "@/lib/tools-registry";
import type { Dictionary } from "@/lib/i18n";

/** Normaliza para buscar: minusculas y sin diacriticos. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Herramientas cuyo nombre (en el idioma vigente) contiene el texto buscado, en el orden del catalogo. Es la MISMA busqueda
 * del buscador de la barra lateral y del menu movil: sin texto no hay resultados. El llamador decide cuantos muestra.
 */
export function searchTools(t: Dictionary, query: string): Tool[] {
  const needle = fold(query.trim());
  if (needle.length === 0) return [];
  return TOOLS.filter((tool) => fold(t.tools[tool.slug].name).includes(needle));
}
