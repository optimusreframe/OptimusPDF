import {
  PdfError,
  loadPdf,
  readFileBytes,
  scaleProgress,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de division y extraccion de paginas.
 *
 * Modulo puro (sin React). Todo el trabajo ocurre en la memoria del
 * navegador: ni un byte del documento sale del dispositivo.
 *
 * Convencion de numeracion: la API publica habla en numeros de pagina
 * 1-based (los que ve la persona usuaria); los indices 0-based solo
 * existen dentro de este modulo, que es lo que espera pdf-lib.
 *
 * Wave 8: la ejecucion (`splitPdf`) la hace `pageAssemblyExport`: una sola
 * parte sale del motor en sitio (`extractPages`: conserva titulo, autor,
 * formulario, marcadores y enlaces de las paginas que quedan, y no arrastra
 * las demas); varias partes, de `splitDocument` (cada parte es un documento
 * nuevo con los metadatos y los campos de sus paginas). Antes `copyPages` a
 * un documento nuevo perdia metadatos, formulario y marcadores.
 */

/** Rango inclusivo en numeros de pagina 1-based. */
export type PageRange = {
  from: number;
  to: number;
};

export type SplitPlan =
  /** Lista de rangos; `merge` fusiona todos en un unico PDF. */
  | { mode: "ranges"; ranges: PageRange[]; merge: boolean }
  /** Corta el documento en bloques consecutivos de `size` paginas. */
  | { mode: "fixed"; size: number }
  /** Extrae paginas sueltas; `separate` genera un PDF por pagina. */
  | { mode: "extract"; pages: number[]; separate: boolean };

export type SplitOutput = {
  blob: Blob;
  /** `zip` cuando el plan produce mas de un documento. */
  kind: "pdf" | "zip";
  /** Numero de documentos generados. */
  parts: number;
};

/* ------------------------------------------------------------------ *
 * Listas de paginas escritas a mano ("1,3-5")
 * ------------------------------------------------------------------ */

const LIST_SEPARATORS = /[,;\s]+/;
/** Guion normal, guion medio y guion largo: los tres se teclean igual. */
const RANGE_SEPARATOR = /[-–—]/;
/**
 * El espacio separa elementos de la lista, asi que hay que pegar los
 * guiones a sus numeros antes de trocear: `"4 - 6"` es un rango, no tres
 * elementos.
 */
const LOOSE_RANGE = /\s*[-–—]\s*/g;

/**
 * Interpreta una lista de paginas tipo `"1,3-5"`.
 *
 * Devuelve numeros de pagina 1-based, ordenados y sin repetir, o `null`
 * si algun tramo es invalido (fuera de rango, sin numero, al reves).
 * Una cadena vacia devuelve una lista vacia, que es un estado valido.
 */
export function parsePageList(
  text: string,
  pageCount: number,
): number[] | null {
  const trimmed = text.trim().replace(LOOSE_RANGE, "-");
  if (trimmed.length === 0) return [];

  const pages = new Set<number>();

  for (const token of trimmed.split(LIST_SEPARATORS)) {
    if (token.length === 0) continue;
    const bounds = token.split(RANGE_SEPARATOR);
    if (bounds.length > 2) return null;

    const from = toPageNumber(bounds[0], pageCount);
    if (from === null) return null;

    if (bounds.length === 1) {
      pages.add(from);
      continue;
    }

    const to = toPageNumber(bounds[1], pageCount);
    if (to === null || to < from) return null;
    for (let page = from; page <= to; page += 1) pages.add(page);
  }

  return [...pages].sort((a, b) => a - b);
}

function toPageNumber(raw: string, pageCount: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 1) return null;
  if (pageCount > 0 && value > pageCount) return null;
  return value;
}

/** Inversa de `parsePageList`: `[1,3,4,5]` -> `"1, 3-5"`. */
export function formatPageList(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const chunks: string[] = [];

  let start = -1;
  let previous = -1;

  const flush = () => {
    if (start < 0) return;
    chunks.push(start === previous ? `${start}` : `${start}-${previous}`);
  };

  for (const page of sorted) {
    if (start < 0) {
      start = page;
      previous = page;
      continue;
    }
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    flush();
    start = page;
    previous = page;
  }
  flush();

  return chunks.join(", ");
}

/* ------------------------------------------------------------------ *
 * Plan -> grupos de paginas
 * ------------------------------------------------------------------ */

/**
 * Traduce un plan a la lista de documentos de salida, cada uno descrito
 * por sus indices de pagina 0-based. Nunca lanza: un plan invalido
 * devuelve una lista vacia para que la interfaz pueda previsualizarlo
 * sin envolverlo en `try`.
 */
export function buildSplitGroups(
  plan: SplitPlan,
  pageCount: number,
): number[][] {
  if (pageCount < 1) return [];

  if (plan.mode === "ranges") {
    const groups: number[][] = [];
    for (const range of plan.ranges) {
      const from = clampPage(range.from, pageCount);
      const to = clampPage(range.to, pageCount);
      if (from === null || to === null || to < from) continue;
      const indices: number[] = [];
      for (let page = from; page <= to; page += 1) indices.push(page - 1);
      groups.push(indices);
    }
    if (groups.length === 0) return [];
    return plan.merge ? [dedupe(groups.flat())] : groups;
  }

  if (plan.mode === "fixed") {
    const size = Math.floor(plan.size);
    if (!Number.isFinite(size) || size < 1) return [];
    const groups: number[][] = [];
    for (let start = 0; start < pageCount; start += size) {
      const indices: number[] = [];
      for (let index = start; index < Math.min(start + size, pageCount); index += 1) {
        indices.push(index);
      }
      groups.push(indices);
    }
    return groups;
  }

  const pages = [...new Set(plan.pages)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
    .sort((a, b) => a - b);
  if (pages.length === 0) return [];
  const indices = pages.map((page) => page - 1);
  return plan.separate ? indices.map((index) => [index]) : [indices];
}

function clampPage(value: number, pageCount: number): number | null {
  if (!Number.isFinite(value)) return null;
  const page = Math.floor(value);
  if (page < 1 || page > pageCount) return null;
  return page;
}

function dedupe(indices: number[]): number[] {
  const seen = new Set<number>();
  const output: number[] = [];
  for (const index of indices) {
    if (seen.has(index)) continue;
    seen.add(index);
    output.push(index);
  }
  return output;
}

/* ------------------------------------------------------------------ *
 * Ejecucion
 * ------------------------------------------------------------------ */

/**
 * Aplica un plan de division. Devuelve un unico PDF cuando el plan
 * produce un solo documento y un ZIP cuando produce varios.
 */
export async function splitPdf(
  file: File,
  plan: SplitPlan,
  baseName: string,
  onProgress?: ProgressCallback,
): Promise<SplitOutput> {
  try {
    const bytes = await readFileBytes(file);
    // `pageAssemblyExport` importa de este modulo (rangos y nombres): se carga aqui, al ejecutar,
    // para no cerrar un ciclo de importaciones en la carga.
    const { extractPages, splitDocument } = await import("@/lib/pdf/pageAssemblyExport");
    const pageCount = (await loadPdf(bytes)).getPageCount();
    onProgress?.(0.12);

    const groups = buildSplitGroups(plan, pageCount);
    // "nothingSelected", no "empty": el archivo ya se cargo bien -- lo que
    // falta es que el plan (rangos/paginas) resulte en algo que dividir.
    if (groups.length === 0) throw new PdfError("nothingSelected");

    if (groups.length === 1) {
      const result = await extractPages(bytes, groups[0], {
        onProgress: (value) => onProgress?.(scaleProgress(value, 0.12, 1)),
      });
      onProgress?.(1);
      return {
        blob: new Blob([result.bytes as unknown as BlobPart], { type: "application/pdf" }),
        kind: "pdf",
        parts: 1,
      };
    }

    const outcome = await splitDocument(bytes, groups, baseName, {
      onProgress: (value) => onProgress?.(scaleProgress(value, 0.12, 1)),
    });
    onProgress?.(1);
    return {
      blob: new Blob([outcome.bytes as unknown as BlobPart], {
        type: outcome.kind === "zip" ? "application/zip" : "application/pdf",
      }),
      kind: outcome.kind,
      parts: outcome.parts,
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
