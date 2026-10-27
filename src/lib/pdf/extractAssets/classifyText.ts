/**
 * Texto cercano a un elemento (U7.3): arma LINEAS con los trozos de texto de pdf.js, encuentra las etiquetas de firma e iniciales
 * (ES/EN: «Firma», «Signature», «Sign here», «Initials», «Iniciales», «X_____», «Firmante», «Insured», «Assured»...) y decide si
 * un rectangulo esta CERCA de una (a <= 2 lineas de texto). El diccionario es el del automapeo (`autoMapText.ts`): una palabra clave
 * solo cuenta como etiqueta si no es prosa (entre parentesis, ante dos puntos o subrayado, o en una frase corta).
 */

import { displayLabel, findLabelHits, foldKeepLength, normalizeLabelText, wordCount } from "@/lib/pdf/autoMapText";
import {
  NEAR_LABEL_LINES,
  NEAR_LABEL_MAX_DX_PT,
  type LabelFact,
  type PageFacts,
  type TextLine,
} from "./classifyTypes";

/** Trozo de texto de pdf.js en puntos de vista con el origen ABAJO-izquierda (`readPageTexts` de `autoMapCollect.ts`). */
export type RawTextPiece = { text: string; raw: string; left: number; right: number; baseline: number; height: number };

/** Une los trozos de una misma linea (misma base, sin hueco grande) en lineas de texto con el origen ARRIBA-izquierda. */
export function buildTextLines(pieces: ReadonlyArray<RawTextPiece>, viewHeight: number): TextLine[] {
  const sorted = [...pieces].sort((a, b) => b.baseline - a.baseline || a.left - b.left);
  const lines: TextLine[] = [];
  let current: { left: number; right: number; baseline: number; height: number; text: string } | null = null;
  const flush = (): void => {
    if (!current) return;
    const top = viewHeight - current.baseline - current.height * 0.85;
    lines.push({
      text: current.text,
      x: current.left,
      y: Math.max(0, top),
      width: Math.max(0, current.right - current.left),
      height: current.height,
    });
    current = null;
  };
  for (const piece of sorted) {
    const text = piece.raw.replace(/\s+/g, " ").trim().length > 0 ? piece.raw : piece.text;
    if (current && Math.abs(piece.baseline - current.baseline) <= Math.max(piece.height, current.height) * 0.35 && piece.left - current.right <= Math.max(piece.height, current.height) * 2.5) {
      const gap = piece.left - current.right;
      current.text += (gap > Math.max(piece.height, current.height) * 0.2 && !current.text.endsWith(" ") && !text.startsWith(" ") ? " " : "") + text;
      current.right = Math.max(current.right, piece.right);
      current.height = Math.max(current.height, piece.height);
      continue;
    }
    flush();
    current = { left: piece.left, right: piece.right, baseline: piece.baseline, height: piece.height, text };
  }
  flush();
  return lines.map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() })).filter((line) => line.text.length > 0);
}

/** Interlineado: una «linea» de texto mide el cuerpo por 1,2. */
export const LEADING = 1.2;

/** `X _____`: la raya de firma de los formularios en ingles. */
const X_LINE = /(^|\s)x\s*(?:_{2,}|\.{3,}|-{3,})/i;
/** Roles que firman: una etiqueta DEBIL (solo cuentan en una linea corta). */
const ROLE_LABEL = /\b(?:insured|assured|asegurad[oa]|contratante|tomador|policy ?holder|signer|firmante)\b/;
const ROLE_MAX_WORDS = 5;
/** «Autografo» / «autograph»: otra forma de decir firma (el diccionario del automapeo solo conoce «firma autografa» por la palabra «firma»). */
const AUTOGRAPH = /\bautograf[oa]s?\b|\bautograph\b/;
/** «Paraf» / «paraphe» / «parafo»: las iniciales en otros idiomas. */
const PARAF = /\b(?:paraphe?|parafo?|parafe)\b/;
/** «Firmado por:» / «Firmada por»: el diccionario del automapeo solo conoce «signed by» (con «by»). */
const FIRMADO_POR = /\bfirmad[oa] por\b/;
/** «Rubrica» es el rasgo que cierra la firma: unas iniciales para unos y la firma entera para otros. Se admite como las dos cosas. */
const RUBRICA = /\brubrica\b/;
/** Estas etiquetas cortas valen por si solas hasta esta longitud (una frase larga con «autografo» es prosa). */
const WORD_LABEL_MAX_WORDS = 5;

/** Etiquetas de firma o iniciales de las lineas de una pagina. */
export function findLabels(lines: ReadonlyArray<TextLine>): LabelFact[] {
  const found: LabelFact[] = [];
  for (const line of lines) {
    const folded = foldKeepLength(line.text);
    const phraseWords = wordCount(normalizeLabelText(line.text));
    let kind: LabelFact["kind"] | null = null;
    let strength = 0;
    for (const hit of findLabelHits(folded, phraseWords)) {
      if (hit.kind !== "signature" && hit.kind !== "initials") continue;
      if (hit.strength > strength || (hit.kind === "initials" && hit.strength === strength)) {
        kind = hit.kind;
        strength = hit.strength;
      }
    }
    if (!kind && X_LINE.test(line.text)) {
      kind = "signature";
      strength = 1;
    }
    if (!kind && phraseWords <= ROLE_MAX_WORDS && ROLE_LABEL.test(folded)) {
      kind = "signature";
      strength = 0.5;
    }
    if (!kind && phraseWords <= ROLE_MAX_WORDS && FIRMADO_POR.test(folded)) {
      kind = "signature";
      strength = 0.9;
    }
    if (!kind && phraseWords <= WORD_LABEL_MAX_WORDS && AUTOGRAPH.test(folded)) {
      kind = "signature";
      strength = 0.8;
    }
    if (!kind && phraseWords <= WORD_LABEL_MAX_WORDS && PARAF.test(folded)) {
      kind = "initials";
      strength = 0.8;
    }
    if (!kind) continue;
    found.push({
      kind,
      strength,
      ...(kind === "initials" && RUBRICA.test(folded) ? { alsoSignature: true } : {}),
      text: displayLabel(line.text) || line.text,
      box: { x: line.x, y: line.y, width: line.width, height: line.height },
      lineHeight: Math.max(4, line.height * LEADING),
    });
  }
  return found;
}

export type NearLabel = { label: LabelFact; distance: number };

/**
 * La etiqueta mas cercana a `box` (puntos de vista, origen arriba-izquierda) a no mas de dos lineas de texto en vertical y
 * `NEAR_LABEL_MAX_DX_PT` puntos (a escala de carta) en horizontal. Una etiqueta DENTRO de la caja (firma sobre la raya) cuenta
 * con distancia 0.
 */
export function nearestLabel(
  box: { x: number; y: number; width: number; height: number },
  labels: ReadonlyArray<LabelFact>,
  pageWidth: number,
  kind?: LabelFact["kind"],
): NearLabel | null {
  let best: NearLabel | null = null;
  const maxDx = NEAR_LABEL_MAX_DX_PT * Math.max(0.5, pageWidth / 612);
  for (const label of labels) {
    if (kind && label.kind !== kind && !(kind === "signature" && label.alsoSignature)) continue;
    const lb = label.box;
    const dy = Math.max(0, lb.y - (box.y + box.height), box.y - (lb.y + lb.height));
    const dx = Math.max(0, lb.x - (box.x + box.width), box.x - (lb.x + lb.width));
    if (dy > NEAR_LABEL_LINES * label.lineHeight + 1 || dx > maxDx) continue;
    const distance = dy / label.lineHeight + dx / maxDx;
    if (!best || distance < best.distance || (distance === best.distance && label.strength > best.label.strength)) best = { label, distance };
  }
  return best;
}

/** Etiquetas de cada pagina (indexadas por pagina). */
export function labelsByPage(pages: ReadonlyArray<PageFacts>): Map<number, LabelFact[]> {
  const out = new Map<number, LabelFact[]>();
  for (const page of pages) out.set(page.pageIndex, findLabels(page.lines));
  return out;
}

/** Texto de la etiqueta para un motivo: «cerca de “Firma”». */
export function labelReason(label: LabelFact): string {
  const text = label.text.length > 36 ? `${label.text.slice(0, 36).trimEnd()}…` : label.text;
  return `cerca de «${text}»`;
}
