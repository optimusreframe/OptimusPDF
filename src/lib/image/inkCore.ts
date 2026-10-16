/**
 * Motor de «tinta» (U6.1 de `docs/PLAN-FIRMA-AGIL.md` §9.4): convierte los pixeles de una foto o imagen de una firma
 * (tinta oscura sobre papel claro) en un RGBA con fondo transparente. Es PURO: solo recibe y devuelve arreglos de bytes
 * (`InkImage`, compatible con `ImageData`), no toca DOM, canvas, red ni reloj, y por eso mismo corre igual en el hilo
 * principal, en un Web Worker y en Node (Vitest). Misma entrada y mismas opciones dan EXACTAMENTE los mismos bytes (solo
 * aritmetica de doble precision basica: sumas, restos y productos, sin `Math.sin`/`exp`).
 *
 * Todo el trabajo largo se escribe como GENERADORES (`Steps<T>`) que ceden el control cada ~65 000 pixeles: la version
 * sincrona (`extractInk`) los consume de golpe y la asincrona (`extractInkAsync`, en `inkExtract.ts`) cede al navegador
 * entre trozos para que ninguna tarea larga pase de ~50 ms.
 *
 * Las utilidades `estimateBackground`, `otsuThreshold`, `removeSpecks`, `trimToInk` y `resizeArea` se exportan para que el
 * Extractor (F7) las reutilice en el recorte manual de regiones.
 */

/** Pixeles RGBA de 8 bits con alfa recto (NO premultiplicado). `ImageData` cumple esta forma. */
export interface InkImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface InkColor {
  r: number;
  g: number;
  b: number;
}

export interface InkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Region a analizar. Con `exact: true` la salida ES esa region (sin recortar al contenido). */
export type InkCrop = "auto" | "none" | (InkRect & { exact?: boolean });

export type InkMode = "original" | "black" | "blue" | InkColor;

export interface InkOptions {
  /**
   * Luminancia (0-255) en la que la tinta queda al 50 % de opacidad: lo mas oscuro es opaco, lo mas claro, transparente.
   * `"auto"` (por defecto): Otsu sobre la luminancia (cae en el punto medio entre la media de la tinta y la del papel).
   * Subirlo conserva mas gris (trazos mas anchos); bajarlo deja solo lo mas oscuro.
   */
  threshold?: number | "auto";
  /** 0 (borde duro) a 1 (degradado largo). Por defecto 0,5. */
  softness?: number;
  /** Color final de la tinta. `"original"` conserva el color de la foto (por defecto). */
  ink?: InkMode;
  /** Tamano minimo (en pixeles, 8-conectados) de un trazo para conservarlo; 0 lo desactiva. `"auto"` escala con la imagen. */
  cleanSpecks?: number | "auto";
  /** Corrige sombras y degradados del papel (fondo estimado y division). Por defecto `true`. */
  evenLighting?: boolean;
  /** `"auto"` (por defecto): recorta a la tinta con margen. `"none"`: toda la imagen. Un rectangulo: solo esa region. */
  crop?: InkCrop;
  /** Margen transparente alrededor de la tinta, en pixeles de la IMAGEN DE ENTRADA. `"auto"`: ~5 % del lado mayor. */
  margin?: number | "auto";
  /** Lado maximo de la salida (por defecto 4096, el tope del baul). */
  maxDimension?: number;
}

export interface ExtractResult {
  /** RGBA recto, con el fondo transparente (alfa 0 y RGB 0). */
  image: InkImage & { data: Uint8ClampedArray };
  /** Umbral usado (luminancia, tras corregir la iluminacion). */
  threshold: number;
  auto: boolean;
  /** Caja ajustada a la tinta, en coordenadas de la imagen de ENTRADA. */
  inkBounds: InkRect;
  /** Region de la entrada que ocupa la salida antes de escalar (incluye el margen; puede salirse de la imagen). */
  outputRect: InkRect;
  /** Pixeles con algo de tinta (alfa > 0) tras quitar motas, antes de escalar. */
  inkPixels: number;
  removedSpecks: number;
  /** 1, o menos si hubo que reducir al `maxDimension`. */
  scale: number;
  evenLighting: boolean;
}

export type InkErrorCode =
  | "empty-file"
  | "file-too-large"
  | "unsupported-format"
  | "decode-failed"
  | "too-many-pixels"
  | "invalid-image"
  | "no-ink"
  | "too-dark"
  | "encode-failed"
  | "aborted";

const ERROR_MESSAGES: Record<InkErrorCode, string> = {
  "empty-file": "El archivo está vacío.",
  "file-too-large": "La imagen pesa más de 10 MB. Elige una más pequeña o reduce su tamaño.",
  "unsupported-format": "Formato no admitido. Usa una imagen PNG, JPG, WEBP o SVG.",
  "decode-failed": "No se pudo leer la imagen. Puede estar dañada o ser de un formato que este navegador no abre.",
  "too-many-pixels": "La imagen es demasiado grande en píxeles. Elige una con menos resolución.",
  "invalid-image": "La imagen no es válida.",
  "no-ink": "No se encontró tinta. Comprueba que la firma se vea y que esté sobre un fondo claro.",
  "too-dark": "La imagen es demasiado oscura: se necesita tinta oscura sobre un fondo claro.",
  "encode-failed": "No se pudo generar un PNG de un tamaño admitido.",
  aborted: "Operación cancelada.",
};

/** Error con codigo estable (la interfaz mapea el codigo a su texto; `message` trae uno en espanol por defecto). */
export class InkError extends Error {
  readonly code: InkErrorCode;
  constructor(code: InkErrorCode, message: string = ERROR_MESSAGES[code]) {
    super(message);
    this.name = "InkError";
    this.code = code;
  }
}

/** Tope de pixeles que acepta `extractInk` (memoria de trabajo ~13 bytes por pixel). */
export const MAX_EXTRACT_PIXELS = 50_000_000;
/** Lado maximo de la salida: lo mismo que `MAX_VAULT_IMAGE_DIMENSION` de `signVault.ts`. */
export const MAX_OUTPUT_DIMENSION = 4096;
/** Tinta negra y azul: los mismos tonos del compositor de firmas (`SIGNATURE_INKS`). */
export const BLACK_INK: Readonly<InkColor> = { r: 11, g: 11, b: 12 };
export const BLUE_INK: Readonly<InkColor> = { r: 18, g: 50, b: 125 };

/** Mediana de luminancia por debajo de la cual la imagen se considera «demasiado oscura». */
export const DARK_MEDIAN = 64;
/** Diferencia minima entre la media del papel y la de la tinta para hablar de tinta. */
export const MIN_CONTRAST = 40;
/** Pixeles minimos de tinta. */
export const MIN_INK_PIXELS = 4;

/** Una tarea generadora cede (`yield`) cada trozo de trabajo. */
export type Steps<T> = Generator<void, T, undefined>;

/** Pixeles de trabajo entre dos cesiones de control. */
const BAND_PIXELS = 1 << 16;

function bandRows(width: number): number {
  return Math.max(1, Math.floor(BAND_PIXELS / Math.max(1, width)));
}

/** Consume una tarea generadora de golpe. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Validacion y utilidades basicas                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

export function validateInkImage(image: InkImage): void {
  const { width, height, data } = image ?? ({} as Partial<InkImage>);
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
    throw new InkError("invalid-image");
  }
  // Primero el limite de pixeles (sin tocar `data`): una cabecera falsa de 30 000 x 30 000 no debe asignar nada.
  if ((width as number) * (height as number) > MAX_EXTRACT_PIXELS) throw new InkError("too-many-pixels");
  if (!data || data.length < (width as number) * (height as number) * 4) throw new InkError("invalid-image");
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function* histogramSteps(values: Uint8Array): Steps<Uint32Array> {
  const histogram = new Uint32Array(256);
  for (let start = 0; start < values.length; start += BAND_PIXELS) {
    if (start > 0) yield;
    const end = Math.min(values.length, start + BAND_PIXELS);
    for (let i = start; i < end; i += 1) histogram[values[i]] += 1;
  }
  return histogram;
}

/** Valor por debajo del cual queda la fraccion `fraction` de las muestras del histograma. */
function percentileOfHistogram(histogram: ArrayLike<number>, fraction: number): number {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += histogram[i];
  const target = Math.max(1, Math.ceil(total * fraction));
  let sum = 0;
  for (let i = 0; i < 256; i += 1) {
    sum += histogram[i];
    if (sum >= target) return i;
  }
  return 255;
}

/**
 * Umbral de Otsu de un histograma de 256 niveles: el corte que maximiza la varianza entre clases. Devuelve `t`: los
 * valores `<= t` son la clase oscura (tinta). Con una meseta de empates (imagen de dos valores) devuelve su centro.
 * Un histograma vacio o de un solo nivel devuelve 128.
 */
export function otsuThreshold(histogram: ArrayLike<number>): number {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) {
    total += histogram[i];
    sumAll += i * histogram[i];
  }
  let weightBack = 0;
  let sumBack = 0;
  let best = -1;
  let first = 128;
  let last = 128;
  for (let t = 0; t < 256; t += 1) {
    weightBack += histogram[t];
    if (weightBack === 0) continue;
    const weightFront = total - weightBack;
    if (weightFront === 0) break;
    sumBack += t * histogram[t];
    const meanBack = sumBack / weightBack;
    const meanFront = (sumAll - sumBack) / weightFront;
    const between = weightBack * weightFront * (meanBack - meanFront) * (meanBack - meanFront);
    if (between > best * (1 + 1e-9)) {
      best = between;
      first = t;
      last = t;
    } else if (between >= best * (1 - 1e-9)) {
      last = t;
    }
  }
  return Math.floor((first + last) / 2);
}

/**
 * Medias de la clase oscura (`<= t`) y clara (`> t`), cuantos pixeles tiene la oscura y el NIVEL DEL NUCLEO de la tinta (su
 * percentil 10: lo mas oscuro que alcanza de verdad el trazo, sin contar el borde antialias, que lo subiria).
 */
function classStats(
  histogram: ArrayLike<number>,
  t: number,
): { dark: number; darkMean: number; lightMean: number; inkLevel: number } {
  let darkCount = 0;
  let darkSum = 0;
  let lightCount = 0;
  let lightSum = 0;
  for (let i = 0; i < 256; i += 1) {
    if (i <= t) {
      darkCount += histogram[i];
      darkSum += i * histogram[i];
    } else {
      lightCount += histogram[i];
      lightSum += i * histogram[i];
    }
  }
  let inkLevel = 0;
  const target = Math.max(1, Math.ceil(darkCount * 0.1));
  for (let i = 0, seen = 0; i <= t && i < 256; i += 1) {
    seen += histogram[i];
    if (seen >= target) {
      inkLevel = i;
      break;
    }
  }
  return {
    dark: darkCount,
    darkMean: darkCount > 0 ? darkSum / darkCount : 0,
    lightMean: lightCount > 0 ? lightSum / lightCount : 255,
    inkLevel,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Luminancia y fondo                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Luminancia (Rec. 601, 0-255) de una region, con los pixeles semitransparentes compuestos sobre BLANCO: una firma que
 * ya viene en un PNG transparente se trata igual que la misma firma sobre papel.
 */
function* lumaSteps(src: InkImage, rx: number, ry: number, rw: number, rh: number): Steps<Uint8Array> {
  const luma = new Uint8Array(rw * rh);
  const data = src.data;
  const rows = bandRows(rw);
  for (let y = 0; y < rh; y += 1) {
    if (y % rows === 0) yield;
    let s = ((ry + y) * src.width + rx) * 4;
    let o = y * rw;
    for (let x = 0; x < rw; x += 1, s += 4, o += 1) {
      const a = data[s + 3];
      if (a === 255) {
        luma[o] = (299 * data[s] + 587 * data[s + 1] + 114 * data[s + 2] + 500) / 1000;
      } else {
        const k = 255 - a;
        const r = ((data[s] * a + 127) / 255 | 0) + k;
        const g = ((data[s + 1] * a + 127) / 255 | 0) + k;
        const b = ((data[s + 2] * a + 127) / 255 | 0) + k;
        luma[o] = (299 * r + 587 * g + 114 * b + 500) / 1000;
      }
    }
  }
  return luma;
}

export interface BackgroundOptions {
  /** Lado de la celda en pixeles. Por defecto ~1/32 del lado mayor, entre 6 y 64. */
  cell?: number;
  /** Percentil de cada celda que se toma como «papel» (por defecto 0,85: ignora la tinta, que es minoria). */
  percentile?: number;
}

/** Brillo minimo que se admite para el papel estimado (evita dividir por casi cero en sombras negras). */
const BACKGROUND_FLOOR = 24;

/**
 * Estima el brillo del PAPEL en cada pixel (un `Uint8Array` del mismo tamano que `luma`): percentil alto por celdas (la
 * tinta es minoria y no cuenta), reparacion de las celdas con demasiada tinta con la mediana de sus vecinas y ampliacion
 * bilineal. Dividir la luminancia por este campo (y multiplicar por 255) borra sombras y
 * degradados suaves.
 */
export function* estimateBackgroundSteps(
  luma: Uint8Array,
  width: number,
  height: number,
  options: BackgroundOptions = {},
): Steps<Uint8Array> {
  const cell = Math.max(2, Math.round(options.cell ?? clamp(Math.round(Math.max(width, height) / 32), 6, 64)));
  const percentile = clamp(options.percentile ?? 0.85, 0.05, 1);
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const histograms = new Uint32Array(cols * rows * 256);
  const bandStep = bandRows(width);
  for (let y = 0; y < height; y += 1) {
    if (y % bandStep === 0) yield;
    const base = Math.floor(y / cell) * cols;
    let o = y * width;
    for (let x = 0; x < width; x += 1, o += 1) {
      histograms[(base + Math.floor(x / cell)) * 256 + luma[o]] += 1;
    }
  }
  // Valor de papel de cada celda.
  let grid: Float64Array = new Float64Array(cols * rows);
  for (let c = 0; c < cols * rows; c += 1) {
    grid[c] = percentileOfHistogram(histograms.subarray(c * 256, c * 256 + 256), percentile);
  }
  // Celdas con tinta de sobra (mucho mas oscuras que la mediana de sus vecinas) se sustituyen por esa mediana. Una
  // dilatacion (maximo) haria lo mismo pero sesgaria hacia arriba cualquier degradado; la mediana no.
  for (let pass = 0; pass < 2; pass += 1) grid = repairInkCells(grid, cols, rows);
  yield;

  // Ampliacion bilineal (con extrapolacion lineal en los bordes): el centro de cada celda vale su valor.
  const column0 = new Int32Array(width);
  const column1 = new Int32Array(width);
  const columnFraction = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    const u = (x + 0.5) / cell - 0.5;
    const base = cols > 1 ? clamp(Math.floor(u), 0, cols - 2) : 0;
    column0[x] = base;
    column1[x] = cols > 1 ? base + 1 : 0;
    columnFraction[x] = cols > 1 ? u - base : 0;
  }
  const background = new Uint8Array(width * height);
  const top = new Float64Array(cols);
  for (let y = 0; y < height; y += 1) {
    if (y % bandStep === 0) yield;
    const v = (y + 0.5) / cell - 0.5;
    const baseRow = rows > 1 ? clamp(Math.floor(v), 0, rows - 2) : 0;
    const row0 = baseRow * cols;
    const row1 = (rows > 1 ? baseRow + 1 : 0) * cols;
    const fy = rows > 1 ? v - baseRow : 0;
    for (let c = 0; c < cols; c += 1) top[c] = grid[row0 + c] + (grid[row1 + c] - grid[row0 + c]) * fy;
    let o = y * width;
    for (let x = 0; x < width; x += 1, o += 1) {
      const a = top[column0[x]];
      const value = a + (top[column1[x]] - a) * columnFraction[x];
      background[o] = clamp(Math.round(value), BACKGROUND_FLOOR, 255);
    }
  }
  return background;
}

/** Una celda mas de un 7 % por debajo de la mediana de su vecindad 3 x 3 se da por «con tinta» y toma esa mediana. */
function repairInkCells(grid: Float64Array, cols: number, rows: number): Float64Array {
  const out = new Float64Array(grid);
  const around: number[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      around.length = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < cols && yy >= 0 && yy < rows) around.push(grid[yy * cols + xx]);
        }
      }
      around.sort((a, b) => a - b);
      const median = around[around.length >> 1];
      if (grid[y * cols + x] < median * 0.93) out[y * cols + x] = median;
    }
  }
  return out;
}

/** Version sincrona de `estimateBackgroundSteps`. */
export function estimateBackground(luma: Uint8Array, width: number, height: number, options?: BackgroundOptions): Uint8Array {
  return runSteps(estimateBackgroundSteps(luma, width, height, options));
}

/** `L * 255 / fondo`, saturado a 255: el papel queda en 255 aunque este en sombra. */
function* normalizeSteps(luma: Uint8Array, background: Uint8Array, width: number): Steps<Uint8Array> {
  const out = new Uint8Array(luma.length);
  const rows = bandRows(width) * width;
  for (let i = 0; i < luma.length; i += 1) {
    if (i % rows === 0) yield;
    const value = (luma[i] * 255 + (background[i] >> 1)) / background[i];
    out[i] = value > 255 ? 255 : value;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Motas (componentes conexos pequenos)                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Pone a 0 los componentes (8-conectados) de pixeles con `alpha > 0` que tengan MENOS de `minSize` pixeles. Modifica
 * `alpha` en el sitio y devuelve cuantos componentes quito. Etiquetado de dos pasadas con union-find (la etiqueta menor
 * manda), sin recursion.
 */
export function* removeSpecksSteps(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minSize: number,
): Steps<number> {
  if (!(minSize > 1)) return 0;
  const labels = new Int32Array(width * height);
  // Cota de etiquetas provisionales: solo nace una etiqueta cuando no hay vecino previo, y dos nacimientos nunca son vecinos.
  const parent = new Int32Array(((width + 1) >> 1) * ((height + 1) >> 1) + 2);
  let next = 1;
  const find = (label: number): number => {
    let current = label;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  // Une la etiqueta actual con la de un vecino ya etiquetado y devuelve la raiz resultante (siempre la menor).
  const merge = (label: number, neighborLabel: number): number => {
    if (neighborLabel === 0) return label;
    const root = find(neighborLabel);
    if (label === 0) return root;
    if (root < label) {
      parent[label] = root;
      return root;
    }
    if (root > label) parent[root] = label;
    return label;
  };
  const rows = bandRows(width);
  for (let y = 0; y < height; y += 1) {
    if (y % rows === 0) yield;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (alpha[index] === 0) continue;
      let label = 0;
      if (x > 0) label = merge(label, labels[index - 1]);
      if (y > 0) {
        if (x > 0) label = merge(label, labels[index - width - 1]);
        label = merge(label, labels[index - width]);
        if (x < width - 1) label = merge(label, labels[index - width + 1]);
      }
      if (label === 0) {
        label = next;
        parent[label] = label;
        next += 1;
      }
      labels[index] = label;
    }
  }
  // Aplana: como siempre se enlaza al menor, `parent[l] <= l` y basta una pasada ascendente.
  const sizes = new Int32Array(next);
  for (let label = 1; label < next; label += 1) parent[label] = parent[parent[label]];
  for (let y = 0; y < height; y += 1) {
    if (y % rows === 0) yield;
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      const label = labels[base + x];
      if (label !== 0) sizes[parent[label]] += 1;
    }
  }
  let removed = 0;
  for (let label = 1; label < next; label += 1) {
    if (parent[label] === label && sizes[label] < minSize) removed += 1;
  }
  if (removed === 0) return 0;
  for (let y = 0; y < height; y += 1) {
    if (y % rows === 0) yield;
    const base = y * width;
    for (let x = 0; x < width; x += 1) {
      const label = labels[base + x];
      if (label !== 0 && sizes[parent[label]] < minSize) alpha[base + x] = 0;
    }
  }
  return removed;
}

/** Version sincrona de `removeSpecksSteps`. */
export function removeSpecks(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minSize: number,
): number {
  return runSteps(removeSpecksSteps(alpha, width, height, minSize));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Recorte                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** Caja de los elementos con valor `>= minValue` en un plano (`stride` 1 para mascaras, 4 con `offset` 3 para RGBA). */
function* planeBoundsSteps(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  stride: number,
  offset: number,
  minValue: number,
): Steps<InkRect | null> {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const rows = bandRows(width);
  for (let y = 0; y < height; y += 1) {
    if (y % rows === 0) yield;
    let index = y * width * stride + offset;
    for (let x = 0; x < width; x += 1, index += stride) {
      if (plane[index] >= minValue) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copia una region de una imagen RGBA; lo que cae FUERA de la imagen queda transparente. */
export function copyRect(src: InkImage, rect: InkRect): InkImage & { data: Uint8ClampedArray } {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const x0 = Math.max(0, rect.x);
  const x1 = Math.min(src.width, rect.x + rect.width);
  if (x1 > x0) {
    for (let y = 0; y < rect.height; y += 1) {
      const sy = rect.y + y;
      if (sy < 0 || sy >= src.height) continue;
      const from = (sy * src.width + x0) * 4;
      out.set(src.data.subarray(from, from + (x1 - x0) * 4), (y * rect.width + (x0 - rect.x)) * 4);
    }
  }
  return { width: rect.width, height: rect.height, data: out };
}

/**
 * Recorta una imagen RGBA a la caja de su tinta (pixeles con alfa >= `minAlpha`) mas `margin` pixeles transparentes por
 * lado. Devuelve `null` si no hay tinta. `rect` es la caja AJUSTADA (sin margen), en pixeles de la imagen recibida.
 */
export function trimToInk(
  image: InkImage,
  margin = 0,
  minAlpha = 1,
): { image: InkImage & { data: Uint8ClampedArray }; rect: InkRect; padded: InkRect } | null {
  validateInkImage(image);
  const rect = runSteps(planeBoundsSteps(image.data, image.width, image.height, 4, 3, minAlpha));
  if (!rect) return null;
  const pad = Math.max(0, Math.round(margin));
  const padded = { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad };
  return { image: copyRect(image, padded), rect, padded };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Reduccion de tamano                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** Pesos de cobertura de cada pixel destino sobre los pixeles origen (filtro de caja exacto). */
function boxWeights(from: number, to: number): { start: Int32Array; count: Int32Array; offset: Int32Array; weights: Float64Array } {
  const ratio = from / to;
  const start = new Int32Array(to);
  const count = new Int32Array(to);
  const offset = new Int32Array(to);
  const list: number[] = [];
  for (let i = 0; i < to; i += 1) {
    const lo = i * ratio;
    const hi = Math.min(from, (i + 1) * ratio);
    const first = Math.floor(lo);
    const last = Math.min(from, Math.ceil(hi));
    start[i] = first;
    count[i] = last - first;
    offset[i] = list.length;
    for (let s = first; s < last; s += 1) {
      list.push((Math.min(hi, s + 1) - Math.max(lo, s)) / ratio);
    }
  }
  return { start, count, offset, weights: Float64Array.from(list) };
}

/**
 * Reduce (o amplia) con promedio por area y alfa premultiplicado: los bordes semitransparentes no se manchan con el color
 * de los pixeles invisibles. Memoria constante respecto al tamano de entrada.
 */
export function* resizeAreaSteps(src: InkImage, newWidth: number, newHeight: number): Steps<InkImage & { data: Uint8ClampedArray }> {
  const horizontal = boxWeights(src.width, newWidth);
  const vertical = boxWeights(src.height, newHeight);
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);
  const row = new Float64Array(newWidth * 4);
  const accumulator = new Float64Array(newWidth * 4);
  const data = src.data;
  const rowsPerBand = Math.max(1, Math.floor(BAND_PIXELS / Math.max(1, src.width)));
  for (let oy = 0; oy < newHeight; oy += 1) {
    accumulator.fill(0);
    for (let k = 0; k < vertical.count[oy]; k += 1) {
      const sy = vertical.start[oy] + k;
      if (sy % rowsPerBand === 0) yield;
      const weightY = vertical.weights[vertical.offset[oy] + k];
      row.fill(0);
      for (let ox = 0; ox < newWidth; ox += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let j = 0; j < horizontal.count[ox]; j += 1) {
          const sx = horizontal.start[ox] + j;
          const w = horizontal.weights[horizontal.offset[ox] + j];
          const p = (sy * src.width + sx) * 4;
          const alpha = data[p + 3] * w;
          r += data[p] * alpha;
          g += data[p + 1] * alpha;
          b += data[p + 2] * alpha;
          a += alpha;
        }
        const q = ox * 4;
        row[q] = r;
        row[q + 1] = g;
        row[q + 2] = b;
        row[q + 3] = a;
      }
      for (let i = 0; i < row.length; i += 1) accumulator[i] += row[i] * weightY;
    }
    for (let ox = 0; ox < newWidth; ox += 1) {
      const q = ox * 4;
      const a = accumulator[q + 3];
      const p = (oy * newWidth + ox) * 4;
      if (a > 0.5) {
        out[p] = Math.round(accumulator[q] / a);
        out[p + 1] = Math.round(accumulator[q + 1] / a);
        out[p + 2] = Math.round(accumulator[q + 2] / a);
        out[p + 3] = Math.round(a);
      }
    }
  }
  return { width: newWidth, height: newHeight, data: out };
}

export function resizeArea(src: InkImage, newWidth: number, newHeight: number): InkImage & { data: Uint8ClampedArray } {
  return runSteps(resizeAreaSteps(src, newWidth, newHeight));
}

/** Dimensiones que caben en `maxDimension` conservando la proporcion (nunca menos de 1 px). */
export function fitDimensions(width: number, height: number, maxDimension: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height, scale: 1 };
  const scale = maxDimension / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Extraccion                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  exact: boolean;
}

function resolveRegion(image: InkImage, crop: InkCrop): Region {
  if (typeof crop === "object" && crop !== null) {
    const values = [crop.x, crop.y, crop.width, crop.height];
    if (!values.every((value) => Number.isFinite(value))) throw new InkError("invalid-image");
    const x0 = Math.max(0, Math.floor(crop.x));
    const y0 = Math.max(0, Math.floor(crop.y));
    const x1 = Math.min(image.width, Math.ceil(crop.x + crop.width));
    const y1 = Math.min(image.height, Math.ceil(crop.y + crop.height));
    if (x1 <= x0 || y1 <= y0) throw new InkError("invalid-image", "La región elegida queda fuera de la imagen.");
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, exact: crop.exact === true };
  }
  return { x: 0, y: 0, width: image.width, height: image.height, exact: false };
}

function resolveInk(mode: InkMode | undefined): InkColor | null {
  if (mode === undefined || mode === "original") return null;
  if (mode === "black") return BLACK_INK;
  if (mode === "blue") return BLUE_INK;
  const { r, g, b } = mode;
  if (![r, g, b].every((value) => Number.isFinite(value))) throw new InkError("invalid-image", "Color de tinta no válido.");
  return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255) };
}

/** Tamano minimo de trazo por defecto: crece con el cuadrado del lado (6 px hasta ~800 px, 26 px a 1600 px, 160 px a 4000 px). */
export function autoSpeckSize(width: number, height: number): number {
  const side = Math.max(width, height);
  return Math.max(6, Math.round((side * side) / 100_000));
}

/** Tabla luminancia -> alfa: 50 % en `threshold`, rampa simetrica de semiancho `halfWidth`. */
function alphaTable(threshold: number, halfWidth: number): Uint8Array {
  const table = new Uint8Array(256);
  for (let level = 0; level < 256; level += 1) {
    const value = 0.5 + (threshold - level) / (2 * halfWidth);
    table[level] = value >= 1 ? 255 : value <= 0 ? 0 : Math.round(value * 255);
  }
  return table;
}

/**
 * Pipeline completo como tarea generadora (ver la cabecera). Orden: region -> luminancia -> (iluminacion) -> umbral ->
 * alfa -> motas -> recorte al contenido -> color -> reduccion. Lanza `InkError` con codigo estable.
 */
export function* extractInkSteps(image: InkImage, options: InkOptions = {}): Steps<ExtractResult> {
  validateInkImage(image);
  const evenLighting = options.evenLighting !== false;
  const inkColor = resolveInk(options.ink);
  const softness = clamp(Number.isFinite(options.softness) ? (options.softness as number) : 0.5, 0, 1);
  const maxDimension = Math.max(1, Math.floor(options.maxDimension ?? MAX_OUTPUT_DIMENSION));
  const region = resolveRegion(image, options.crop ?? "auto");
  const { width: rw, height: rh } = region;

  const luma = yield* lumaSteps(image, region.x, region.y, rw, rh);
  const rawHistogram = yield* histogramSteps(luma);
  if (percentileOfHistogram(rawHistogram, 0.5) < DARK_MEDIAN) throw new InkError("too-dark");

  let background: Uint8Array | null = null;
  let level = luma;
  if (evenLighting) {
    background = yield* estimateBackgroundSteps(luma, rw, rh);
    level = yield* normalizeSteps(luma, background, rw);
  }
  const histogram = yield* histogramSteps(level);

  // Umbral: Otsu (que ya cae en el punto medio entre las medias de tinta y de papel) o el manual.
  const auto = options.threshold === undefined || options.threshold === "auto";
  let threshold: number;
  if (auto) {
    threshold = otsuThreshold(histogram);
  } else {
    if (typeof options.threshold !== "number" || !Number.isFinite(options.threshold)) throw new InkError("invalid-image", "Umbral no válido.");
    threshold = clamp(Math.round(options.threshold), 1, 254);
  }
  const stats = classStats(histogram, threshold);
  if (stats.dark < MIN_INK_PIXELS || stats.lightMean - stats.darkMean < MIN_CONTRAST) throw new InkError("no-ink");

  // Alfa suave: 50 % en el umbral, rampa proporcional a la distancia hasta la tinta y hasta el papel.
  const halfWidth = Math.max(0.5, softness * Math.min(threshold - stats.darkMean, stats.lightMean - threshold));
  const table = alphaTable(threshold, halfWidth);
  const alpha = new Uint8Array(rw * rh);
  const rows = bandRows(rw);
  for (let y = 0; y < rh; y += 1) {
    if (y % rows === 0) yield;
    for (let o = y * rw, end = o + rw; o < end; o += 1) alpha[o] = table[level[o]];
  }

  // Motas.
  const speckSize =
    options.cleanSpecks === undefined || options.cleanSpecks === "auto"
      ? autoSpeckSize(rw, rh)
      : Math.max(0, Math.floor(options.cleanSpecks));
  const removedSpecks = yield* removeSpecksSteps(alpha, rw, rh, speckSize);

  const bounds = yield* planeBoundsSteps(alpha, rw, rh, 1, 0, 1);
  if (!bounds) throw new InkError("no-ink");
  let inkPixels = 0;
  for (let start = 0; start < alpha.length; start += BAND_PIXELS) {
    yield;
    const end = Math.min(alpha.length, start + BAND_PIXELS);
    for (let i = start; i < end; i += 1) if (alpha[i] > 0) inkPixels += 1;
  }

  // Region de salida (coordenadas de la region, puede salirse por el margen).
  const crop = options.crop ?? "auto";
  let out: InkRect;
  if (crop === "none" || region.exact) {
    out = { x: 0, y: 0, width: rw, height: rh };
  } else {
    const margin =
      options.margin === undefined || options.margin === "auto"
        ? clamp(Math.round(Math.max(bounds.width, bounds.height) * 0.05), 2, 48)
        : Math.max(0, Math.round(options.margin));
    out = { x: bounds.x - margin, y: bounds.y - margin, width: bounds.width + 2 * margin, height: bounds.height + 2 * margin };
  }

  // Color y composicion de la salida.
  const pixels = new Uint8ClampedArray(out.width * out.height * 4);
  const source = image.data;
  const inkSpan = Math.max(1, 255 - stats.inkLevel);
  const outRows = bandRows(out.width);
  for (let oy = 0; oy < out.height; oy += 1) {
    if (oy % outRows === 0) yield;
    const ry = out.y + oy;
    if (ry < 0 || ry >= rh) continue;
    for (let ox = 0; ox < out.width; ox += 1) {
      const rx = out.x + ox;
      if (rx < 0 || rx >= rw) continue;
      const index = ry * rw + rx;
      const a = alpha[index];
      if (a === 0) continue;
      const target = (oy * out.width + ox) * 4;
      pixels[target + 3] = a;
      if (inkColor) {
        pixels[target] = inkColor.r;
        pixels[target + 1] = inkColor.g;
        pixels[target + 2] = inkColor.b;
        continue;
      }
      // Color original: se compone sobre blanco, se corrige la iluminacion y se «desmezcla» el papel de los bordes
      // semitransparentes (C = c * tinta + (1 - c) * 255 con c la cobertura estimada a partir de la luminancia).
      const s = ((region.y + ry) * image.width + region.x + rx) * 4;
      const sourceAlpha = source[s + 3];
      const k = 255 - sourceAlpha;
      let r = ((source[s] * sourceAlpha + 127) / 255 | 0) + k;
      let g = ((source[s + 1] * sourceAlpha + 127) / 255 | 0) + k;
      let b = ((source[s + 2] * sourceAlpha + 127) / 255 | 0) + k;
      if (background) {
        const gain = 255 / background[index];
        r *= gain;
        g *= gain;
        b *= gain;
      }
      const coverage = clamp((255 - level[index]) / inkSpan, 0, 1);
      if (coverage > 0.05) {
        const paper = 255 * (1 - coverage);
        r = (r - paper) / coverage;
        g = (g - paper) / coverage;
        b = (b - paper) / coverage;
      }
      pixels[target] = r;
      pixels[target + 1] = g;
      pixels[target + 2] = b;
    }
  }

  const outputRect: InkRect = { x: region.x + out.x, y: region.y + out.y, width: out.width, height: out.height };
  let result: InkImage & { data: Uint8ClampedArray } = { width: out.width, height: out.height, data: pixels };
  const fit = fitDimensions(out.width, out.height, maxDimension);
  if (fit.scale < 1) result = yield* resizeAreaSteps(result, fit.width, fit.height);

  return {
    image: result,
    threshold,
    auto,
    inkBounds: { x: region.x + bounds.x, y: region.y + bounds.y, width: bounds.width, height: bounds.height },
    outputRect,
    inkPixels,
    removedSpecks,
    scale: fit.scale,
    evenLighting,
  };
}

/** Version sincrona de `extractInkSteps`. */
export function extractInk(image: InkImage, options?: InkOptions): ExtractResult {
  return runSteps(extractInkSteps(image, options));
}
