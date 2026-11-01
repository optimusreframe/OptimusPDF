/**
 * Resolucion de candidatos a VALORES finales: confianza, nivel (`high`/`review`), fusion de repetidos, conflictos entre valores
 * distintos de una misma clave y orden de salida. Puro y determinista (misma entrada, misma salida, mismos `id`).
 *
 * Reglas (precision primero):
 *   - `high` solo con etiqueta clara, formato valido, confianza >= 0,85 y sin ninguna bandera de revision;
 *   - dos valores DISTINTOS para la misma clave -> todos `review`, el de mayor confianza primero;
 *   - el mismo valor visto varias veces (p. ej. el nombre en cada pagina) es UN valor, con la mejor evidencia;
 *   - un valor con etiqueta debil («Name:») no compite con uno de etiqueta clara; un valor libre no compite con uno con etiqueta.
 */

import { fold, clip } from "@/lib/autofill/text";
import { reasonFor, type ReasonFlag } from "@/lib/autofill/reasons";
import type { Candidate, Flag } from "@/lib/autofill/rules";
import type { ExtractedValue } from "@/lib/autofill/types";

export const HIGH_CONFIDENCE = 0.85;
const REVIEW_MAX = 0.84;
const HIGH_MAX = 0.98;
export const MAX_VALUES_PER_KEY = 4;

/** Banderas que nunca dejan pasar un valor como `high`. */
const BLOCKING: ReadonlySet<Flag> = new Set<Flag>(["ambiguous-date", "single-word", "lowercase", "margin", "ocr-low", "generic-mailbox", "multi-name", "unlabeled"]);

/** Techo de confianza por clave: lo que se lee de un nombre o una direccion se equivoca mas que un correo con formato valido. */
const KEY_CEILING: Record<string, number> = { insuredName1: 0.95, insuredName2: 0.95, address: 0.95, insurer: 0.95, claimType: 0.93, lossDate: 0.96, policyNumber: 0.97, claimNumber: 0.97, phone: 0.98, email: 0.98 };

const LAYOUT_FACTOR: Record<Candidate["layout"], number> = { inline: 1, right: 0.98, below: 0.95, free: 1 };

/** Orden estable de las claves en la salida. */
const KEY_ORDER = ["insuredName1", "insuredName2", "address", "phone", "email", "insurer", "policyNumber", "claimNumber", "claimType", "lossDate"];

type Scored = {
  candidate: Candidate;
  confidence: number;
  repeats: number;
  flags: ReasonFlag[];
};

function score(candidate: Candidate): { confidence: number; flags: ReasonFlag[] } {
  let confidence = candidate.labelWeight * candidate.valueStrength * LAYOUT_FACTOR[candidate.layout];
  if (candidate.origin === "ocr") confidence *= 0.92;
  if (candidate.flags.includes("ocr-low")) confidence *= 0.85;
  if (candidate.flags.includes("margin")) confidence *= 0.8;
  if (candidate.flags.includes("generic-mailbox")) confidence *= 0.8;
  if (candidate.flags.includes("shared-surname")) confidence *= 0.95;
  if (!candidate.labeled) confidence = Math.min(confidence, 0.74);
  return { confidence: Math.max(0.05, Math.min(confidence, 0.99)), flags: [...candidate.flags] };
}

/** Clave de comparacion de un valor: sin tildes, mayusculas ni signos. */
function normal(value: string): string {
  return fold(value).replace(/[^a-z0-9]/g, "");
}

const tokensOf = (value: string): string[] => fold(value).split(/[^a-z0-9]+/).filter(Boolean);

/** ¿`short` esta contenido en `long` (mismas palabras, el mas corto es parte del mas largo)? Solo para nombres, direcciones y similares. */
function contained(short: string, long: string, key: string): boolean {
  if (normal(short) === normal(long)) return true;
  if (key === "address") {
    const a = normal(short);
    const b = normal(long);
    return a.length >= 6 && b.includes(a);
  }
  if (key === "insuredName1" || key === "insuredName2" || key === "insurer" || key === "claimType") {
    const a = tokensOf(short);
    const b = tokensOf(long);
    if (a.length < (key === "claimType" ? 1 : 2) || a.length >= b.length) return false;
    return a.every((token) => b.includes(token));
  }
  return false;
}

function better(a: Scored, b: Scored): Scored {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  return a.candidate.order <= b.candidate.order ? a : b;
}

function resolveKey(key: string, candidates: Candidate[]): Array<{ scored: Scored; conflict: boolean }> {
  let items: Scored[] = candidates.map((candidate) => ({ candidate, ...score(candidate), repeats: 1 }));

  // Un candidato claramente mas flojo (etiqueta debil o formato dudoso) no compite con uno solido.
  const base = (item: Scored): number => item.candidate.labelWeight * item.candidate.valueStrength;
  if (items.some((item) => item.candidate.labeled && base(item) >= HIGH_CONFIDENCE)) {
    items = items.filter((item) => base(item) >= 0.62 || items.some((other) => other !== item && normal(other.candidate.value) === normal(item.candidate.value)));
  }

  // Un valor libre no compite con uno que tiene etiqueta; uno de etiqueta debil, tampoco con uno de etiqueta clara.
  if (items.some((item) => item.candidate.labeled)) items = items.filter((item) => item.candidate.labeled || items.some((other) => other.candidate.labeled && normal(other.candidate.value) === normal(item.candidate.value)));
  const strongest = Math.max(...items.map((item) => (item.candidate.labeled ? item.candidate.labelWeight : 0)));
  if (strongest >= 0.9) items = items.filter((item) => !item.candidate.labeled || item.candidate.labelWeight >= 0.8 || items.some((other) => other !== item && normal(other.candidate.value) === normal(item.candidate.value)));

  // Fusion: iguales y contenidos (el valor mas completo gana, con la mejor evidencia).
  const merged: Scored[] = [];
  for (const item of items.sort((a, b) => b.confidence - a.confidence || a.candidate.order - b.candidate.order)) {
    const home = merged.find((other) => contained(item.candidate.value, other.candidate.value, key) || contained(other.candidate.value, item.candidate.value, key));
    if (!home) {
      merged.push({ ...item });
      continue;
    }
    const longer = normal(item.candidate.value).length > normal(home.candidate.value).length ? item : home;
    const winner = better(item, home);
    const index = merged.indexOf(home);
    merged[index] = {
      candidate:
        longer === winner
          ? winner.candidate
          : { ...longer.candidate, labeled: winner.candidate.labeled, labelWeight: Math.max(winner.candidate.labelWeight, longer.candidate.labelWeight), flags: winner.candidate.flags },
      confidence: winner.confidence,
      flags: winner.flags,
      repeats: home.repeats + 1,
    };
  }

  // Repetirse en varios sitios (nombre en cada pagina) refuerza un poco, sin pasar de un tope.
  for (const item of merged) item.confidence = Math.min(HIGH_MAX, item.confidence + Math.min(0.04, 0.02 * (item.repeats - 1)));

  const conflict = merged.length > 1;
  return merged
    .sort((a, b) => b.confidence - a.confidence || a.candidate.order - b.candidate.order)
    .slice(0, MAX_VALUES_PER_KEY)
    .map((scored) => ({ scored, conflict }));
}

/** Candidatos de todas las fuentes -> valores finales ordenados por clave y confianza. */
export function resolveCandidates(candidates: readonly Candidate[], locale: "es" | "en"): ExtractedValue[] {
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byKey.get(candidate.key);
    if (list) list.push(candidate);
    else byKey.set(candidate.key, [candidate]);
  }
  const keys = [...byKey.keys()].sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a);
    const ib = KEY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  const out: ExtractedValue[] = [];
  for (const key of keys) {
    for (const { scored, conflict } of resolveKey(key, byKey.get(key) ?? [])) {
      const { candidate } = scored;
      const flags: ReasonFlag[] = [...scored.flags];
      if (conflict) flags.push("conflict");
      const blocked = candidate.flags.some((flag) => BLOCKING.has(flag)) || conflict || !candidate.labeled;
      const high = !blocked && scored.confidence >= HIGH_CONFIDENCE;
      const ceiling = Math.min(HIGH_MAX, KEY_CEILING[key] ?? HIGH_MAX);
      const confidence = high ? Math.min(ceiling, scored.confidence) : Math.min(REVIEW_MAX, scored.confidence);
      out.push({
        id: `ev-${out.length}`,
        key,
        value: candidate.value,
        confidence: Math.round(confidence * 100) / 100,
        tier: high ? "high" : "review",
        reason: reasonFor(candidate, locale, flags),
        evidence: {
          sourceIndex: candidate.sourceIndex,
          pageIndex: candidate.pageIndex,
          snippet: clip(candidate.snippet, 120),
          origin: candidate.origin,
        },
      });
    }
  }
  return out;
}
