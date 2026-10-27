/**
 * Correccion de perspectiva ("desdoblar" la foto de un documento).
 *
 * La parte de matematicas es pura y no toca el DOM, para poder probarla
 * con imagenes sinteticas. Solo `warpPerspective` necesita canvas, y se
 * ejecuta una unica vez al confirmar el recorte: nunca en el bucle de
 * video en vivo.
 *
 * Las esquinas viajan siempre **normalizadas 0-1** respecto al ancho y
 * alto de la captura, igual que el rectangulo de `crop-pdf`. Asi el mismo
 * quad sirve para la miniatura, para el editor y para el original a
 * resolucion completa.
 */

import { canvasToBlob } from "@/lib/pdf/imagesToPdf";
import { CAPTURE_QUALITY } from "@/lib/pdf/scanToPdf";

export type ScanPoint = { x: number; y: number };

/**
 * Buffer RGBA plano. Se declara estructuralmente en vez de usar el
 * `ImageData` del DOM para que el nucleo sea probable en Node; un
 * `ImageData` real encaja sin conversion.
 */
export type RgbaImage = {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
};

export type QuadCorners = {
  topLeft: ScanPoint;
  topRight: ScanPoint;
  bottomRight: ScanPoint;
  bottomLeft: ScanPoint;
};

export const QUAD_KEYS = [
  "topLeft",
  "topRight",
  "bottomRight",
  "bottomLeft",
] as const;

export type QuadKey = (typeof QUAD_KEYS)[number];

/** Cuadrilatero que cubre la imagen entera: punto de partida manual. */
export const DEFAULT_QUAD: QuadCorners = {
  topLeft: { x: 0, y: 0 },
  topRight: { x: 1, y: 0 },
  bottomRight: { x: 1, y: 1 },
  bottomLeft: { x: 0, y: 1 },
};

/** Fraccion minima del area de la imagen que debe encerrar el quad. */
const MIN_AREA_RATIO = 0.02;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Mantiene las cuatro esquinas dentro de la imagen. */
export function clampQuad(corners: QuadCorners): QuadCorners {
  const next = {} as QuadCorners;
  for (const key of QUAD_KEYS) {
    next[key] = { x: clamp01(corners[key].x), y: clamp01(corners[key].y) };
  }
  return next;
}

/** Area con signo (formula del cordon de zapato) en el orden dado. */
function signedArea(corners: QuadCorners): number {
  let total = 0;
  for (let index = 0; index < QUAD_KEYS.length; index += 1) {
    const current = corners[QUAD_KEYS[index]];
    const next = corners[QUAD_KEYS[(index + 1) % QUAD_KEYS.length]];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

function cross(a: ScanPoint, b: ScanPoint, c: ScanPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Un quad es utilizable si es convexo y encierra area suficiente. Sin
 * este filtro un usuario puede cruzar dos esquinas y producir una
 * homografia que da la vuelta a media imagen.
 */
export function isDegenerateQuad(corners: QuadCorners): boolean {
  const area = signedArea(corners);
  if (!Number.isFinite(area) || Math.abs(area) < MIN_AREA_RATIO) return true;

  const sign = Math.sign(area);
  for (let index = 0; index < QUAD_KEYS.length; index += 1) {
    const a = corners[QUAD_KEYS[index]];
    const b = corners[QUAD_KEYS[(index + 1) % QUAD_KEYS.length]];
    const c = corners[QUAD_KEYS[(index + 2) % QUAD_KEYS.length]];
    const turn = cross(a, b, c);
    if (turn === 0 || Math.sign(turn) !== sign) return true;
  }
  return false;
}

/** `true` si el quad es (casi) el rectangulo completo: recortar no haria nada. */
export function isFullFrameQuad(corners: QuadCorners, epsilon = 0.005): boolean {
  return QUAD_KEYS.every(
    (key) =>
      Math.abs(corners[key].x - DEFAULT_QUAD[key].x) < epsilon &&
      Math.abs(corners[key].y - DEFAULT_QUAD[key].y) < epsilon,
  );
}

function distance(a: ScanPoint, b: ScanPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Tamano de salida: el lado mas largo de cada par opuesto, para no perder
 * detalle del borde que quedo mas cerca de la camara.
 */
export function quadOutputSize(
  corners: QuadCorners,
  sourceWidth: number,
  sourceHeight: number,
): { width: number; height: number } {
  const pixels = toPixelQuad(corners, sourceWidth, sourceHeight);
  const width = Math.max(
    distance(pixels.topLeft, pixels.topRight),
    distance(pixels.bottomLeft, pixels.bottomRight),
  );
  const height = Math.max(
    distance(pixels.topLeft, pixels.bottomLeft),
    distance(pixels.topRight, pixels.bottomRight),
  );
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function toPixelQuad(
  corners: QuadCorners,
  width: number,
  height: number,
): QuadCorners {
  const next = {} as QuadCorners;
  for (const key of QUAD_KEYS) {
    next[key] = { x: corners[key].x * width, y: corners[key].y * height };
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Homografia
 * ------------------------------------------------------------------ */

/** Coeficientes h0..h7 de la homografia (h8 se fija a 1). */
export type Homography = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Resuelve un sistema lineal denso por eliminacion gaussiana con pivoteo. */
function solveLinearSystem(
  matrix: number[][],
  vector: number[],
): number[] | null {
  const size = vector.length;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) < 1e-12) return null;

    if (pivot !== column) {
      [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
      [vector[pivot], vector[column]] = [vector[column], vector[pivot]];
    }

    const diagonal = matrix[column][column];
    for (let row = column + 1; row < size; row += 1) {
      const factor = matrix[row][column] / diagonal;
      if (factor === 0) continue;
      for (let k = column; k < size; k += 1) {
        matrix[row][k] -= factor * matrix[column][k];
      }
      vector[row] -= factor * vector[column];
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let accumulator = vector[row];
    for (let column = row + 1; column < size; column += 1) {
      accumulator -= matrix[row][column] * solution[column];
    }
    solution[row] = accumulator / matrix[row][row];
  }
  return solution.every((value) => Number.isFinite(value)) ? solution : null;
}

/**
 * Homografia que lleva el rectangulo de salida (0..width, 0..height) a
 * las esquinas del documento en la imagen origen. Es el mapeo *inverso*:
 * se recorre el destino y se muestrea el origen, que es lo que evita
 * agujeros en la salida.
 */
export function inverseHomography(
  corners: QuadCorners,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): Homography | null {
  const pixels = toPixelQuad(corners, sourceWidth, sourceHeight);
  const from: ScanPoint[] = [
    { x: 0, y: 0 },
    { x: outputWidth, y: 0 },
    { x: outputWidth, y: outputHeight },
    { x: 0, y: outputHeight },
  ];
  const to: ScanPoint[] = QUAD_KEYS.map((key) => pixels[key]);

  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x: u, y: v } = from[index];
    const { x, y } = to[index];
    matrix.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    vector.push(x);
    matrix.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    vector.push(y);
  }

  const solution = solveLinearSystem(matrix, vector);
  if (!solution) return null;
  return solution as unknown as Homography;
}

/** Aplica la homografia a un punto del destino y devuelve el del origen. */
export function projectPoint(
  homography: Homography,
  x: number,
  y: number,
): ScanPoint {
  const denominator = homography[6] * x + homography[7] * y + 1;
  if (denominator === 0) return { x: 0, y: 0 };
  return {
    x: (homography[0] * x + homography[1] * y + homography[2]) / denominator,
    y: (homography[3] * x + homography[4] * y + homography[5]) / denominator,
  };
}

/* ------------------------------------------------------------------ *
 * Remuestreo
 * ------------------------------------------------------------------ */

function sampleBilinear(
  source: RgbaImage,
  x: number,
  y: number,
  target: Uint8ClampedArray<ArrayBuffer>,
  offset: number,
): void {
  const { width, height, data } = source;
  const clampedX = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const clampedY = y < 0 ? 0 : y > height - 1 ? height - 1 : y;

  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const topLeft = (y0 * width + x0) * 4;
  const topRight = (y0 * width + x1) * 4;
  const bottomLeft = (y1 * width + x0) * 4;
  const bottomRight = (y1 * width + x1) * 4;

  for (let channel = 0; channel < 4; channel += 1) {
    const top =
      data[topLeft + channel] * (1 - fx) + data[topRight + channel] * fx;
    const bottom =
      data[bottomLeft + channel] * (1 - fx) + data[bottomRight + channel] * fx;
    target[offset + channel] = top * (1 - fy) + bottom * fy;
  }
}

/**
 * Rellena las filas `[fromRow, toRow)` de `target` (ancho `outputWidth`) muestreando el origen con la homografia. Permite
 * enderezar por bandas, cediendo el hilo entre ellas, sin que una foto de 12 Mpx bloquee la pantalla.
 */
export function warpRowsInto(
  source: RgbaImage,
  homography: Homography,
  outputWidth: number,
  fromRow: number,
  toRow: number,
  target: Uint8ClampedArray,
): void {
  // Se muestrea el centro de cada pixel de destino, no su esquina: con la
  // esquina la salida queda desplazada medio pixel hacia arriba/izquierda.
  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const point = projectPoint(homography, x + 0.5, y + 0.5);
      sampleBilinear(source, point.x - 0.5, point.y - 0.5, target as Uint8ClampedArray<ArrayBuffer>, (y * outputWidth + x) * 4);
    }
  }
}

export type WarpResult = RgbaImage;

/**
 * Endereza el cuadrilatero a un rectangulo. Puro: entra y sale un buffer
 * RGBA, sin canvas de por medio, para poder verificarlo en las pruebas.
 */
export function warpImageData(
  source: RgbaImage,
  corners: QuadCorners,
  size?: { width: number; height: number },
): WarpResult | null {
  const output =
    size ?? quadOutputSize(corners, source.width, source.height);
  const width = Math.max(1, Math.round(output.width));
  const height = Math.max(1, Math.round(output.height));

  const homography = inverseHomography(
    corners,
    source.width,
    source.height,
    width,
    height,
  );
  if (!homography) return null;

  const data = new Uint8ClampedArray(width * height * 4);
  warpRowsInto(source, homography, width, 0, height, data);

  return { data, width, height };
}

/* ------------------------------------------------------------------ *
 * Puente con el navegador
 * ------------------------------------------------------------------ */

/** Lado maximo de la imagen enderezada; evita salidas absurdas. */
const MAX_OUTPUT_SIDE = 4096;

function limitSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const largest = Math.max(size.width, size.height);
  if (largest <= MAX_OUTPUT_SIDE) return size;
  const scale = MAX_OUTPUT_SIDE / largest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * Endereza la captura y devuelve un JPEG nuevo. **No** modifica el blob
 * original: el recorte siempre es una copia derivada, para poder
 * deshacerlo. Si el navegador no puede decodificar o el quad no sirve,
 * devuelve el original tal cual en vez de romper el flujo.
 */
export async function warpPerspective(
  source: Blob,
  corners: QuadCorners,
  quality = CAPTURE_QUALITY,
): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return source;
  if (isDegenerateQuad(corners) || isFullFrameQuad(corners)) return source;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return source;
  }

  const input = document.createElement("canvas");
  input.width = Math.max(1, bitmap.width);
  input.height = Math.max(1, bitmap.height);
  const inputContext = input.getContext("2d", { willReadFrequently: true });
  if (!inputContext) {
    bitmap.close();
    return source;
  }
  inputContext.drawImage(bitmap, 0, 0);
  bitmap.close();

  const pixels = inputContext.getImageData(0, 0, input.width, input.height);
  const size = limitSize(quadOutputSize(corners, input.width, input.height));
  const warped = warpImageData(pixels, corners, size);
  input.width = 0;
  input.height = 0;
  if (!warped) return source;

  const output = document.createElement("canvas");
  output.width = warped.width;
  output.height = warped.height;
  const outputContext = output.getContext("2d");
  if (!outputContext) return source;
  outputContext.putImageData(
    new ImageData(warped.data, warped.width, warped.height),
    0,
    0,
  );

  const blob = await canvasToBlob(output, "image/jpeg", quality);
  output.width = 0;
  output.height = 0;
  return blob;
}
