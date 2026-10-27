/**
 * Hechos de cada pagina para el clasificador (U7.3): texto con posiciones (lineas) y grupos de trazos vectoriales. Una pasada por
 * pagina con `page.cleanup()` al terminar, plazo por paso (pdf.js puede dejar una promesa sin resolver con un documento roto) y
 * cancelacion. Un fallo en una pagina no rompe el resto: esa pagina se queda sin hechos (el clasificador sigue con lo que tiene).
 */

import { PdfError } from "@/lib/pdf/core";
import { readPageTexts, viewGeometryOf } from "@/lib/pdf/autoMapCollect";
import { countLegibleChars } from "@/lib/pdf/pageTextKind";
import { STEP_TIMEOUT_MS, withTimeout } from "./annotationsRaster";
import { isCancellation } from "./annotations";
import type { PdfDocument, PdfPage } from "./annotationsTypes";
import type { PageFacts, PageVectors } from "./classifyTypes";
import { buildTextLines } from "./classifyText";
import { scanVectors, toPageVectors, type VectorOps } from "./vectors";

export type FactsContext = {
  ops: VectorOps;
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  /** Lista de operadores de una pagina (compartida con las demas pasadas); por defecto, `page.getOperatorList`. */
  getOperatorList?: (page: PdfPage, pageIndex: number) => Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
  /** Se llama tras cada pagina (0-based). */
  onPage?: (pageIndex: number) => void;
};

export type PageFactsResult = { facts: PageFacts[]; vectors: PageVectors[]; failures: number };

/** Hechos de una pagina ya abierta. Nunca lanza salvo por cancelacion. */
export async function pageFactsOf(page: PdfPage, pageIndex: number, ctx: FactsContext): Promise<{ facts: PageFacts; vectors: PageVectors | null; failed: boolean }> {
  const timeout = ctx.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const viewport = page.getViewport({ scale: 1 });
  const geometry = viewGeometryOf(page);
  let failed = false;
  let lines: PageFacts["lines"] = [];
  let chars = 0;
  try {
    const pieces = await withTimeout(readPageTexts(page, geometry), timeout, ctx.signal, "texto");
    lines = buildTextLines(pieces, viewport.height);
    for (const piece of pieces) chars += countLegibleChars(piece.text).legible;
  } catch (error) {
    if (isCancellation(error, ctx.signal)) throw new PdfError("cancelled");
    failed = true;
  }
  let vectors: PageVectors | null = null;
  try {
    const list = await withTimeout(ctx.getOperatorList ? ctx.getOperatorList(page, pageIndex) : page.getOperatorList({ annotationMode: 0 } as never), timeout, ctx.signal, "operadores");
    const scan = scanVectors(
      list.fnArray as unknown as ArrayLike<number>,
      list.argsArray as unknown as ArrayLike<unknown>,
      ctx.ops,
      { toView: (x, y) => viewport.convertToViewportPoint(x, y) as [number, number] },
      pageIndex,
      viewport.width,
      viewport.height,
    );
    if (scan.candidates.length > 0) vectors = toPageVectors(pageIndex, scan);
  } catch (error) {
    if (isCancellation(error, ctx.signal)) throw new PdfError("cancelled");
    failed = true;
  }
  return { facts: { pageIndex, width: viewport.width, height: viewport.height, lines, chars }, vectors, failed };
}

/** Hechos de las paginas pedidas (0-based), una a una. */
export async function collectPageFacts(doc: PdfDocument, pageIndices: ReadonlyArray<number>, ctx: FactsContext): Promise<PageFactsResult> {
  const facts: PageFacts[] = [];
  const vectors: PageVectors[] = [];
  let failures = 0;
  const timeout = ctx.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  for (const pageIndex of pageIndices) {
    if (ctx.signal?.aborted) throw new PdfError("cancelled");
    let page: PdfPage | null = null;
    try {
      page = await withTimeout(doc.getPage(pageIndex + 1), timeout, ctx.signal, "pagina");
      const got = await pageFactsOf(page, pageIndex, ctx);
      facts.push(got.facts);
      if (got.vectors) vectors.push(got.vectors);
      if (got.failed) failures += 1;
    } catch (error) {
      if (isCancellation(error, ctx.signal)) throw new PdfError("cancelled");
      failures += 1;
    } finally {
      try {
        page?.cleanup();
      } catch {
        // documento ya destruido
      }
    }
    ctx.onPage?.(pageIndex);
  }
  return { facts, vectors, failures };
}
