/**
 * Paginacion de «HTML a PDF»: en vez de trocear el documento a ciegas cada `H` pixeles, busca los cortes MAS CERCANOS
 * que no partan nada importante. Es logica PURA (intervalos verticales en px CSS de maquetacion), sin DOM: el DOM solo
 * aporta la lista de intervalos (`collectBreakConstraints` en `htmlToPdfLayout.ts`).
 *
 * Tres clases de restricciones, de mas a menos fuertes:
 *   - `hard`    lineas de texto, imagenes/SVG/canvas, filas de tabla, bloques `break-inside: avoid`. Un corte DENTRO de
 *               uno de ellos los parte (una linea mitad en cada pagina): nunca se hace salvo que no haya alternativa.
 *   - `keep`    un encabezado se queda con la primera linea que le sigue (no acaba una pagina un titulo solo).
 *   - `orphans` viudas y huerfanas: no deja una sola linea de un parrafo suelta arriba o abajo; los parrafos cortos
 *               (2-3 lineas) no se parten.
 *
 * Un corte es VALIDO en un punto que no cae dentro de ningun intervalo. Se busca el mas bajo posible (pagina lo mas llena
 * posible) pero sin dejar mas de ~40 % de blanco; si no hay, se relajan primero `orphans`, luego `keep`, y se acepta una
 * pagina mas vacia antes que partir una linea. Solo si ninguna combinacion tiene un corte valido (un bloque monolitico mas
 * alto que la pagina) se corta a ciegas en el borde de la pagina, y se cuenta en `forcedBreaks`.
 */

export type Interval = readonly [number, number];

export type BreakConstraints = {
  hard: Interval[];
  keep: Interval[];
  orphans: Interval[];
};

export type PlannedPage = {
  /** Inicio dentro del documento, en px CSS de maquetacion. */
  y: number;
  height: number;
};

export type PaginationResult = {
  pages: PlannedPage[];
  /** Cortes a ciegas (ninguna posicion valida). Con documentos normales es 0. */
  forcedBreaks: number;
};

/**
 * Une intervalos que se SOLAPAN; descarta los degenerados. Devuelve una lista ordenada. Dos intervalos que solo se tocan
 * (filas de tabla contiguas, dos imagenes una bajo otra) NO se unen: el borde que comparten es un corte valido.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]): [number, number] => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start < last[1] - TOUCH_TOLERANCE) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Dos bordes a menos de esta distancia (px) son el mismo borde: error de coma flotante, no un solape. */
const TOUCH_TOLERANCE = 1e-3;

/** Margen minimo (px) entre un corte y el contenido que lo rodea. */
const EDGE_MARGIN = 1;
/** Espacio (px) que se deja en la pagina nueva por encima de su primer contenido, como maximo. */
const TOP_BREATHING = 16;

/**
 * Posicion de corte valida, la MAS ALTA que no pase de `hi` y no baje de `lo`; `null` si no existe. Un punto es valido si
 * no cae estrictamente DENTRO de ningun intervalo (el borde de uno si lo es). `merged` es la salida de `mergeIntervals`.
 */
export function findCut(merged: readonly Interval[], lo: number, hi: number): number | null {
  // Ultimo intervalo que empieza antes de `hi`.
  let low = 0;
  let high = merged.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (merged[middle][0] < hi) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (index >= 0 && merged[index][1] > hi + TOUCH_TOLERANCE) {
    // `hi` cae DENTRO de un intervalo: el corte va en el hueco anterior, pegado al contenido siguiente (la pagina nueva
    // empieza casi en el, con un poco de aire).
    const gapStart = index > 0 ? merged[index - 1][1] : -Infinity;
    const gapEnd = merged[index][0];
    const gap = gapEnd - gapStart;
    const preferred = gap <= TOUCH_TOLERANCE ? gapEnd : gapEnd - Math.min(gap / 2, TOP_BREATHING);
    // Si `lo` cae dentro de este hueco, el corte sube hasta `lo` (sigue dentro del hueco).
    const cut = Math.max(preferred, lo);
    return cut <= gapEnd + TOUCH_TOLERANCE ? Math.min(cut, gapEnd) : null;
  }

  // `hi` esta en un hueco entre dos intervalos: se corta en `hi`, con aire a ambos lados del contenido vecino.
  const gapStart = index >= 0 ? merged[index][1] : -Infinity;
  const nextStart = index + 1 < merged.length ? merged[index + 1][0] : Infinity;
  const lowest = gapStart + EDGE_MARGIN;
  const highest = nextStart - EDGE_MARGIN;
  const cut = lowest > highest ? (gapStart + nextStart) / 2 : Math.min(Math.max(hi, lowest), highest);
  return cut >= lo ? cut : null;
}

/** Orden de busqueda: [nivel de restricciones, fraccion minima de pagina que debe quedar llena]. */
const SEARCH_ORDER: ReadonlyArray<readonly [level: 0 | 1 | 2, minFill: number]> = [
  [0, 0.6],
  [1, 0.6],
  [0, 0.3],
  [1, 0.3],
  [2, 0.6],
  [2, 0.3],
];

/** Un resto menor que esto (px) no es contenido: es el redondeo del alto medido. */
const TAIL_EPSILON = 1;

export function planPages(totalHeight: number, pageHeight: number, constraints: BreakConstraints): PaginationResult {
  const total = Number.isFinite(totalHeight) ? Math.max(1, totalHeight) : 1;
  const page = Number.isFinite(pageHeight) ? Math.max(1, pageHeight) : 1;

  const all = mergeIntervals([...constraints.hard, ...constraints.keep, ...constraints.orphans]);
  const noOrphans = mergeIntervals([...constraints.hard, ...constraints.keep]);
  const hardOnly = mergeIntervals(constraints.hard);
  const levels = [all, noOrphans, hardOnly] as const;

  const pages: PlannedPage[] = [];
  let forcedBreaks = 0;
  let start = 0;

  while (total - start > page + TAIL_EPSILON) {
    const hi = start + page;
    let cut: number | null = null;
    for (const [level, minFill] of SEARCH_ORDER) {
      const found = findCut(levels[level], start + page * minFill, hi);
      if (found !== null && found > start + 1) {
        cut = found;
        break;
      }
    }
    if (cut === null) {
      cut = hi;
      forcedBreaks += 1;
    }
    cut = Math.min(cut, hi + EDGE_MARGIN);
    pages.push({ y: start, height: cut - start });
    start = cut;
  }

  pages.push({ y: start, height: Math.max(TAIL_EPSILON, total - start) });
  return { pages, forcedBreaks };
}

/**
 * Reparte las paginas en lotes de captura contiguos: cada lote es un tramo del documento que cabe en un lienzo y empieza
 * y acaba en un limite de pagina (los cortes planificados), asi que el recorte posterior es exacto.
 */
export type CaptureBatch = { y: number; height: number; pages: PlannedPage[] };

export function groupPagesIntoBatches(pages: readonly PlannedPage[], maxBatchHeight: number): CaptureBatch[] {
  const batches: CaptureBatch[] = [];
  let current: CaptureBatch | null = null;
  for (const page of pages) {
    if (current && current.height + page.height <= maxBatchHeight) {
      current.pages.push(page);
      current.height += page.height;
    } else {
      current = { y: page.y, height: page.height, pages: [page] };
      batches.push(current);
    }
  }
  return batches;
}

/* ------------------------------------------------------------------ *
 * Ajuste fino sobre los pixeles
 * ------------------------------------------------------------------ */

/** Cuanto puede moverse un corte (px CSS) al ajustarlo a una banda realmente en blanco. */
export const SNAP_WINDOW_PX = 24;
/** Holgura que se resta a la altura de pagina al PLANIFICAR, para que el ajuste fino nunca la desborde (2 x ventana). */
export const SNAP_SLACK_PX = SNAP_WINDOW_PX * 2;
/** Margen extra que se captura por arriba y por abajo de cada lote, para poder ajustar los cortes de sus bordes. */
export const SNAP_OVERSCAN_PX = SNAP_WINDOW_PX + 8;

/**
 * html2canvas pinta el texto con sus propias metricas de fuente y, medido en Chromium, lo deja ~9 px CSS mas abajo (16 px de
 * fuente; mas cuanto mayor la fuente) de donde lo situa el DOM: los cortes planificados con las cajas del DOM pueden caer sobre
 * una linea ya dibujada. Por eso, ademas de planificar con el DOM, cada corte se AJUSTA mirando los pixeles: se busca, lo mas
 * cerca posible de `target`, una banda de `bandRows` filas SIN TEXTO. Una fila cuenta como sin texto si casi todos sus pixeles
 * son del color de fondo (el del borde izquierdo): se toleran unos pocos pixeles distintos (`maxStrayFraction`, el filete
 * vertical de una cita o el borde de una columna), pero una fila de texto tiene muchos mas. Devuelve la fila elegida (centro de
 * la banda) o `null` si no hay ninguna (el corte cruza una imagen, un degradado...): entonces se queda el planificado.
 *
 * `data` es RGBA de `width` x `rows`, con el origen en la fila 0. Solo se mira entre `minRow` y `maxRow`.
 */
export function findCleanRow(
  data: ArrayLike<number>,
  width: number,
  rows: number,
  target: number,
  maxShift: number,
  minRow: number,
  maxRow: number,
  bandRows = 3,
  tolerance = 12,
  maxStrayFraction = 0.012,
): number | null {
  // Primero una banda TOTALMENTE lisa en toda la ventana; solo si no hay ninguna, una con filetes verticales (el borde de una
  // cita): sus pixeles sueltos pueden ser tambien los rabitos de las letras, asi que es el ultimo recurso.
  return (
    searchCleanRow(data, width, rows, target, maxShift, minRow, maxRow, bandRows, tolerance, 0) ??
    searchCleanRow(data, width, rows, target, maxShift, minRow, maxRow, bandRows, tolerance, maxStrayFraction)
  );
}

function searchCleanRow(
  data: ArrayLike<number>,
  width: number,
  rows: number,
  target: number,
  maxShift: number,
  minRow: number,
  maxRow: number,
  bandRows: number,
  tolerance: number,
  maxStrayFraction: number,
): number | null {
  const stray = Math.floor(width * maxStrayFraction);

  type RowScan = { color: [number, number, number]; strays: number[] };

  /** El color de fondo de la fila es el de su primer pixel; se anotan las columnas que se apartan de el. */
  const scanRow = (row: number): RowScan | null => {
    if (row < 0 || row >= rows) return null;
    const base = row * width * 4;
    const r = data[base];
    const g = data[base + 1];
    const b = data[base + 2];
    const strays: number[] = [];
    for (let column = 1; column < width; column += 1) {
      const index = base + column * 4;
      if (Math.abs(data[index] - r) > tolerance || Math.abs(data[index + 1] - g) > tolerance || Math.abs(data[index + 2] - b) > tolerance) {
        strays.push(column);
        if (strays.length > stray) return null;
      }
    }
    return { color: [r, g, b], strays };
  };

  const half = Math.floor(bandRows / 2);
  const clean = (center: number): boolean => {
    if (center - half < Math.max(0, minRow) || center + half > Math.min(rows - 1, maxRow)) return false;
    const first = scanRow(center - half);
    if (!first) return false;
    for (let row = center - half + 1; row <= center + half; row += 1) {
      const scan = scanRow(row);
      if (!scan) return false;
      if (Math.abs(scan.color[0] - first.color[0]) > tolerance || Math.abs(scan.color[1] - first.color[1]) > tolerance || Math.abs(scan.color[2] - first.color[2]) > tolerance) {
        return false;
      }
      // Los pixeles sueltos de un filete vertical estan en las MISMAS columnas en todas las filas; la punta de una letra
      // (el rabito de una «g», un acento) aparece solo en algunas: eso es texto, no una banda libre.
      if (scan.strays.length !== first.strays.length || scan.strays.some((column, i) => column !== first.strays[i])) return false;
    }
    return true;
  };

  const sameAs = (scan: RowScan | null, reference: RowScan): boolean =>
    !!scan &&
    Math.abs(scan.color[0] - reference.color[0]) <= tolerance &&
    Math.abs(scan.color[1] - reference.color[1]) <= tolerance &&
    Math.abs(scan.color[2] - reference.color[2]) <= tolerance &&
    scan.strays.length === reference.strays.length &&
    scan.strays.every((column, i) => column === reference.strays[i]);

  /** Del punto elegido se extiende por toda la franja libre (dentro de la ventana) y se devuelve su CENTRO: aire a ambos lados. */
  const centered = (found: number): number => {
    const reference = scanRow(found)!;
    const lowest = Math.max(target - maxShift, minRow, 0);
    const highest = Math.min(target + maxShift, maxRow, rows - 1);
    let up = found;
    while (up - 1 >= lowest && sameAs(scanRow(up - 1), reference)) up -= 1;
    let down = found;
    while (down + 1 <= highest && sameAs(scanRow(down + 1), reference)) down += 1;
    return Math.round((up + down) / 2);
  };

  for (let shift = 0; shift <= maxShift; shift += 1) {
    // A igual distancia se prefiere bajar (el texto de html2canvas queda mas abajo que su caja en el DOM).
    if (clean(target + shift)) return centered(target + shift);
    if (shift > 0 && clean(target - shift)) return centered(target - shift);
  }
  return null;
}
