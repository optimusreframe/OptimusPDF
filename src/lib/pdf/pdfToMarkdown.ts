import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { OCR_LANGUAGES, type OcrLanguage } from "@/lib/pdf/ocr";

/**
 * Motor "PDF -> Markdown".
 *
 * El modulo tiene dos capas bien separadas:
 *
 *  1. Capa PURA (`buildLines`, `buildMarkdown` y sus ayudantes): recibe
 *     una lista de paginas ya extraidas y devuelve Markdown. No toca el
 *     DOM ni pdf.js, asi que se puede probar en Node (ver
 *     `pdfToMarkdown.test.ts`).
 *  2. Capa de NAVEGADOR (`extractMarkdownPages`, `pdfToMarkdown`): saca
 *     el texto con su geometria via pdf.js y, cuando una pagina no tiene
 *     capa de texto (escaneo), la rasteriza y la pasa por tesseract.js
 *     igual que hace `ocr.ts`.
 *
 * LIMITE HONESTO: esto es extraccion semantica, no conversion exacta. Se
 * reconstruyen titulos, listas, bloques de codigo y tablas regulares a
 * partir de tamano de letra, negrita y posicion. Un documento a dos
 * columnas, una tabla con celdas combinadas, notas al pie o el maquetado
 * de un paper academico no se recuperan bien: el PDF no guarda esa
 * estructura, solo glifos colocados en la pagina.
 */

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

/** Fragmento de texto con su geometria en espacio de VISTA (y hacia abajo). */
export type MarkdownTextItem = {
  text: string;
  /** Borde izquierdo en puntos. */
  x: number;
  /** Linea base en puntos, medida desde el borde superior. */
  y: number;
  /** Avance del fragmento en puntos. */
  width: number;
  /** Cuerpo de letra aproximado en puntos. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  monospace: boolean;
};

export type MarkdownPageSource = "text" | "ocr" | "empty";

export type MarkdownPage = {
  /** 1..n */
  pageNumber: number;
  width: number;
  height: number;
  source: MarkdownPageSource;
  /** Fragmentos con geometria. Vacio cuando `source !== "text"`. */
  items: MarkdownTextItem[];
  /** Texto plano reconocido cuando `source === "ocr"`. */
  ocrText?: string;
};

/** Linea reconstruida a partir de los fragmentos de una pagina. */
export type MarkdownLine = {
  pageNumber: number;
  text: string;
  /** Borde izquierdo de la linea. */
  x: number;
  /** Borde derecho de la linea. */
  right: number;
  /** Linea base (crece hacia abajo). */
  y: number;
  /** Cuerpo dominante de la linea (el que cubre mas caracteres). */
  fontSize: number;
  bold: boolean;
  monospace: boolean;
  /**
   * Segmentos separados por huecos anchos: la pista con la que se
   * detectan columnas de tabla.
   */
  cells: string[];
  /** Borde izquierdo de cada segmento de `cells`. */
  cellStarts: number[];
};

export type PdfToMarkdownOptions = {
  /** Convierte lineas mas grandes o en negrita en `#`, `##`, `###`. */
  detectHeadings: boolean;
  /** Reconstruye tablas cuando las columnas se alinean en varias filas. */
  detectTables: boolean;
  /** Elimina encabezados y pies que se repiten en casi todas las paginas. */
  stripRepeated: boolean;
  /** Inserta `---` entre paginas. */
  pageSeparators: boolean;
  /** Reconoce con OCR las paginas sin capa de texto. */
  ocrFallback: boolean;
  ocrLanguage: OcrLanguage;
};

export const DEFAULT_PDF_TO_MARKDOWN_OPTIONS: PdfToMarkdownOptions = {
  detectHeadings: true,
  detectTables: true,
  stripRepeated: true,
  pageSeparators: false,
  ocrFallback: true,
  ocrLanguage: "spa",
};

export type MarkdownStats = {
  pages: number;
  /** Paginas resueltas con la capa de texto del PDF. */
  textPages: number;
  /** Paginas resueltas con OCR. */
  ocrPages: number;
  /** Paginas sin texto que nadie pudo resolver. */
  emptyPages: number;
  headings: number;
  listItems: number;
  tables: number;
  codeBlocks: number;
  characters: number;
};

export type PdfToMarkdownResult = {
  markdown: string;
  stats: MarkdownStats;
};

export type PdfToMarkdownConversion = PdfToMarkdownResult & {
  blob: Blob;
};

/* ------------------------------------------------------------------ *
 * Constantes de las heuristicas
 * ------------------------------------------------------------------ */

/** Dos fragmentos son la misma linea si sus bases distan menos que esto. */
const LINE_TOLERANCE_RATIO = 0.5;
/** Hueco (en cuerpos de letra) que ya cuenta como espacio entre palabras. */
const WORD_GAP_RATIO = 0.22;
/** Hueco (en cuerpos de letra) que separa columnas, no palabras. */
const CELL_GAP_RATIO = 1.2;
/** A partir de este cociente sobre el cuerpo del texto, la linea es titulo. */
const HEADING_SIZE_RATIO = 1.08;
/** Un titulo largo casi nunca es un titulo. */
const MAX_HEADING_CHARS = 120;
/** Un titulo solo por negrita tiene que ser corto de verdad. */
const MAX_BOLD_HEADING_CHARS = 80;
/** Nivel maximo de titulo emitido (H1..H3). */
const MAX_HEADING_LEVEL = 3;
/** Lineas seguidas del mismo cuerpo grande que dejan de ser titulo. */
const MAX_HEADING_RUN_BY_SIZE = 3;
/** Lineas seguidas en negrita del cuerpo normal que dejan de ser titulo. */
const MAX_HEADING_RUN_BY_WEIGHT = 2;
/** Filas minimas (cabecera incluida) para dar una tabla por buena. */
const MIN_TABLE_ROWS = 3;
/** Columnas minimas para dar una tabla por buena. */
const MIN_TABLE_COLUMNS = 2;
/** Si mas de esta fraccion de lineas es monoespaciada, no es codigo: es la fuente del documento. */
const MAX_CODE_LINE_SHARE = 0.4;
/** Sangria maxima reconstruida en una lista. */
const MAX_LIST_LEVEL = 3;
/** Paginas minimas para buscar encabezados/pies repetidos. */
const MIN_PAGES_FOR_REPEAT_STRIP = 3;
/** Franja superior/inferior donde viven encabezados y pies. */
const REPEAT_ZONE_RATIO = 0.1;
/** Fraccion de paginas en las que debe aparecer una linea para ser un pie. */
const REPEAT_SHARE = 0.6;
/** Caracteres utiles por debajo de los cuales una pagina se considera escaneada. */
const MIN_CHARS_FOR_TEXT_PAGE = 24;
/** Resolucion de rasterizado para OCR: 2x ~ 144 DPI. */
const OCR_SCALE = 2;
const MAX_RASTER_SIDE = 4000;

/* ------------------------------------------------------------------ *
 * Capa pura: de fragmentos a lineas
 * ------------------------------------------------------------------ */

function roundSize(value: number): number {
  return Math.round(value * 2) / 2;
}

/** Espacio duro y espacios tipograficos que sueltan algunos generadores. */
const SPACE_CLASS = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

function normalizeSpaces(text: string): string {
  return text.replace(SPACE_CLASS, " ").trim();
}

/** Cuerpo dominante de una lista de fragmentos, pesado por caracteres. */
function dominantSize(items: MarkdownTextItem[]): number {
  const weights = new Map<number, number>();
  for (const item of items) {
    const key = roundSize(item.fontSize);
    const length = Math.max(1, item.text.trim().length);
    weights.set(key, (weights.get(key) ?? 0) + length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && size > best)) {
      best = size;
      bestWeight = weight;
    }
  }
  return best > 0 ? best : 12;
}

function makeLine(
  items: MarkdownTextItem[],
  pageNumber: number,
): MarkdownLine {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const size = dominantSize(sorted);

  let text = "";
  let cell = "";
  const cells: string[] = [];
  const cellStarts: number[] = [];
  let cellStart = sorted[0].x;
  let previousRight = sorted[0].x;
  let boldChars = 0;
  let monoChars = 0;
  let chars = 0;
  let right = sorted[0].x;

  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const gap = item.x - previousRight;
    const reference = item.fontSize > 0 ? item.fontSize : size;

    if (index > 0) {
      if (gap >= reference * CELL_GAP_RATIO) {
        cells.push(cell.trim());
        cellStarts.push(cellStart);
        cell = "";
        cellStart = item.x;
        if (!text.endsWith(" ")) text += " ";
      } else if (gap >= reference * WORD_GAP_RATIO) {
        if (!text.endsWith(" ") && !item.text.startsWith(" ")) {
          text += " ";
          cell += " ";
        }
      }
    }

    text += item.text;
    cell += item.text;

    const length = item.text.trim().length;
    chars += length;
    if (item.bold) boldChars += length;
    if (item.monospace) monoChars += length;

    previousRight = item.x + item.width;
    right = Math.max(right, previousRight);
  }

  cells.push(cell.trim());
  cellStarts.push(cellStart);

  return {
    pageNumber,
    text: normalizeSpaces(text),
    x: sorted[0].x,
    right,
    y: sorted[0].y,
    fontSize: size,
    bold: chars > 0 && boldChars / chars > 0.6,
    monospace: chars > 0 && monoChars / chars > 0.6,
    cells,
    cellStarts,
  };
}

/**
 * Agrupa los fragmentos de una pagina en lineas por cercania de linea
 * base. Trabaja en espacio de vista, asi que las paginas rotadas ya
 * llegan enderezadas desde `extractMarkdownPages`.
 */
export function buildLines(page: MarkdownPage): MarkdownLine[] {
  const items = page.items.filter((item) => item.text.trim().length > 0);
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: MarkdownLine[] = [];
  let current: MarkdownTextItem[] = [sorted[0]];
  let baseline = sorted[0].y;
  let reference = sorted[0].fontSize;

  for (let index = 1; index < sorted.length; index += 1) {
    const item = sorted[index];
    const tolerance = Math.max(1, reference * LINE_TOLERANCE_RATIO);
    if (Math.abs(item.y - baseline) <= tolerance) {
      current.push(item);
      reference = Math.max(reference, item.fontSize);
      continue;
    }
    lines.push(makeLine(current, page.pageNumber));
    current = [item];
    baseline = item.y;
    reference = item.fontSize;
  }
  lines.push(makeLine(current, page.pageNumber));
  return lines;
}

/** Mediana pesada por numero de caracteres: el cuerpo del texto corrido. */
export function bodyFontSize(pages: MarkdownPage[]): number {
  const weights = new Map<number, number>();
  let total = 0;
  for (const page of pages) {
    for (const item of page.items) {
      const length = item.text.trim().length;
      if (length === 0) continue;
      const key = roundSize(item.fontSize);
      weights.set(key, (weights.get(key) ?? 0) + length);
      total += length;
    }
  }
  if (total === 0) return 12;

  const sizes = [...weights.keys()].sort((a, b) => a - b);
  let seen = 0;
  for (const size of sizes) {
    seen += weights.get(size) ?? 0;
    if (seen >= total / 2) return size;
  }
  return sizes[sizes.length - 1];
}

/* ------------------------------------------------------------------ *
 * Capa pura: clasificacion de lineas
 * ------------------------------------------------------------------ */

export type ListMarker = {
  ordered: boolean;
  /** Numero original de la lista ordenada. */
  number: number;
  /** Texto sin la vineta. */
  rest: string;
};

const BULLET =
  /^[\u2022\u2023\u25aa\u25e6\u00b7\u25cb\u25cf\u2219*+\-\u2013\u2014]\s+/;
const ORDERED = /^(\d{1,3})[.)]\s+/;

/** Reconoce vinetas y numeraciones al principio de una linea. */
export function matchListMarker(text: string): ListMarker | null {
  const trimmed = text.trimStart();
  const ordered = ORDERED.exec(trimmed);
  if (ordered) {
    return {
      ordered: true,
      number: Number.parseInt(ordered[1], 10),
      rest: trimmed.slice(ordered[0].length).trim(),
    };
  }
  const bullet = BULLET.exec(trimmed);
  if (bullet) {
    const rest = trimmed.slice(bullet[0].length).trim();
    // "- " sin nada detras no es una lista, es un guion suelto.
    if (rest.length === 0) return null;
    return { ordered: false, number: 0, rest };
  }
  return null;
}

/**
 * Escapa lo minimo imprescindible para que una linea de texto normal no
 * se lea como sintaxis Markdown. Deliberadamente conservador: escapar de
 * mas ensucia mas de lo que arregla.
 */
export function escapeInline(text: string): string {
  return text
    .replace(/^(#{1,6})(\s|$)/, "\\$1$2")
    .replace(/^>/, "\\>")
    .replace(/^(\d{1,3})([.)])(\s)/, "$1\\$2$3")
    .replace(/^([-*+])(\s)/, "\\$1$2");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export type HeadingScale = {
  bodySize: number;
  /** Tamanos de titulo distintos, de mayor a menor. */
  ranked: number[];
};

function buildHeadingScale(
  lines: MarkdownLine[],
  bodySize: number,
): HeadingScale {
  const sizes = new Set<number>();
  for (const line of lines) {
    if (line.monospace) continue;
    if (line.text.length === 0 || line.text.length > MAX_HEADING_CHARS) continue;
    if (matchListMarker(line.text)) continue;
    if (line.fontSize / bodySize >= HEADING_SIZE_RATIO) {
      sizes.add(roundSize(line.fontSize));
    }
  }
  return { bodySize, ranked: [...sizes].sort((a, b) => b - a) };
}

/** 0 = no es titulo; 1..3 = nivel. */
export function headingLevel(
  line: MarkdownLine,
  scale: HeadingScale,
): number {
  if (line.monospace) return 0;
  const text = line.text.trim();
  if (text.length === 0 || text.length > MAX_HEADING_CHARS) return 0;
  if (matchListMarker(text)) return 0;

  const ratio = line.fontSize / scale.bodySize;
  if (ratio >= HEADING_SIZE_RATIO) {
    const rank = scale.ranked.indexOf(roundSize(line.fontSize));
    if (rank < 0) return 0;
    return Math.min(MAX_HEADING_LEVEL, rank + 1);
  }

  // Titulo marcado solo con negrita: exigimos que sea corto y que no
  // termine como una frase, o cualquier parrafo en negrita se convierte
  // en un titulo falso.
  if (line.bold && ratio >= 0.95 && text.length <= MAX_BOLD_HEADING_CHARS) {
    if (/[.,;]$/.test(text)) return 0;
    return Math.min(MAX_HEADING_LEVEL, scale.ranked.length + 1);
  }
  return 0;
}

/**
 * Niveles de titulo de UNA pagina, ya depurados por contexto.
 *
 * `headingLevel` mira cada linea aislada, y asi un parrafo entero
 * compuesto en negrita o en un cuerpo algo mayor (los avisos legales en
 * mayusculas de un contrato, por ejemplo) sale convertido en una pila de
 * titulos falsos. La correccion es contar rachas: un titulo de verdad
 * ocupa una linea, o dos si se parte. En cuanto varias lineas seguidas
 * del mismo cuerpo y pegadas entre si son todas candidatas, deja de ser
 * un titulo y pasa a ser un bloque destacado.
 *
 * Se pide una racha mas larga cuando el candidato lo es por tamano (los
 * titulos partidos en dos lineas son normales) que cuando solo lo es por
 * la negrita (ahi dos lineas seguidas ya delatan un parrafo).
 */
export function pageHeadingLevels(
  lines: MarkdownLine[],
  scale: HeadingScale,
): number[] {
  const raw = lines.map((line) => headingLevel(line, scale));
  const levels = [...raw];

  const bySize = (line: MarkdownLine) =>
    line.fontSize / scale.bodySize >= HEADING_SIZE_RATIO;

  let start = 0;
  while (start < lines.length) {
    if (raw[start] === 0) {
      start += 1;
      continue;
    }

    let end = start + 1;
    while (
      end < lines.length &&
      raw[end] > 0 &&
      roundSize(lines[end].fontSize) === roundSize(lines[start].fontSize) &&
      lines[end].y - lines[end - 1].y <=
        Math.max(lines[end].fontSize, lines[end - 1].fontSize) * 2
    ) {
      end += 1;
    }

    const limit = bySize(lines[start])
      ? MAX_HEADING_RUN_BY_SIZE
      : MAX_HEADING_RUN_BY_WEIGHT;
    if (end - start >= limit) {
      for (let index = start; index < end; index += 1) levels[index] = 0;
    }
    start = end;
  }

  return levels;
}

/* ------------------------------------------------------------------ *
 * Capa pura: encabezados y pies repetidos
 * ------------------------------------------------------------------ */

function repeatKey(text: string): string {
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Claves de las lineas que aparecen en la franja superior o inferior de
 * la mayoria de las paginas: numeros de pagina, titulillos, pies de
 * copyright. Se calculan sobre el documento entero.
 */
export function findRepeatedLines(
  pages: MarkdownPage[],
  linesByPage: MarkdownLine[][],
): Set<string> {
  const repeated = new Set<string>();
  if (pages.length < MIN_PAGES_FOR_REPEAT_STRIP) return repeated;

  const counts = new Map<string, number>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const height = page.height > 0 ? page.height : 792;
    const seen = new Set<string>();
    for (const line of linesByPage[index] ?? []) {
      const inHeader = line.y <= height * REPEAT_ZONE_RATIO;
      const inFooter = line.y >= height * (1 - REPEAT_ZONE_RATIO);
      if (!inHeader && !inFooter) continue;
      const key = repeatKey(line.text);
      if (key.length === 0) continue;
      seen.add(key);
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const threshold = Math.max(2, Math.ceil(pages.length * REPEAT_SHARE));
  for (const [key, count] of counts) {
    if (count >= threshold) repeated.add(key);
  }
  return repeated;
}

/* ------------------------------------------------------------------ *
 * Capa pura: bloques
 * ------------------------------------------------------------------ */

type Counters = {
  headings: number;
  listItems: number;
  tables: number;
  codeBlocks: number;
};

function columnsAlign(
  line: MarkdownLine,
  header: MarkdownLine,
): boolean {
  if (line.cellStarts.length !== header.cellStarts.length) return false;
  const tolerance = Math.max(6, header.fontSize);
  return line.cellStarts.every(
    (start, index) => Math.abs(start - header.cellStarts[index]) <= tolerance,
  );
}

/**
 * Tabla de mejor esfuerzo: solo se acepta una rejilla regular (mismo
 * numero de columnas, bordes izquierdos alineados y al menos tres filas).
 * Es deliberadamente conservador: una tabla inventada estropea el
 * documento mas que una tabla no detectada.
 */
function tryTable(
  lines: MarkdownLine[],
  start: number,
  levels: number[],
): { rows: MarkdownLine[]; end: number } | null {
  const header = lines[start];
  if (header.cells.length < MIN_TABLE_COLUMNS) return null;
  if (header.monospace) return null;
  if (matchListMarker(header.text)) return null;

  const rows: MarkdownLine[] = [header];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.pageNumber !== header.pageNumber) break;
    if (line.cells.length !== header.cells.length) break;
    if (line.monospace) break;
    if (matchListMarker(line.text)) break;
    if (levels[index] > 0) break;
    if (!columnsAlign(line, header)) break;
    const previous = rows[rows.length - 1];
    if (line.y - previous.y > Math.max(line.fontSize, previous.fontSize) * 3) {
      break;
    }
    rows.push(line);
    index += 1;
  }

  if (rows.length < MIN_TABLE_ROWS) return null;
  return { rows, end: index };
}

function renderTable(rows: MarkdownLine[]): string {
  const columns = rows[0].cells.length;
  const out: string[] = [];
  out.push(`| ${rows[0].cells.map(escapeCell).join(" | ")} |`);
  out.push(`| ${Array.from({ length: columns }, () => "---").join(" | ")} |`);
  for (let index = 1; index < rows.length; index += 1) {
    out.push(`| ${rows[index].cells.map(escapeCell).join(" | ")} |`);
  }
  return out.join("\n");
}

function renderCode(run: MarkdownLine[]): string {
  const minX = Math.min(...run.map((line) => line.x));
  const body = run.map((line) => {
    // Ancho medio de caracter monoespaciado ~ 0.6 del cuerpo.
    const unit = Math.max(1, line.fontSize * 0.6);
    const indent = Math.max(0, Math.round((line.x - minX) / unit));
    return `${" ".repeat(indent)}${line.text}`;
  });
  return ["```", ...body, "```"].join("\n");
}

/** Une la linea siguiente al parrafo, deshaciendo la particion silabica. */
function joinParagraph(previous: string, next: string): string {
  if (/[\p{L}]-$/u.test(previous) && /^[\p{Ll}]/u.test(next)) {
    return previous.slice(0, -1) + next;
  }
  return `${previous} ${next}`;
}

function isPlainLine(
  line: MarkdownLine,
  level: number,
  codeAllowed: boolean,
): boolean {
  if (codeAllowed && line.monospace) return false;
  if (matchListMarker(line.text)) return false;
  return level === 0;
}

/** Convierte las lineas de UNA pagina en bloques Markdown. */
function pageBlocks(
  lines: MarkdownLine[],
  scale: HeadingScale,
  options: PdfToMarkdownOptions,
  codeAllowed: boolean,
  counters: Counters,
): string[] {
  const blocks: string[] = [];
  const levels = options.detectHeadings
    ? pageHeadingLevels(lines, scale)
    : lines.map(() => 0);

  // Borde derecho del cuerpo de la pagina: una linea que no llega ahi
  // termina el parrafo.
  const bodyRight = Math.max(
    0,
    ...lines.filter((_, index) => levels[index] === 0).map((line) => line.right),
  );

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    // 1. Bloque de codigo: lineas monoespaciadas seguidas.
    if (codeAllowed && line.monospace) {
      const run: MarkdownLine[] = [];
      while (index < lines.length && lines[index].monospace) {
        run.push(lines[index]);
        index += 1;
      }
      blocks.push(renderCode(run));
      counters.codeBlocks += 1;
      continue;
    }

    // 2. Tabla regular.
    if (options.detectTables) {
      const table = tryTable(lines, index, levels);
      if (table) {
        blocks.push(renderTable(table.rows));
        counters.tables += 1;
        index = table.end;
        continue;
      }
    }

    // 3. Titulo.
    {
      const level = levels[index];
      if (level > 0) {
        blocks.push(`${"#".repeat(level)} ${escapeInline(line.text)}`);
        counters.headings += 1;
        index += 1;
        continue;
      }
    }

    // 4. Lista.
    const marker = matchListMarker(line.text);
    if (marker) {
      const entries: { level: number; text: string; ordered: boolean; number: number }[] =
        [];
      const baseX = line.x;
      let last: MarkdownLine = line;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate.monospace && codeAllowed) break;
        if (levels[index] > 0) break;
        const candidateMarker = matchListMarker(candidate.text);
        if (candidateMarker) {
          const step = Math.max(1, candidate.fontSize * 1.5);
          const level = Math.min(
            MAX_LIST_LEVEL,
            Math.max(0, Math.round((candidate.x - baseX) / step)),
          );
          entries.push({
            level,
            text: candidate.text.trimStart().replace(BULLET, "").replace(ORDERED, ""),
            ordered: candidateMarker.ordered,
            number: candidateMarker.number,
          });
          last = candidate;
          index += 1;
          continue;
        }
        // Continuacion: sangrada respecto a la vineta y pegada a ella.
        const isContinuation =
          entries.length > 0 &&
          candidate.x > last.x + 1 &&
          candidate.y - last.y <=
            Math.max(candidate.fontSize, last.fontSize) * 2.2;
        if (!isContinuation) break;
        const previous = entries[entries.length - 1];
        previous.text = joinParagraph(previous.text, candidate.text);
        last = candidate;
        index += 1;
      }

      blocks.push(
        entries
          .map((entry) => {
            const indent = "  ".repeat(entry.level);
            const bullet = entry.ordered ? `${entry.number}. ` : "- ";
            return `${indent}${bullet}${entry.text.trim()}`;
          })
          .join("\n"),
      );
      counters.listItems += entries.length;
      continue;
    }

    // 5. Parrafo: se pegan las lineas hasta que algo indica que acabo.
    let paragraph = line.text;
    let previous = line;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!isPlainLine(next, levels[index], codeAllowed)) break;
      if (options.detectTables && next.cells.length >= MIN_TABLE_COLUMNS) {
        const table = tryTable(lines, index, levels);
        if (table) break;
      }
      const lineHeight = Math.max(previous.fontSize, next.fontSize) * 1.35;
      if (next.y - previous.y > lineHeight * 1.6) break;
      // Linea corta = final de parrafo.
      if (previous.right < bodyRight - previous.fontSize * 2) break;
      // Sangria de primera linea = parrafo nuevo.
      if (next.x > previous.x + previous.fontSize) break;
      paragraph = joinParagraph(paragraph, next.text);
      previous = next;
      index += 1;
    }
    blocks.push(escapeInline(paragraph.trim()));
  }

  return blocks;
}

/** Texto OCR -> parrafos planos (el reconocimiento no da estructura). */
function ocrBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((chunk) => normalizeSpaces(chunk))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => escapeInline(chunk));
}

/* ------------------------------------------------------------------ *
 * Capa pura: documento completo
 * ------------------------------------------------------------------ */

export function buildMarkdown(
  pages: MarkdownPage[],
  options: PdfToMarkdownOptions = DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
): PdfToMarkdownResult {
  const linesByPage = pages.map((page) =>
    page.source === "text" ? buildLines(page) : [],
  );

  const repeated = options.stripRepeated
    ? findRepeatedLines(pages, linesByPage)
    : new Set<string>();

  const cleaned = linesByPage.map((lines, index) => {
    if (repeated.size === 0) return lines;
    const page = pages[index];
    const height = page.height > 0 ? page.height : 792;
    return lines.filter((line) => {
      const inHeader = line.y <= height * REPEAT_ZONE_RATIO;
      const inFooter = line.y >= height * (1 - REPEAT_ZONE_RATIO);
      if (!inHeader && !inFooter) return true;
      return !repeated.has(repeatKey(line.text));
    });
  });

  const allLines = cleaned.flat();
  const bodySize = bodyFontSize(pages);
  const scale = buildHeadingScale(allLines, bodySize);

  // Un documento entero en Courier no es codigo: es un documento en
  // Courier. Solo se reconoce codigo cuando es minoria.
  const monoLines = allLines.filter((line) => line.monospace).length;
  const codeAllowed =
    monoLines > 0 && monoLines <= Math.max(1, allLines.length) * MAX_CODE_LINE_SHARE;

  const counters: Counters = {
    headings: 0,
    listItems: 0,
    tables: 0,
    codeBlocks: 0,
  };

  let textPages = 0;
  let ocrPages = 0;
  let emptyPages = 0;
  const rendered: string[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    let blocks: string[] = [];

    if (page.source === "ocr") {
      ocrPages += 1;
      blocks = ocrBlocks(page.ocrText ?? "");
    } else if (page.source === "text") {
      textPages += 1;
      blocks = pageBlocks(
        cleaned[index],
        scale,
        options,
        codeAllowed,
        counters,
      );
    } else {
      emptyPages += 1;
    }

    const body = blocks.filter((block) => block.trim().length > 0).join("\n\n");
    if (body.length > 0) rendered.push(body);
  }

  const separator = options.pageSeparators ? "\n\n---\n\n" : "\n\n";
  const markdown = `${rendered.join(separator).replace(/\n{3,}/g, "\n\n").trim()}\n`;

  return {
    markdown,
    stats: {
      pages: pages.length,
      textPages,
      ocrPages,
      emptyPages,
      headings: counters.headings,
      listItems: counters.listItems,
      tables: counters.tables,
      codeBlocks: counters.codeBlocks,
      characters: markdown.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Capa de navegador: extraccion con pdf.js (+ OCR)
 * ------------------------------------------------------------------ */

type TextLikeItem = {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
};

function isTextItem(item: unknown): item is TextLikeItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string" &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

/**
 * Aplica una matriz afin de pdf.js `[a, b, c, d, e, f]` a un punto.
 * Se usa con `viewport.transform` para llevar el espacio de usuario del
 * PDF (origen abajo-izquierda, sin rotar) al espacio de vista (origen
 * arriba-izquierda, ya rotado), que es donde las heuristicas de arriba
 * saben leer.
 */
export function applyTransform(
  matrix: number[],
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

type FontFlags = { bold: boolean; italic: boolean; monospace: boolean };

const BOLD_NAME = /bold|black|heavy|semibold|demi/i;
const ITALIC_NAME = /italic|oblique/i;
const MONO_NAME = /mono|courier|consol/i;

/**
 * pdf.js solo publica `fontFamily` en `TextContent.styles`, que basta
 * para monoespaciada. La negrita y la cursiva viven en el objeto de
 * fuente cargado (`commonObjs`), que puede no estar resuelto: si falta,
 * se cae al nombre de la fuente, y si tampoco lo hay, se asume normal.
 * La deteccion de titulos no depende de esto: manda el cuerpo de letra.
 */
function readFontFlags(
  page: PDFPageProxy,
  fontName: string,
  fontFamily: string | undefined,
): FontFlags {
  const flags: FontFlags = {
    bold: false,
    italic: false,
    monospace: fontFamily === "monospace",
  };
  try {
    if (!page.commonObjs.has(fontName)) return flags;
    const font = page.commonObjs.get(fontName) as
      | { name?: string; bold?: boolean; italic?: boolean; black?: boolean }
      | null
      | undefined;
    if (!font) return flags;
    const name = typeof font.name === "string" ? font.name : "";
    flags.bold = font.bold === true || font.black === true || BOLD_NAME.test(name);
    flags.italic = font.italic === true || ITALIC_NAME.test(name);
    if (!flags.monospace && MONO_NAME.test(name)) flags.monospace = true;
  } catch {
    // Fuente no resuelta todavia: nos quedamos con lo que da `styles`.
  }
  return flags;
}

async function recognizePage(
  worker: Awaited<ReturnType<typeof import("tesseract.js").createWorker>>,
  page: PDFPageProxy,
): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const longest = Math.max(base.width, base.height, 1);
  const scale = Math.max(0.1, Math.min(OCR_SCALE, MAX_RASTER_SIDE / longest));
  const canvas = await renderPageToCanvas(page, {
    scale,
    // Obligatorio: rasterizado fuera de pantalla.
    intent: "print",
  });
  const result = await worker.recognize(canvas, {}, { text: true });
  canvas.width = 0;
  canvas.height = 0;
  return result.data.text ?? "";
}

/**
 * Extrae, pagina a pagina, los fragmentos de texto con su geometria.
 * Cuando una pagina no trae capa de texto util y el OCR esta activado,
 * la rasteriza y la reconoce con tesseract.js (mismo patron que
 * `ocr.ts`: import dinamico y worker unico para todo el documento).
 */
export async function extractMarkdownPages(
  file: Blob,
  options: PdfToMarkdownOptions = DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<MarkdownPage[]> {
  const language: OcrLanguage = OCR_LANGUAGES.includes(options.ocrLanguage)
    ? options.ocrLanguage
    : "spa";

  let viewer: PDFDocumentProxy | null = null;
  let worker: Awaited<
    ReturnType<typeof import("tesseract.js").createWorker>
  > | null = null;

  try {
    viewer = await openPdfDocument(file);
    const total = viewer.numPages;
    if (total === 0) throw new PdfError("empty");

    const pages: MarkdownPage[] = [];
    let currentPage = 0;
    const report = (fraction: number) => {
      const value = (currentPage + Math.min(1, Math.max(0, fraction))) / total;
      onProgress?.(value);
    };

    for (let number = 1; number <= total; number += 1) {
      throwIfAborted(signal);
      currentPage = number - 1;
      report(0);

      const page = await viewer.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const items: MarkdownTextItem[] = [];
      let chars = 0;
      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        if (raw.str.length === 0) continue;
        const transform = raw.transform;
        const point = applyTransform(
          viewport.transform as unknown as number[],
          transform[4],
          transform[5],
        );
        const fontSize =
          Math.hypot(transform[2], transform[3]) || raw.height || 12;
        const style = content.styles?.[raw.fontName];
        const flags = readFontFlags(page, raw.fontName, style?.fontFamily);
        items.push({
          text: raw.str,
          x: point.x,
          y: point.y,
          width: raw.width,
          fontSize,
          bold: flags.bold,
          italic: flags.italic,
          monospace: flags.monospace,
        });
        chars += raw.str.trim().length;
      }
      report(0.2);

      if (chars >= MIN_CHARS_FOR_TEXT_PAGE) {
        pages.push({
          pageNumber: number,
          width: viewport.width,
          height: viewport.height,
          source: "text",
          items,
        });
        page.cleanup();
      } else if (options.ocrFallback) {
        if (!worker) {
          const tesseract = await import("tesseract.js");
          worker = await tesseract.createWorker(
            language,
            tesseract.OEM.LSTM_ONLY,
            {
              logger: (message) => {
                if (message.status === "recognizing text") {
                  report(0.2 + message.progress * 0.75);
                }
              },
            },
          );
        }
        const text = await recognizePage(worker, page);
        page.cleanup();
        pages.push({
          pageNumber: number,
          width: viewport.width,
          height: viewport.height,
          source: "ocr",
          items: [],
          ocrText: text,
        });
      } else {
        pages.push({
          pageNumber: number,
          width: viewport.width,
          height: viewport.height,
          source: chars > 0 ? "text" : "empty",
          items: chars > 0 ? items : [],
        });
        page.cleanup();
      }

      report(1);
    }

    return pages;
  } finally {
    if (worker) await worker.terminate();
    if (viewer) await closePdfDocument(viewer);
  }
}

/**
 * Convierte un PDF en Markdown. Devuelve tambien el texto y las
 * estadisticas para poder mostrar una vista previa antes de descargar.
 */
export async function pdfToMarkdown(
  file: Blob,
  options: PdfToMarkdownOptions = DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<PdfToMarkdownConversion> {
  try {
    const pages = await extractMarkdownPages(
      file,
      options,
      (value) => onProgress?.(value * 0.92),
      signal,
    );
    const result = buildMarkdown(pages, options);
    if (result.markdown.trim().length === 0) throw new PdfError("empty");

    const blob = new Blob([result.markdown], {
      type: "text/markdown;charset=utf-8",
    });
    onProgress?.(1);
    return { ...result, blob };
  } catch (error) {
    throw toPdfError(error);
  }
}
