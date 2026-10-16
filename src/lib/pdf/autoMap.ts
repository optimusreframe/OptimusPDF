/*
 * Automapeo (U2.8): identifica, en un documento desconocido, las lineas de iniciales, de firma, de fecha y los
 * campos de texto con etiqueta clara, y los propone ya colocados para 1 o 2 firmantes.
 *
 * Senales (todas explicables, sin IA):
 *  a) TEXTO de pdf.js con posicion: etiquetas ES/EN («Signature», «Firma del cliente», «(INITIAL)», «Date»...).
 *  b) GEOMETRIA vectorial del operator list: rayas finas (trazos y rellenos), casillas y guiones bajos de texto.
 *  c) REPETICION entre paginas: una raya corta sin etiqueta en posicion casi identica en la mayoria de las paginas.
 *  d) DISPOSICION por firmante (iniciales una al lado de la otra; firmas por columnas, apiladas o numeradas).
 *  e) PAGINAS ESCANEADAS: solo rayas por proyeccion raster, confianza baja.
 *
 * Politica (precision primero; el antecedente de la Wave 6 fueron «cientos de campos»):
 *  - `high`: etiqueta clara + raya asociada, o repeticion clara, sin avisos (no tapa texto, hay sitio, firmante conocido).
 *  - `review`: una sola senal debil, o un aviso (tapa texto, sin sitio, firma de la empresa, firmante sin pista).
 *  - `ignore`: el resto; no se devuelve salvo `includeIgnored`.
 *  - Topes: `MAX_FIELDS_PER_PAGE` y `MAX_FIELDS_PER_DOCUMENT`; deduplicacion; jamas sobre parrafos (cobertura de texto).
 *
 * No bloquea la interfaz: cada pagina se lee y analiza por trozos y se cede el control cada ~30 ms.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  readPageGraphics,
  readPageTexts,
  throwIfAbortedSignal,
  viewGeometryOf,
  yieldToMain,
  type CollectContext,
} from "@/lib/pdf/autoMapCollect";
import { analyzePage, type Candidate, type PageAnalysis } from "@/lib/pdf/autoMapPage";
import { layoutInitials, pageEm, toNormalized, type LayoutEnv } from "@/lib/pdf/autoMapLayout";
import { clusterRepeats } from "@/lib/pdf/autoMapRepeat";
import { detectRasterLines } from "@/lib/pdf/autoMapRaster";
import type {
  AutoField,
  AutoFieldType,
  AutoMapOptions,
  AutoMapPageSummary,
  AutoMapResult,
  AutoMapWarning,
  AutoTier,
  OpsTable,
} from "@/lib/pdf/autoMapTypes";

export type { AutoField, AutoFieldType, AutoMapOptions, AutoMapResult, AutoTier } from "@/lib/pdf/autoMapTypes";

/** Topes duros (precision primero): por pagina y por documento. */
export const MAX_FIELDS_PER_PAGE = 12;
export const MAX_FIELDS_PER_DOCUMENT = 80;
export const DEFAULT_MAX_PAGES = 200;
/** Umbrales de confianza de cada nivel. */
export const HIGH_CONFIDENCE = 0.75;
export const REVIEW_CONFIDENCE = 0.4;
/** Un grupo repetido solo es `high` en al menos este numero de paginas y esta fraccion del cuerpo. */
export const REPEAT_HIGH_MIN_PAGES = 3;
export const REPEAT_HIGH_MIN_RATIO = 0.6;
/** Por encima de esta fraccion de la altura (desde arriba) una raya repetida es membrete, no iniciales. */
export const REPEAT_MIN_TOP_FRACTION = 0.12;
/** Dos propuestas del mismo tipo se consideran la misma si se solapan mas de esto (IoU) o una contiene el centro de la otra. */
export const DUPLICATE_IOU = 0.4;

const TYPE_PRIORITY: Record<AutoFieldType, number> = { initials: 0, signature: 1, date: 2, text: 3 };
const TIER_RANK: Record<AutoTier, number> = { high: 0, review: 1, ignore: 2 };

type Locale = "es" | "en";

const REASONS: Record<Locale, Record<string, (label: string, extra: { pages?: number; total?: number }) => string>> = {
  es: {
    "label-line-right": (label) => `Etiqueta «${label}» con una raya a su derecha`,
    "label-line-above": (label) => `Etiqueta «${label}» debajo de una raya`,
    "label-line-below": (label) => `Etiqueta «${label}» encima de una raya`,
    "label-slots": (label) => `Marcas de iniciales del propio documento junto a «${label}»`,
    "label-box": (label) => `Casilla vacía junto a «${label}»`,
    "label-only": (label) => `Etiqueta «${label}» sin raya clara: hueco a su derecha`,
    "text-slot": (label) => `Campo con etiqueta «${label}»`,
    repetition: (_label, { pages, total }) => `Raya corta que se repite en ${pages} de ${total} páginas`,
    raster: () => "Raya horizontal larga en una página escaneada (sin texto)",
  },
  en: {
    "label-line-right": (label) => `Label “${label}” with a line to its right`,
    "label-line-above": (label) => `Label “${label}” below a line`,
    "label-line-below": (label) => `Label “${label}” above a line`,
    "label-slots": (label) => `The document's own initials marks next to “${label}”`,
    "label-box": (label) => `Empty box next to “${label}”`,
    "label-only": (label) => `Label “${label}” without a clear line: space to its right`,
    "text-slot": (label) => `Field with label “${label}”`,
    repetition: (_label, { pages, total }) => `Short line repeated on ${pages} of ${total} pages`,
    raster: () => "Long horizontal line on a scanned page (no text)",
  },
};

const NOTE_TEXT: Record<Locale, Record<string, string>> = {
  es: {
    blocked: "poco sitio libre sobre la raya",
    "covers-text": "podría tapar texto",
    "covers-image": "podría tapar una imagen",
    company: "firma de la otra parte",
    "no-signer": "firmante sin pista clara",
    "no-line": "sin raya asociada",
    "slot-structural": "no confirmado por la etiqueta",
    tight: "poco espacio entre iniciales",
  },
  en: {
    blocked: "little free space above the line",
    "covers-text": "may cover text",
    "covers-image": "may cover an image",
    company: "other party's signature",
    "no-signer": "signer unclear",
    "no-line": "no associated line",
    "slot-structural": "not confirmed by the label",
    tight: "little room between initials",
  },
};

/** Avisos que bajan una propuesta `high` a `review`. */
const DEMOTING_NOTES = new Set(["blocked", "covers-text", "covers-image", "company", "no-signer", "no-line", "slot-structural"]);

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function describe(locale: Locale, code: string, label: string, notes: readonly string[], extra: { pages?: number; total?: number } = {}): string {
  const base = (REASONS[locale][code] ?? REASONS[locale]["text-slot"])(label, extra);
  const flags = notes.filter((note) => NOTE_TEXT[locale][note]).map((note) => NOTE_TEXT[locale][note]);
  return flags.length > 0 ? `${base} (${flags.join("; ")})` : base;
}

/** Tier y confianza finales de un candidato, tras los avisos y el numero de firmantes. */
export function finalizeTier(candidate: Pick<Candidate, "tier" | "confidence" | "notes" | "signerIndex" | "type">, signers: 1 | 2): { tier: AutoTier; confidence: number } {
  let { tier, confidence } = candidate;
  if (tier === "high" && candidate.notes.some((note) => DEMOTING_NOTES.has(note))) {
    tier = "review";
    confidence = Math.min(confidence, 0.7);
  }
  if (candidate.signerIndex !== undefined && candidate.signerIndex >= signers) {
    return { tier: "ignore", confidence: Math.min(confidence, 0.3) };
  }
  if (tier === "high") confidence = Math.min(Math.max(confidence, HIGH_CONFIDENCE), 0.97);
  else if (tier === "review") confidence = Math.min(Math.max(confidence, REVIEW_CONFIDENCE), HIGH_CONFIDENCE - 0.01);
  else confidence = Math.min(confidence, REVIEW_CONFIDENCE - 0.01);
  return { tier, confidence };
}

type Located = { candidate: Candidate; analysis: PageAnalysis; reasonExtra?: { pages: number; total: number }; raster?: boolean };

function iou(a: AutoField["rect"], b: AutoField["rect"]): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function centerInside(a: AutoField["rect"], b: AutoField["rect"]): boolean {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}

/** Quita duplicados (mismo tipo y firmante, o el mismo sitio) quedandose con el mejor. */
export function dedupeFields(fields: readonly AutoField[]): AutoField[] {
  const sorted = [...fields].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.confidence - a.confidence || TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type],
  );
  const kept: AutoField[] = [];
  for (const field of sorted) {
    const duplicate = kept.some(
      (other) =>
        other.pageIndex === field.pageIndex &&
        ((other.type === field.type && (iou(other.rect, field.rect) > DUPLICATE_IOU || centerInside(field.rect, other.rect) || centerInside(other.rect, field.rect))) ||
          iou(other.rect, field.rect) > 0.6),
    );
    if (!duplicate) kept.push(field);
  }
  return kept;
}

/** Aplica los topes por pagina y por documento dejando fuera lo menos fiable. */
export function applyCaps(
  fields: readonly AutoField[],
  warnings: AutoMapWarning[],
  locale: Locale,
  limits: { perPage: number; perDocument: number } = { perPage: MAX_FIELDS_PER_PAGE, perDocument: MAX_FIELDS_PER_DOCUMENT },
): AutoField[] {
  const rank = (field: AutoField) => TIER_RANK[field.tier] * 10 + TYPE_PRIORITY[field.type];
  const byPage = new Map<number, AutoField[]>();
  for (const field of fields) byPage.set(field.pageIndex, [...(byPage.get(field.pageIndex) ?? []), field]);
  let kept: AutoField[] = [];
  for (const [pageIndex, list] of byPage) {
    const live = list.filter((field) => field.tier !== "ignore");
    const ignored = list.filter((field) => field.tier === "ignore");
    if (live.length <= limits.perPage) {
      kept.push(...live, ...ignored);
      continue;
    }
    const sorted = [...live].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
    kept.push(...sorted.slice(0, limits.perPage), ...ignored);
    warnings.push({
      code: "page-field-cap",
      pageIndex,
      message:
        locale === "es"
          ? `La página ${pageIndex + 1} tenía ${live.length} propuestas; se conservan las ${limits.perPage} más fiables.`
          : `Page ${pageIndex + 1} had ${live.length} proposals; the ${limits.perPage} most reliable are kept.`,
    });
  }
  const liveTotal = kept.filter((field) => field.tier !== "ignore").length;
  if (liveTotal > limits.perDocument) {
    const sorted = kept.filter((field) => field.tier !== "ignore").sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
    const keep = new Set(sorted.slice(0, limits.perDocument));
    kept = kept.filter((field) => field.tier === "ignore" || keep.has(field));
    warnings.push({
      code: "document-field-cap",
      message:
        locale === "es"
          ? `El documento tenía ${liveTotal} propuestas; se conservan las ${limits.perDocument} más fiables.`
          : `The document had ${liveTotal} proposals; the ${limits.perDocument} most reliable are kept.`,
    });
  }
  return kept;
}

function toField(
  located: Located,
  signers: 1 | 2,
  locale: Locale,
  counter: { n: number },
): AutoField {
  const { candidate, analysis } = located;
  const { tier, confidence } = finalizeTier(candidate, signers);
  const rect = toNormalized(candidate.rect, analysis.width, analysis.height);
  counter.n += 1;
  const field: AutoField = {
    id: `am-${candidate.pageIndex}-${counter.n}`,
    pageIndex: candidate.pageIndex,
    rect,
    type: candidate.type,
    confidence: Math.round(confidence * 1000) / 1000,
    tier,
    reason: located.raster
      ? describe(locale, "raster", "", candidate.notes)
      : describe(locale, candidate.reasonCode, candidate.label ?? "", candidate.notes, located.reasonExtra),
    source: candidate.source,
  };
  if (candidate.signerIndex !== undefined) field.signerIndex = candidate.signerIndex;
  if (candidate.label) field.label = candidate.label;
  return field;
}

/**
 * Mapea automaticamente un documento ya abierto con pdf.js. Devuelve las propuestas por pagina; no escribe nada
 * en el PDF. Cancelable con `signal` (lanza `AbortError`).
 */
export async function autoMapDocument(
  pdf: PDFDocumentProxy,
  options: AutoMapOptions,
  signal?: AbortSignal,
): Promise<AutoMapResult> {
  const locale: Locale = options.locale ?? "es";
  const signers = options.signers;
  const yieldEveryMs = options.yieldEveryMs ?? 30;
  const warnings: AutoMapWarning[] = [];
  throwIfAbortedSignal(signal);

  let ops: OpsTable;
  if (options.ops) ops = options.ops;
  else {
    const { getPdfJs } = await import("@/lib/pdf/core");
    ops = (await getPdfJs()).OPS as unknown as OpsTable;
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageCount = Math.min(pdf.numPages, maxPages);
  if (pdf.numPages > pageCount) {
    warnings.push({
      code: "too-many-pages",
      message:
        locale === "es"
          ? `Se analizan solo las primeras ${pageCount} de ${pdf.numPages} páginas.`
          : `Only the first ${pageCount} of ${pdf.numPages} pages are analysed.`,
    });
  }

  const context: CollectContext = { yieldEveryMs, now: nowMs, signal };
  let sliceStart = nowMs();
  const maybeYield = async () => {
    if (nowMs() - sliceStart > yieldEveryMs) {
      await yieldToMain();
      throwIfAbortedSignal(signal);
      sliceStart = nowMs();
    }
  };

  /* ---- Geometria y analisis por pagina ---- */
  const analyses: PageAnalysis[] = [];
  const located: Located[] = [];
  const rasterFields: AutoField[] = [];
  const scannedPages = new Set<number>();
  const counter = { n: 0 };
  for (let index = 0; index < pageCount; index += 1) {
    throwIfAbortedSignal(signal);
    let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
    try {
      page = await pdf.getPage(index + 1);
      const geometry = viewGeometryOf(page);
      const texts = await readPageTexts(page, geometry);
      if (texts.length === 0) {
        // Pagina sin texto: escaneo o pagina en blanco.
        const graphics = await readPageGraphics(page, geometry, ops, context);
        const data = { pageIndex: index, width: geometry.viewWidth, height: geometry.viewHeight, texts, ...graphics };
        analyses.push(analyzePage(data, { signers }));
        const hasImages = graphics.images.length > 0;
        if (hasImages) {
          scannedPages.add(index);
          if (options.rasterizer) {
            const raster = await options.rasterizer(page, index);
            if (raster) {
              rasterFields.push(...rasterFieldsFor(raster, index, signers, locale, counter));
            }
          } else {
            warnings.push({
              code: "scanned-page",
              pageIndex: index,
              message:
                locale === "es"
                  ? `La página ${index + 1} no tiene texto (escaneo): no se analiza sin renderizarla.`
                  : `Page ${index + 1} has no text (scan): not analysed without rendering it.`,
            });
          }
        }
      } else {
        const graphics = await readPageGraphics(page, geometry, ops, context);
        const data = { pageIndex: index, width: geometry.viewWidth, height: geometry.viewHeight, texts, ...graphics };
        if (graphics.truncated) {
          warnings.push({
            code: "page-too-complex",
            pageIndex: index,
            message: locale === "es" ? `La página ${index + 1} es demasiado compleja y se omite.` : `Page ${index + 1} is too complex and is skipped.`,
          });
        }
        const analysis = analyzePage(data, { signers });
        analyses.push(analysis);
        for (const candidate of analysis.candidates) located.push({ candidate, analysis });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      warnings.push({
        code: "page-skipped",
        pageIndex: index,
        message: locale === "es" ? `No se pudo analizar la página ${index + 1}.` : `Page ${index + 1} could not be analysed.`,
      });
    } finally {
      page?.cleanup();
    }
    options.onProgress?.(index + 1, pageCount);
    await maybeYield();
  }

  /* ---- Repeticion entre paginas: rayas cortas sin etiqueta ---- */
  const clusters = clusterRepeats(analyses);
  const bodyPageCount = analyses.filter((analysis) => analysis.hasText).length;
  for (const cluster of clusters) {
    const high =
      cluster.members.length >= REPEAT_HIGH_MIN_PAGES && cluster.pageRatio >= REPEAT_HIGH_MIN_RATIO && cluster.cy >= REPEAT_MIN_TOP_FRACTION;
    for (const { point, page } of cluster.members) {
      // Si la pagina ya tiene iniciales por etiqueta en ese sitio, la repeticion no anade nada.
      const em = pageEm(page.width);
      const already = page.candidates.some(
        (c) => c.type === "initials" && c.host && Math.abs(c.host.y - point.y) <= 1.5 * em && Math.min(c.host.x1, point.x1) - Math.max(c.host.x0, point.x0) > 0,
      );
      if (already) continue;
      const env: LayoutEnv = { em, pageWidth: page.width, pageHeight: page.height };
      const layout = layoutInitials(
        { x0: point.line.x0, x1: point.line.x1, y: point.line.y, box: point.line.box },
        signers,
        env,
      );
      layout.rects.forEach((rect, order) => {
        const candidate: Candidate = {
          pageIndex: page.pageIndex,
          type: "initials",
          signerIndex: order as 0 | 1,
          slotOrder: order,
          rect,
          source: "repetition",
          reasonCode: "repetition",
          tier: high ? "high" : "review",
          confidence: high ? 0.7 + 0.25 * cluster.pageRatio : 0.5,
          host: { x0: point.x0, x1: point.x1, y: point.y },
          notes: layout.tight ? ["tight"] : [],
        };
        located.push({ candidate, analysis: page, reasonExtra: { pages: cluster.members.length, total: bodyPageCount } });
        page.initialsHosts += 1;
      });
    }
  }

  /* ---- Politica final ---- */
  let fields = located.map((entry) => toField(entry, signers, locale, counter));
  fields.push(...rasterFields);
  fields = dedupeFields(fields);
  fields = applyCaps(fields, warnings, locale);
  const visible = options.includeIgnored ? fields : fields.filter((field) => field.tier !== "ignore");
  const ordered = visible.sort((a, b) => a.pageIndex - b.pageIndex || a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  const live = ordered.filter((field) => field.tier !== "ignore");
  const summaryPages: AutoMapPageSummary[] = Array.from({ length: pageCount }, (_, pageIndex) => {
    const onPage = live.filter((field) => field.pageIndex === pageIndex);
    return {
      pageIndex,
      hasInitialsLine: onPage.some((field) => field.type === "initials"),
      signatureLines: onPage.filter((field) => field.type === "signature").length,
      ...(scannedPages.has(pageIndex) ? { scanned: true } : {}),
    };
  });
  const byType: Record<AutoFieldType, number> = { signature: 0, initials: 0, date: 0, text: 0 };
  for (const field of live) byType[field.type] += 1;
  const high = live.filter((field) => field.tier === "high");
  const perPageCounts = summaryPages.map((p) => live.filter((field) => field.pageIndex === p.pageIndex).length);
  if (live.length === 0) {
    warnings.push({
      code: "no-fields",
      message:
        locale === "es"
          ? "No se encontraron campos con suficiente seguridad: colócalos a mano."
          : "No fields were found with enough confidence: place them manually.",
    });
  }
  return {
    fields: ordered,
    pages: summaryPages,
    confidenceSummary: {
      high: high.length,
      review: live.length - high.length,
      ignore: ordered.length - live.length,
      byType,
      meanHighConfidence: high.length > 0 ? Math.round((high.reduce((sum, field) => sum + field.confidence, 0) / high.length) * 1000) / 1000 : 0,
      maxPerPage: Math.max(0, ...perPageCounts),
    },
    warnings,
  };
}

/** Rayas de una pagina escaneada: solo las largas y aisladas, como firma, con confianza baja y `review` como mucho. */
function rasterFieldsFor(
  raster: { data: ArrayLike<number>; width: number; height: number },
  pageIndex: number,
  signers: 1 | 2,
  locale: Locale,
  counter: { n: number },
): AutoField[] {
  const lines = detectRasterLines(raster)
    .filter((line) => line.y >= 0.3 && line.y <= 0.97 && line.x1 - line.x0 >= 0.2)
    .sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))
    .slice(0, 4)
    .sort((a, b) => a.y - b.y);
  return lines.map((line, order) => {
    counter.n += 1;
    const height = 0.05;
    return {
      id: `am-${pageIndex}-${counter.n}`,
      pageIndex,
      rect: { x: line.x0, y: Math.max(0, line.y - height), width: line.x1 - line.x0, height },
      type: "signature" as const,
      ...(order < signers ? { signerIndex: order as 0 | 1 } : {}),
      confidence: 0.42,
      tier: "review" as const,
      reason: describe(locale, "raster", "", []),
      source: "geometry" as const,
    };
  });
}
