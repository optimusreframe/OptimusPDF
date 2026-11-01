/**
 * Maquetacion del texto leido: de CAJAS con posicion (capa de texto de un PDF, palabras de un OCR, o lineas de un texto pegado)
 * a LINEAS con CELDAS. Una celda es un tramo de texto continuo; entre celdas hay un hueco grande (columnas de una tabla, un
 * valor puesto a la derecha de su etiqueta). El texto de una linea une las celdas con un tabulador, asi las reglas ven a la vez
 * «Etiqueta: valor» y «Etiqueta <hueco> valor».
 *
 * Coordenadas: origen ARRIBA-izquierda, `y` crece hacia abajo, en la unidad de la fuente (puntos en un PDF, pixeles en una
 * imagen, columnas/filas en un texto pegado). Las proporciones (alto de letra) hacen que los umbrales valgan en cualquiera.
 */

import { collapseSpaces, normalizeText } from "@/lib/autofill/text";

export type TextBox = { text: string; x0: number; x1: number; y0: number; y1: number; confidence?: number };

export type Cell = { text: string; x0: number; x1: number; confidence?: number };

export type TextLine = {
  /** Celdas unidas con «\t». */
  text: string;
  cells: Cell[];
  /** Desplazamiento de cada celda dentro de `text`. */
  starts: number[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Alto de letra tipico de la linea. */
  size: number;
  /** Posicion de la linea dentro de la pagina (0..n-1). */
  index: number;
};

export type TextOrigin = "text-layer" | "ocr" | "pasted";

export type TextPage = {
  index: number;
  width: number;
  height: number;
  lines: TextLine[];
  origin: TextOrigin;
};

/** Hueco horizontal (en alturas de letra) a partir del cual dos tramos son celdas distintas. */
export const CELL_GAP_EM = 2.2;
/** Por debajo de este hueco los tramos se pegan sin espacio (una palabra partida por el lector). */
const GLUE_GAP_EM = 0.12;
/** Separacion vertical maxima (en alturas) entre una linea y la siguiente para considerarlas contiguas. */
export const NEXT_LINE_GAP_EM = 1.6;
/** Tope de cajas por pagina: una pagina con mas es un grafico o un ataque, no un formulario. */
export const MAX_BOXES_PER_PAGE = 40_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Agrupa las cajas en lineas (por centro vertical) y cada linea en celdas (por hueco horizontal). Determinista: el orden de
 * entrada no importa. Las cajas sin coordenadas finitas o sin texto se descartan.
 */
export function buildLines(input: readonly TextBox[], limit = MAX_BOXES_PER_PAGE): TextLine[] {
  const boxes: TextBox[] = [];
  for (const box of input) {
    if (boxes.length >= limit) break;
    if (![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite)) continue;
    const text = normalizeText(box.text).replace(/[\t\r\n]+/g, " ");
    if (text.trim() === "") continue;
    boxes.push({ ...box, text, x1: Math.max(box.x1, box.x0) });
  }
  if (boxes.length === 0) return [];
  const center = (box: TextBox): number => (box.y0 + box.y1) / 2;
  const height = (box: TextBox): number => Math.max(box.y1 - box.y0, 0.01);
  boxes.sort((a, b) => center(a) - center(b) || a.x0 - b.x0);

  const groups: Array<{ boxes: TextBox[]; center: number; height: number }> = [];
  for (const box of boxes) {
    const h = height(box);
    const last = groups[groups.length - 1];
    if (last && Math.abs(center(box) - last.center) <= 0.5 * Math.min(h, last.height)) {
      last.boxes.push(box);
      last.center += (center(box) - last.center) / last.boxes.length;
      last.height += (h - last.height) / last.boxes.length;
    } else {
      groups.push({ boxes: [box], center: center(box), height: h });
    }
  }

  const lines: TextLine[] = [];
  for (const group of groups) {
    const ordered = [...group.boxes].sort((a, b) => a.x0 - b.x0);
    const size = median(ordered.map(height));
    const cells: Cell[] = [];
    let current: { text: string; x0: number; x1: number; confidence?: number } | null = null;
    let runEnd = -Infinity;
    for (const box of ordered) {
      const h = Math.max(Math.min(height(box), size * 1.6), size * 0.6);
      const gap = box.x0 - runEnd;
      if (current === null || gap >= CELL_GAP_EM * h) {
        if (current) cells.push(current);
        current = { text: box.text, x0: box.x0, x1: box.x1, confidence: box.confidence };
      } else {
        const glue = gap >= -0.3 * h && gap < GLUE_GAP_EM * h;
        const spaced = current.text.endsWith(" ") || box.text.startsWith(" ");
        current.text += glue || spaced ? box.text : ` ${box.text}`;
        current.x1 = Math.max(current.x1, box.x1);
        if (box.confidence !== undefined) current.confidence = current.confidence === undefined ? box.confidence : Math.min(current.confidence, box.confidence);
      }
      runEnd = Math.max(runEnd, box.x1);
    }
    if (current) cells.push(current);
    const cleaned: Cell[] = [];
    for (const cell of cells) {
      const text = collapseSpaces(cell.text);
      if (text !== "") cleaned.push({ text, x0: cell.x0, x1: cell.x1, confidence: cell.confidence });
    }
    if (cleaned.length === 0) continue;
    const starts: number[] = [];
    let offset = 0;
    for (const cell of cleaned) {
      starts.push(offset);
      offset += cell.text.length + 1;
    }
    lines.push({
      text: cleaned.map((cell) => cell.text).join("\t"),
      cells: cleaned,
      starts,
      x0: Math.min(...cleaned.map((cell) => cell.x0)),
      x1: Math.max(...cleaned.map((cell) => cell.x1)),
      y0: Math.min(...ordered.map((box) => box.y0)),
      y1: Math.max(...ordered.map((box) => box.y1)),
      size: Math.max(size, 0.01),
      index: lines.length,
    });
  }
  return lines;
}

/**
 * Texto pegado -> cajas: una por celda; la columna hace de `x` y la fila de `y`. Una linea en blanco deja un salto de fila
 * (separa bloques: «debajo de la etiqueta» no la cruza). Las celdas se separan con tabuladores, «|» o tres espacios seguidos.
 */
export function pastedBoxes(text: string): TextBox[] {
  const boxes: TextBox[] = [];
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  for (let row = 0; row < rows.length; row += 1) {
    const raw = rows[row].replace(/\t/g, "    ");
    if (raw.trim() === "") continue;
    const pattern = / {3,}|\s\|\s/g;
    let from = 0;
    const push = (start: number, end: number): void => {
      const piece = raw.slice(start, end);
      const lead = piece.length - piece.trimStart().length;
      const body = piece.trim();
      if (body === "") return;
      boxes.push({ text: body, x0: start + lead, x1: start + lead + body.length, y0: row * 2, y1: row * 2 + 1 });
    };
    for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
      push(from, match.index);
      from = match.index + match[0].length;
    }
    push(from, raw.length);
  }
  return boxes;
}

/** Cuanto se solapan dos tramos horizontales, como fraccion del mas corto (0..1). */
export function overlapFraction(a: { x0: number; x1: number }, b: { x0: number; x1: number }): number {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const shortest = Math.min(a.x1 - a.x0, b.x1 - b.x0);
  if (shortest <= 0) return overlap >= 0 ? 1 : 0;
  return Math.max(0, overlap) / shortest;
}

/** ¿`next` es la linea contigua de `line` (justo debajo, sin hueco de parrafo)? */
export function isContiguous(line: TextLine, next: TextLine | undefined): next is TextLine {
  if (!next) return false;
  const gap = next.y0 - line.y1;
  return gap <= NEXT_LINE_GAP_EM * Math.max(line.size, next.size) && next.y0 >= line.y0;
}
