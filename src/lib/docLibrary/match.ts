import { estimateJaccard, hammingDistance } from "./fingerprintCore";
import {
  MATCH_THRESHOLDS,
  type Fingerprint,
  type MatchLevel,
  type MatchResult,
  type PageFingerprint,
  type PageMatch,
  type PageSize,
} from "./types";

/**
 * Comparación de huellas (plan §3 Fase 2 «Reconocer el documento al cargarlo»). Puro y determinista.
 *
 * Roles: `doc` es el documento que la persona acaba de cargar; `template` es el guardado en la biblioteca. Todo el
 * resultado se expresa en páginas de la PLANTILLA (`pageMatches`, `mappedPages`, `reviewPages`), porque lo que se aplica
 * son los campos de la plantilla, y cada uno vive en una página de ella.
 *
 * Reglas:
 *  - `exact`: mismos bytes (SHA-256).
 *  - `match` («Coincide», se aplica sola con aviso deshacible): MISMO número de páginas, tamaños de página dentro de
 *    ±1 pt y Jaccard ≥ 0,90 (o dHash ≤ 10 bits) en TODAS las páginas.
 *  - `similar` («Parece la plantilla X (85 %)», pregunta): la media de similitudes de página (repartida entre el mayor
 *    número de páginas de los dos) es ≥ 0,75 (`documentSimilar`) sin cumplir `match`. Con distinto número de páginas
 *    nunca pasa de `similar`. Una página solo entra en la media si su similitud es ≥ 0,70.
 *  - Una página comparada por IMAGEN (escaneado) impide `match`: como mucho `similar` (la imagen de 64 bits no distingue
 *    páginas de texto parecidas).
 *  - `none`: la media < 0,75, o no se puede comparar (huella parcial, sin páginas, versión de algoritmo distinta).
 *  - Por página: una página con similitud < 0,70, sin página correspondiente o de otro tamaño NO se aplica sola
 *    (`review`, `documentPage: null`, `similarity: 0`). Con el mismo número de páginas se emparejan por posición; con
 *    distinto número, por un alineamiento que conserva el orden (una página añadida o quitada no desplaza el resto).
 */

const LEVEL_RANK: Record<MatchLevel, number> = { none: 0, similar: 1, match: 2, exact: 3 };

/** Rango de un nivel (para ordenar): `none` < `similar` < `match` < `exact`. */
export function matchLevelRank(level: MatchLevel): number {
  return LEVEL_RANK[level];
}

/** ¿Dos tamaños de página son «el mismo» (±1 pt en ancho y alto)? */
export function sameSize(a: PageSize, b: PageSize): boolean {
  return (
    Math.abs(a.width - b.width) <= MATCH_THRESHOLDS.pageSizeTolerance &&
    Math.abs(a.height - b.height) <= MATCH_THRESHOLDS.pageSizeTolerance
  );
}

/** Similitud 0..1 de dos páginas escaneadas a partir de la distancia de Hamming (10 bits = 0,90; 20 bits = 0,70). */
export function dhashSimilarity(bits: number): number {
  if (!Number.isFinite(bits)) return 0;
  if (bits <= MATCH_THRESHOLDS.dhashMatchBits) return 1 - bits / 100;
  if (bits <= MATCH_THRESHOLDS.dhashSimilarBits) return 0.9 - (bits - MATCH_THRESHOLDS.dhashMatchBits) * 0.02;
  return Math.max(0, 0.7 - (bits - MATCH_THRESHOLDS.dhashSimilarBits) * 0.0175);
}

export type PageScore = { similarity: number; level: MatchLevel; kind: PageMatch["kind"]; identical: boolean };

const NO_SCORE: PageScore = { similarity: 0, level: "none", kind: "none", identical: false };

function levelOf(similarity: number): MatchLevel {
  if (similarity >= MATCH_THRESHOLDS.match) return "match";
  if (similarity >= MATCH_THRESHOLDS.similar) return "similar";
  return "none";
}

/** Similitud de dos páginas (sin mirar tamaños). Texto con texto, imagen con imagen; lo demás no se compara. */
export function comparePages(doc: PageFingerprint | undefined, template: PageFingerprint | undefined): PageScore {
  if (!doc || !template) return NO_SCORE;
  const docText = doc.textHash !== "";
  const templateText = template.textHash !== "";
  if (docText && templateText) {
    if (doc.textHash === template.textHash) return { similarity: 1, level: "exact", kind: "text", identical: true };
    const similarity = estimateJaccard(doc.minhash, template.minhash);
    return { similarity, level: levelOf(similarity), kind: "text", identical: false };
  }
  if (!docText && !templateText && doc.dhash !== undefined && template.dhash !== undefined) {
    const bits = hammingDistance(doc.dhash, template.dhash);
    const similarity = dhashSimilarity(bits);
    const level: MatchLevel =
      bits === 0
        ? "exact"
        : bits <= MATCH_THRESHOLDS.dhashMatchBits
          ? "match"
          : bits <= MATCH_THRESHOLDS.dhashSimilarBits
            ? "similar"
            : "none";
    return { similarity, level, kind: "image", identical: bits === 0 };
  }
  return NO_SCORE;
}

/** Emparejamiento página a página de la PLANTILLA con el documento: `pairs[t] = índice en doc | null`. */
function alignPages(doc: Fingerprint, template: Fingerprint): Array<number | null> {
  const n = doc.pages.length;
  const m = template.pages.length;
  const score = (d: number, t: number): number => {
    if (!sameSize(doc.pageSizes[d], template.pageSizes[t])) return -1;
    const result = comparePages(doc.pages[d], template.pages[t]);
    return result.similarity >= MATCH_THRESHOLDS.similar ? result.similarity : -1;
  };
  const pairs: Array<number | null> = new Array(m).fill(null);
  if (n === m) {
    // Mismo número de páginas: por posición (lo normal: el mismo contrato re-exportado).
    for (let index = 0; index < m; index += 1) if (score(index, index) >= 0) pairs[index] = index;
    return pairs;
  }
  // Distinto número de páginas: alineamiento que conserva el orden (como la subsecuencia común más larga, pesada).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cells: number[][] = Array.from({ length: n }, (_, d) => Array.from({ length: m }, (__, t) => score(d, t)));
  for (let d = 1; d <= n; d += 1) {
    for (let t = 1; t <= m; t += 1) {
      let best = Math.max(dp[d - 1][t], dp[d][t - 1]);
      const pair = cells[d - 1][t - 1];
      if (pair >= 0) best = Math.max(best, dp[d - 1][t - 1] + pair);
      dp[d][t] = best;
    }
  }
  let d = n;
  let t = m;
  while (d > 0 && t > 0) {
    const pair = cells[d - 1][t - 1];
    if (pair >= 0 && dp[d][t] === dp[d - 1][t - 1] + pair) {
      pairs[t - 1] = d - 1;
      d -= 1;
      t -= 1;
    } else if (dp[d][t] === dp[d - 1][t]) {
      d -= 1;
    } else {
      t -= 1;
    }
  }
  return pairs;
}

function none(reason: MatchResult["reason"], templatePages: number): MatchResult {
  return {
    level: "none",
    similarity: 0,
    percent: 0,
    ...(reason ? { reason } : {}),
    pageMatches: Array.from({ length: templatePages }, (_, templatePage) => ({
      templatePage,
      documentPage: null,
      similarity: 0,
      level: "none" as const,
      kind: "none" as const,
      identical: false,
      review: true,
    })),
    mappedPages: new Array<number | null>(templatePages).fill(null),
    reviewPages: Array.from({ length: templatePages }, (_, index) => index),
  };
}

/** Compara el documento cargado (`doc`) con una plantilla guardada (`template`). Ver las reglas arriba. */
export function compareFingerprints(doc: Fingerprint, template: Fingerprint): MatchResult {
  if (doc.version !== template.version) return none("version", template.pageCount);
  if (doc.exact !== "" && doc.exact === template.exact && doc.pageCount === template.pageCount) {
    const pageMatches: PageMatch[] = Array.from({ length: template.pageCount }, (_, index) => ({
      templatePage: index,
      documentPage: index,
      similarity: 1,
      level: "exact",
      kind: template.pages[index] ? (template.pages[index].textHash !== "" ? "text" : "image") : "none",
      identical: true,
      review: false,
    }));
    return {
      level: "exact",
      similarity: 1,
      percent: 100,
      pageMatches,
      mappedPages: pageMatches.map((_, index) => index),
      reviewPages: [],
    };
  }
  if (doc.partial || template.partial) return none("partial", template.pageCount);
  if (doc.pages.length === 0 || template.pages.length === 0) return none("empty", template.pageCount);

  const pairs = alignPages(doc, template);
  const pageMatches: PageMatch[] = pairs.map((documentPage, templatePage) => {
    if (documentPage === null) {
      return { templatePage, documentPage: null, similarity: 0, level: "none", kind: "none", identical: false, review: true };
    }
    const result = comparePages(doc.pages[documentPage], template.pages[templatePage]);
    return {
      templatePage,
      documentPage,
      similarity: result.similarity,
      level: result.level,
      kind: result.kind,
      identical: result.identical,
      review: result.level === "similar" || result.level === "none",
    };
  });

  const total = Math.max(doc.pages.length, template.pages.length);
  const mean = pageMatches.reduce((sum, page) => sum + page.similarity, 0) / total;
  const samePages = doc.pages.length === template.pages.length;
  const everyPageMatches = pageMatches.every((page) => page.level === "match" || page.level === "exact");
  let level: MatchLevel = "none";
  // Un escaneado se reconoce por la imagen (dHash de 64 bits a 32×32), que NO distingue páginas de texto parecidas:
  // medido con escaneados sintéticos distintos, ~55 % de los pares de páginas quedan a ≤ 10 bits. Por eso una página
  // comparada por imagen nunca llega a «Coincide» (no se aplica sola): como mucho «Parece» y se pregunta.
  const comparedByImage = pageMatches.some((page) => page.kind === "image");
  if (samePages && everyPageMatches && !comparedByImage) level = "match";
  else if (mean >= MATCH_THRESHOLDS.documentSimilar) level = "similar";

  const reviewPages = pageMatches.filter((page) => page.review).map((page) => page.templatePage);
  const byText = pageMatches.some((page) => page.kind === "text");
  const basis = byText ? (comparedByImage ? "mixed" : "text") : comparedByImage ? "image" : undefined;
  const rounded = Math.round(mean * 100);
  return {
    level,
    similarity: mean,
    // Solo «Coincide» puede decir 100 %: un «parece» se queda en 99 como mucho.
    percent: level === "match" ? rounded : Math.min(99, rounded),
    ...(level === "none" && !samePages ? { reason: "pages" as const } : {}),
    ...(basis ? { basis } : {}),
    pageMatches,
    mappedPages: pairs,
    reviewPages,
  };
}

/** Un candidato para `findBestMatch`: una plantilla (o documento) guardada con su huella. */
export type MatchCandidate = { id: string; fingerprint: Fingerprint; updatedAt: string };

/** Dos candidatos cuyas similitudes distan menos que esto (y del mismo nivel) cuentan como empatados («ambiguo»). */
export const AMBIGUOUS_MARGIN = 0.02;

/**
 * La mejor coincidencia de `fingerprint` entre `candidates`, o `null` si ninguna llega a `similar`.
 * Orden: nivel (exact > match > similar), similitud, `updatedAt` más reciente y por último el id. Si otro candidato
 * del mismo nivel queda a menos de `AMBIGUOUS_MARGIN`, `ambiguous: true` y sus ids en `alternatives`
 * (p. ej. varias plantillas con la misma huella: se elige la más reciente).
 */
export function findBestMatch(fingerprint: Fingerprint, candidates: readonly MatchCandidate[]): MatchResult | null {
  const scored = candidates
    .map((candidate) => ({ candidate, result: compareFingerprints(fingerprint, candidate.fingerprint) }))
    .filter((entry) => entry.result.level !== "none");
  if (scored.length === 0) return null;
  scored.sort(
    (a, b) =>
      LEVEL_RANK[b.result.level] - LEVEL_RANK[a.result.level] ||
      b.result.similarity - a.result.similarity ||
      (a.candidate.updatedAt < b.candidate.updatedAt ? 1 : a.candidate.updatedAt > b.candidate.updatedAt ? -1 : 0) ||
      (a.candidate.id < b.candidate.id ? -1 : 1),
  );
  const best = scored[0];
  const alternatives = scored
    .slice(1)
    .filter(
      (entry) =>
        entry.result.level === best.result.level && best.result.similarity - entry.result.similarity < AMBIGUOUS_MARGIN,
    )
    .map((entry) => entry.candidate.id);
  return {
    ...best.result,
    candidateId: best.candidate.id,
    ambiguous: alternatives.length > 0,
    alternatives,
  };
}
