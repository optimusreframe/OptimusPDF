/**
 * Muestreo del color de fondo alrededor de un bloque de texto (Wave 5).
 *
 * Para "cubrir y redibujar" hace falta un rectangulo del color del fondo. Se
 * toma la MEDIANA por canal de un anillo de pixeles justo FUERA del bloque
 * (dentro estaria el propio texto) y se mide cuanto se aparta el anillo de
 * esa mediana: si el fondo es un degradado, una foto o una tabla con lineas,
 * `uniform` sale `false` y la interfaz avisa (`background-not-uniform`) y
 * deja elegir el color en vez de dejar un borde visible sin decir nada.
 *
 * Modulo puro sobre pixeles RGBA: lo alimenta quien tiene el canvas de la
 * pagina (el lienzo del editor o un test en Node).
 */

export type RgbaImage = {
  /** RGBA, 4 bytes por pixel, fila a fila desde arriba. */
  data: ArrayLike<number>;
  width: number;
  height: number;
};

/** Caja en PIXELES de la imagen (origen arriba-izquierda). */
export type PixelBox = { x: number; y: number; width: number; height: number };

export type BackgroundSampleOptions = {
  /** Grosor del anillo exterior, en pixeles (por defecto 3). */
  ring?: number;
  /**
   * Distancia RGB maxima a la mediana de los pixeles "cercanos" (por defecto
   * 10): lo que la supera es patron (rayas, textura, degradado) o tinta.
   */
  tolerance?: number;
  /** Distancia a partir de la cual un pixel se toma por TINTA y no por fondo (por defecto 90). */
  inkDistance?: number;
  /** Fraccion maxima de pixeles de patron (entre `tolerance` e `inkDistance`); por defecto 0.12. */
  maxOutliers?: number;
  /** Fraccion maxima de pixeles de tinta en el anillo; por defecto 0.08. */
  maxInk?: number;
  /** Diferencia RGB maxima entre las medianas de dos lados del anillo; por defecto 6. */
  sideTolerance?: number;
  /**
   * (W5-U5) Cuadrilatero (esquinas en PIXELES de la imagen) que se va a cubrir cuando el
   * texto esta girado un angulo LIBRE. El anillo se toma pegado a el (a menos de `ring` px
   * por fuera), no alrededor de la caja envolvente: lo que haya dentro de la envolvente
   * pero lejos del cuadrilatero (vecinos) no cuenta, y las esquinas de la envolvente,
   * lejos de lo que se tapa, tampoco. `box` solo delimita la ventana de lectura.
   */
  polygon?: ReadonlyArray<{ x: number; y: number }>;
  /**
   * Cajas (mismos pixeles que `box`) de OTROS bloques de texto conocidos: sus
   * pixeles son la tinta de un vecino, no fondo, y no se muestrean.
   */
  ignore?: readonly PixelBox[];
  /**
   * Ignora las lineas finas (bordes de celda de 1-2 px) que cruzan el anillo.
   * Por defecto `true`; `false` reproduce el comportamiento anterior (pruebas).
   */
  thinLines?: boolean;
  /**
   * Pixeles por punto PDF de la imagen. Con el, el anillo, la distancia a la que
   * se buscan lineas finas y el grosor maximo de una linea (3 pt) se miden en
   * PUNTOS, asi que la decision no cambia con el zoom. Sin el, valores en
   * pixeles (3 / 8 / 2), como en las pruebas sinteticas.
   */
  pxPerPt?: number;
  /**
   * Caja (mismos pixeles que `box`) del texto original, DENTRO de `box`: las
   * filas entre ella y `box` son las que la cobertura va a tapar y tambien se
   * revisan por si llevan una linea (borde de celda) que no hay que borrar.
   */
  inner?: PixelBox;
};

export type BackgroundSample = {
  /** "#rrggbb" mediano del anillo. */
  color: string;
  /** False si el fondo no es de un solo color (degradado, imagen, lineas). */
  uniform: boolean;
  /** Fraccion de muestras de patron (ni fondo ni tinta), 0..1. */
  outliers: number;
  /** Numero de pixeles muestreados. */
  samples: number;
  /** Mayor diferencia RGB entre las medianas de dos lados del anillo (degradados). */
  sideDelta?: number;
  /** Fraccion de pixeles de tinta (muy distintos de la mediana). */
  ink?: number;
  /**
   * Lineas finas (<= 3 pt, bordes de celda) halladas alrededor, como franjas en los
   * pixeles de la imagen. Ni cuentan como fondo no liso ni se deben cubrir.
   */
  lines?: PixelBox[];
};

const DEFAULT_RING = 3;
const DEFAULT_TOLERANCE = 10;
const DEFAULT_INK_DISTANCE = 90;
const DEFAULT_MAX_OUTLIERS = 0.12;
const DEFAULT_MAX_INK = 0.08;
const DEFAULT_SIDE_TOLERANCE = 6;
const MIN_SAMPLES = 8;
const MIN_SIDE_SAMPLES = 4;
/** Fraccion maxima de un lado del anillo que puede apartarse del fondo (rayas que cruzan solo dos lados). */
const MAX_SIDE_OFF = 0.25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toHex(r: number, g: number, b: number): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

type Side = "top" | "bottom" | "left" | "right";

/** Filas (a partir del borde de la caja) que se leen para reconocer lineas finas (sin escala). */
const LINE_SCAN_DEPTH = 8;
/** Grosor maximo (px) de una linea que se ignora como borde de celda (sin escala). */
const MAX_LINE_PX = 2;
/** Con escala (px/pt): anillo, distancia de busqueda y grosor maximo de linea, en puntos. */
const RING_PT = 1;
export const SCAN_PT = 8;
const MAX_LINE_PT = 3;
/** Margen de px (suavizado del borde) que se suma al grosor maximo de una linea. */
const LINE_AA_PX = 2;
/** Cuanto se entra (pt) en la caja del texto al buscar lineas que la tocan. */
const INNER_INSET_PT = 0.5;
/** Fraccion minima de una fila que debe ser del mismo color para llamarla linea (coherencia). */
const LINE_COHERENCE = 0.8;
const MIN_ROW_SAMPLES = 4;

/**
 * Filas de cada lado que son una LINEA FINA: de 1 a `MAX_LINE_PX` filas
 * coherentes a lo largo del lado (>= 80 % del mismo color) y de un color
 * distinto al fondo del lado (la mediana de las medianas de sus filas). Una
 * rayada, un degradado o una foto no pasan: sus filas no son coherentes, o son
 * demasiadas. Devuelve claves `lado:profundidad`.
 */
function thinLineRows(
  reds: number[],
  greens: number[],
  blues: number[],
  sides: Side[],
  depths: number[],
  tolerance: number,
  maxLinePx: number,
): Map<Side, Array<{ from: number; to: number }>> {
  const rows = new Map<string, number[]>();
  for (let i = 0; i < reds.length; i += 1) {
    const key = `${sides[i]}:${depths[i]}`;
    const list = rows.get(key);
    if (list) list.push(i);
    else rows.set(key, [i]);
  }
  const result = new Map<Side, Array<{ from: number; to: number }>>();
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const present: Array<{ depth: number; median: number[]; coherent: boolean }> = [];
    const depthsOfSide = new Set<number>();
    for (let i = 0; i < sides.length; i += 1) if (sides[i] === side) depthsOfSide.add(depths[i]);
    for (const depth of [...depthsOfSide].sort((a, b) => a - b)) {
      const indexes = rows.get(`${side}:${depth}`);
      if (!indexes || indexes.length < MIN_ROW_SAMPLES) continue;
      const m = [
        median(indexes.map((i) => reds[i])),
        median(indexes.map((i) => greens[i])),
        median(indexes.map((i) => blues[i])),
      ];
      let near = 0;
      for (const i of indexes) {
        if (Math.hypot(reds[i] - m[0], greens[i] - m[1], blues[i] - m[2]) <= tolerance) near += 1;
      }
      present.push({ depth, median: m, coherent: near / indexes.length >= LINE_COHERENCE });
    }
    // Sin filas de sobra para distinguir una linea del fondo no se decide nada.
    if (present.length < 4) continue;
    const base = [0, 1, 2].map((c) => median(present.map((row) => row.median[c])));
    const flagged = present.filter(
      (row) =>
        row.coherent &&
        Math.hypot(row.median[0] - base[0], row.median[1] - base[1], row.median[2] - base[2]) >
          tolerance,
    );
    // Rachas de filas consecutivas: cada una es una linea si es fina.
    const runs: Array<{ from: number; to: number }> = [];
    for (const row of flagged) {
      const last = runs[runs.length - 1];
      if (last && row.depth === last.to + 1) last.to = row.depth;
      else runs.push({ from: row.depth, to: row.depth });
    }
    // Una racha mas gruesa que `maxLinePx` es banda, rayado o degradado; mas de dos rachas
    // tambien (rayas paralelas al lado); y las lineas no pueden ser mas de la mitad de las filas.
    const total = flagged.length;
    if (
      runs.length > 0 &&
      runs.length <= 2 &&
      runs.every((run) => run.to - run.from + 1 <= maxLinePx) &&
      total * 2 <= present.length
    ) {
      result.set(side, runs);
    }
  }
  return result;
}

/**
 * Color de fondo estimado alrededor de `box` y si ese fondo es liso.
 *
 * El color es la mediana del anillo exterior. El fondo se da por liso solo si
 * se cumplen TRES comprobaciones (ante la duda, avisa):
 *  1. Entre lados: las medianas de los cuatro lados (arriba, abajo, izquierda,
 *     derecha) difieren menos de `sideTolerance`. Detecta degradados suaves,
 *     que un parche del color mediano deja visibles como un escalon.
 *  2. Patron: pocos pixeles (`maxOutliers`) se apartan mas de `tolerance` de la
 *     mediana sin llegar a ser tinta. Detecta rayas, tramas y texturas.
 *  3. Tinta: pocos pixeles (`maxInk`) son muy distintos (unos trazos de
 *     texto vecino se toleran; una linea de tabla pegada a la caja, no).
 * Los pixeles transparentes (alfa 0) se ignoran. Sin muestras suficientes
 * devuelve blanco y `uniform: false`.
 */
export function sampleBackgroundColor(
  image: RgbaImage,
  box: PixelBox,
  options: BackgroundSampleOptions = {},
): BackgroundSample {
  const ppp = options.pxPerPt !== undefined && options.pxPerPt > 0 ? options.pxPerPt : null;
  const ring = Math.max(
    1,
    Math.round(options.ring ?? (ppp ? Math.max(2, ppp * RING_PT) : DEFAULT_RING)),
  );
  const maxLinePx = ppp ? Math.ceil(MAX_LINE_PT * ppp) + LINE_AA_PX : MAX_LINE_PX;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const inkDistance = options.inkDistance ?? DEFAULT_INK_DISTANCE;
  const maxOutliers = options.maxOutliers ?? DEFAULT_MAX_OUTLIERS;
  const maxInk = options.maxInk ?? DEFAULT_MAX_INK;
  const sideTolerance = options.sideTolerance ?? DEFAULT_SIDE_TOLERANCE;

  const insufficient: BackgroundSample = {
    color: "#ffffff",
    uniform: false,
    outliers: 1,
    samples: 0,
  };
  // Datos o caja inservibles (vacios, NaN, buffer mas corto que la imagen): sin lanzar.
  if (
    !(image.width > 0) ||
    !(image.height > 0) ||
    image.data.length < image.width * image.height * 4 ||
    ![box.x, box.y, box.width, box.height].every(Number.isFinite)
  ) {
    return insufficient;
  }

  const left = Math.floor(box.x);
  const top = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);

  let reds: number[] = [];
  let greens: number[] = [];
  let blues: number[] = [];
  let sides: Side[] = [];
  /** Distancia (px) de cada muestra al borde de la caja: 0 es el pixel pegado a ella. */
  let depths: number[] = [];
  // Se leen algunas filas mas alla del anillo solo para reconocer lineas finas.
  const scan = Math.max(ring, ppp ? Math.ceil(SCAN_PT * ppp) : LINE_SCAN_DEPTH);

  const polygon = options.polygon && options.polygon.length >= 3 ? options.polygon : null;
  if (polygon && !polygon.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return insufficient;

  const x0 = Math.max(0, left - scan);
  const x1 = Math.min(image.width, right + scan);
  const y0 = Math.max(0, top - scan);
  const y1 = Math.min(image.height, bottom + scan);

  const polygonSides: Side[] = ["bottom", "right", "top", "left"];
  const ignored = (options.ignore ?? []).filter((b) =>
    [b.x, b.y, b.width, b.height].every(Number.isFinite),
  );
  const takeAt = (x: number, y: number, side: Side, depth: number) => {
    for (const b of ignored) {
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return;
    }
    const offset = (y * image.width + x) * 4;
    if (image.data[offset + 3] === 0) return;
    reds.push(image.data[offset]);
    greens.push(image.data[offset + 1]);
    blues.push(image.data[offset + 2]);
    sides.push(side);
    depths.push(depth);
  };

  const take = (x: number, y: number) => {
    if (y < top) takeAt(x, y, "top", top - 1 - y);
    else if (y >= bottom) takeAt(x, y, "bottom", y - bottom);
    else if (x < left) takeAt(x, y, "left", left - 1 - x);
    else takeAt(x, y, "right", x - right);
  };
  if (polygon) {
    // Anillo pegado al cuadrilatero: fuera de el y a menos de `ring` px de su borde.
    const n = polygon.length;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        let best = Number.POSITIVE_INFINITY;
        let bestEdge = 0;
        for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
          const a = polygon[j];
          const b = polygon[i];
          if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
          const distance = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
          if (distance < best) {
            best = distance;
            bestEdge = j;
          }
        }
        if (inside || best > scan) continue;
        takeAt(x, y, polygonSides[bestEdge % 4], Math.floor(best));
      }
    }
  } else {
    // Filas ENTRE el texto original y `box`: las que va a tapar la cobertura. Solo cuentan para
    // reconocer lineas (profundidad negativa), nunca para el color ni la uniformidad.
    const inner = options.inner;
    if (inner && [inner.x, inner.y, inner.width, inner.height].every(Number.isFinite)) {
      // Se entra medio punto en la caja del texto: una linea que la TOCA o la solapa unas
      // decimas (tablas con margen 0) cae en la fila del borde, que si no quedaria dentro.
      const inset = ppp ? Math.max(1, Math.ceil(INNER_INSET_PT * ppp)) : 1;
      const il = Math.max(left, Math.floor(inner.x) + inset);
      const it = Math.max(top, Math.floor(inner.y) + inset);
      const ir = Math.min(right, Math.ceil(inner.x + inner.width) - inset);
      const ib = Math.min(bottom, Math.ceil(inner.y + inner.height) - inset);
      for (let y = Math.max(0, top); y < Math.min(image.height, it); y += 1) {
        for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) takeAt(x, y, "top", top - 1 - y);
      }
      for (let y = Math.max(0, ib); y < Math.min(image.height, bottom); y += 1) {
        for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) takeAt(x, y, "bottom", y - bottom);
      }
      for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y += 1) {
        for (let x = Math.max(0, left); x < Math.min(image.width, il); x += 1) takeAt(x, y, "left", left - 1 - x);
        for (let x = Math.max(0, ir); x < Math.min(image.width, right); x += 1) takeAt(x, y, "right", x - right);
      }
    }
    // Solo se recorre el anillo (nunca el interior, que puede ser enorme).
    for (let y = y0; y < y1; y += 1) {
      if (y < top || y >= bottom) {
        for (let x = x0; x < x1; x += 1) take(x, y);
      } else {
        for (let x = x0; x < Math.min(x1, left); x += 1) take(x, y);
        for (let x = Math.max(x0, right); x < x1; x += 1) take(x, y);
      }
    }
  }

  // Lineas finas (bordes de celda de hasta 3 pt): no son fondo ni patron, y no se deben cubrir.
  const thin =
    options.thinLines === false
      ? new Map<Side, Array<{ from: number; to: number }>>()
      : thinLineRows(reds, greens, blues, sides, depths, tolerance, maxLinePx);
  const inThin = (side: Side, depth: number) =>
    (thin.get(side) ?? []).some((run) => depth >= run.from && depth <= run.to);
  // El anillo empieza justo FUERA de la ultima linea que lo toca (o del borde, si no hay).
  const ringStart = (side: Side) => {
    let start = 0;
    for (const run of thin.get(side) ?? []) if (run.from < ring + start) start = Math.max(start, run.to + 1);
    return start;
  };
  const starts: Record<Side, number> = {
    top: ringStart("top"),
    bottom: ringStart("bottom"),
    left: ringStart("left"),
    right: ringStart("right"),
  };
  const keep: number[] = [];
  for (let i = 0; i < reds.length; i += 1) {
    const start = starts[sides[i]];
    if (depths[i] >= start && depths[i] < start + ring && !inThin(sides[i], depths[i])) keep.push(i);
  }
  const lines: PixelBox[] = [];
  if (!polygon) {
    for (const [side, runs] of thin) {
      for (const run of runs) {
        const thickness = run.to - run.from + 1;
        if (side === "top") {
          lines.push({ x: left - scan, y: top - 1 - run.to, width: right - left + scan * 2, height: thickness });
        } else if (side === "bottom") {
          lines.push({ x: left - scan, y: bottom + run.from, width: right - left + scan * 2, height: thickness });
        } else if (side === "left") {
          lines.push({ x: left - 1 - run.to, y: top - scan, width: thickness, height: bottom - top + scan * 2 });
        } else {
          lines.push({ x: right + run.from, y: top - scan, width: thickness, height: bottom - top + scan * 2 });
        }
      }
    }
  }
  reds = keep.map((i) => reds[i]);
  greens = keep.map((i) => greens[i]);
  blues = keep.map((i) => blues[i]);
  sides = keep.map((i) => sides[i]);
  depths = keep.map((i) => depths[i]);

  if (reds.length < MIN_SAMPLES) {
    return { color: "#ffffff", uniform: false, outliers: 1, samples: reds.length };
  }

  const mr = median(reds);
  const mg = median(greens);
  const mb = median(blues);
  let pattern = 0;
  let ink = 0;
  for (let i = 0; i < reds.length; i += 1) {
    const distance = Math.sqrt(
      (reds[i] - mr) ** 2 + (greens[i] - mg) ** 2 + (blues[i] - mb) ** 2,
    );
    if (distance > inkDistance) ink += 1;
    else if (distance > tolerance) pattern += 1;
  }
  const outliers = pattern / reds.length;
  const inkFraction = ink / reds.length;

  // Diferencia entre lados opuestos: la señal de un degradado, aunque suave.
  const perSide = new Map<Side, number[][]>();
  sides.forEach((side, i) => {
    const list = perSide.get(side) ?? [[], [], []];
    list[0].push(reds[i]);
    list[1].push(greens[i]);
    list[2].push(blues[i]);
    perSide.set(side, list);
  });
  const medians: number[][] = [];
  for (const channels of perSide.values()) {
    if (channels[0].length >= MIN_SIDE_SAMPLES) {
      medians.push(channels.map((values) => median(values)));
    }
  }
  let sideDelta = 0;
  for (let i = 0; i < medians.length; i += 1) {
    for (let j = i + 1; j < medians.length; j += 1) {
      sideDelta = Math.max(
        sideDelta,
        Math.sqrt(
          (medians[i][0] - medians[j][0]) ** 2 +
            (medians[i][1] - medians[j][1]) ** 2 +
            (medians[i][2] - medians[j][2]) ** 2,
        ),
      );
    }
  }

  // Por lado: un lado donde una cuarta parte de los pixeles se aparta del fondo no es liso
  // aunque el resto del anillo (que lo diluye) lo sea (rayas que cruzan solo dos lados).
  let worstSide = 0;
  for (const side of ["top", "bottom", "left", "right"] as const) {
    let total = 0;
    let off = 0;
    for (let i = 0; i < reds.length; i += 1) {
      if (sides[i] !== side) continue;
      total += 1;
      if (Math.hypot(reds[i] - mr, greens[i] - mg, blues[i] - mb) > tolerance) off += 1;
    }
    if (total >= MIN_SIDE_SAMPLES * 2) worstSide = Math.max(worstSide, off / total);
  }

  return {
    color: toHex(mr, mg, mb),
    uniform:
      outliers <= maxOutliers &&
      inkFraction <= maxInk &&
      sideDelta <= sideTolerance &&
      worstSide <= MAX_SIDE_OFF,
    outliers,
    samples: reds.length,
    sideDelta,
    ink: inkFraction,
    ...(lines.length > 0 ? { lines } : {}),
  };
}
