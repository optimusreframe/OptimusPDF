/*
 * Huecos de relleno «de verdad» en un PDF plano (W6-A).
 *
 * El detector vectorial antiguo contaba CUALQUIER raya o borde horizontal fino
 * (<= 6 pt de alto, >= 30 pt de ancho) como un hueco: bordes de celda,
 * separadores de fila, reglas decorativas, franjas de un degradado. En un
 * recibo o una tabla salian decenas (157 en un documento de 16 paginas).
 *
 * Aqui se decide con geometria PURA (sin pdf.js ni DOM, para probarlo en Node)
 * que rayas y cajas parecen un hueco de relleno: una raya AISLADA, con una etiqueta
 * de texto a su izquierda en la misma linea ("Nombre: ____"), encima ("Firma" sobre la
 * raya), debajo (leyenda de una linea de firma) o a su derecha; una caja vacia con
 * etiqueta; una celda sombreada de etiqueta junto a una celda vacia; una celda de formulario
 * oficial con su rotulo arriba. Nada de esto vale dentro de una tabla o cuadricula, sobre
 * cajas o texto, ni en barras (progreso, Gantt), tarjetas de precios, graficas, filas de totales,
 * guias de indice o reglas de cabecera y pie. Los guiones bajos y las hileras de puntos de
 * texto ("Nombre: ________") cuentan como una raya mas, y las marcas sueltas de una raya
 * punteada se funden en una sola.
 *
 * INVARIANTE A LA ESCALA (r3): ningun umbral esta en puntos absolutos. `findFillSlots` mide la
 * unidad tipografica del documento (la letra tipica, `documentUnit`), normaliza la geometria a
 * una unidad de referencia de 11 pt y aplica las reglas de abajo, escritas en esa unidad
 * (p. ej. «hueco etiqueta-raya <= 16 em»). Un formulario ampliado, reducido, impreso en A3 o con
 * letra de 14 pt da el mismo resultado que a 11 pt en A4.
 *
 * Todas las coordenadas estan en el espacio de usuario del PDF (origen abajo a
 * la izquierda), tal como las entrega pdf.js.
 */

import type { Box } from "@/lib/pdf/core";

/** Unidad tipografica de referencia (pt): los umbrales de este archivo se expresan para un texto de este tamano. */
export const REFERENCE_UNIT_PT = 11;
const MIN_UNIT_PT = 4;
const MAX_UNIT_PT = 48;
/** Grosor maximo (en puntos PDF, a la unidad de referencia) para contar como raya/subrayado. */
export const SLOT_MAX_THICKNESS_PT = 6;
/** Ancho minimo (en puntos PDF) para contar como hueco util. */
export const SLOT_MIN_WIDTH_PT = 30;
/** Una raya de mas de esta fraccion del ancho de la pagina es un separador, no un hueco. */
export const SLOT_MAX_PAGE_FRACTION = 0.5;
/** Tope duro de huecos sugeridos por pagina. */
export const MAX_SLOTS_PER_PAGE = 20;
/** Tope duro de huecos sugeridos por documento. */
export const MAX_SLOTS_PER_DOCUMENT = 60;
/** Por encima de este numero de rayas finas en una pagina, esta es decorativa/compleja: no se analiza. */
export const MAX_THIN_SEGMENTS_PER_PAGE = 600;

/** Distancia horizontal maxima entre una etiqueta y el hueco a su derecha (12 em; crece con la letra de la etiqueta). */
const LABEL_SAME_LINE_MAX_GAP_PT = 176;
const LABEL_SAME_LINE_MAX_GAP_EM = 16;
/** En una columna de rayas alineadas la etiqueta corta queda lejos de la raya de la etiqueta mas larga: hasta el doble. */
const ALIGNED_COLUMN_GAP_FACTOR = 2;
const ALIGNED_COLUMN_TOLERANCE_PT = 9;
/** Una etiqueta a menos de esto (en unidades) de la raya esta "pegada" a ella. */
const ADJACENT_LABEL_GAP_UNITS = 1.5;
/** Distancia vertical maxima entre un rotulo encima y la raya (el hueco de escritura queda entre ambos). */
const LABEL_ABOVE_MAX_GAP_PT = 34;
const LABEL_ABOVE_MAX_GAP_EM = 4.6;
/** Distancia vertical maxima entre la raya y su leyenda debajo ("Firma" bajo la raya). */
const LABEL_BELOW_MAX_GAP_PT = 16;
const LABEL_BELOW_MAX_GAP_EM = 1.6;
/** Una leyenda debajo de la raya no es un titular (el doble que el texto corriente como mucho). */
const BELOW_LABEL_MAX_HEIGHT_UNITS = 2;
/** Rotulos de una fila de totales: la raya que los acompana (subrayado de la cifra) no es un hueco. */
const TOTALS_LABEL = /\b(sub\s*-?\s*total|total|grand total|iva|igv|vat|tax|impuestos?|saldo|balance|importe|amount due)\b/i;
/** Una raya con rotulo de totales y pegada al margen derecho (alineada con la columna de importes). */
const TOTALS_RIGHT_FRACTION = 0.8;
/** Una raya de relleno es una linea FINA: mas gruesa es una barra (Gantt, acento), no un hueco. */
export const SLOT_MAX_FIELD_THICKNESS_PT = 2.4;
/** ... o, con una etiqueta de letra grande, hasta esta fraccion de su altura (0,22 em). */
const THICKNESS_LABEL_EM = 0.22;
/** Tope previo (antes de conocer la etiqueta): rayas aun mas gruesas que esto, en unidades, son barras. */
const MAX_THICKNESS_LABEL_FACTOR = 1.7;
/** Una caja vacia de este tamano (alto, pt) con etiqueta es un campo dibujado como recuadro. */
const BOX_FIELD_MIN_HEIGHT_PT = 8;
const BOX_FIELD_MAX_HEIGHT_PT = 176;
/** Una caja vacia con etiqueta o una raya con etiqueta ADYACENTE a su izquierda pueden pasar de media pagina (hasta esta fraccion). */
const LABELLED_MAX_PAGE_FRACTION = 0.995;
/** Un rotulo que es una frase (cinco palabras o mas, o con punto final) es prosa, no la etiqueta de un campo. */
const PROSE_MIN_WORDS = 9;
/** Una frase con puntuacion de cierre (punto, coma, punto y coma) y tantas palabras es prosa. */
const PROSE_MIN_WORDS_PUNCTUATED = 5;
/** Una frase que cierra con dos puntos o interrogacion es un rotulo de campo hasta esta longitud. */
const PROSE_MIN_WORDS_COLON = 14;
const WIDE_LEFT_LABEL_MAX_CHARS = 60;
const WIDE_LEFT_LABEL_MAX_HEIGHT_UNITS = 1.8;
/** Texto que queda justo debajo de una raya con rotulo encima: es un separador entre contenidos. */
const SEPARATOR_BELOW_PT = 13.5;
/** Una cifra pegada al final de una raya con concepto a la izquierda: linea de guia (indice, carta de precios). */
const LEADER_RIGHT_GAP_PT = 40;
const NUMERIC_TEXT = /^[\d.,:%$€£\s-]+$/;
/** Una cifra ("45", "12,50", "60%"): numerica y con al menos un digito (un punto suelto no lo es). */
function isNumericValue(text: string): boolean {
  return (NUMERIC_TEXT.test(text) || NUMERIC_WITH_UNIT.test(text)) && /\d/.test(text);
}
/** "50 g", "12,5 kg", "3 pts": una cifra con su unidad. */
const NUMERIC_WITH_UNIT = /^[$€£]?\s*[\d.,:]+\s*(%|[A-Za-zµ°]{1,5}\.?)$/;
/** Separacion maxima entre las dos primeras rayas de una pila. */
const STACK_MAX_GAP_PT = 90;
/** Una pila de campos (renglones con su rotulo) tiene rotulo en casi todos sus renglones; una tabla, solo en el encabezado. */
const STACK_MIN_CAPTIONED_RATIO = 0.75;
/** Un renglon sin rotulo a menos de esta distancia (en unidades) por debajo de uno con rotulo continua su respuesta. */
const CONTINUATION_MAX_GAP_UNITS = 3;
const CONTINUATION_MAX_LINES = 4;
/** Un rotulo encima de una raya apilada es una leyenda corta, no el contenido de una celda. */
const STACK_CAPTION_MAX_FRACTION = 1.05;
/** El rotulo de un campo deja sitio para escribir: la raya queda al menos tanto como su alto por debajo. */
const ABOVE_ROOM_FACTOR = 1.2;
/** Texto por encima de la raya (pt) que ocupa el sitio de escritura: una fila de datos o de totales, no un hueco. */
const OCCUPIED_BAND_PT = 12;
/** Una raya con leyenda debajo es una linea fina de firma, no una barra decorativa. */
const BELOW_LABEL_MAX_THICKNESS_PT = 1.5;
const BELOW_THICKNESS_LABEL_EM = 0.16;
const BELOW_MIN_GAP_EM = 0.45;
const BELOW_THICKNESS_PRECHECK_FACTOR = 2.5;
/** Tolerancia de columna para una etiqueta situada encima del hueco. */
const LABEL_ABOVE_COLUMN_TOLERANCE_PT = 60;
/** Un rotulo encima de la raya no puede ser un titular. */
const ABOVE_LABEL_MAX_HEIGHT_UNITS = 1.8;
const LABEL_MAX_CHARS = 60;
/** Anchura de un guion bajo, en em (Helvetica/Arial 0,556; Times 0,5). */
const UNDERSCORE_EM = 0.55;
/** Un guion bajo suelto o doble es puntuacion; una raya de texto empieza en 5. */
const MIN_UNDERSCORE_RUN = 5;

export type Seg = {
  x0: number;
  x1: number;
  /** Ordenada del centro de la raya. */
  y: number;
  thickness: number;
  /** Indice del texto del que sale (guiones bajos) o `-1` si es vectorial. */
  fromText: number;
  /** Etiqueta que lleva delante en su propio texto ("Nombre:" en "Nombre: ____"). */
  inlineLabel?: string;
  /** Raya de trazo discontinuo o de marcas sueltas fundidas: una regla de recibo, no un subrayado de campo. */
  dashed?: boolean;
  /** Dos rayas de distinto largo superpuestas (barra de progreso sobre su pista): no es un hueco. */
  layered?: boolean;
};

export type VerticalSeg = { x: number; y0: number; y1: number };
export type PaintedBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** La caja se pinta con relleno / con borde. Sin dato (undefined) se trata como una caja con borde. */
  fill?: boolean;
  stroke?: boolean;
  /** Luminancia (0..1) del relleno: una caja sombreada (< 0,97) distingue la celda de etiqueta de un formulario en tabla. */
  shade?: number;
};

export type SlotText = {
  text: string;
  left: number;
  right: number;
  baseline: number;
  height: number;
};

export type SlotCandidate = {
  box: Box;
  label?: string;
  kind: "left" | "above" | "below" | "right" | "inline";
  /** Mayor = mas probable que sea un hueco real. */
  score: number;
};

/** Marca corta de una raya discontinua o punteada (un punto, un guion). */
export type DashMark = { x0: number; x1: number; y: number; thickness: number };

export type SlotInput = {
  segments: readonly Seg[];
  /** Marcas sueltas alineadas (puntos, guiones): se funden en rayas. */
  dashes?: readonly DashMark[];
  verticals: readonly VerticalSeg[];
  boxes: readonly PaintedBox[];
  texts: readonly SlotText[];
  pageWidth: number;
  pageHeight: number;
};

/* ------------------------------------------------------------------ *
 * Etiquetas
 * ------------------------------------------------------------------ */

/**
 * Etiqueta mas cercana a un hueco candidato: o bien termina justo a su
 * izquierda en la misma linea ("Cliente: ____"), o bien queda justo
 * encima alineada por la columna izquierda (rotulo sobre una raya).
 * Version original (tolerante), conservada por compatibilidad.
 */
export function nearestLabel(
  items: readonly SlotText[],
  box: Box,
): string | undefined {
  let best: { text: string; gap: number } | null = null;
  // Los umbrales (a la unidad de referencia) se escalan con la letra de los textos.
  const sc = documentUnit(items) / REFERENCE_UNIT_PT;

  for (const item of items) {
    const sameLine =
      Math.abs(item.baseline - box.y) <= Math.max(item.height, box.height) + 4 * sc;
    const toTheLeft =
      item.right <= box.x + 2 * sc && box.x - item.right <= sc * sameLineGap(item.height / sc);

    const above =
      item.baseline >= box.y + box.height - 2 * sc &&
      item.baseline - (box.y + box.height) <= sc * LABEL_ABOVE_MAX_GAP_PT;
    const columnAligned =
      Math.abs(item.left - box.x) <= sc * LABEL_ABOVE_COLUMN_TOLERANCE_PT;

    let gap: number | null = null;
    if (sameLine && toTheLeft) gap = box.x - item.right;
    else if (above && columnAligned) gap = item.baseline - (box.y + box.height);
    if (gap === null) continue;

    if (!best || gap < best.gap) best = { text: item.text, gap };
  }

  return best?.text;
}

/** Distancia maxima en horizontal entre una etiqueta y su hueco: 12 em de la letra de la etiqueta (minimo la de referencia). */
function sameLineGap(labelHeight: number, relaxed = false): number {
  const factor = relaxed ? ALIGNED_COLUMN_GAP_FACTOR : 1;
  return factor * Math.max(LABEL_SAME_LINE_MAX_GAP_PT, LABEL_SAME_LINE_MAX_GAP_EM * labelHeight);
}

function cleanLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX_CHARS ? flat.slice(flat.length - LABEL_MAX_CHARS) : flat;
}

type LabelHit = { text: string; indices: number[]; gap: number; height: number; width: number };

/** Cajas y rayas verticales que separan zonas distintas de la pagina (tarjetas, celdas, columnas). */
type Walls = { boxes: readonly PaintedBox[]; verticals: readonly VerticalSeg[] };

/** Entre la etiqueta y la raya hay una pared: una caja que contiene la raya pero no la etiqueta, o una raya vertical alta. */
function separated(label: SlotText, seg: Seg, walls: Walls): boolean {
  const mid = (seg.x0 + seg.x1) / 2;
  const boxed = walls.boxes.some(
    (box) =>
      box.x1 - box.x0 >= SLOT_MIN_WIDTH_PT &&
      box.y1 - box.y0 >= BOX_FIELD_MIN_HEIGHT_PT &&
      mid > box.x0 &&
      mid < box.x1 &&
      seg.y > box.y0 - 1 &&
      seg.y < box.y1 + 1 &&
      label.right <= box.x0 + 1 &&
      !(box.x0 <= label.left && box.x1 >= label.right),
  );
  if (boxed) return true;
  return walls.verticals.some(
    (v) =>
      v.x > label.right + 1 &&
      v.x < seg.x0 - 1 &&
      v.y1 - v.y0 >= WALL_MIN_HEIGHT_UNITS * REFERENCE_UNIT_PT &&
      v.y0 <= seg.y &&
      v.y1 >= seg.y,
  );
}
const WALL_MIN_HEIGHT_UNITS = 2;

/** Etiqueta a la izquierda en la MISMA linea (la base del texto casi sobre la raya). */
function leftLabelOf(
  seg: Seg,
  texts: readonly SlotText[],
  skip: number,
  relaxed = false,
  walls?: Walls,
  tall = false,
): LabelHit | undefined {
  if (seg.inlineLabel) return { text: seg.inlineLabel, indices: [], gap: 0, height: 0, width: 0 };
  const chain = texts
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      if (index === skip) return false;
      if (item.right > seg.x0 + 3) return false;
      if (seg.x0 - item.right > sameLineGap(item.height, relaxed)) return false;
      // Una tarjeta, una celda o una columna distinta (una caja que contiene la raya pero no la etiqueta).
      if (walls && separated(item, seg, walls)) return false;
      // El texto de un hueco real "apoya" en la raya: su base queda un poco por encima (mas, en una tabla de filas altas).
      const delta = item.baseline - seg.y;
      // Pegada a la raya (una frase con huecos y interlineado amplio) tolera la misma holgura.
      const adjacent = seg.x0 - item.right <= ADJACENT_LABEL_GAP_UNITS * REFERENCE_UNIT_PT;
      return delta >= -3.5 && delta <= (tall || adjacent ? 0.8 : 0.45) * item.height + 3;
    })
    .sort((a, b) => b.item.right - a.item.right);
  return chainLabel(chain, seg.x0);
}

/** Un hueco que abre una linea se etiqueta con el final de la linea anterior ("... por motivo de" / "______"). */
const WRAP_MAX_LINE_GAP_UNITS = 3.4;
const WRAP_MIN_LINE_GAP_UNITS = 0.9;
const WRAP_LEFT_MARGIN_UNITS = 2;
const WRAP_MIN_LINE_CHARS = 25;

/**
 * Etiqueta de un hueco que quedo al principio de la linea siguiente porque no cabia en la anterior:
 * el texto que cierra la linea de arriba, sin punto final, y que llega tan cerca del borde derecho
 * del bloque que el hueco no habria cabido a su lado.
 */
function wrappedLabelOf(seg: Seg, texts: readonly SlotText[], skip: number): LabelHit | undefined {
  if (texts.length === 0) return undefined;
  const leftEdge = Math.min(...texts.map((item) => item.left));
  if (seg.x0 > leftEdge + WRAP_LEFT_MARGIN_UNITS * REFERENCE_UNIT_PT) return undefined;
  const rightEdge = Math.max(...texts.map((item) => item.right));
  const width = seg.x1 - seg.x0;
  // Una raya vectorial dentro de una frase lleva texto a continuacion (el punto final, la siguiente palabra).
  if (seg.fromText < 0) {
    const trailing = texts.some(
      (item, index) =>
        index !== skip &&
        item.left >= seg.x1 - 2 &&
        item.left - seg.x1 <= 2.5 * REFERENCE_UNIT_PT &&
        Math.abs(item.baseline - seg.y) <= 0.6 * item.height + 2,
    );
    if (!trailing) return undefined;
  }
  const above = texts
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      if (index === skip) return false;
      const gap = item.baseline - seg.y;
      return gap >= WRAP_MIN_LINE_GAP_UNITS * item.height && gap <= WRAP_MAX_LINE_GAP_UNITS * item.height;
    });
  if (above.length === 0) return undefined;
  // La linea inmediatamente superior: la de baseline mas cercana.
  const lineBase = Math.min(...above.map(({ item }) => item.baseline));
  const line = above.filter(({ item }) => Math.abs(item.baseline - lineBase) <= 2);
  // La linea de arriba es texto corrido (una frase), no una etiqueta suelta ("Fecha" a la derecha de otra raya).
  if (line.reduce((sum, { item }) => sum + item.text.length, 0) < WRAP_MIN_LINE_CHARS) return undefined;
  const lastRight = Math.max(...line.map(({ item }) => item.right));
  // El hueco no habria cabido a continuacion del texto de esa linea.
  if (rightEdge - lastRight >= width + REFERENCE_UNIT_PT) return undefined;
  const chain = line.filter(({ item }) => item.right <= lastRight + 0.5).sort((a, b) => b.item.right - a.item.right);
  const hit = chainLabel(chain, seg.x0);
  if (!hit || /[.!?;]$/.test(hit.text)) return undefined;
  // Solo las ultimas palabras: el resto de la linea es el cuerpo de la frase.
  const words = hit.text.split(" ");
  return { ...hit, text: words.slice(-4).join(" "), gap: 0 };
}

/** Une los textos contiguos de una etiqueta partida ("Fecha de" + "nacimiento:"). */
function chainLabel(
  chain: Array<{ item: SlotText; index: number }>,
  boxLeft: number,
): LabelHit | undefined {
  if (chain.length === 0) return undefined;
  let text = chain[0].item.text;
  let left = chain[0].item.left;
  const indices = [chain[0].index];
  let previous = chain[0].item;
  for (const { item, index } of chain.slice(1)) {
    if (left - item.right > 8 || left - item.right < -2) continue;
    text = `${item.text}${needsSpace(item, previous, left - item.right) ? " " : ""}${text}`;
    left = item.left;
    previous = item;
    indices.push(index);
  }
  const clean = cleanLabel(text);
  if (clean.length === 0) return undefined;
  return {
    text: clean,
    indices,
    gap: boxLeft - chain[0].item.right,
    height: chain[0].item.height,
    width: chain[0].item.right - left,
  };
}

/** Una raya ancha con rotulo encima (linea de respuesta) deja al menos este sitio: una regla bajo una linea de texto no. */
const WIDE_ABOVE_ROOM_FACTOR = 1.8;
/** Una frase con al menos este espacio libre (en alturas) entre ella y la raya es el enunciado de una respuesta. */
const PROMPT_ROOM_FACTOR = 2.2;
/** Etiqueta a la DERECHA de la raya ("______ Fecha"): cerca, en la misma linea, corta y no una cifra. */
const RIGHT_LABEL_MAX_GAP_UNITS = 2.4;
const RIGHT_LABEL_MAX_CHARS = 30;
const RIGHT_LABEL_MIN_COUNT = 2;
/** Un rotulo puede pasar del final de su raya hasta esta fraccion del ancho de la raya. */
const CAPTION_PAST_END_FRACTION = 1;
/** Una caja con rotulo encima y leyenda debajo: gana la leyenda si esta bastante mas cerca (esta fraccion de la distancia del rotulo). */
const BELOW_PREFERRED_RATIO = 0.8;
/** Un texto a menos de esto (en alturas) por debajo de una raya con la que se solapa es la leyenda de esa raya. */
const OWNED_CAPTION_MAX_GAP_EM = 1.45;
const OWNER_FREE_ABOVE_EM = 2.2;
/** Una linea de texto que se solapa con la raya y queda mas cerca que el rotulo (mas de esta holgura) lo tapa. */
const ABOVE_BLOCKER_MARGIN = 2;
/** Un rotulo centrado sobre la raya (certificados): su centro cae cerca del centro de la raya. */
const CENTRED_CAPTION_TOLERANCE = 0.12;
/** ... y la raya no es la regla de margen a margen de una cabecera: menos de esta fraccion del ANCHO UTIL (el rango de x de todo el contenido). */
const CENTRED_CAPTION_MAX_LINE_FRACTION = 0.92;
/** Hueco maximo entre dos palabras sueltas de un mismo rotulo (Chromium parte el texto en palabras). */
const WORD_GAP_MAX_PT = 14;
const TOUCHING_GAP_PT = 0.8;

/** Hace falta un espacio entre dos fragmentos de texto: hay hueco, o alguno trae el espacio en su cadena original. */
function needsSpace(before: SlotText, after: SlotText, gap: number): boolean {
  if (gap > TOUCHING_GAP_PT || gap < -TOUCHING_GAP_PT || Math.abs(before.baseline - after.baseline) > 2) return true;
  const raw = (item: SlotText) => (item as Partial<RawText>).raw;
  const a = raw(before);
  const b = raw(after);
  if (a === undefined || b === undefined) return true;
  return /\s$/.test(a) || /^\s/.test(b);
}

/** Une las palabras sueltas de una misma linea (ya ordenadas por su izquierda) en el primer rotulo contiguo. */
function joinWords(words: Array<{ item: SlotText; index: number }>): { text: string; indices: number[]; left: number; right: number; height: number } | undefined {
  if (words.length === 0) return undefined;
  const sorted = [...words].sort((a, b) => a.item.left - b.item.left);
  let right = sorted[0].item.right;
  const taken = [sorted[0]];
  let text = sorted[0].item.text;
  for (const word of sorted.slice(1)) {
    if (word.item.left - right > WORD_GAP_MAX_PT) break;
    // Fragmentos pegados ("O" + "fi" + "cina:", una ligadura) se unen sin espacio.
    text += (needsSpace(taken[taken.length - 1].item, word.item, word.item.left - right) ? " " : "") + word.item.text;
    taken.push(word);
    right = Math.max(right, word.item.right);
  }
  return {
    text: cleanLabel(text),
    indices: taken.map((word) => word.index),
    left: taken[0].item.left,
    right,
    height: Math.max(...taken.map((word) => word.item.height)),
  };
}

/** Hay texto (de cualquier clase) a la izquierda de la raya, en su linea y a distancia de etiqueta. */
function hasTextLeftOnLine(seg: Seg, texts: readonly SlotText[], skip: number): boolean {
  return texts.some((item, index) => {
    if (index === skip || item.right > seg.x0 + 3 || seg.x0 - item.right > sameLineGap(item.height)) return false;
    const delta = item.baseline - seg.y;
    return delta >= -3.5 && delta <= 0.8 * item.height + 3;
  });
}

/** Etiqueta pegada a la derecha de la raya, en su linea: "____ Fecha". */
function rightLabelOf(seg: Seg, texts: readonly SlotText[], skip: number): LabelHit | undefined {
  const candidates = texts
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      if (index === skip) return false;
      if (item.left < seg.x1 - 2 || item.left - seg.x1 > RIGHT_LABEL_MAX_GAP_UNITS * REFERENCE_UNIT_PT) return false;
      const delta = item.baseline - seg.y;
      return delta >= -0.9 * item.height - 2 && delta <= 0.5 * item.height + 2;
    })
    .sort((a, b) => a.item.left - b.item.left);
  const joined = joinWords(candidates);
  if (!joined || joined.text.length > RIGHT_LABEL_MAX_CHARS || isNumericValue(joined.text) || /[.,;]$/.test(joined.text)) return undefined;
  return { text: joined.text, indices: joined.indices, gap: 0, height: joined.height, width: joined.right - joined.left };
}

/** Rotulo encima de la raya, alineado a su columna izquierda (la linea de texto mas cercana). */
function aboveLabelOf(
  seg: Seg,
  texts: readonly SlotText[],
  skip: number,
  pageWidth: number,
  minGap = 1.5,
  owners: ReadonlyArray<{ x0: number; x1: number; y: number }> = [],
): LabelHit | undefined {
  const candidates: Array<{ item: SlotText; index: number; gap: number }> = [];
  texts.forEach((item, index) => {
    if (index === skip) return;
    const gap = item.baseline - seg.y;
    if (gap < minGap || gap > Math.max(LABEL_ABOVE_MAX_GAP_PT, LABEL_ABOVE_MAX_GAP_EM * item.height)) return;
    const centred =
      !seg.dashed &&
      seg.x1 - seg.x0 <= CENTRED_CAPTION_MAX_LINE_FRACTION * pageWidth &&
      Math.abs((item.left + item.right) / 2 - (seg.x0 + seg.x1) / 2) <= CENTRED_CAPTION_TOLERANCE * (seg.x1 - seg.x0);
    if (item.left < seg.x0 - 4 || (item.left - seg.x0 > LABEL_ABOVE_COLUMN_TOLERANCE_PT && !centred)) return;
    // El rotulo puede pasar del final de la raya (una raya corta con un rotulo largo debajo de ella), no mucho.
    if (item.right > seg.x1 + Math.max(8, CAPTION_PAST_END_FRACTION * (seg.x1 - seg.x0))) return;
    candidates.push({ item, index, gap });
  });
  if (candidates.length === 0) return undefined;
  // La linea de texto mas cercana manda: si es un titular (letra grande) la raya cuelga de un titular, no de un campo.
  const nearest = Math.min(...candidates.map((candidate) => candidate.gap));
  // Y si encima de la raya hay una linea de texto mas cercana que NO esta alineada con ella (un parrafo que pasa por
  // encima), el rotulo no es de esta raya: la linea que lo precede en lectura es ese parrafo.
  const blocker = texts.some(
    (item, index) =>
      index !== skip &&
      item.baseline - seg.y >= minGap &&
      item.baseline - seg.y < nearest - ABOVE_BLOCKER_MARGIN &&
      overlapLength(seg.x0, seg.x1, item.left, item.right) >= 2,
  );
  if (blocker) return undefined;
  const start = candidates.filter((candidate) => Math.abs(candidate.gap - nearest) <= 2);
  // El rotulo sigue hacia la derecha mas alla de la tolerancia de columna: se suman las palabras contiguas de esa linea.
  const base = start[0].item.baseline;
  const line: Array<{ item: SlotText; index: number }> = [];
  texts.forEach((item, index) => {
    if (index === skip || Math.abs(item.baseline - base) > 2) return;
    if (item.left < seg.x0 - 4 || item.right > seg.x1 + Math.max(8, CAPTION_PAST_END_FRACTION * (seg.x1 - seg.x0))) return;
    line.push({ item, index });
  });
  const joined = joinWords(line);
  if (!joined) return undefined;
  if (joined.height > ABOVE_LABEL_MAX_HEIGHT_UNITS * REFERENCE_UNIT_PT) return undefined;
  // Un texto pegado POR DEBAJO de otra raya es la leyenda de esa raya (raya-y-leyenda en filas), no el rotulo de esta.
  const captionBase = texts[joined.indices[0]].baseline;
  const owned = owners.some(
    (owner) =>
      owner.y > captionBase &&
      owner.y - captionBase <= OWNED_CAPTION_MAX_GAP_EM * joined.height &&
      overlapLength(owner.x0, owner.x1, joined.left, joined.right) >= 0.5 * (joined.right - joined.left) &&
      // La raya duena tiene sitio libre encima (donde se escribe): una regla bajo un titular no es duena de la pregunta que le sigue.
      !texts.some(
        (item) =>
          item.baseline > owner.y &&
          item.baseline - owner.y <= OWNER_FREE_ABOVE_EM * item.height &&
          overlapLength(owner.x0, owner.x1, item.left, item.right) > 0,
      ),
  );
  if (owned) return undefined;
  return {
    text: joined.text,
    indices: joined.indices,
    gap: nearest,
    height: joined.height,
    width: joined.right - joined.left,
  };
}

/**
 * Leyenda DEBAJO de la raya ("Firma del solicitante" bajo la linea de firma).
 * Solo cuenta si la raya es una linea fina, el espacio de escritura de encima
 * esta vacio y la leyenda cabe en el ancho de la raya (no es un parrafo).
 */
function belowLabelOf(seg: Seg, texts: readonly SlotText[], skip: number): LabelHit | undefined {
  // (el grosor maximo crece con la letra de la leyenda: 0,16 em, minimo el de referencia)
  if (seg.thickness > BELOW_LABEL_MAX_THICKNESS_PT * BELOW_THICKNESS_PRECHECK_FACTOR) return undefined;
  const width = seg.x1 - seg.x0;
  const blocked = texts.some((item, index) => {
    if (index === skip) return false;
    const gap = item.baseline - seg.y;
    if (gap <= 0 || gap > LABEL_BELOW_MAX_GAP_PT) return false;
    return overlapLength(seg.x0, seg.x1, item.left, item.right) >= 0.2 * Math.min(width, item.right - item.left);
  });
  if (blocked) return undefined;
  const candidates: Array<{ item: SlotText; index: number; gap: number }> = [];
  texts.forEach((item, index) => {
    if (index === skip) return;
    if (item.height > BELOW_LABEL_MAX_HEIGHT_UNITS * REFERENCE_UNIT_PT) return;
    const gap = seg.y - item.baseline;
    // (una leyenda queda DEBAJO de la raya, no apoyada en ella: un texto de la misma linea, como el evento de «hora ..... evento», no cuenta)
    if (gap < Math.max(2, BELOW_MIN_GAP_EM * item.height) || gap > Math.max(LABEL_BELOW_MAX_GAP_PT, LABEL_BELOW_MAX_GAP_EM * item.height)) return;
    if (item.left < seg.x0 - 6 || item.right > seg.x1 + Math.max(8, CAPTION_PAST_END_FRACTION * (seg.x1 - seg.x0))) return;
    candidates.push({ item, index, gap });
  });
  if (candidates.length === 0) return undefined;
  const nearest = Math.min(...candidates.map((candidate) => candidate.gap));
  const joined = joinWords(candidates.filter((candidate) => Math.abs(candidate.gap - nearest) <= 2));
  if (!joined) return undefined;
  if (seg.thickness > Math.max(BELOW_LABEL_MAX_THICKNESS_PT, BELOW_THICKNESS_LABEL_EM * joined.height)) return undefined;
  return { text: joined.text, indices: joined.indices, gap: nearest, height: joined.height, width: joined.right - joined.left };
}

/* ------------------------------------------------------------------ *
 * Guiones bajos de texto como rayas
 * ------------------------------------------------------------------ */

export type RawText = SlotText & { raw: string };

/** Una hilera de guiones bajos o puntos dentro de una frase es un hueco desde 2 em (menos que una raya vectorial). */
const TEXT_RUN_MIN_WIDTH_PT = 22;
/** Caracteres de relleno que dibujan una raya en un texto: guiones bajos, puntos suspensivos y puntos. */
const FILLER_MIN_RUN: Record<string, number> = { _: MIN_UNDERSCORE_RUN, ".": 8, "…": 4 };
/** Ancho del relleno en em (Helvetica/Arial; el punto se calibra con el texto real, la tipografia mono es mas ancha). */
const FILLER_EM: Record<string, number> = { _: UNDERSCORE_EM, ".": 0.28, "…": 1 };
/** Ancho medio de una letra en em, para repartir el ancho de un texto que mezcla letras y puntos. */
const OTHER_EM = 0.52;
const NARROW_EM = 0.28;

/**
 * Rayas que dibujan los guiones bajos (o una hilera de puntos) de un texto ("Nombre: ________",
 * "Nombre: ........"). El ancho de cada caracter no se conoce: el relleno mide `FILLER_EM` (los
 * puntos se calibran con el ancho real del texto) y el resto se reparte lo que sobra del ancho real
 * (exacto cuando el hueco esta al final, que es lo normal). Una hilera de puntos seguida de una cifra
 * en el mismo texto ("Capitulo 3 ........ 45") es una guia de indice, no un hueco.
 */
export function underscoreSegments(texts: readonly RawText[]): Seg[] {
  const out: Seg[] = [];
  texts.forEach((item, index) => {
    const raw = item.raw;
    if (!/_{5}|\.{8}|…{4}/.test(raw)) return;
    const chars = Array.from(raw);
    const isFiller = (char: string) => char === "_" || char === "." || char === "…";
    const width = item.right - item.left;
    const size = item.height > 0 ? item.height : 10;
    const fillerWidth = (char: string): number => {
      if (char === "_") return UNDERSCORE_EM * size;
      const dots = chars.filter((c) => c === char).length;
      // Letras ~0,52 em; espacios y puntuacion ~0,28 em (Helvetica/Arial): lo que sobra del ancho real es de los puntos.
      const othersWidth = chars
        .filter((c) => !isFiller(c))
        .reduce((sum, c) => sum + (/[\s,;:()\-'"!?¿¡]/.test(c) ? NARROW_EM : OTHER_EM) * size, 0);
      const estimate = othersWidth === 0 ? width / chars.length : (width - othersWidth) / Math.max(dots, 1);
      // Con un texto que mezcla letras y puntos el reparto es una estimacion: se acota a lo que mide un punto
      // (Helvetica 0,28 em ... una tipografia mono 0,6 em) en vez de descartarla.
      return Number.isFinite(estimate) ? Math.min(Math.max(estimate, 0.2 * size), 0.65 * size) : FILLER_EM[char] * size;
    };
    // Reparto: cada tipo de relleno ocupa su ancho (acotado al ancho real) y el resto, lo que sobra.
    const widths = new Map<string, number>(["_", ".", "…"].map((char) => [char, fillerWidth(char)]));
    let fillerTotal = 0;
    for (const char of chars) if (isFiller(char)) fillerTotal += widths.get(char) ?? 0;
    if (fillerTotal > width * 0.97 && fillerTotal > 0) {
      const factor = (width * 0.97) / fillerTotal;
      for (const [char, w] of widths) widths.set(char, w * factor);
    }
    const nonFillerCount = chars.filter((char) => !isFiller(char)).length;
    const otherWidth = nonFillerCount > 0 ? Math.max(0, width - Math.min(fillerTotal, width * 0.97)) / nonFillerCount : 0;

    let position = 0;
    let x = item.left;
    let labelStart = 0;
    while (position < chars.length) {
      const char = chars[position];
      if (!isFiller(char)) {
        x += otherWidth;
        position += 1;
        continue;
      }
      let end = position;
      while (end < chars.length && chars[end] === char) end += 1;
      const run = end - position;
      const runWidth = run * (widths.get(char) ?? 0);
      const minRun = FILLER_MIN_RUN[char];
      // Una guia de indice: la hilera de puntos termina en una cifra del mismo texto.
      const leaderToNumber = char !== "_" && /^\s*\d/.test(chars.slice(end).join(""));
      if (run >= minRun && runWidth >= TEXT_RUN_MIN_WIDTH_PT && !leaderToNumber) {
        const label = cleanLabel(chars.slice(labelStart, position).join("").replace(/_/g, " "));
        out.push({
          x0: x,
          x1: x + runWidth,
          y: item.baseline - 0.12 * size,
          thickness: 0.7,
          fromText: index,
          inlineLabel: label.length > 0 ? label : undefined,
        });
      }
      x += runWidth;
      position = end;
      labelStart = end;
    }
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Nucleo
 * ------------------------------------------------------------------ */

function overlapLength(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Una raya de puntos o guiones: al menos tantas marcas, con un hueco entre marcas de como mucho esto. */
const LAYERED_MIN_OVERLAP_PT = 4;
const DASH_MIN_MARKS = 6;
const DASH_MAX_GAP_PT = 7;
const DASH_Y_TOLERANCE_PT = 0.8;

/**
 * Funde en una sola raya las marcas cortas (puntos, guiones) alineadas en la misma ordenada y
 * con un paso regular: asi una linea punteada o discontinua dibujada marca a marca cuenta como
 * una unica raya, igual que si fuera un trazo continuo.
 */
export function mergeDashes(dashes: readonly DashMark[]): Seg[] {
  const sorted = [...dashes].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const out: Seg[] = [];
  let index = 0;
  while (index < sorted.length) {
    // Marcas en la misma ordenada.
    const row: DashMark[] = [sorted[index]];
    let next = index + 1;
    while (next < sorted.length && Math.abs(sorted[next].y - row[0].y) <= DASH_Y_TOLERANCE_PT) {
      row.push(sorted[next]);
      next += 1;
    }
    index = next;
    row.sort((a, b) => a.x0 - b.x0);
    let run: DashMark[] = [];
    const flush = () => {
      if (run.length >= DASH_MIN_MARKS) {
        const gaps = run.slice(1).map((mark, i) => mark.x0 - run[i].x1);
        const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        // Paso regular: ningun hueco mucho mayor que el habitual.
        const regular = gaps.every((gap) => gap <= Math.max(2 * medianGap, medianGap + 1.5));
        const x0 = run[0].x0;
        const x1 = run[run.length - 1].x1;
        if (regular && x1 - x0 >= SLOT_MIN_WIDTH_PT) {
          out.push({
            x0,
            x1,
            y: run.reduce((sum, mark) => sum + mark.y, 0) / run.length,
            thickness: Math.max(...run.map((mark) => mark.thickness)),
            fromText: -1,
            dashed: true,
          });
        }
      }
      run = [];
    };
    for (const mark of row) {
      const last = run[run.length - 1];
      if (last && mark.x0 - last.x1 > DASH_MAX_GAP_PT) flush();
      run.push(mark);
    }
    flush();
  }
  return out;
}

/** Une rayas dobles (un borde dibujado dos veces) y trozos contiguos de una misma raya vectorial. */
function mergeSegments(segments: readonly Seg[]): Seg[] {
  const sorted = [...segments].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const merged: Seg[] = [];
  for (const seg of sorted) {
    if (seg.fromText >= 0) {
      merged.push({ ...seg });
      continue;
    }
    const last = merged.find(
      (candidate) =>
        candidate.fromText < 0 &&
        Math.abs(candidate.y - seg.y) <= 2.5 &&
        seg.x0 <= candidate.x1 + 2.5 &&
        seg.x1 >= candidate.x0 - 2.5,
    );
    if (last) {
      const overlap = overlapLength(last.x0, last.x1, seg.x0, seg.x1);
      if (overlap > LAYERED_MIN_OVERLAP_PT && (Math.abs(last.x0 - seg.x0) > 3 || Math.abs(last.x1 - seg.x1) > 3)) last.layered = true;
      last.x0 = Math.min(last.x0, seg.x0);
      last.x1 = Math.max(last.x1, seg.x1);
      last.thickness = Math.max(last.thickness, seg.thickness);
      last.dashed = last.dashed || seg.dashed;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Rayas que forman una pila de >= 3 rayas paralelas y equidistantes en el mismo tramo horizontal
 * (renglones de una tabla, papel pautado, una lista de campos). Cada miembro apunta a su pila.
 */
function stackRuns(segments: readonly Seg[]): Map<Seg, Seg[]> {
  const members = new Map<Seg, Seg[]>();
  for (const seed of segments) {
    // Rayas que comparten (al menos la mitad de) el tramo horizontal con la semilla, de abajo arriba.
    const sameRange = segments
      .filter((other) => {
        const overlap = overlapLength(seed.x0, seed.x1, other.x0, other.x1);
        return overlap >= 0.5 * Math.min(seed.x1 - seed.x0, other.x1 - other.x0);
      })
      .sort((a, b) => a.y - b.y);
    const start = sameRange.indexOf(seed);
    // Cadena que empieza en la semilla: renglones separados de forma regular.
    const run = [seed];
    for (let index = start + 1; index < sameRange.length; index += 1) {
      const previous = run[run.length - 1];
      const gap = sameRange[index].y - previous.y;
      if (gap < 0.5) continue;
      if (run.length === 1) {
        if (gap <= STACK_MAX_GAP_PT) run.push(sameRange[index]);
        continue;
      }
      const firstGap = run[1].y - run[0].y;
      if (Math.abs(gap - firstGap) <= Math.max(1.8, 0.14 * firstGap)) run.push(sameRange[index]);
      else break;
    }
    if (run.length >= 3) for (const member of run) if (!members.has(member) || members.get(member)!.length < run.length) members.set(member, run);
  }
  return members;
}

/** Fraccion del tramo [x0, x1] de la raya cubierta por texto apoyado en ella. */
function onLineCoverage(seg: Seg, texts: readonly SlotText[], skip: number): number {
  const width = seg.x1 - seg.x0;
  if (width <= 0) return 0;
  const intervals: Array<[number, number]> = [];
  texts.forEach((item, index) => {
    if (index === skip) return;
    const delta = item.baseline - seg.y;
    if (delta < -1.5 || delta > 0.45 * item.height + 2.5) return;
    const from = Math.max(seg.x0, item.left);
    const to = Math.min(seg.x1, item.right);
    if (to > from) intervals.push([from, to]);
  });
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [from, to] of intervals) {
    const start = Math.max(from, end);
    if (to > start) covered += to - start;
    end = Math.max(end, to);
  }
  return covered / width;
}

/** La raya atraviesa un texto (tachado). */
function crossesText(seg: Seg, texts: readonly SlotText[], skip: number): boolean {
  const width = seg.x1 - seg.x0;
  return texts.some((item, index) => {
    if (index === skip) return false;
    const delta = seg.y - item.baseline;
    if (delta <= 0.2 * item.height || delta >= 0.8 * item.height) return false;
    const overlap = overlapLength(seg.x0, seg.x1, item.left, item.right);
    return overlap >= 0.3 * Math.min(width, item.right - item.left);
  });
}

function borderOfBox(seg: Seg, boxes: readonly PaintedBox[]): boolean {
  return boxes.some((box) => {
    const onEdge = Math.abs(seg.y - box.y0) <= 1.5 || Math.abs(seg.y - box.y1) <= 1.5;
    return onEdge && seg.x0 >= box.x0 - 3 && seg.x1 <= box.x1 + 3;
  });
}

function touchesVertical(seg: Seg, verticals: readonly VerticalSeg[]): boolean {
  return verticals.some((v) => {
    if (seg.y < v.y0 - 2 || seg.y > v.y1 + 2) return false;
    // Extremos o cruce.
    return v.x >= seg.x0 - 2.5 && v.x <= seg.x1 + 2.5;
  });
}

/** Cajas distintas: el mismo rectangulo pintado dos veces (relleno + borde) cuenta una vez. */
function uniqueBoxes(boxes: readonly PaintedBox[]): PaintedBox[] {
  const out: PaintedBox[] = [];
  for (const box of boxes) {
    const same = out.find(
      (other) =>
        Math.abs(other.x0 - box.x0) <= 1 &&
        Math.abs(other.x1 - box.x1) <= 1 &&
        Math.abs(other.y0 - box.y0) <= 1 &&
        Math.abs(other.y1 - box.y1) <= 1,
    );
    if (same) {
      same.fill = same.fill || box.fill;
      same.stroke = same.stroke || box.stroke;
      if (box.shade !== undefined && same.shade === undefined) same.shade = box.shade;
    } else out.push({ ...box });
  }
  return out;
}

/** Dos cajas comparten un borde (celdas de una tabla). */
function boxesTouch(a: PaintedBox, b: PaintedBox): boolean {
  const verticalOverlap = overlapLength(a.y0, a.y1, b.y0, b.y1);
  const horizontalOverlap = overlapLength(a.x0, a.x1, b.x0, b.x1);
  const sideBySide =
    (Math.abs(a.x1 - b.x0) <= 1.5 || Math.abs(b.x1 - a.x0) <= 1.5) &&
    verticalOverlap >= 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  const stacked =
    (Math.abs(a.y1 - b.y0) <= 1.5 || Math.abs(b.y1 - a.y0) <= 1.5) &&
    horizontalOverlap >= 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
  return sideBySide || stacked;
}


type BoxSlot = { box: PaintedBox; seg: Seg; left?: LabelHit; above?: LabelHit; below?: LabelHit };

/** Una caja sin borde ni subrayado mas baja que esto es una barra (progreso, Gantt), no un campo. */
const BORDERLESS_MIN_HEIGHT_UNITS = 1.5;
/** Luminancia minima del relleno de un campo sin borde (un campo sombreado es claro). */
const BORDERLESS_MIN_LUMINANCE = 0.8;
/** Una cifra a la derecha de una barra o caja a esta distancia (en unidades) es su valor ("60%"), no un campo. */
const VALUE_RIGHT_MAX_GAP_UNITS = 3.6;
/** El rotulo ocupa (en su altura) la parte alta del hueco: el sitio de escritura es lo que queda debajo. */
const OCCUPIED_CAPTION_MARGIN = 0.5;
/** Una linea ancha con su leyenda debajo: la leyenda es corta y la linea no cae en la banda de cabecera o pie. */
const WIDE_BELOW_MAX_CHARS = 40;
const HEADER_FOOTER_FRACTION = 0.12;
const WIDE_BELOW_CLEAR_UNITS = 3;
/** Una regla de margen a margen (mas de esta fraccion del ancho) no es una linea de firma. */
const WIDE_BELOW_MAX_PAGE_FRACTION = 0.995;
/** Un rotulo mayor que esto (en unidades) pide BIG_CAPTION_ROOM alturas de sitio entre el y la raya, no ABOVE_MIN_ROOM. */
const BIG_CAPTION_UNITS = 1.3;
const BIG_CAPTION_ROOM = 1.5;
/** Una barra rellena de esta altura (en unidades) apoyada sobre una raya la ocupa. */
const BAR_MAX_HEIGHT_UNITS = 2;
/** Un rotulo solo numerico ("20", "$12") es el valor de un eje o de una tarifa, no la etiqueta de un campo. */
const NUMERIC_LABEL = /^[\d\s.,:;%$€£+\-–/()#°ºª]*$/;
/** Hueco libre minimo entre el rotulo de encima y la raya, en alturas del rotulo. */
const ABOVE_MIN_ROOM = 0.9;
/** Un rotulo con texto de su mismo bloque justo encima (a menos de esto, en alturas) es la ultima linea de un parrafo. */
const CAPTION_ISOLATION = 1.75;
const HEADING_RATIO = 1.25;

/** Texto de pie o cabecera de pagina ("Pagina 1 de 3", "Confidencial"): la regla que lo acompana no es un hueco. */
const PAGE_MARKER = /^(p[aá]gina|page|p[aá]g\.?|hoja|sheet)\s*\d+|^\d+\s*(de|of|\/)\s*\d+$|confidencial|confidential|^©/i;

function usableLabel(hit?: LabelHit): LabelHit | undefined {
  return hit && !NUMERIC_LABEL.test(hit.text) && !PAGE_MARKER.test(hit.text.trim()) ? hit : undefined;
}

/** El rotulo de encima no es la ultima linea de un parrafo: no hay otra linea de texto pegada por encima. */
function isolatedCaption(hit: LabelHit, texts: readonly SlotText[]): boolean {
  const members = hit.indices.map((index) => texts[index]).filter(Boolean);
  if (members.length === 0) return true;
  const left = Math.min(...members.map((item) => item.left));
  const right = Math.max(...members.map((item) => item.right));
  const base = members[0].baseline;
  const height = hit.height;
  return !texts.some((item, index) => {
    if (hit.indices.includes(index)) return false;
    const up = item.baseline - base;
    if (up <= 0.3 * height || up > CAPTION_ISOLATION * height) return false;
    // Un titular encima (letra bastante mayor) no hace del rotulo la ultima linea de un parrafo.
    if (item.height >= HEADING_RATIO * height) return false;
    return overlapLength(left, right, item.left, item.right) > 0;
  });
}

/**
 * Cajas VACIAS con etiqueta a su izquierda o encima: un campo dibujado como
 * recuadro (un `<input>` de Chromium es una caja de fondo con un borde, un
 * formulario a mano es un rectangulo). Las celdas de una tabla (cajas que se
 * tocan, con texto dentro, o que contienen otras cajas) y las barras (relleno
 * sin borde, poco altas, con su valor al lado) no cuentan.
 */
function boxSlots(
  boxes: readonly PaintedBox[],
  texts: readonly SlotText[],
  segments: readonly Seg[],
  pageWidth: number,
): BoxSlot[] {
  const distinct = uniqueBoxes(boxes);
  if (distinct.length > MAX_THIN_SEGMENTS_PER_PAGE) return [];
  const out: BoxSlot[] = [];
  for (const box of distinct) {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    if (width < SLOT_MIN_WIDTH_PT || width > pageWidth * LABELLED_MAX_PAGE_FRACTION) continue;
    if (height < BOX_FIELD_MIN_HEIGHT_PT || height > BOX_FIELD_MAX_HEIGHT_PT) continue;
    // Una celda de tabla comparte borde con otra; un panel contiene otras cajas.
    if (distinct.some((other) => other !== box && boxesTouch(box, other))) continue;
    // (un agarre de redimensionado o una casilla dentro de la caja no la convierten en panel: solo otra caja de campo)
    if (
      distinct.some(
        (other) =>
          other !== box &&
          // (otra caja de campo, o un relleno de color por pequeno que sea: la barra de un progreso)
          ((other.x1 - other.x0 >= SLOT_MIN_WIDTH_PT && other.y1 - other.y0 >= BOX_FIELD_MIN_HEIGHT_PT) ||
            (other.fill === true && other.x1 - other.x0 >= PAINTED_CONTENT_MIN_WIDTH_PT && other.y1 - other.y0 >= PAINTED_CONTENT_MIN_WIDTH_PT)) &&
          other.x0 >= box.x0 - 1 &&
          other.x1 <= box.x1 + 1 &&
          other.y0 >= box.y0 - 1 &&
          other.y1 <= box.y1 + 1,
      )
    ) {
      continue;
    }
    // El relleno de una barra de progreso: otra caja de su misma altura lo contiene y comparte un extremo.
    if (
      distinct.some(
        (other) =>
          other !== box &&
          box.x0 >= other.x0 - 1 &&
          box.x1 <= other.x1 + 1 &&
          Math.abs(box.y0 - other.y0) <= 1.5 &&
          Math.abs(box.y1 - other.y1) <= 1.5 &&
          (Math.abs(box.x0 - other.x0) <= 1.5 || Math.abs(box.x1 - other.x1) <= 1.5),
      )
    ) {
      continue;
    }
    // Vacia: ningun texto dentro.
    const hasText = texts.some(
      (item) =>
        (item.left + item.right) / 2 > box.x0 &&
        (item.left + item.right) / 2 < box.x1 &&
        item.baseline > box.y0 - 1 &&
        item.baseline < box.y1 + 1,
    );
    if (hasText) continue;
    // Relleno sin borde: es un campo si lleva un subrayado en su base (fondo de color + raya) o es alto como un campo; si no, una barra.
    const borderless = box.fill === true && box.stroke !== true;
    if (borderless) {
      const underlined = segments.some(
        (seg) => Math.abs(seg.y - box.y0) <= 2.5 && Math.abs(seg.x0 - box.x0) <= 3 && Math.abs(seg.x1 - box.x1) <= 3,
      );
      if (!underlined && height < BORDERLESS_MIN_HEIGHT_UNITS * REFERENCE_UNIT_PT) continue;
      // Un campo sombreado es de un tono claro; un relleno oscuro o saturado es un boton, una banda o una barra.
      if (box.shade !== undefined && box.shade < BORDERLESS_MIN_LUMINANCE) continue;
    }
    // Una cifra pegada a su derecha ("60%"): una barra con su valor.
    const mid = (box.y0 + box.y1) / 2;
    const hasValue = texts.some(
      (item) =>
        item.left >= box.x1 - 2 &&
        item.left - box.x1 <= VALUE_RIGHT_MAX_GAP_UNITS * REFERENCE_UNIT_PT &&
        Math.abs(item.baseline - mid) <= Math.max(height, item.height) &&
        isNumericValue(item.text),
    );
    if (hasValue) continue;
    const seg: Seg = { x0: box.x0, x1: box.x1, y: box.y0, thickness: 0, fromText: -1 };
    // Etiqueta a la izquierda: su base cae dentro de la altura de la caja.
    const leftOf = (target: PaintedBox, relaxed: boolean) =>
      usableLabel(
        chainLabel(
          texts
            .map((item, index) => ({ item, index }))
            .filter(
              ({ item }) =>
                item.right <= target.x0 + 3 &&
                target.x0 - item.right <= sameLineGap(item.height, relaxed) &&
                item.baseline >= target.y0 - 3 &&
                item.baseline <= target.y1 + 1,
            )
            .sort((a, b) => b.item.right - a.item.right),
          target.x0,
        ),
      );
    let left = leftOf(box, false);
    // Columna de cajas alineadas: otra caja con el mismo arranque ya tiene su etiqueta cerca; esta la tiene mas lejos.
    if (!left && distinct.some((other) => other !== box && Math.abs(other.x0 - box.x0) <= ALIGNED_COLUMN_TOLERANCE_PT && leftOf(other, false))) {
      left = leftOf(box, true);
    }
    // El rotulo de encima no puede ser una frase ni la ultima linea de un parrafo (un parrafo antes de una fila de cajas).
    const rawAbove = left ? undefined : usableLabel(aboveLabelOf({ ...seg, y: box.y1 }, texts, -1, pageWidth, 0.3));
    let above = rawAbove && !isProse(rawAbove.text) && isolatedCaption(rawAbove, texts) ? rawAbove : undefined;
    // Leyenda debajo de la caja (un campo con su pie: «Nombre del alumno» bajo el recuadro).
    let below = left ? undefined : usableLabel(belowLabelOf({ ...seg, thickness: 0.5 }, texts, -1));
    // Con rotulo encima Y leyenda debajo (una cuadricula de cajas con su rotulo, o filas de caja + leyenda) manda el texto mas cercano.
    if (above && below) {
      if (below.gap < BELOW_PREFERRED_RATIO * above.gap) above = undefined;
      else below = undefined;
    }
    if (!left && !above && !below) continue;
    out.push({ box, seg, left, above, below });
  }
  return out;
}

/**
 * La celda de valor lleva algo pintado dentro (una barra de color, un relleno parcial): es el renglon de un
 * diagrama (Gantt, progreso por filas), no un sitio para escribir. Una caja del mismo tamano que la celda es
 * la propia celda, no contenido.
 */
function hasPaintedContent(cell: { x0: number; y0: number; x1: number; y1: number }, boxes: readonly PaintedBox[]): boolean {
  const area = (cell.x1 - cell.x0) * (cell.y1 - cell.y0);
  return uniqueBoxes(boxes).some((b) => {
    if (b.fill !== true) return false;
    if (b.x0 < cell.x0 - 1 || b.x1 > cell.x1 + 1 || b.y0 < cell.y0 - 1 || b.y1 > cell.y1 + 1) return false;
    return (b.x1 - b.x0) * (b.y1 - b.y0) < 0.9 * area && b.x1 - b.x0 >= PAINTED_CONTENT_MIN_WIDTH_PT;
  });
}
const PAINTED_CONTENT_MIN_WIDTH_PT = 4;

/** Una celda de etiqueta de un formulario en tabla esta sombreada (luminancia por debajo de esto). */
const LABEL_CELL_MAX_LUMINANCE = 0.97;
const LABEL_CELL_MIN_HEIGHT_UNITS = 1.2;
const LABEL_CELL_MAX_HEIGHT_UNITS = 6;
const VALUE_CELL_MIN_WIDTH_UNITS = 4;
/** Columnas que puede haber a la izquierda de una celda de etiqueta (borde y un par anterior: 3 rayas verticales, 2 cajas). */
const LABEL_CELL_MAX_LEFT_VERTICALS = 3;
const LABEL_CELL_MAX_LEFT_BOXES = 2;
/** Un formulario en tabla tiene al menos tantas filas etiqueta + celda vacia. */
const LABEL_CELL_MIN_ROWS = 2;

type ValueCell = { x0: number; y0: number; x1: number; y1: number; label: LabelHit };

/**
 * Formulario en tabla: una celda de etiqueta SOMBREADA con texto y, pegada a su derecha, una celda VACIA
 * que cierra la fila (la celda donde se escribe). El sombreado distingue la columna de etiquetas de una
 * tabla de datos con celdas vacias (un horario, un calendario), donde la celda vacia no es un campo.
 */
function labelCellSlots(
  boxes: readonly PaintedBox[],
  segments: readonly Seg[],
  verticals: readonly VerticalSeg[],
  texts: readonly SlotText[],
  pageWidth: number,
): ValueCell[] {
  const distinct = uniqueBoxes(boxes);
  if (distinct.length > MAX_THIN_SEGMENTS_PER_PAGE) return [];
  const shaded = (box: PaintedBox) => box.fill === true && box.shade !== undefined && box.shade < LABEL_CELL_MAX_LUMINANCE;
  const unit = REFERENCE_UNIT_PT;
  const out: ValueCell[] = [];
  for (const cell of distinct) {
    if (!shaded(cell)) continue;
    const height = cell.y1 - cell.y0;
    if (height < LABEL_CELL_MIN_HEIGHT_UNITS * unit || height > LABEL_CELL_MAX_HEIGHT_UNITS * unit) continue;
    const inside = texts
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item }) =>
          (item.left + item.right) / 2 > cell.x0 &&
          (item.left + item.right) / 2 < cell.x1 &&
          item.baseline > cell.y0 - 1 &&
          item.baseline < cell.y1 + 1,
      );
    const joined = joinWords(inside);
    if (!joined || NUMERIC_LABEL.test(joined.text)) continue;
    const label: LabelHit = { text: joined.text, indices: joined.indices, gap: 0, height: joined.height, width: joined.right - joined.left };
    // La celda de valor: una caja pegada a la derecha, o el hueco que cierran las rayas de la fila.
    const sameRow = (a: number, b: number) => Math.abs(a - b) <= 2.5;
    // La etiqueta abre la fila (o el segundo par de una fila de dos pares): una "etiqueta" con muchas
    // columnas a su izquierda es una celda de una tabla de datos (un horario), no una columna de etiquetas.
    const leftVerticals = verticals.filter((v) => v.x <= cell.x0 + 2.5 && v.y0 <= cell.y0 + 2 && v.y1 >= cell.y1 - 2).length;
    const leftBoxes = distinct.filter(
      (other) => other !== cell && other.x1 <= cell.x0 + 2.5 && overlapLength(other.y0, other.y1, cell.y0, cell.y1) >= 0.5 * height,
    ).length;
    if (leftVerticals > LABEL_CELL_MAX_LEFT_VERTICALS || leftBoxes > LABEL_CELL_MAX_LEFT_BOXES) continue;
    let value: { x0: number; x1: number } | undefined;
    const box = distinct.find(
      (other) => other !== cell && !shaded(other) && sameRow(other.x0, cell.x1) && sameRow(other.y0, cell.y0) && sameRow(other.y1, cell.y1),
    );
    if (box) {
      // Si otra caja sigue vacia a su derecha, hay mas columnas de datos: no es un campo.
      const trailing = distinct.some((other) => other !== box && other !== cell && sameRow(other.x0, box.x1) && other.y0 < box.y1 && other.y1 > box.y0 && !shaded(other));
      if (!trailing) value = { x0: box.x0, x1: box.x1 };
    } else {
      // Las rayas de la fila pueden venir fundidas con las de la celda de etiqueta (mismo trazo continuo).
      const spansValue = (seg: Seg) => seg.x0 <= cell.x1 + 2.5 && seg.x1 >= cell.x1 + VALUE_CELL_MIN_WIDTH_UNITS * unit;
      const bottom = segments.find((seg) => sameRow(seg.y, cell.y0) && spansValue(seg));
      const top = segments.find((seg) => sameRow(seg.y, cell.y1) && spansValue(seg));
      if (bottom && top) {
        const x1 = Math.min(bottom.x1, top.x1);
        // Una raya vertical en medio de la celda parte la fila en mas columnas.
        const split = verticals.some((v) => v.x > cell.x1 + 2 * unit && v.x < x1 - 2 && v.y0 <= cell.y0 + 2 && v.y1 >= cell.y1 - 2);
        if (!split) value = { x0: cell.x1, x1 };
      }
    }
    if (!value) continue;
    const width = value.x1 - value.x0;
    if (width < VALUE_CELL_MIN_WIDTH_UNITS * unit || width > pageWidth * LABELLED_MAX_PAGE_FRACTION) continue;
    const occupied = texts.some(
      (item) =>
        (item.left + item.right) / 2 > value!.x0 &&
        (item.left + item.right) / 2 < value!.x1 &&
        item.baseline > cell.y0 - 1 &&
        item.baseline < cell.y1 + 1,
    );
    if (occupied) continue;
    if (hasPaintedContent({ x0: value.x0, y0: cell.y0, x1: value.x1, y1: cell.y1 }, boxes)) continue;
    out.push({ x0: value.x0, y0: cell.y0, x1: value.x1, y1: cell.y1, label });
  }
  return out.length >= LABEL_CELL_MIN_ROWS ? out : [];
}

/** Una celda de formulario oficial: el rotulo pequeno arriba a la izquierda y el resto de la celda, vacio. */
const CELL_MIN_HEIGHT_UNITS = 3;
const CELL_MAX_HEIGHT_UNITS = 12;
const CELL_MIN_WIDTH_UNITS = 5;
/** El rotulo ocupa la parte alta de la celda (como mucho esta fraccion de su altura, medida desde arriba). */
const CELL_CAPTION_TOP_FRACTION = 0.55;
const CELL_MIN_COUNT = 2;
const CELL_CAPTION_MAX_CHARS = 50;
const CELL_CLOSE_TOLERANCE_PT = 3;

type CaptionCell = { x0: number; y0: number; x1: number; y1: number; label: LabelHit };

/**
 * Formulario oficial denso (W-9, solicitudes): cada casilla es una celda con un rotulo pequeno arriba
 * ("1 Nombre", "2 Apellido") y el sitio para escribir debajo. Las celdas se cierran con rayas o cajas.
 * Hace falta mas de una celda asi en la pagina: una celda suelta no es un formulario. Un calendario
 * (el rotulo es un numero) o una tabla de datos (el texto llena la celda) no entran.
 */
/** Bordes horizontales y verticales de una tabla: rayas y paredes sueltas mas los lados de las cajas. */
function cellEdges(segments: readonly Seg[], verticals: readonly VerticalSeg[], boxes: readonly PaintedBox[]) {
  const unit = REFERENCE_UNIT_PT;
  const edges = boxes.length > MAX_THIN_SEGMENTS_PER_PAGE ? [] : uniqueBoxes(boxes).filter((b) => b.y1 - b.y0 >= 2 * unit && b.x1 - b.x0 >= 2 * unit);
  const horizontals = [
    ...segments.map((seg) => ({ x0: seg.x0, x1: seg.x1, y: seg.y })),
    ...edges.flatMap((b) => [
      { x0: b.x0, x1: b.x1, y: b.y0 },
      { x0: b.x0, x1: b.x1, y: b.y1 },
    ]),
  ];
  const walls = [
    ...verticals.map((v) => ({ x: v.x, y0: v.y0, y1: v.y1 })),
    ...edges.flatMap((b) => [
      { x: b.x0, y0: b.y0, y1: b.y1 },
      { x: b.x1, y0: b.y0, y1: b.y1 },
    ]),
  ];
  // Los bordes de celdas contiguas forman una sola raya continua (los lados de dos cajas pegadas).
  const merged: Array<{ x0: number; x1: number; y: number }> = [];
  for (const h of [...horizontals].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const last = merged.find((m) => Math.abs(m.y - h.y) <= 1.5 && h.x0 <= m.x1 + 2.5 && h.x1 >= m.x0 - 2.5);
    if (last) {
      last.x0 = Math.min(last.x0, h.x0);
      last.x1 = Math.max(last.x1, h.x1);
    } else merged.push({ ...h });
  }
  return { horizontals: merged, walls };
}

function captionCellSlots(
  texts: readonly SlotText[],
  segments: readonly Seg[],
  verticals: readonly VerticalSeg[],
  boxes: readonly PaintedBox[],
  pageWidth: number,
): CaptionCell[] {
  const unit = REFERENCE_UNIT_PT;
  const { horizontals, walls } = cellEdges(segments, verticals, boxes);
  if (horizontals.length === 0 || walls.length === 0) return [];
  const out: CaptionCell[] = [];
  // Los rotulos son pequenos: se parte de cada texto no numerico y se busca la celda que lo encierra.
  const unitText = documentUnit(texts);
  texts.forEach((item, index) => {
    if (item.text.length > CELL_CAPTION_MAX_CHARS || item.height > 1.3 * unitText) return;
    const cover = (h: { x0: number; x1: number }) => h.x0 <= item.left + 2 && h.x1 >= Math.min(item.right, item.left + 3 * unit) - 2;
    const top = horizontals.filter((h) => cover(h) && h.y > item.baseline && h.y - item.baseline <= 2.2 * item.height + 2).sort((a, b) => a.y - b.y)[0];
    const bottom = horizontals.filter((h) => cover(h) && h.y < item.baseline - CELL_MIN_HEIGHT_UNITS * unit * 0.6).sort((a, b) => b.y - a.y)[0];
    if (!top || !bottom) return;
    const cellHeight = top.y - bottom.y;
    if (cellHeight < CELL_MIN_HEIGHT_UNITS * unit || cellHeight > CELL_MAX_HEIGHT_UNITS * unit) return;
    // Rotulo en la parte alta de la celda.
    if (item.baseline < top.y - CELL_CAPTION_TOP_FRACTION * cellHeight) return;
    const spans = (w: { y0: number; y1: number }) => w.y0 <= bottom.y + 2 && w.y1 >= top.y - 2;
    const left = walls.filter((w) => spans(w) && w.x <= item.left + 1).sort((a, b) => b.x - a.x)[0];
    const right = walls.filter((w) => spans(w) && w.x >= item.right - 1).sort((a, b) => a.x - b.x)[0];
    if (!left || !right) return;
    const width = right.x - left.x;
    if (width < CELL_MIN_WIDTH_UNITS * unit || width > pageWidth * LABELLED_MAX_PAGE_FRACTION) return;
    if (item.left - left.x > 2.5 * unit) return;
    // Los bordes de arriba y de abajo cierran la celda de pared a pared (una regla con margen dentro de una tarjeta no).
    const closes = (h: { x0: number; x1: number }) => h.x0 <= left.x + CELL_CLOSE_TOLERANCE_PT && h.x1 >= right.x - CELL_CLOSE_TOLERANCE_PT;
    if (!closes(top) || !closes(bottom)) return;
    // Celda vacia salvo su rotulo (el rotulo puede venir partido en palabras).
    const inside = texts
      .map((other, otherIndex) => ({ item: other, index: otherIndex }))
      .filter(({ item: other }) => other.left < right.x && other.right > left.x && other.baseline > bottom.y && other.baseline < top.y);
    const joined = joinWords(inside.filter(({ item: other }) => Math.abs(other.baseline - item.baseline) <= 2));
    if (!joined || joined.indices[0] !== index && !joined.indices.includes(index)) return;
    if (inside.length !== joined.indices.length) return;
    if (NUMERIC_LABEL.test(joined.text) || PAGE_MARKER.test(joined.text)) return;
    if (item.baseline - bottom.y < 2 * unit) return;
    out.push({
      x0: left.x,
      x1: right.x,
      y0: bottom.y,
      y1: item.baseline - 0.4 * item.height,
      label: { text: joined.text, indices: joined.indices, gap: 0, height: joined.height, width: joined.right - joined.left },
    });
  });
  // Un mismo rotulo partido en palabras genera la misma celda varias veces.
  const unique = out.filter((cell, i) => out.findIndex((other) => Math.abs(other.x0 - cell.x0) < 1 && Math.abs(other.y0 - cell.y0) < 1) === i);
  return unique.length >= CELL_MIN_COUNT ? unique : [];
}

/** Tabla de dos columnas SIN sombreado: etiqueta | celda vacia, en tres filas o mas con las mismas columnas. */
const KV_MIN_ROWS = 3;
const KV_MIN_ROW_HEIGHT_UNITS = 1.4;
const KV_MAX_ROW_HEIGHT_UNITS = 6;
const KV_COLUMN_TOLERANCE_PT = 2.5;

/**
 * Formulario en tabla sin sombrear (un cuadro de Word): la primera columna lleva el rotulo de cada fila
 * y la ultima, vacia, es donde se escribe. Se exigen tres filas seguidas con las MISMAS columnas, todas con
 * rotulo en la primera celda y la segunda vacia, y que la segunda sea la ultima columna: asi una tabla de datos
 * (varias columnas, celdas con texto) o un horario no cuentan. Las filas de etiquetas numericas (un calendario,
 * un horario) tampoco.
 */
function keyValueRowSlots(
  texts: readonly SlotText[],
  segments: readonly Seg[],
  verticals: readonly VerticalSeg[],
  boxes: readonly PaintedBox[],
  pageWidth: number,
): ValueCell[] {
  const unit = REFERENCE_UNIT_PT;
  const { horizontals, walls } = cellEdges(segments, verticals, boxes);
  if (horizontals.length === 0 || walls.length === 0) return [];
  type Row = ValueCell & { left: number; mid: number };
  const rows: Row[] = [];
  const seen = new Set<string>();
  texts.forEach((item, index) => {
    if (item.text.length > CELL_CAPTION_MAX_CHARS) return;
    const cover = (h: { x0: number; x1: number }) => h.x0 <= item.left + 2 && h.x1 >= Math.min(item.right, item.left + 3 * unit) - 2;
    const top = horizontals.filter((h) => cover(h) && h.y > item.baseline && h.y - item.baseline <= 3.5 * unit).sort((a, b) => a.y - b.y)[0];
    const bottom = horizontals.filter((h) => cover(h) && h.y < item.baseline && item.baseline - h.y <= 4 * unit).sort((a, b) => b.y - a.y)[0];
    if (!top || !bottom) return;
    const rowHeight = top.y - bottom.y;
    if (rowHeight < KV_MIN_ROW_HEIGHT_UNITS * unit || rowHeight > KV_MAX_ROW_HEIGHT_UNITS * unit) return;
    const spans = (w: { y0: number; y1: number }) => w.y0 <= bottom.y + 2 && w.y1 >= top.y - 2;
    const left = walls.filter((w) => spans(w) && w.x <= item.left + 1).sort((a, b) => b.x - a.x)[0];
    const mid = walls.filter((w) => spans(w) && w.x >= item.right - 1).sort((a, b) => a.x - b.x)[0];
    if (!left || !mid || item.left - left.x > 2.5 * unit) return;
    // La etiqueta abre la fila (o el segundo par de una fila de dos pares): con mas columnas a su izquierda es una celda de datos.
    // (las paredes se cuentan una vez por posicion: el lado de una caja y el de la siguiente coinciden)
    const leftWallXs = walls.filter((w) => spans(w) && w.x <= left.x + 2.5).map((w) => Math.round(w.x / 2));
    if (new Set(leftWallXs).size > LABEL_CELL_MAX_LEFT_VERTICALS) return;
    // La fila acaba donde acaban sus rayas de arriba y de abajo (o en una pared a la derecha).
    const closing = walls.filter((w) => spans(w) && w.x > mid.x + 2).sort((a, b) => a.x - b.x)[0];
    const end = Math.min(top.x1, bottom.x1);
    // La celda de valor es la ULTIMA columna: si otra pared la cierra antes del final de la fila, hay mas columnas (una tabla de datos).
    // (salvo que le siga la etiqueta de un segundo par: etiqueta | vacia | etiqueta | vacia)
    if (closing && closing.x < end - 2.5) {
      const nextLabel = texts.some(
        (other) => other.baseline > bottom.y && other.baseline < top.y && other.left >= closing.x - 1 && other.left <= closing.x + 2.5 * unit,
      );
      if (!nextLabel) return;
    }
    const right = closing && closing.x <= end + 2 ? closing.x : end;
    // Debe cerrar de pared a pared por arriba y por abajo, sin mas paredes en medio de la celda de valor.
    if (top.x0 > left.x + CELL_CLOSE_TOLERANCE_PT || bottom.x0 > left.x + CELL_CLOSE_TOLERANCE_PT) return;
    if (top.x1 < right - CELL_CLOSE_TOLERANCE_PT || bottom.x1 < right - CELL_CLOSE_TOLERANCE_PT) return;
    if (walls.some((w) => spans(w) && w.x > mid.x + 2 && w.x < right - 2)) return;
    const labelWidth = mid.x - left.x;
    const valueWidth = right - mid.x;
    if (valueWidth < VALUE_CELL_MIN_WIDTH_UNITS * unit || valueWidth > pageWidth * LABELLED_MAX_PAGE_FRACTION || valueWidth < 0.8 * labelWidth) return;
    // La celda de valor esta vacia; la de etiqueta lleva solo su texto (en varias palabras o lineas).
    const inside = texts
      .map((other, otherIndex) => ({ item: other, index: otherIndex }))
      .filter(({ item: other }) => other.baseline > bottom.y && other.baseline < top.y && other.right > left.x && other.left < right);
    const labelWords = inside.filter(({ item: other }) => other.right <= mid.x + 1);
    if (labelWords.length !== inside.length || !labelWords.some(({ index: i }) => i === index)) return;
    const joined = joinWords(labelWords.filter(({ item: other }) => Math.abs(other.baseline - item.baseline) <= 2));
    if (!joined || NUMERIC_LABEL.test(joined.text) || PAGE_MARKER.test(joined.text)) return;
    if (hasPaintedContent({ x0: mid.x, y0: bottom.y, x1: right, y1: top.y }, boxes)) return;
    const key = `${Math.round(left.x)}|${Math.round(mid.x)}|${Math.round(bottom.y)}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      left: left.x,
      mid: mid.x,
      x0: mid.x,
      y0: bottom.y,
      x1: right,
      y1: top.y,
      label: { text: joined.text, indices: joined.indices, gap: 0, height: joined.height, width: joined.right - joined.left },
    });
  });
  // Tres filas o mas con las mismas columnas.
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const keyCols = [...groups.keys()].find((key) => {
      const [l, m] = key.split("|").map(Number);
      return Math.abs(l - row.left) <= KV_COLUMN_TOLERANCE_PT && Math.abs(m - row.mid) <= KV_COLUMN_TOLERANCE_PT;
    });
    const key = keyCols ?? `${row.left}|${row.mid}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].filter((group) => group.length >= KV_MIN_ROWS).flat();
}

/** Una frase (no la etiqueta de un campo): muchas palabras o puntuacion de cierre. */
function isProse(text: string): boolean {
  const clean = text.trim();
  const words = clean.split(/\s+/).filter(Boolean);
  // Un rotulo que termina en dos puntos o interrogacion ("Nombre completo del solicitante:") es de un campo.
  if (/[:?]$/.test(clean)) return words.length >= PROSE_MIN_WORDS_COLON;
  if (/[.,;]$/.test(clean)) return words.length >= PROSE_MIN_WORDS_PUNCTUATED;
  return words.length >= PROSE_MIN_WORDS;
}

/**
 * Unidad tipografica del documento: el tamano de letra tipico (mediana de la altura del
 * texto ponderada por numero de caracteres). Toda la deteccion se mide en esta unidad, no en
 * puntos: un formulario ampliado, reducido o con letra mas grande se analiza igual.
 */
export function documentUnit(texts: ReadonlyArray<Pick<SlotText, "text" | "height">>): number {
  const weighted = texts
    .filter((item) => item.height > 0 && item.text.trim().length >= 2)
    .map((item) => ({ height: item.height, weight: item.text.trim().length }))
    .sort((a, b) => a.height - b.height);
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total === 0) return REFERENCE_UNIT_PT;
  let acc = 0;
  for (const item of weighted) {
    acc += item.weight;
    if (acc >= total / 2) return Math.min(Math.max(item.height, MIN_UNIT_PT), MAX_UNIT_PT);
  }
  return REFERENCE_UNIT_PT;
}

function scaleInput(input: SlotInput, s: number): SlotInput {
  return {
    segments: input.segments.map((seg) => ({ ...seg, x0: seg.x0 * s, x1: seg.x1 * s, y: seg.y * s, thickness: seg.thickness * s })),
    verticals: input.verticals.map((v) => ({ x: v.x * s, y0: v.y0 * s, y1: v.y1 * s })),
    boxes: input.boxes.map((b) => ({ ...b, x0: b.x0 * s, y0: b.y0 * s, x1: b.x1 * s, y1: b.y1 * s })),
    texts: input.texts.map((t) => ({ ...t, left: t.left * s, right: t.right * s, baseline: t.baseline * s, height: t.height * s })),
    dashes: input.dashes?.map((d) => ({ x0: d.x0 * s, x1: d.x1 * s, y: d.y * s, thickness: d.thickness * s })),
    pageWidth: input.pageWidth * s,
    pageHeight: input.pageHeight * s,
  };
}

/**
 * Huecos de relleno de una pagina. Invariante a la escala: la geometria se normaliza a una
 * unidad tipografica de referencia (11 pt) y los umbrales de este archivo se expresan en esa unidad.
 */
export function findFillSlots(
  input: SlotInput,
  limit: number = MAX_SLOTS_PER_PAGE,
): SlotCandidate[] {
  const unit = documentUnit(input.texts);
  const s = REFERENCE_UNIT_PT / unit;
  if (Math.abs(s - 1) < 1e-6) return findFillSlotsReference(input, limit);
  const back = (value: number) => Math.round((value / s) * 1e6) / 1e6;
  return findFillSlotsReference(scaleInput(input, s), limit).map((slot) => ({
    ...slot,
    box: { x: back(slot.box.x), y: back(slot.box.y), width: back(slot.box.width), height: back(slot.box.height) },
  }));
}

type SegInfo = {
  seg: Seg;
  left?: LabelHit;
  above?: LabelHit;
  below?: LabelHit;
  right?: LabelHit;
  hit: LabelHit | undefined;
  width: number;
};

/** Ancho util: el rango horizontal que ocupa TODO el contenido (textos, rayas y cajas), no el del papel (margenes de 0,25 pulgadas). */
function usableWidthOf(input: SlotInput): number {
  const lefts = [...input.texts.map((t) => t.left), ...input.segments.map((s) => s.x0), ...input.boxes.map((b) => b.x0)];
  const rights = [...input.texts.map((t) => t.right), ...input.segments.map((s) => s.x1), ...input.boxes.map((b) => b.x1)];
  if (lefts.length === 0) return input.pageWidth;
  return Math.min(input.pageWidth, Math.max(Math.max(...rights) - Math.min(...lefts), USABLE_MIN_PAGE_FRACTION * input.pageWidth));
}
const USABLE_MIN_PAGE_FRACTION = 0.4;

function findFillSlotsReference(input: SlotInput, limit: number): SlotCandidate[] {
  const { texts, verticals, boxes } = input;
  const usableWidth = usableWidthOf(input);
  const maxWidth = input.pageWidth * SLOT_MAX_PAGE_FRACTION;

  const thin = [...input.segments, ...mergeDashes(input.dashes ?? [])].filter(
    (seg) => seg.thickness <= SLOT_MAX_THICKNESS_PT && seg.x1 - seg.x0 >= (seg.fromText >= 0 ? TEXT_RUN_MIN_WIDTH_PT : SLOT_MIN_WIDTH_PT),
  );
  // Pagina decorativa o muy compleja (degradados de miles de franjas): no es un formulario.
  if (thin.length > MAX_THIN_SEGMENTS_PER_PAGE) return [];

  const merged = mergeSegments(thin);
  // La pila se calcula con TODAS las rayas (tambien las anchas): una tabla con bordes a todo
  // lo ancho y celdas por separado sigue siendo una tabla.
  const runs = stackRuns(merged);

  /**
   * Un campo apilado con rotulo ENCIMA o DEBAJO solo vale si la pila parece una lista de campos
   * (rotulos cortos, sitio para escribir y rotulo en casi todos los renglones), no una tabla o
   * papel pautado, donde solo el encabezado lleva texto.
   */
  const stackOk = (
    hit: LabelHit | undefined,
    width: number,
    kind: "above" | "below" | "box",
    captioned: number,
    total: number,
  ): boolean => {
    if (!hit) return false;
    if (hit.width > STACK_CAPTION_MAX_FRACTION * width) return false;
    if (captioned < STACK_MIN_CAPTIONED_RATIO * total) return false;
    // El sitio para escribir de una caja es la propia caja; el de una raya, el hueco hasta su rotulo.
    return kind !== "above" || hit.gap >= ABOVE_ROOM_FACTOR * hit.height;
  };

  const slots = boxSlots(boxes, texts, merged, input.pageWidth);
  const boxRuns = stackRuns(slots.map((slot) => slot.seg));
  const out: SlotCandidate[] = [];

  for (const slot of slots) {
    const width = slot.box.x1 - slot.box.x0;
    const run = boxRuns.get(slot.seg);
    if (!slot.left && run && !stackOk(slot.above ?? slot.below, width, slot.above ? "box" : "below", run.length, run.length)) continue;
    const hit = slot.left ?? slot.above ?? slot.below!;
    let score = slot.left ? 3.5 : 2;
    if (slot.left && /[:_.]$/.test(hit.text)) score += 1;
    if (width >= 60 && width <= 300) score += 1;
    if (hit.text.length > 3) score += 0.5;
    out.push({
      box: { x: slot.box.x0, y: slot.box.y0, width, height: slot.box.y1 - slot.box.y0 },
      label: hit.text,
      kind: slot.left ? "left" : slot.above ? "above" : "below",
      score,
    });
  }
  const accepted = slots.map((slot) => slot.box);

  for (const cell of labelCellSlots(boxes, merged, verticals, texts, input.pageWidth)) {
    out.push({
      box: { x: cell.x0, y: cell.y0, width: cell.x1 - cell.x0, height: cell.y1 - cell.y0 },
      label: cell.label.text,
      kind: "left",
      score: 3.5,
    });
  }

  const walls: Walls = { boxes, verticals };
  const owners = [...merged.map((line) => ({ x0: line.x0, x1: line.x1, y: line.y })), ...uniqueBoxes(boxes).map((b) => ({ x0: b.x0, x1: b.x1, y: b.y0 }))];
  const shadedCells = labelCellSlots(boxes, merged, verticals, texts, input.pageWidth);
  for (const cell of keyValueRowSlots(texts, merged, verticals, boxes, input.pageWidth)) {
    // (una fila ya hallada como celda sombreada no se repite)
    if (shadedCells.some((other) => Math.abs(other.x0 - cell.x0) < 3 && Math.abs(other.y0 - cell.y0) < 3)) continue;
    out.push({
      box: { x: cell.x0, y: cell.y0, width: cell.x1 - cell.x0, height: cell.y1 - cell.y0 },
      label: cell.label.text,
      kind: "left",
      score: 3.3,
    });
  }
  for (const cell of captionCellSlots(texts, merged, verticals, boxes, input.pageWidth)) {
    out.push({
      box: { x: cell.x0, y: cell.y0, width: cell.x1 - cell.x0, height: cell.y1 - cell.y0 },
      label: cell.label.text,
      kind: "above",
      score: 2.5,
    });
  }

  const infos: SegInfo[] = [];
  for (const seg of merged) {
    if (seg.x1 - seg.x0 > input.pageWidth * LABELLED_MAX_PAGE_FRACTION) continue;
    if (seg.thickness > SLOT_MAX_FIELD_THICKNESS_PT * MAX_THICKNESS_LABEL_FACTOR || seg.layered) continue;
    const skip = seg.fromText;
    // El borde de una caja que YA es un campo no es otro campo; el de cualquier otra caja, tampoco.
    if (borderOfBox(seg, boxes) || borderOfBox(seg, accepted)) continue;
    if (touchesVertical(seg, verticals)) continue;
    if (crossesText(seg, texts, skip)) continue;
    if (onLineCoverage(seg, texts, skip) >= 0.5) continue;

    let left = leftLabelOf(seg, texts, skip, false, walls);
    // Columna de rayas alineadas: otra raya con el mismo arranque ya tiene su etiqueta cerca; esta la tiene mas lejos.
    if (!left && merged.some((other) => other !== seg && Math.abs(other.x0 - seg.x0) <= ALIGNED_COLUMN_TOLERANCE_PT && leftLabelOf(other, texts, other.fromText, false, walls))) {
      left = leftLabelOf(seg, texts, skip, true, walls);
    }
    // Renglones altos de una lista (una tabla sin bordes verticales): la etiqueta, centrada en la fila, queda mas arriba de la raya.
    // Solo vale si TODOS los renglones de la pila la llevan igual (una lista de campos), no si es un caso suelto.
    if (!left && runs.get(seg)) {
      const run = runs.get(seg)!;
      if (run.every((member) => leftLabelOf(member, texts, member.fromText, true, walls, true))) left = leftLabelOf(seg, texts, skip, true, walls, true);
    }
    left = usableLabel(left ?? wrappedLabelOf(seg, texts, skip));
    // Un rotulo de encima que no deja sitio para escribir o es la ultima linea de un parrafo no es un rotulo:
    // la raya puede llevar entonces su leyenda debajo o a la derecha.
    const rawAbove = left ? undefined : usableLabel(aboveLabelOf(seg, texts, skip, usableWidth, undefined, owners));
    const above = rawAbove && rawAbove.gap >= ABOVE_MIN_ROOM * rawAbove.height && isolatedCaption(rawAbove, texts) ? rawAbove : undefined;
    const below = left || above ? undefined : usableLabel(belowLabelOf(seg, texts, skip));
    let right = left || above || below ? undefined : usableLabel(rightLabelOf(seg, texts, skip));
    // Una raya con texto a AMBOS lados en su linea (hora ........ evento) es una guia de puntos entre dos textos, no un hueco.
    if (right && (seg.inlineLabel || hasTextLeftOnLine(seg, texts, skip))) right = undefined;
    // Una raya sin etiqueta es decoracion.
    if (!left && !above && !below && !right) continue;
    // Una raya de relleno es fina respecto a la letra de SU etiqueta (no del resto del documento): una barra no lo es.
    const labelHeight = (left ?? above ?? below ?? right)?.height ?? 0;
    if (seg.thickness > Math.max(SLOT_MAX_FIELD_THICKNESS_PT, THICKNESS_LABEL_EM * labelHeight)) continue;
    const width = seg.x1 - seg.x0;
    const caption = above ?? below ?? right;
    // Mas de media pagina: con una etiqueta corta PEGADA a su izquierda ("Nombre: ______") o con un
    // rotulo de campo encima que deja sitio para escribir (una linea de respuesta de una encuesta).
    if (width > maxWidth) {
      const wideLeft =
        left !== undefined &&
        left.height <= WIDE_LEFT_LABEL_MAX_HEIGHT_UNITS * REFERENCE_UNIT_PT &&
        left.text.length <= WIDE_LEFT_LABEL_MAX_CHARS;
      const wideAbove = above !== undefined && above.gap >= WIDE_ABOVE_ROOM_FACTOR * above.height;
      const wideRight = right !== undefined && right.text.length <= WIDE_LEFT_LABEL_MAX_CHARS;
      // Una linea de firma de lado a lado con su leyenda debajo; no la regla de una cabecera o un pie de pagina.
      const wideBelow =
        below !== undefined &&
        below.text.length <= WIDE_BELOW_MAX_CHARS &&
        width <= input.pageWidth * WIDE_BELOW_MAX_PAGE_FRACTION &&
        seg.y > input.pageHeight * HEADER_FOOTER_FRACTION &&
        seg.y < input.pageHeight * (1 - HEADER_FOOTER_FRACTION) &&
        // Aislada: sitio libre encima (donde se firma) y nada debajo de la leyenda (un titular tiene su texto debajo).
        !texts.some(
          (item, index) =>
            index !== skip &&
            !below.indices.includes(index) &&
            overlapLength(seg.x0, seg.x1, item.left, item.right) > 0 &&
            ((item.baseline > seg.y && item.baseline <= seg.y + WIDE_BELOW_CLEAR_UNITS * REFERENCE_UNIT_PT) ||
              (item.baseline < seg.y - below.gap && item.baseline >= seg.y - below.gap - WIDE_BELOW_CLEAR_UNITS * REFERENCE_UNIT_PT)),
        );
      if (!wideLeft && !wideAbove && !wideBelow && !wideRight) continue;
    }
    // Raya de puntos/guiones entre un concepto y una cifra ("Capitulo 3 ........ 45", un menu con precios).
    if (left) {
      const leader = texts.some(
        (item, index) =>
          index !== skip &&
          item.left >= seg.x1 - 2 &&
          item.left - seg.x1 <= LEADER_RIGHT_GAP_PT &&
          Math.abs(item.baseline - seg.y) <= 0.8 * item.height + 2 &&
          isNumericValue(item.text),
      );
      if (leader) continue;
    }
    // Un rotulo que es una frase no etiqueta un campo (una `<hr>` bajo un parrafo de una tarjeta).
    // (salvo una frase con mucho sitio de escritura debajo: la pregunta de un examen o una encuesta)
    if (!left && caption && isProse(caption.text) && !(above && above.gap >= PROMPT_ROOM_FACTOR * above.height)) continue;
    if (above && !left) {
      // El campo deja sitio para escribir entre el rotulo y la raya.
      // (un rotulo bastante mayor que el texto corriente, 1,3 veces, es casi un titular: pide mas sitio, como la regla de una tarjeta)
      const bigCaption = above.height > BIG_CAPTION_UNITS * REFERENCE_UNIT_PT;
      if (above.gap < (bigCaption ? BIG_CAPTION_ROOM : ABOVE_MIN_ROOM) * above.height) continue;
      // La ultima linea de un parrafo (con otra linea de texto pegada encima) no es un rotulo.
      if (!isolatedCaption(above, texts)) continue;
      // Raya con rotulo encima y texto justo debajo: separa dos contenidos, no es un hueco.
      const separator = texts.some(
        (item, index) =>
          index !== skip &&
          item.baseline < seg.y - 2 &&
          item.baseline >= seg.y - SEPARATOR_BELOW_PT &&
          overlapLength(seg.x0, seg.x1, item.left, item.right) >= 0.3 * Math.min(width, item.right - item.left),
      );
      if (separator) continue;
    }
    // Texto de una fila de datos o de totales justo encima de la raya (importe alineado con su
    // etiqueta): el sitio de escritura esta ocupado, no es un hueco.
    const labelIndices = new Set([...(left?.indices ?? []), ...(above?.indices ?? []), ...(below?.indices ?? []), ...(right?.indices ?? [])]);
    // Con rotulo encima, todo el hueco entre el rotulo y la raya es el sitio de escritura.
    const band = above ? Math.max(OCCUPIED_BAND_PT, above.gap - OCCUPIED_CAPTION_MARGIN * above.height) : OCCUPIED_BAND_PT;
    const occupied = texts.some(
      (item, index) =>
        index !== skip &&
        !labelIndices.has(index) &&
        item.baseline > seg.y + 0.5 &&
        item.baseline <= seg.y + band &&
        overlapLength(seg.x0, seg.x1, item.left, item.right) >= 2,
    );
    if (occupied) continue;
    // La fila del rotulo no lleva otro texto sobre el tramo de la raya (un importe frente a su concepto).
    if (above && above.indices.length > 0) {
      const captionBase = texts[above.indices[0]].baseline;
      const rowText = texts.some(
        (item, index) =>
          index !== skip &&
          !labelIndices.has(index) &&
          Math.abs(item.baseline - captionBase) <= 2 &&
          overlapLength(seg.x0, seg.x1, item.left, item.right) >= 2,
      );
      if (rowText) continue;
    }
    // ... y no hay nada pintado en ese hueco (barras, imagenes, cajas): el sitio esta ocupado.
    if (above) {
      const top = above.indices.length > 0 ? texts[above.indices[0]].baseline : seg.y + above.gap;
      const painted = boxes.some(
        (box) =>
          box.y0 >= seg.y - 1 &&
          box.y1 <= top &&
          overlapLength(seg.x0, seg.x1, box.x0, box.x1) >= 0.1 * Math.min(width, box.x1 - box.x0),
      );
      if (painted) continue;
    }
    // Una barra rellena apoyada sobre la raya (barra de un Gantt sobre su renglon): el sitio esta ocupado.
    const barOnLine = boxes.some(
      (box) =>
        box.fill === true &&
        box.stroke !== true &&
        box.y0 >= seg.y - 2.5 &&
        box.y0 <= seg.y + 4 &&
        box.y1 - box.y0 <= BAR_MAX_HEIGHT_UNITS * REFERENCE_UNIT_PT &&
        overlapLength(seg.x0, seg.x1, box.x0, box.x1) >= 0.1 * width,
    );
    if (barOnLine) continue;
    const hit = left ?? above ?? below ?? right;
    // Raya de la columna de importes con rotulo de totales ("Subtotal", "IVA"): subrayado de una cifra.
    if (hit && TOTALS_LABEL.test(hit.text) && seg.x1 >= input.pageWidth * TOTALS_RIGHT_FRACTION) continue;
    infos.push({ seg, left, above, below, right, hit, width });
  }
  // Una etiqueta a la derecha solo cuenta en una lista de campos (varias rayas asi), no como un caso suelto.
  const rightCount = infos.filter((info) => info.right).length;

  const infoOf = new Map<Seg, SegInfo>(infos.map((info) => [info.seg, info]));
  for (const info of infos) {
    const { seg, left, above, below, right, hit, width } = info;
    if (right && rightCount < RIGHT_LABEL_MIN_COUNT) continue;
    // En una pila (tabla, papel pautado): con etiqueta a la izquierda siempre; con rotulo encima o
    // debajo solo si es una lista de campos con rotulos cortos, sitio para escribir y rotulo en casi todos los renglones.
    const run = runs.get(seg);
    if (run && !left && !right) {
      const members = run.map((member) => infoOf.get(member));
      // Un renglon sin rotulo pegado a uno con rotulo (la segunda, tercera linea de una respuesta) continua esa
      // respuesta: no cuenta en la proporcion de renglones con rotulo.
      const continuations = new Set<Seg>();
      const chain = new Map<Seg, number>();
      const byHeight = [...run].sort((a, b) => b.y - a.y);
      byHeight.forEach((member, index) => {
        const previous = byHeight[index - 1];
        if (!previous || infoOf.has(member)) return;
        const length = infoOf.has(previous) ? 0 : (chain.get(previous) ?? Number.POSITIVE_INFINITY);
        // Pocos renglones (un campo de comentarios de 3 o 4 lineas); decenas son papel pautado.
        if ((infoOf.has(previous) || continuations.has(previous)) && length < CONTINUATION_MAX_LINES && previous.y - member.y <= CONTINUATION_MAX_GAP_UNITS * REFERENCE_UNIT_PT) {
          continuations.add(member);
          chain.set(member, length + 1);
        }
      });
      const total = run.filter((member) => !continuations.has(member)).length;
      const captioned = members.filter(Boolean).length;
      // Una pila donde la mayoria de renglones lleva su etiqueta a la izquierda es una lista de campos
      // ("Yo, ____ con documento ____"): el renglon que cae sin etiqueta propia es uno mas.
      const labelLed = members.filter((member) => member?.left || member?.right).length >= 0.5 * run.length;
      if (!labelLed && !stackOk(above ?? below, width, above ? "above" : "below", captioned, total)) continue;
    }

    let score = left ? 3 : below || right ? 2 : 1.5;
    if (left && /[:_.]$/.test(left.text)) score += 1;
    if (width >= 60 && width <= 300) score += 1;
    if (seg.thickness <= 2) score += 0.5;
    if ((hit?.text ?? "").length > 3) score += 0.5;
    if (seg.fromText >= 0) score += 0.25;

    out.push({
      box: {
        x: seg.x0,
        y: seg.y - Math.max(seg.thickness, 0.5) / 2,
        width,
        height: Math.max(seg.thickness, 0.5),
      },
      label: hit?.text,
      kind: seg.inlineLabel ? "inline" : left ? "left" : above ? "above" : below ? "below" : "right",
      score,
    });
  }

  // Los mejores primero; luego, orden de lectura (arriba abajo, izquierda a derecha).
  out.sort((a, b) => b.score - a.score);
  const kept = out.slice(0, limit);
  kept.sort((a, b) => b.box.y - a.box.y || a.box.x - b.box.x);
  return kept;
}
