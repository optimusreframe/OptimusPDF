/*
 * Analisis de UNA pagina para el automapeo: frases de texto, etiquetas, rayas, asociacion etiqueta-raya, firmantes
 * y colocacion. Funcion PURA sobre `PageData` (sin pdf.js ni DOM): se prueba en Node con datos construidos a mano y
 * con PDFs sinteticos.
 *
 * Reglas (todas en «em», la unidad tipografica del documento; ver `autoMapLayout.ts` y la subseccion U2.8 del plan):
 *  - Una ETIQUETA es una palabra clave (firma, iniciales, fecha, nombre...) que no es prosa.
 *  - Una RAYA es un trazo/relleno fino horizontal, o una hilera de guiones bajos, aislada (no de una tabla).
 *  - Se asocian con tres relaciones: etiqueta a la izquierda de la raya («Firma: ____»), etiqueta DEBAJO de la raya
 *    (la leyenda de una linea de firma) y etiqueta ENCIMA de la raya. Cada raya sirve a una sola etiqueta.
 */

import {
  findFillSlots,
  mergeDashes,
  underscoreSegments,
  type RawText,
  type Seg,
} from "@/lib/pdf/detectSlots";
import type { PageData } from "@/lib/pdf/autoMapCollect";
import type { AutoFieldType, AutoSource, AutoTier } from "@/lib/pdf/autoMapTypes";
import {
  DATE_H_EM,
  INITIAL_MIN_W_EM,
  TEXT_H_EM,
  coverage,
  layoutInitials,
  layoutLine,
  layoutSignature,
  pageEm,
  type LayoutEnv,
  type Rect,
} from "@/lib/pdf/autoMapLayout";
import {
  dataKindOfLabel,
  displayLabel,
  findLabelHits,
  foldKeepLength,
  fieldTypeForKind,
  DATA_KINDS,
  roleOf,
  signerHintOf,
  wordCount,
  type LabelKind,
  type RoleKind,
} from "@/lib/pdf/autoMapText";

/* ------------------------------------------------------------------ *
 * Umbrales (en em salvo que se diga lo contrario)
 * ------------------------------------------------------------------ */

/** Una raya de firma/iniciales/fecha es FINA: hasta este grosor (pt en una carta; escala con el «em» de la pagina). */
export const LINE_MAX_THICKNESS_PT = 2.4;
/** Ancho minimo, en em de pagina, de una raya vectorial y de una hilera de guiones bajos. */
export const LINE_MIN_WIDTH_EM = 2.6;
export const UNDERSCORE_MIN_WIDTH_EM = 2.0;
/** Una raya mas ancha que esta fraccion de la pagina es un separador, no un hueco de firma. */
export const LINE_MAX_PAGE_FRACTION = 0.62;
/** Distancia horizontal maxima etiqueta-raya cuando la etiqueta esta a su izquierda. */
export const RIGHT_GAP_MAX_EM: Record<LabelKind, number> = {
  initials: 7,
  signature: 14,
  date: 9,
  name: 14,
  phone: 9,
  address: 9,
  email: 9,
  claim: 9,
  policy: 9,
  insurer: 9,
  other: 9,
};
/** Etiqueta DEBAJO de la raya: distancia vertical maxima entre la raya y el borde superior de la etiqueta. */
export const BELOW_LABEL_MAX_GAP_EM = 2.4;
/** Etiqueta ENCIMA de la raya: distancia vertical maxima entre el borde inferior de la etiqueta y la raya. */
export const ABOVE_LABEL_MAX_GAP_EM = 3.4;
const SAME_ROW_EM = 1.3;
const PHRASE_BREAK_EM = 1.4;
const SAME_BASELINE_EM = 0.35;
/** Solapamiento minimo, en fraccion del ancho de la etiqueta, para alinear una etiqueta con la raya de arriba o abajo. */
const ALIGN_MIN_OVERLAP = 0.4;
/** Una casilla vacia de iniciales: tamano en em. */
const BOX_MIN_W_EM = 2.2;
const BOX_MAX_W_EM = 12;
const BOX_MIN_H_EM = 1.4;
const BOX_MAX_H_EM = 4.6;

/* ------------------------------------------------------------------ *
 * Modelo interno
 * ------------------------------------------------------------------ */

export type Phrase = {
  items: number[];
  folded: string;
  /** Mismo texto que `folded` con las mayusculas originales (mismos indices). */
  rawText: string;
  display: string;
  left: number;
  right: number;
  baseline: number;
  height: number;
  /** Posicion x del borde izquierdo de cada caracter de `folded` y la del borde derecho. */
  xs: number[];
  xe: number[];
  words: number;
};

export type Anchor = {
  kind: LabelKind;
  strength: number;
  /** Rango x de la palabra clave y fin de la etiqueta completa (incluye «of Policyholder»). */
  x0: number;
  x1: number;
  labelRight: number;
  phraseLeft: number;
  phraseRight: number;
  baseline: number;
  height: number;
  text: string;
  role: RoleKind;
  hint: 0 | 1 | undefined;
  phrase: number;
  items: number[];
};

export type LineInfo = {
  x0: number;
  x1: number;
  y: number;
  thickness: number;
  /** Indice del texto del que sale (guiones bajos) o -1. */
  fromText: number;
  dashed: boolean;
  /** Casilla vacia que hace de raya de iniciales (borde inferior). */
  box?: Rect;
};

export type Relation = "right" | "above" | "below";

export type Assoc = { anchor: Anchor; line: LineInfo; relation: Relation; cost: number };

export type ReasonCode =
  | "label-line-right"
  | "label-line-above"
  | "label-line-below"
  | "label-slots"
  | "label-box"
  | "label-only"
  | "geometry-line"
  | "text-slot"
  | "repetition";

export type Candidate = {
  pageIndex: number;
  type: AutoFieldType;
  signerIndex?: 0 | 1;
  /** Orden de lectura dentro de un grupo de iniciales de un mismo anfitrion (0 = izquierda). */
  slotOrder?: number;
  rect: Rect;
  label?: string;
  labelKind?: LabelKind;
  role?: RoleKind;
  source: AutoSource;
  reasonCode: ReasonCode;
  tier: AutoTier;
  confidence: number;
  /** Raya anfitriona (para deduplicar y agrupar por repeticion). */
  host?: { x0: number; x1: number; y: number };
  /** Marcas del analisis: `covers-text`, `blocked`, `tight`, `company`, `extra-signer`, `no-signer`. */
  notes: string[];
};

export type RepeatPoint = {
  pageIndex: number;
  x0: number;
  x1: number;
  y: number;
  /** Rect propuesto para iniciales con 1 y con N firmantes (se recalcula al agrupar). */
  line: LineInfo;
};

export type PageAnalysis = {
  pageIndex: number;
  width: number;
  height: number;
  hasText: boolean;
  candidates: Candidate[];
  /** Rayas cortas sin etiqueta que podrian ser iniciales (se agrupan por repeticion entre paginas). */
  unlabeledShortLines: RepeatPoint[];
  /** Cuadros de texto de la pagina (para comprobar solapes de candidatos creados despues). */
  textBoxes: Rect[];
  signatureLines: number;
  initialsHosts: number;
  complex: boolean;
};

/* ------------------------------------------------------------------ *
 * Frases
 * ------------------------------------------------------------------ */

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Une los fragmentos de texto de una misma linea en frases (separadas por huecos de mas de `PHRASE_BREAK_EM`). */
export function buildPhrases(texts: readonly RawText[]): Phrase[] {
  const order = texts.map((_, index) => index).sort((a, b) => texts[b].baseline - texts[a].baseline || texts[a].left - texts[b].left);
  const rows: number[][] = [];
  for (const index of order) {
    const item = texts[index];
    const row = rows.find((candidate) => {
      const ref = texts[candidate[0]];
      return Math.abs(ref.baseline - item.baseline) <= SAME_BASELINE_EM * Math.max(ref.height, item.height);
    });
    if (row) row.push(index);
    else rows.push([index]);
  }
  const phrases: Phrase[] = [];
  for (const row of rows) {
    row.sort((a, b) => texts[a].left - texts[b].left);
    let group: number[] = [];
    const flush = () => {
      if (group.length === 0) return;
      phrases.push(makePhrase(group, texts));
      group = [];
    };
    for (const index of row) {
      const previous = group[group.length - 1];
      if (
        previous !== undefined &&
        (texts[index].left - texts[previous].right > PHRASE_BREAK_EM * Math.max(texts[previous].height, texts[index].height) ||
          /_{3,}/.test(texts[previous].raw) ||
          /^\s*_{3,}/.test(texts[index].raw))
      ) {
        flush();
      }
      group.push(index);
    }
    flush();
  }
  return phrases;
}

function makePhrase(group: number[], texts: readonly RawText[]): Phrase {
  let folded = "";
  let rawText = "";
  const xs: number[] = [];
  const xe: number[] = [];
  let display = "";
  let height = 0;
  let baselineSum = 0;
  for (const index of group) {
    const item = texts[index];
    const previous = texts[group[group.indexOf(index) - 1] ?? -1];
    if (previous && folded.length > 0) {
      const gap = item.left - previous.right;
      const needsSpace = gap > 0.12 * Math.max(previous.height, item.height, 1) && !/\s$/.test(folded) && !/^\s/.test(item.raw);
      if (needsSpace) {
        folded += " ";
        rawText += " ";
        xs.push(previous.right);
        xe.push(item.left);
        display += " ";
      }
    }
    const fragment = foldKeepLength(item.raw);
    const rawChars = Array.from(item.raw);
    const count = Math.max(fragment.length, 1);
    const width = item.right - item.left;
    for (let k = 0; k < fragment.length; k += 1) {
      folded += fragment[k];
      rawText += rawChars[k] ?? fragment[k];
      xs.push(item.left + (k / count) * width);
      xe.push(item.left + ((k + 1) / count) * width);
    }
    display += item.raw;
    height = Math.max(height, item.height);
    baselineSum += item.baseline;
  }
  const first = texts[group[0]];
  const last = texts[group[group.length - 1]];
  return {
    items: group,
    folded,
    rawText,
    display: display.replace(/\s+/g, " ").trim(),
    left: first.left,
    right: last.right,
    baseline: baselineSum / group.length,
    height,
    xs,
    xe,
    words: wordCount(folded),
  };
}

/** Texto en x de un indice de `folded`. */
function xAt(phrase: Phrase, index: number, side: "start" | "end"): number {
  if (phrase.xs.length === 0) return phrase.left;
  const i = Math.min(Math.max(index, 0), phrase.xs.length - 1);
  return side === "start" ? phrase.xs[i] : phrase.xe[i];
}

/** Hasta donde llega la etiqueta (la palabra clave mas su «of Policyholder», «Owner/Agent»...), sin pasar de un subrayado. */
function labelEndIndex(phrase: Phrase, hitEnd: number): number {
  const folded = phrase.folded;
  let end = hitEnd;
  let limit = hitEnd + 30;
  limit = Math.min(limit, folded.length);
  while (end < limit && /[a-z0-9 ()/.,'&-]/.test(folded[end])) {
    if (folded[end] === "." && /^\.{3,}/.test(folded.slice(end))) break;
    if (folded[end] === "(" && /^\(\s*_/.test(folded.slice(end))) break;
    end += 1;
  }
  if (end < folded.length && folded[end] === ":") end += 1;
  return end;
}

export function buildAnchors(phrases: readonly Phrase[]): Anchor[] {
  const anchors: Anchor[] = [];
  phrases.forEach((phrase, phraseIndex) => {
    const hits = findLabelHits(phrase.folded, phrase.words);
    hits.forEach((hit, order) => {
      const previous = hits[order - 1];
      const next = hits[order + 1];
      const labelStart = previous ? previous.end : 0;
      const labelStop = next ? next.start : phrase.folded.length;
      // Texto de la propia etiqueta: lo que hay entre la etiqueta anterior y la siguiente de la misma frase.
      const endIndex = Math.min(labelEndIndex(phrase, hit.end), labelStop);
      const x0 = xAt(phrase, hit.start, "start");
      const x1 = xAt(phrase, hit.end - 1, "end");
      const labelRight = Math.max(x1, xAt(phrase, endIndex - 1, "end"));
      const before = phrase.folded.slice(Math.max(labelStart, hit.start - 30), hit.start);
      const after = phrase.folded.slice(hit.end, Math.min(labelStop, hit.end + 36));
      // La fecha no hereda rol ni numero de sus vecinas: se asigna por posicion junto a la firma.
      const usesContext = hit.kind === "initials" || hit.kind === "signature" || hit.kind === "name";
      const hint = usesContext ? signerHintOf(before) ?? signerHintOf(after) : undefined;
      const role = usesContext ? roleOf(`${before} ${phrase.folded.slice(hit.start, hit.end)} ${after}`) : "unknown";
      const rawLabel =
        hit.kind === "date"
          ? phrase.rawText.slice(hit.start, hit.end)
          : phrase.words <= 8 && !next && !previous
            ? phrase.display
            : phrase.rawText.slice(labelStart, endIndex);
      anchors.push({
        kind: hit.kind,
        strength: hit.strength,
        x0,
        x1,
        labelRight,
        phraseLeft: xAt(phrase, labelStart, "start"),
        phraseRight: labelRight,
        baseline: phrase.baseline,
        height: phrase.height,
        text: displayLabel(rawLabel),
        role,
        hint,
        phrase: phraseIndex,
        items: phrase.items,
      });
    });
  });
  return anchors;
}

/* ------------------------------------------------------------------ *
 * Rayas
 * ------------------------------------------------------------------ */

/** Funde rayas del mismo y que se tocan o se solapan (una raya dibujada a trozos o duplicada). */
export function mergeLines(lines: readonly LineInfo[], em: number): LineInfo[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const out: LineInfo[] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last && line.fromText < 0 && last.fromText < 0 && Math.abs(last.y - line.y) <= 0.12 * em + 0.4 && line.x0 <= last.x1 + 0.2 * em) {
      last.x1 = Math.max(last.x1, line.x1);
      last.thickness = Math.max(last.thickness, line.thickness);
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

export function buildLines(data: PageData, em: number): { lines: LineInfo[]; underscoreSegs: Seg[] } {
  const sc = em / 11;
  const maxThickness = Math.max(LINE_MAX_THICKNESS_PT * sc, 1.2);
  const underscoreSegs = underscoreSegments(data.texts);
  const lines: LineInfo[] = [];
  const maxWidth = LINE_MAX_PAGE_FRACTION * data.width;
  const push = (seg: Seg, minWidth: number) => {
    const width = seg.x1 - seg.x0;
    if (width < minWidth || width > maxWidth || seg.thickness > maxThickness) return;
    lines.push({ x0: seg.x0, x1: seg.x1, y: seg.y, thickness: seg.thickness, fromText: seg.fromText, dashed: Boolean(seg.dashed) });
  };
  for (const seg of data.segments) push(seg, LINE_MIN_WIDTH_EM * em);
  for (const seg of mergeDashes(data.dashes)) push(seg, LINE_MIN_WIDTH_EM * em);
  for (const seg of underscoreSegs) push(seg, UNDERSCORE_MIN_WIDTH_EM * em);
  return { lines: mergeLines(lines, em), underscoreSegs };
}

/** Una raya es borde de celda si hay verticales altas en sus dos extremos (tabla, no linea de firma). */
function isCellBorder(line: LineInfo, data: PageData, em: number): boolean {
  if (line.fromText >= 0) return false;
  const touchLeft = data.verticals.some((v) => Math.abs(v.x - line.x0) <= 0.6 * em && v.y0 <= line.y + 0.5 * em && v.y1 >= line.y + 1.2 * em);
  const touchRight = data.verticals.some((v) => Math.abs(v.x - line.x1) <= 0.6 * em && v.y0 <= line.y + 0.5 * em && v.y1 >= line.y + 1.2 * em);
  return touchLeft && touchRight;
}

/**
 * Una raya que forma parte de una cuadricula o pauta: muchas rayas paralelas, apiladas a paso regular, del mismo
 * largo y sin etiquetas propias (papel pautado, tablas de precios). Devuelve el conjunto de rayas que son pauta.
 */
export function ruledPaperLines(lines: readonly LineInfo[], em: number): Set<LineInfo> {
  const result = new Set<LineInfo>();
  const buckets = new Map<string, LineInfo[]>();
  for (const line of lines) {
    if (line.fromText >= 0) continue;
    const key = `${Math.round(line.x0 / (0.8 * em))}:${Math.round((line.x1 - line.x0) / (0.8 * em))}`;
    const list = buckets.get(key) ?? [];
    list.push(line);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    if (list.length < 5) continue;
    const ys = list.map((line) => line.y).sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const regular = gaps.filter((gap) => Math.abs(gap - median) <= 0.25 * median).length;
    if (regular >= 0.7 * gaps.length) for (const line of list) result.add(line);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Asociacion etiqueta-raya
 * ------------------------------------------------------------------ */

type AssociationEnv = {
  em: number;
  texts: readonly RawText[];
  phrases: readonly Phrase[];
};

function textBoxOf(item: RawText): Rect {
  return { x0: item.left, x1: item.right, y0: item.baseline - 0.22 * item.height, y1: item.baseline + 0.85 * item.height };
}

/** Hay texto ajeno (no de la propia etiqueta ni de la propia raya) dentro del rectangulo? */
function blockedByText(region: Rect, ignore: ReadonlySet<number>, env: AssociationEnv): boolean {
  if (region.x1 <= region.x0 || region.y1 <= region.y0) return false;
  for (let index = 0; index < env.texts.length; index += 1) {
    if (ignore.has(index)) continue;
    const box = textBoxOf(env.texts[index]);
    const w = Math.min(region.x1, box.x1) - Math.max(region.x0, box.x0);
    const h = Math.min(region.y1, box.y1) - Math.max(region.y0, box.y0);
    if (w > 0.2 * env.em && h > 0.25 * env.em) return true;
  }
  return false;
}

/** Candidatas de asociacion de una etiqueta con las rayas de la pagina. */
export function associationsFor(anchor: Anchor, lines: readonly LineInfo[], pageEnv: AssociationEnv): Assoc[] {
  // Las distancias etiqueta-raya se miden en la altura de la PROPIA etiqueta (con topes respecto a la pagina).
  const em = Math.min(Math.max(anchor.height, 0.65 * pageEnv.em), 1.7 * pageEnv.em);
  const env: AssociationEnv = { ...pageEnv, em };
  const out: Assoc[] = [];
  const own = new Set(anchor.items);
  const labelTop = anchor.baseline + 0.85 * anchor.height;
  const labelBottom = anchor.baseline - 0.25 * anchor.height;
  const labelCenter = (anchor.phraseLeft + anchor.phraseRight) / 2;
  const labelWidth = Math.max(anchor.phraseRight - anchor.phraseLeft, 0.001);
  for (const line of lines) {
    const ignore = new Set<number>(own);
    if (line.fromText >= 0) ignore.add(line.fromText);
    const width = line.x1 - line.x0;

    // a) etiqueta a la izquierda, en la misma fila
    const gap = line.x0 - anchor.labelRight;
    const dy = line.y - anchor.baseline;
    // Una casilla vacia cuenta como «misma fila» si el texto de la etiqueta cae dentro de su altura.
    const sameRow = line.box
      ? anchor.baseline >= line.box.y0 - 0.4 * em && anchor.baseline <= line.box.y1 + 0.2 * em
      : dy <= 0.45 * em && dy >= -0.95 * em;
    const rightOk = gap >= -0.35 * em && gap <= RIGHT_GAP_MAX_EM[anchor.kind] * em && line.x1 > anchor.labelRight + 0.5 * em;
    if (sameRow && rightOk) {
      const between: Rect = { x0: anchor.labelRight + 0.1 * em, x1: line.x0 - 0.1 * em, y0: anchor.baseline - 0.1 * em, y1: anchor.baseline + 0.6 * em };
      if (!blockedByText(between, ignore, env)) {
        out.push({ anchor, line, relation: "right", cost: Math.max(gap, 0) / em * 0.5 + (line.box ? 0.2 : Math.abs(dy + 0.15 * em) / em * 0.7) });
      }
    }

    // b) etiqueta DEBAJO de la raya (la leyenda de una linea de firma)
    const vgAbove = line.y - labelTop;
    const alignedBelow =
      overlap1d(anchor.phraseLeft, anchor.phraseRight, line.x0, line.x1) >= ALIGN_MIN_OVERLAP * Math.min(labelWidth, width) ||
      (anchor.phraseLeft >= line.x0 - 1.5 * em && anchor.phraseLeft <= line.x1);
    if (vgAbove >= -0.45 * em && vgAbove <= BELOW_LABEL_MAX_GAP_EM * em && alignedBelow) {
      const strip: Rect = { x0: Math.max(line.x0, anchor.phraseLeft), x1: Math.min(line.x1, anchor.phraseRight), y0: labelTop + 0.02 * em, y1: line.y - 0.05 * em };
      if (!blockedByText(strip, ignore, env)) {
        const center = (line.x0 + line.x1) / 2;
        out.push({ anchor, line, relation: "above", cost: Math.max(vgAbove, 0) / em * 0.9 + (Math.abs(labelCenter - center) / width) * 0.6 });
      }
    }

    // c) etiqueta ENCIMA de la raya (el rotulo de un campo; el hueco queda entre ambos)
    const vgBelow = labelBottom - line.y;
    const alignedAbove =
      overlap1d(anchor.phraseLeft, anchor.phraseRight, line.x0, line.x1) >= ALIGN_MIN_OVERLAP * Math.min(labelWidth, width) ||
      Math.abs(anchor.phraseLeft - line.x0) <= 2.5 * em;
    if (vgBelow >= 0.15 * em && vgBelow <= ABOVE_LABEL_MAX_GAP_EM * em && alignedAbove && anchor.kind !== "signature") {
      const strip: Rect = { x0: Math.max(line.x0, anchor.phraseLeft), x1: Math.min(line.x1, anchor.phraseRight), y0: line.y + 0.05 * em, y1: labelBottom - 0.02 * em };
      if (!blockedByText(strip, ignore, env)) {
        const center = (line.x0 + line.x1) / 2;
        out.push({ anchor, line, relation: "below", cost: 0.7 + vgBelow / em * 1.1 + (Math.abs(labelCenter - center) / width) * 0.6 });
      }
    }
    // Una firma con el rotulo encima ("Signature" y debajo la raya): menos frecuente, solo si esta pegado.
    if (vgBelow >= 0.15 * em && vgBelow <= 1.6 * em && alignedAbove && anchor.kind === "signature") {
      const strip: Rect = { x0: Math.max(line.x0, anchor.phraseLeft), x1: Math.min(line.x1, anchor.phraseRight), y0: line.y + 0.05 * em, y1: labelBottom - 0.02 * em };
      if (!blockedByText(strip, ignore, env)) {
        out.push({ anchor, line, relation: "below", cost: 1.4 + vgBelow / em * 1.3 });
      }
    }
  }
  return out;
}

/** Asignacion voraz por costo: cada raya a una sola etiqueta y cada etiqueta a una sola raya (o grupo de marcas). */
export function assignGreedy(all: readonly Assoc[]): Assoc[] {
  const sorted = [...all].sort((a, b) => a.cost - b.cost);
  const usedLines = new Set<LineInfo>();
  const usedAnchors = new Set<Anchor>();
  const chosen: Assoc[] = [];
  for (const assoc of sorted) {
    if (usedLines.has(assoc.line) || usedAnchors.has(assoc.anchor)) continue;
    usedLines.add(assoc.line);
    usedAnchors.add(assoc.anchor);
    chosen.push(assoc);
  }
  return chosen;
}

/**
 * Como `assignGreedy`, pero una raya larga puede rotular a varias etiquetas que quedan DEBAJO de ella y no se solapan
 * («Firma ......  Fecha» bajo una sola raya): cada etiqueta recibe el tramo de raya que tiene encima.
 */
export function assignSharing(all: readonly Assoc[], em: number): Assoc[] {
  const sorted = [...all].sort((a, b) => a.cost - b.cost);
  const byLine = new Map<LineInfo, Assoc[]>();
  const usedAnchors = new Set<Anchor>();
  for (const assoc of sorted) {
    if (usedAnchors.has(assoc.anchor)) continue;
    const present = byLine.get(assoc.line) ?? [];
    if (present.length > 0) {
      const shareable =
        assoc.relation === "above" &&
        present.every((other) => other.relation === "above") &&
        present.every((other) => assoc.anchor.phraseLeft >= other.anchor.phraseRight + 0.3 * em || assoc.anchor.phraseRight <= other.anchor.phraseLeft - 0.3 * em) &&
        assoc.cost <= 1.3;
      if (!shareable) continue;
    }
    present.push(assoc);
    byLine.set(assoc.line, present);
    usedAnchors.add(assoc.anchor);
  }
  const out: Assoc[] = [];
  for (const [line, group] of byLine) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    group.sort((a, b) => a.anchor.phraseLeft - b.anchor.phraseLeft);
    group.forEach((assoc, index) => {
      const next = group[index + 1];
      const x0 = index === 0 ? line.x0 : Math.max(line.x0, assoc.anchor.phraseLeft - 0.3 * em);
      const x1 = next ? Math.min(line.x1, next.anchor.phraseLeft - 1.0 * em) : line.x1;
      out.push({ ...assoc, line: { ...line, x0, x1: Math.max(x1, x0 + 2 * em) } });
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Firmantes
 * ------------------------------------------------------------------ */

type SigItem = { assoc: Assoc; signer?: 0 | 1 };

/**
 * Asigna firmante a las firmas de cliente sin pista explicita: filas con varias firmas (columnas) -> izquierda =
 * firmante 1, derecha = firmante 2; filas con una sola firma (apiladas) -> de arriba abajo.
 */
export function assignSigners(items: SigItem[], em: number): void {
  const pool = items.filter((item) => item.signer === undefined && item.assoc.anchor.role !== "company");
  if (pool.length === 0) return;
  const sorted = [...pool].sort((a, b) => b.assoc.line.y - a.assoc.line.y);
  const rows: SigItem[][] = [];
  for (const item of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate[0].assoc.line.y - item.assoc.line.y) <= SAME_ROW_EM * em);
    if (row) row.push(item);
    else rows.push([item]);
  }
  const hasColumns = rows.some((row) => row.length >= 2);
  // Indices ya tomados por pistas explicitas en la misma fila.
  const takenInRow = (row: SigItem[]) => new Set(items.filter((it) => it.signer !== undefined && Math.abs(it.assoc.line.y - row[0].assoc.line.y) <= SAME_ROW_EM * em).map((it) => it.signer));
  if (hasColumns) {
    for (const row of rows) {
      row.sort((a, b) => a.assoc.line.x0 - b.assoc.line.x0);
      const taken = takenInRow(row);
      let next = 0;
      for (const item of row) {
        while (taken.has(next as 0 | 1)) next += 1;
        item.signer = next <= 1 ? (next as 0 | 1) : undefined;
        next += 1;
      }
    }
    return;
  }
  const taken = new Set(items.filter((it) => it.signer !== undefined).map((it) => it.signer));
  let next = 0;
  for (const row of rows) {
    while (taken.has(next as 0 | 1)) next += 1;
    row[0].signer = next <= 1 ? (next as 0 | 1) : undefined;
    next += 1;
  }
}

/** Firmante mas probable de una linea (fecha, nombre) a partir de las firmas de la pagina: la de su fila a la izquierda o la de arriba. */
export function nearestSigner(line: LineInfo, sigs: readonly SigItem[], em: number): 0 | 1 | undefined {
  let best: { signer: 0 | 1 | undefined; cost: number } | null = null;
  for (const sig of sigs) {
    const s = sig.assoc.line;
    const dy = s.y - line.y;
    let cost: number | null = null;
    if (Math.abs(dy) <= SAME_ROW_EM * em && s.x0 <= line.x0 + 0.5 * em) cost = (line.x0 - s.x1) / em;
    else if (Math.abs(dy) <= SAME_ROW_EM * em) cost = 3 + Math.abs(s.x0 - line.x0) / em;
    else if (overlap1d(s.x0, s.x1, line.x0, line.x1) >= 0.3 * Math.min(s.x1 - s.x0, line.x1 - line.x0) && Math.abs(dy) <= 9 * em) cost = 4 + Math.abs(dy) / em;
    if (cost === null || cost < 0) continue;
    // La firma de la otra parte tambien cuenta: una fecha pegada a ella es de ella, no de un firmante.
    if (!best || cost < best.cost) best = { signer: sig.assoc.anchor.role === "company" ? undefined : sig.signer, cost };
  }
  return best?.signer;
}

/* ------------------------------------------------------------------ *
 * Casillas vacias de iniciales
 * ------------------------------------------------------------------ */

type BoxRange = { minW: number; maxW: number; minH: number; maxH: number };
const INITIALS_BOX: BoxRange = { minW: BOX_MIN_W_EM, maxW: BOX_MAX_W_EM, minH: BOX_MIN_H_EM, maxH: BOX_MAX_H_EM };
/** Un recuadro de firma: ancho y alto de una firma a mano (8-40 em de ancho, 2-9 em de alto). */
const SIGNATURE_BOX: BoxRange = { minW: 8, maxW: 40, minH: 2, maxH: 9 };

/** Casillas VACIAS (sin texto ni imagen dentro) de un tamano dado, como anfitrionas de iniciales o de firma. */
function emptyBoxes(data: PageData, em: number, range: BoxRange): LineInfo[] {
  const out: LineInfo[] = [];
  for (const box of data.boxes) {
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    if (w < range.minW * em || w > range.maxW * em || h < range.minH * em || h > range.maxH * em) continue;
    if (box.fill && !box.stroke && (box.shade ?? 0) < 0.97) continue; // celda sombreada de una tabla
    const interior: Rect = { x0: box.x0 + 0.1 * em, x1: box.x1 - 0.1 * em, y0: box.y0 + 0.1 * em, y1: box.y1 - 0.1 * em };
    const hasText = data.texts.some((t) => {
      const tb = textBoxOf(t);
      return Math.min(interior.x1, tb.x1) - Math.max(interior.x0, tb.x0) > 0.2 * em && Math.min(interior.y1, tb.y1) - Math.max(interior.y0, tb.y0) > 0.2 * em;
    });
    const hasImage = data.images.some((img) => Math.min(box.x1, img.x1) - Math.max(box.x0, img.x0) > 0.3 * w && Math.min(box.y1, img.y1) - Math.max(box.y0, img.y0) > 0.3 * h);
    if (hasText || hasImage) continue;
    out.push({ x0: box.x0, x1: box.x1, y: box.y0, thickness: 0.5, fromText: -1, dashed: false, box: { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 } });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Analisis de la pagina
 * ------------------------------------------------------------------ */

export type AnalyzeOptions = {
  signers: 1 | 2;
  /** Unidad de disposicion en pt (por defecto `pageEm` del ancho de la pagina). */
  em?: number;
};

const SLOT_GROUP_GAP_EM = 2.6;

/** Marcas de subrayado contiguas en la misma fila que la raya anfitriona («(____/____)»). */
function slotGroup(host: LineInfo, lines: readonly LineInfo[], em: number): LineInfo[] {
  if (host.fromText < 0) return [host];
  const row = lines
    .filter((l) => l.fromText === host.fromText && Math.abs(l.y - host.y) <= 0.3 * em)
    .sort((a, b) => a.x0 - b.x0);
  const index = row.indexOf(host);
  if (index < 0) return [host];
  const group = [host];
  for (let i = index + 1; i < row.length && row[i].x0 - group[group.length - 1].x1 <= SLOT_GROUP_GAP_EM * em; i += 1) group.push(row[i]);
  return group;
}

/** Rotulo de un hueco de texto, tomado de las frases de la pagina segun la relacion que reporto el detector de W6. */
function phraseLabelForSlot(
  kind: "left" | "above" | "below" | "right" | "inline",
  line: { x0: number; x1: number; y: number },
  phrases: readonly Phrase[],
  em: number,
): { text: string; cost: number } | undefined {
  let best: { phrase: Phrase; cost: number } | null = null;
  for (const phrase of phrases) {
    if (!/[a-z]/.test(phrase.folded)) continue;
    let cost: number | null = null;
    const overlaps = overlap1d(phrase.left, phrase.right, line.x0, line.x1) > 0 || Math.abs(phrase.left - line.x0) <= 3 * em;
    if (kind === "left" || kind === "inline") {
      if (Math.abs(phrase.baseline - line.y) <= 1.0 * em && phrase.right <= line.x0 + 1.0 * em) cost = Math.max(line.x0 - phrase.right, 0) / em + Math.abs(phrase.baseline - line.y) / em;
    } else if (kind === "above") {
      const gap = phrase.baseline - line.y;
      if (gap > 0.2 * em && gap <= 5 * em && overlaps) cost = gap / em;
    } else if (kind === "below") {
      const gap = line.y - phrase.baseline;
      if (gap > 0.2 * em && gap <= 3 * em && overlaps) cost = gap / em;
    } else if (Math.abs(phrase.baseline - line.y) <= 1.0 * em && phrase.left >= line.x1 - 0.5 * em) {
      cost = (phrase.left - line.x1) / em;
    }
    if (cost !== null && (!best || cost < best.cost)) best = { phrase, cost };
  }
  if (!best) return undefined;
  const words = best.phrase.display.split(" ").filter((word) => word.length > 0);
  const tail = words.length > 6 ? words.slice(-6).join(" ") : words.join(" ");
  const text = displayLabel(tail);
  return text.length > 0 ? { text, cost: best.cost } : undefined;
}

export function analyzePage(data: PageData, options: AnalyzeOptions): PageAnalysis {
  const { signers } = options;
  const em = options.em ?? pageEm(data.width);
  const env: LayoutEnv = { em, pageWidth: data.width, pageHeight: data.height };
  const textBoxes = data.texts.map(textBoxOf);
  const empty: PageAnalysis = {
    pageIndex: data.pageIndex,
    width: data.width,
    height: data.height,
    hasText: data.texts.length > 0,
    candidates: [],
    unlabeledShortLines: [],
    textBoxes,
    signatureLines: 0,
    initialsHosts: 0,
    complex: data.truncated,
  };
  if (data.texts.length === 0 || data.truncated) return empty;

  const phrases = buildPhrases(data.texts);
  const anchors = buildAnchors(phrases);
  const built = buildLines(data, em);
  const boxHosts = emptyBoxes(data, em, INITIALS_BOX);
  const signatureBoxes = emptyBoxes(data, em, SIGNATURE_BOX);
  const ruled = ruledPaperLines(built.lines, em);
  // Las rayas de pauta y los bordes de celda no son huecos de firma.
  const lines = built.lines.filter((line) => !ruled.has(line) && !isCellBorder(line, data, em));
  const assocEnv: AssociationEnv = { em, texts: data.texts, phrases };

  const candidates: Candidate[] = [];

  // Fase 1: las iniciales reclaman primero sus rayas (y las marcas contiguas «__/__»); luego firma, fecha y nombre
  // se reparten el resto de las rayas.
  const relevant = anchors.filter((a) => a.kind === "initials" || a.kind === "signature" || a.kind === "date" || a.kind === "name");
  const initialsAnchors = relevant.filter((a) => a.kind === "initials");
  const initialsAll: Assoc[] = [];
  for (const anchor of initialsAnchors) initialsAll.push(...associationsFor(anchor, [...lines, ...boxHosts], assocEnv));
  const chosenInitials = assignGreedy(initialsAll);
  const chosenOf = new Map<Anchor, Assoc>(chosenInitials.map((assoc) => [assoc.anchor, assoc]));
  const consumed = new Set<LineInfo>();
  for (const assoc of chosenInitials) for (const member of slotGroup(assoc.line, lines, em)) consumed.add(member);
  const free = lines.filter((line) => !consumed.has(line));
  const others: Assoc[] = [];
  for (const anchor of relevant) {
    if (anchor.kind === "initials") continue;
    others.push(...associationsFor(anchor, anchor.kind === "signature" ? [...free, ...signatureBoxes] : free, assocEnv));
  }
  const chosenOthers = assignSharing(others, em);
  const chosen = [...chosenInitials, ...chosenOthers];

  /* ---- firmas ---- */
  const sigItems: SigItem[] = chosen
    .filter((assoc) => assoc.anchor.kind === "signature")
    .map((assoc) => ({ assoc, signer: assoc.anchor.role === "company" ? undefined : assoc.anchor.hint }));
  assignSigners(sigItems, em);

  let signatureLines = 0;
  for (const item of sigItems) {
    const { assoc } = item;
    const layout = assoc.line.box
      ? { rect: assoc.line.box, blocked: false }
      : layoutSignature(assoc.line, env, textBoxes.filter((_, index) => index !== assoc.line.fromText && !assoc.anchor.items.includes(index)));
    const notes: string[] = [];
    if (layout.blocked) notes.push("blocked");
    if (assoc.anchor.role === "company") notes.push("company");
    if (item.signer === undefined && assoc.anchor.role !== "company") notes.push("no-signer");
    const quality = 1 - Math.min(assoc.cost, 3) / 6;
    candidates.push({
      pageIndex: data.pageIndex,
      type: "signature",
      signerIndex: item.signer,
      rect: layout.rect,
      label: assoc.anchor.text,
      labelKind: "signature",
      role: assoc.anchor.role,
      source: "label",
      reasonCode: assoc.line.box ? "label-box" : assoc.relation === "right" ? "label-line-right" : assoc.relation === "above" ? "label-line-above" : "label-line-below",
      tier: "high",
      confidence: 0.75 + 0.2 * assoc.anchor.strength * quality,
      host: { x0: assoc.line.x0, x1: assoc.line.x1, y: assoc.line.y },
      notes,
    });
    signatureLines += 1;
  }

  /* ---- iniciales ---- */
  let initialsHosts = 0;
  for (const anchor of initialsAnchors) {
    const assoc = chosenOf.get(anchor);
    const quality = assoc ? 1 - Math.min(assoc.cost, 3) / 6 : 0;
    if (assoc) {
      const group = slotGroup(assoc.line, lines, em);
      const host = {
        x0: group[0].x0,
        x1: group[group.length - 1].x1,
        y: assoc.line.y,
        box: assoc.line.box,
        slots: group.length >= 2 ? group.map((l) => ({ x0: l.x0, x1: l.x1 })) : undefined,
        fromText: assoc.line.fromText >= 0,
        labelRight: anchor.labelRight,
      };
      const layout = layoutInitials(host, signers, env);
      layout.rects.forEach((rect, order) => {
        const notes: string[] = [];
        if (layout.tight) notes.push("tight");
        candidates.push({
          pageIndex: data.pageIndex,
          type: "initials",
          signerIndex: order as 0 | 1,
          slotOrder: order,
          rect,
          label: anchor.text,
          labelKind: "initials",
          role: anchor.role,
          source: "label",
          reasonCode: assoc.line.box ? "label-box" : group.length >= 2 ? "label-slots" : assoc.relation === "right" ? "label-line-right" : assoc.relation === "above" ? "label-line-above" : "label-line-below",
          tier: "high",
          confidence: 0.75 + 0.2 * anchor.strength * quality,
          host: { x0: host.x0, x1: host.x1, y: host.y },
          notes,
        });
      });
      initialsHosts += 1;
      continue;
    }
    // Etiqueta de iniciales sin raya: hueco a su derecha (una sola senal debil).
    const x0 = anchor.labelRight + 0.3 * em;
    const host = { x0, x1: x0 + 2 * INITIAL_MIN_W_EM * em, y: anchor.baseline - 0.15 * em, fromText: true, labelRight: anchor.labelRight };
    const layout = layoutInitials(host, signers, env);
    layout.rects.forEach((rect, order) => {
      candidates.push({
        pageIndex: data.pageIndex,
        type: "initials",
        signerIndex: order as 0 | 1,
        slotOrder: order,
        rect,
        label: anchor.text,
        labelKind: "initials",
        role: anchor.role,
        source: "label",
        reasonCode: "label-only",
        tier: "review",
        confidence: 0.45 + 0.1 * anchor.strength,
        host: { x0: host.x0, x1: host.x1, y: host.y },
        notes: ["no-line"],
      });
    });
    initialsHosts += 1;
  }

  /* ---- fechas y nombres impresos ---- */
  for (const assoc of chosen) {
    const kind = assoc.anchor.kind;
    if (kind !== "date" && kind !== "name") continue;
    const signer = assoc.anchor.role === "company" ? undefined : assoc.anchor.hint ?? nearestSigner(assoc.line, sigItems, em);
    const rect = layoutLine(assoc.line, kind === "date" ? DATE_H_EM : TEXT_H_EM, env);
    const quality = 1 - Math.min(assoc.cost, 3) / 6;
    candidates.push({
      pageIndex: data.pageIndex,
      type: kind === "date" ? "date" : "text",
      signerIndex: signer,
      rect,
      label: assoc.anchor.text,
      labelKind: kind,
      role: assoc.anchor.role,
      source: "label",
      reasonCode: assoc.relation === "right" ? "label-line-right" : assoc.relation === "above" ? "label-line-above" : "label-line-below",
      tier: "high",
      confidence: 0.73 + 0.2 * assoc.anchor.strength * quality,
      host: { x0: assoc.line.x0, x1: assoc.line.x1, y: assoc.line.y },
      notes: assoc.anchor.role === "company" ? ["company"] : [],
    });
  }

  /* ---- campos de texto con etiqueta (reutiliza el detector conservador de W6) ---- */
  const claimedLines = candidates.map((c) => c.host).filter((h): h is { x0: number; x1: number; y: number } => Boolean(h));
  const slots = findFillSlots(
    {
      segments: [...data.segments, ...built.underscoreSegs],
      dashes: data.dashes,
      verticals: data.verticals,
      boxes: data.boxes,
      texts: data.texts,
      pageWidth: data.width,
      pageHeight: data.height,
    },
    12,
  );
  type SlotLabel = { text: string; cost: number };
  const textSlots: Array<{ slot: (typeof slots)[number]; line: { x0: number; x1: number; y: number }; label?: SlotLabel }> = [];
  for (const slot of slots) {
    const slotLine = { x0: slot.box.x, x1: slot.box.x + slot.box.width, y: slot.box.y };
    const taken = claimedLines.some((h) => Math.abs(h.y - slotLine.y) <= 0.8 * em && overlap1d(h.x0, h.x1, slotLine.x0, slotLine.x1) >= 0.4 * Math.min(h.x1 - h.x0, slotLine.x1 - slotLine.x0));
    if (taken) continue;
    textSlots.push({ slot, line: slotLine, label: phraseLabelForSlot(slot.kind, slotLine, phrases, em) });
  }
  // Una misma etiqueta rotula UN solo campo: si dos rayas la reclaman, gana la mas cercana.
  const bestByLabel = new Map<string, number>();
  for (const entry of textSlots) {
    if (!entry.label) continue;
    const key = entry.label.text.toLowerCase();
    const known = bestByLabel.get(key);
    if (known === undefined || entry.label.cost < known) bestByLabel.set(key, entry.label.cost);
  }
  for (const { slot, line: slotLine, label: found } of textSlots) {
    if (found && found.cost > (bestByLabel.get(found.text.toLowerCase()) ?? Infinity) + 1e-9) continue;
    const label = found?.text ?? (slot.label ? displayLabel(slot.label) : undefined);
    const folded = label ? foldKeepLength(label) : "";
    const hits = label ? findLabelHits(folded, wordCount(folded)) : [];
    const kind = hits[0]?.kind ?? dataKindOfLabel(label ?? "");
    // Una firma, iniciales o fecha que mi asociacion no vio: se acepta solo como «review».
    const structural = kind === "signature" || kind === "initials" || kind === "date";
    const dataKind = DATA_KINDS.has(kind);
    const type = fieldTypeForKind(kind);
    const height = slot.box.height > 0 ? Math.max(slot.box.height, TEXT_H_EM * em * 0.8) : TEXT_H_EM * em;
    // Un campo de texto sin etiqueta legible no se propone (solo con etiqueta clara).
    if (!label || label.length < 2) continue;
    const near = kind === "name" || kind === "date" ? nearestSigner({ x0: slotLine.x0, x1: slotLine.x1, y: slotLine.y, thickness: 1, fromText: -1, dashed: false }, sigItems, em) : undefined;
    candidates.push({
      pageIndex: data.pageIndex,
      type,
      signerIndex: near,
      rect: { x0: slotLine.x0, x1: slotLine.x1, y0: slotLine.y, y1: slotLine.y + Math.min(height, TEXT_H_EM * em * 1.2) },
      label,
      labelKind: kind,
      source: "label",
      reasonCode: "text-slot",
      tier: !structural && dataKind && slot.score >= 3.5 && wordCount(folded) <= 5 ? "high" : "review",
      confidence: !structural && dataKind && slot.score >= 3.5 && wordCount(folded) <= 5 ? 0.76 : 0.5,
      host: slotLine,
      notes: structural ? ["slot-structural"] : [],
    });
    claimedLines.push(slotLine);
  }

  /* ---- solapes con texto y con imagenes ---- */
  // Los textos que SON la raya (hileras de guiones bajos o de puntos) no cuentan como texto cubierto.
  const coverBoxes = data.texts.filter((t) => !/_{3,}|\.{6,}/.test(t.raw)).map(textBoxOf);
  const bigImages = data.images.filter((img) => img.x1 - img.x0 < 0.85 * data.width);
  const imageRects: Rect[] = bigImages.map((img) => ({ x0: img.x0, y0: img.y0, x1: img.x1, y1: img.y1 }));
  for (const candidate of candidates) {
    // Solo el texto que cae DENTRO del rectangulo: se recorta una franja fina para tolerar rozes.
    const inner: Rect = {
      x0: candidate.rect.x0 + 0.1 * em,
      x1: candidate.rect.x1 - 0.1 * em,
      y0: candidate.rect.y0 + 0.15 * em,
      y1: candidate.rect.y1 - 0.1 * em,
    };
    const ownRow = candidate.type === "initials" && candidate.reasonCode === "label-slots";
    const covered = coverage(inner, ownRow ? coverBoxes.filter((tb) => tb.y1 < inner.y0 || tb.y0 > inner.y1 - 0.5 * em) : coverBoxes);
    if (covered > 0.2) candidate.notes.push("covers-text");
    if (coverage(inner, imageRects) > 0.3) candidate.notes.push("covers-image");
  }

  /* ---- rayas cortas sin etiqueta (para la repeticion entre paginas) ---- */
  const claimed = new Set(candidates.map((c) => c.host).filter(Boolean));
  const unlabeledShortLines: RepeatPoint[] = [];
  const shortMin = 3.0 * em;
  const shortMax = 11 * em;
  for (const line of [...lines, ...boxHosts]) {
    const width = line.x1 - line.x0;
    if (width < shortMin || width > shortMax) continue;
    if (line.fromText >= 0) continue;
    const isClaimed = [...claimed].some((h) => h && Math.abs(h.y - line.y) <= 0.8 * em && overlap1d(h.x0, h.x1, line.x0, line.x1) >= 0.4 * width);
    if (isClaimed) continue;
    // Una raya con texto debajo, pegado, es el separador de un pie; con texto justo ENCIMA es el subrayado de ese texto.
    const below: Rect = { x0: line.x0, x1: line.x1, y0: line.y - 1.4 * em, y1: line.y - 0.1 * em };
    if (coverage(below, textBoxes) > 0.15) continue;
    const above: Rect = { x0: line.x0, x1: line.x1, y0: line.y - 0.05 * em, y1: line.y + 1.1 * em };
    if (coverage(above, coverBoxes) > 0.25) continue;
    unlabeledShortLines.push({ pageIndex: data.pageIndex, x0: line.x0, x1: line.x1, y: line.y, line });
  }

  return {
    ...empty,
    candidates,
    unlabeledShortLines,
    signatureLines,
    initialsHosts,
  };
}
