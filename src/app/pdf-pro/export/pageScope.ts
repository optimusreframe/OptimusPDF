import { parseRangeParts } from "@/lib/pdf/pageAssemblyExport";
import type { ImagesExportOptions } from "@/app/pdf-pro/export/exportTypes";

/**
 * Paginas que se exportan a imagen (0-based, ordenadas y sin repetir), o un motivo si no se pueden resolver.
 * Funcion PURA: la usan la interfaz (para validar antes de exportar) y el motor de exportacion.
 */
export type ScopeResolution =
  | { ok: true; pages: number[] | undefined; count: number }
  | { ok: false; reason: "rangeEmpty" | "rangeInvalid" | "selectionEmpty" };

export function resolvePageScope(
  options: Pick<ImagesExportOptions, "scope" | "range">,
  pageCount: number,
  selectedPages: readonly number[] = [],
): ScopeResolution {
  if (options.scope === "all") return { ok: true, pages: undefined, count: pageCount };
  if (options.scope === "selected") {
    const pages = [...new Set(selectedPages)].filter((page) => Number.isInteger(page) && page >= 0 && page < pageCount);
    pages.sort((a, b) => a - b);
    return pages.length === 0 ? { ok: false, reason: "selectionEmpty" } : { ok: true, pages, count: pages.length };
  }
  if (options.range.trim() === "") return { ok: false, reason: "rangeEmpty" };
  const ranges = parseRangeParts(options.range, pageCount);
  if (!ranges || ranges.length === 0) return { ok: false, reason: "rangeInvalid" };
  const set = new Set<number>();
  for (const range of ranges) for (let page = range.from; page <= range.to; page += 1) set.add(page - 1);
  const pages = [...set].sort((a, b) => a - b);
  return { ok: true, pages, count: pages.length };
}
