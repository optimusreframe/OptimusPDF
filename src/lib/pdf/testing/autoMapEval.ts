/*
 * Metricas del automapeo contra una verdad de terreno (real o sintetica). Solo numeros.
 *
 * Una propuesta ACIERTA si su centro cae dentro del rectangulo real expandido +-3 % de pagina y es del tipo
 * correcto (una verdad `either` acepta iniciales o firma). Cada elemento real se empareja con una sola propuesta
 * (la mas cercana primero). Para dos firmantes, las iniciales ademas deben respetar el ORDEN izquierda->derecha.
 */

import type { AutoField, AutoFieldType } from "@/lib/pdf/autoMapTypes";
import type { GroundTruth, GtImage, GtKind, NormRect } from "@/lib/pdf/testing/autoMapGroundTruth";

export const MATCH_MARGIN = 0.03;

export type EvalItem = { pageIndex: number; rect: NormRect; kind: GtKind; anchoredToLine?: boolean };

export type EvalOptions = {
  /** Que niveles cuentan como «propuesto» para el recall. */
  tiers: ReadonlyArray<"high" | "review">;
  signers: 1 | 2;
  margin?: number;
};

export type KindMetrics = {
  total: number;
  matched: number;
  recall: number;
  /** Elementos con ancla geometrica a una raya (solo firmas/iniciales reales). */
  anchoredTotal: number;
  anchoredMatched: number;
  anchoredRecall: number;
};

export type Metrics = {
  initials: KindMetrics;
  signature: KindMetrics;
  either: KindMetrics;
  /** Precision del nivel `high` de iniciales y firmas. */
  highPrecision: { proposals: number; correct: number; precision: number };
  highByType: Record<"initials" | "signature", { proposals: number; correct: number }>;
  /** Orden izquierda->derecha de las iniciales de dos firmantes. */
  initialsOrder: { checked: number; ok: number };
  /** Distancia media centro a centro (fraccion de pagina) de los aciertos. */
  meanPositionError: number;
  perPage: { max: number; mean: number };
  /** Cuantos textos reales caen dentro de un campo `text`/`date` propuesto (informativo). */
  text: { total: number; covered: number; recall: number };
  /** Posiciones de lo que falto y de las propuestas `high` sin elemento real (solo numeros, para depurar). */
  details: {
    missed: Array<{ page: number; kind: GtKind; anchored: boolean; x: number; y: number; w: number; h: number }>;
    falseHigh: Array<{ page: number; type: AutoFieldType; signer?: number; x: number; y: number; w: number; h: number }>;
  };
};

function r3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function center(rect: NormRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function inside(point: { x: number; y: number }, rect: NormRect, margin: number): boolean {
  return point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;
}

function typeOk(kind: GtKind, type: AutoFieldType): boolean {
  if (kind === "either") return type === "initials" || type === "signature";
  return kind === type;
}

type Pairing = { item: number; field: number; distance: number };

/** Empareja elementos reales y propuestas 1 a 1, las mas cercanas primero. */
export function pair(items: readonly EvalItem[], fields: readonly AutoField[], margin: number): Pairing[] {
  const all: Pairing[] = [];
  items.forEach((item, i) => {
    fields.forEach((field, f) => {
      if (field.pageIndex !== item.pageIndex || !typeOk(item.kind, field.type)) return;
      const c = center(field.rect);
      if (!inside(c, item.rect, margin)) return;
      const t = center(item.rect);
      all.push({ item: i, field: f, distance: Math.hypot(c.x - t.x, c.y - t.y) });
    });
  });
  all.sort((a, b) => a.distance - b.distance);
  const usedItems = new Set<number>();
  const usedFields = new Set<number>();
  const out: Pairing[] = [];
  for (const candidate of all) {
    if (usedItems.has(candidate.item) || usedFields.has(candidate.field)) continue;
    usedItems.add(candidate.item);
    usedFields.add(candidate.field);
    out.push(candidate);
  }
  return out;
}

function kindMetrics(items: readonly EvalItem[], matchedItems: ReadonlySet<EvalItem>): KindMetrics {
  const anchored = items.filter((item) => item.anchoredToLine);
  const matched = items.filter((item) => matchedItems.has(item)).length;
  const anchoredMatched = anchored.filter((item) => matchedItems.has(item)).length;
  return {
    total: items.length,
    matched,
    recall: items.length > 0 ? matched / items.length : 1,
    anchoredTotal: anchored.length,
    anchoredMatched,
    anchoredRecall: anchored.length > 0 ? anchoredMatched / anchored.length : 1,
  };
}

export function evaluateAutoMap(fields: readonly AutoField[], truth: GroundTruth | { images: EvalItem[]; texts: Array<{ pageIndex: number; rect: NormRect }> }, options: EvalOptions): Metrics {
  const margin = options.margin ?? MATCH_MARGIN;
  const proposed = fields.filter((field) => options.tiers.includes(field.tier as "high" | "review"));
  const items: EvalItem[] = truth.images.map((image) => ({ pageIndex: image.pageIndex, rect: image.rect, kind: image.kind, anchoredToLine: (image as GtImage).anchoredToLine }));
  const structural = proposed.filter((field) => field.type === "initials" || field.type === "signature");
  const pairs = pair(items, structural, margin);
  const matchedItems = new Set(pairs.map((p) => items[p.item]));

  // Precision del nivel `high`: cada propuesta high (iniciales/firma) debe tener un elemento real compatible.
  const high = fields.filter((field) => field.tier === "high" && (field.type === "initials" || field.type === "signature"));
  const highPairs = pair(items, high, margin);
  const correctHigh = new Set(highPairs.map((p) => high[p.field]));
  const highByType = {
    initials: { proposals: high.filter((f) => f.type === "initials").length, correct: high.filter((f) => f.type === "initials" && correctHigh.has(f)).length },
    signature: { proposals: high.filter((f) => f.type === "signature").length, correct: high.filter((f) => f.type === "signature" && correctHigh.has(f)).length },
  };

  // Orden de las iniciales con dos firmantes: por pagina, el elemento real mas a la izquierda debe ser el firmante 1.
  let checked = 0;
  let ok = 0;
  if (options.signers === 2) {
    const pageIndexes = new Set(items.filter((i) => i.kind === "initials").map((i) => i.pageIndex));
    for (const pageIndex of pageIndexes) {
      const onPage = pairs
        .map((p) => ({ item: items[p.item], field: structural[p.field] }))
        .filter((m) => m.item.pageIndex === pageIndex && m.item.kind === "initials" && m.field.type === "initials" && m.field.signerIndex !== undefined);
      if (onPage.length < 2) continue;
      onPage.sort((a, b) => center(a.item.rect).x - center(b.item.rect).x);
      checked += 1;
      if (onPage.every((m, index) => m.field.signerIndex === index)) ok += 1;
    }
  }

  const positionErrors = pairs.map((p) => p.distance);
  const live = fields.filter((field) => field.tier !== "ignore");
  const pageCounts = new Map<number, number>();
  for (const field of live) pageCounts.set(field.pageIndex, (pageCounts.get(field.pageIndex) ?? 0) + 1);
  const counts = [...pageCounts.values()];

  const textFields = proposed.filter((field) => field.type === "text" || field.type === "date");
  const covered = truth.texts.filter((text) => {
    const c = center(text.rect);
    return textFields.some((field) => field.pageIndex === text.pageIndex && inside(c, { x: field.rect.x, y: field.rect.y, width: field.rect.width, height: field.rect.height }, margin));
  }).length;

  return {
    initials: kindMetrics(items.filter((i) => i.kind === "initials"), matchedItems),
    signature: kindMetrics(items.filter((i) => i.kind === "signature"), matchedItems),
    either: kindMetrics(items.filter((i) => i.kind === "either"), matchedItems),
    highPrecision: {
      proposals: high.length,
      correct: correctHigh.size,
      precision: high.length > 0 ? correctHigh.size / high.length : 1,
    },
    highByType,
    initialsOrder: { checked, ok },
    meanPositionError: positionErrors.length > 0 ? positionErrors.reduce((a, b) => a + b, 0) / positionErrors.length : 0,
    perPage: { max: counts.length > 0 ? Math.max(...counts) : 0, mean: counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0 },
    text: { total: truth.texts.length, covered, recall: truth.texts.length > 0 ? covered / truth.texts.length : 1 },
    details: {
      missed: items
        .filter((item) => !matchedItems.has(item))
        .map((item) => ({ page: item.pageIndex + 1, kind: item.kind, anchored: Boolean(item.anchoredToLine), x: r3(item.rect.x), y: r3(item.rect.y), w: r3(item.rect.width), h: r3(item.rect.height) })),
      falseHigh: high
        .filter((field) => !correctHigh.has(field))
        .map((field) => ({ page: field.pageIndex + 1, type: field.type, signer: field.signerIndex, x: r3(field.rect.x), y: r3(field.rect.y), w: r3(field.rect.width), h: r3(field.rect.height) })),
    },
  };
}
