import { quadArea, quadIoU } from "@/lib/scan/geometry";
import {
  isDegenerateQuad,
  isFullFrameQuad,
  type QuadCorners,
} from "@/lib/scan/perspective";

/**
 * Deteccion automatica del cuadrilatero del documento.
 *
 * Envuelve `scanic` (MIT, detector clasico Canny en JS/WASM) tras un
 * `import()` diferido: asi el motor de deteccion queda en un chunk propio
 * que solo se descarga cuando el usuario captura una pagina, y nunca entra
 * en el bundle comun. El detector "ml" opcional de la libreria no se usa
 * jamas -- necesitaria bajar un runtime ONNX desde un CDN externo, lo que
 * romperia la promesa de que nada sale del navegador.
 */

/** Confianza minima para aplicar el recorte sin preguntar. */
const MIN_CONFIDENCE = 0.5;

/** Lado maximo que se analiza: mas resolucion no mejora el contorno. */
const MAX_PROCESSING_DIMENSION = 1024;

/**
 * Cuanto tiene que apartarse el quad del borde para merecer un recorte.
 * Por debajo de esto la correccion seria nula y solo recomprimiria la foto.
 */
const FULL_FRAME_EPSILON = 0.02;

type ScanicModule = typeof import("scanic");

let modulePromise: Promise<ScanicModule> | null = null;

/** Carga (una sola vez) el chunk diferido de scanic. */
function loadScanic(): Promise<ScanicModule> {
  modulePromise ??= import("scanic");
  return modulePromise;
}

/**
 * Precarga el motor mientras el usuario encuadra, para que la primera
 * captura no espere a la descarga. Falla en silencio: es solo un adelanto.
 */
export function preloadDocumentDetection(): void {
  void loadScanic().catch(() => {
    modulePromise = null;
  });
}

export type DetectedQuad = {
  corners: QuadCorners;
  confidence: number;
};

/**
 * Busca el documento en la imagen y devuelve sus esquinas normalizadas
 * (0-1), o `null` si no hay un cuadrilatero creible. Nunca lanza: si el
 * motor no carga o el navegador no puede procesar la imagen, el flujo
 * sigue con la captura sin recortar.
 */
export async function detectDocumentCorners(
  source: HTMLCanvasElement | ImageData,
): Promise<DetectedQuad | null> {
  const width = source.width;
  const height = source.height;
  if (!width || !height) return null;

  try {
    const { scanDocument } = await loadScanic();
    const result = await scanDocument(source, {
      mode: "detect",
      detector: "classical",
      maxProcessingDimension: MAX_PROCESSING_DIMENSION,
    });

    if (!result.success || !result.corners) return null;

    const confidence = result.confidence ?? 0;
    if (confidence < MIN_CONFIDENCE) return null;

    const corners: QuadCorners = {
      topLeft: {
        x: result.corners.topLeft.x / width,
        y: result.corners.topLeft.y / height,
      },
      topRight: {
        x: result.corners.topRight.x / width,
        y: result.corners.topRight.y / height,
      },
      bottomRight: {
        x: result.corners.bottomRight.x / width,
        y: result.corners.bottomRight.y / height,
      },
      bottomLeft: {
        x: result.corners.bottomLeft.x / width,
        y: result.corners.bottomLeft.y / height,
      },
    };

    // Un cuadrilatero que cubre practicamente toda la foto no aporta nada
    // (recortar seria una operacion nula que solo recomprime la imagen).
    if (isDegenerateQuad(corners) || isFullFrameQuad(corners, FULL_FRAME_EPSILON)) {
      return null;
    }

    return { corners, confidence };
  } catch {
    return null;
  }
}

/** Lado maximo del lienzo que se le entrega al detector. */
const MAX_ANALYSIS_SIDE = 1280;

/**
 * Decodifica una captura y busca el documento en ella. Como las esquinas
 * salen normalizadas, se analiza una version reducida: el contorno sale
 * igual y el coste baja mucho en fotos de 12 Mpx.
 */
export async function detectDocumentInBlob(
  source: Blob,
): Promise<DetectedQuad | null> {
  if (typeof createImageBitmap !== "function") return null;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }

  const largest = Math.max(bitmap.width, bitmap.height);
  const scale = largest > MAX_ANALYSIS_SIDE ? MAX_ANALYSIS_SIDE / largest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return null;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const detected = await detectDocumentCorners(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return detected;
}


/** Area maxima (fraccion del encuadre) de un cuadrilatero para fiarse de el. */
export const MAX_TRUSTED_QUAD_AREA = 0.9;
/** Confianza del detector ligero a partir de la cual desempata a su favor. */
export const LIVE_TRUST_CONFIDENCE = 0.95;

/**
 * Apoyo de borde de un cuadrilatero sobre una muestra RGBA: fraccion de puntos de sus cuatro lados donde hay un salto de color
 * (>= 14 niveles en algun canal) entre un poco dentro y un poco fuera. Un contorno real de hoja tiene casi todo el lado
 * apoyado; uno trazado sobre las vetas del escritorio o sobre un borde interior, no. Un lado pegado al borde de la imagen
 * cuenta como apoyado.
 */
export function edgeSupport(image: { data: Uint8ClampedArray; width: number; height: number }, quad: QuadCorners): number {
  const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((p) => ({ x: p.x * image.width, y: p.y * image.height }));
  const center = { x: corners.reduce((s, p) => s + p.x, 0) / 4, y: corners.reduce((s, p) => s + p.y, 0) / 4 };
  const reach = Math.max(3, Math.round(Math.min(image.width, image.height) * 0.008));
  const slack = Math.max(4, Math.round(Math.min(image.width, image.height) * 0.012));
  const mean = (x: number, y: number, tx: number, ty: number): [number, number, number] | null => {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    // Tres muestras a lo largo del lado (tangente) para no depender de un solo pixel.
    for (let k = -1; k <= 1; k += 1) {
      const ix = Math.round(x + tx * k * 2);
      const iy = Math.round(y + ty * k * 2);
      if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) continue;
      const o = (iy * image.width + ix) * 4;
      r += image.data[o];
      g += image.data[o + 1];
      b += image.data[o + 2];
      count += 1;
    }
    return count ? [r / count, g / count, b / count] : null;
  };
  let samples = 0;
  let supported = 0;
  for (let side = 0; side < 4; side += 1) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / length;
    let ny = (b.x - a.x) / length;
    // Normal hacia fuera (lejos del centro).
    if (nx * (a.x - center.x) + ny * (a.y - center.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const steps = 30;
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      samples += 1;
      // Se busca el salto mas fuerte en una franja alrededor del lado (un detector no clava el borde al pixel).
      let best = 0;
      let outside = false;
      for (let offset = -slack; offset <= slack; offset += 2) {
        const inner = mean(x + nx * (offset - reach), y + ny * (offset - reach), -ny, nx);
        const outer = mean(x + nx * (offset + reach), y + ny * (offset + reach), -ny, nx);
        if (outer === null) {
          outside = true;
          break;
        }
        if (inner !== null) best = Math.max(best, Math.abs(inner[0] - outer[0]), Math.abs(inner[1] - outer[1]), Math.abs(inner[2] - outer[2]));
      }
      if (outside || best >= 14) supported += 1;
    }
  }
  return samples ? supported / samples : 0;
}

/**
 * Combina las dos lecturas del documento al crear una pagina: scanic (preciso en el contorno) y el detector ligero (mira el
 * color, no solo el borde). Un cuadrilatero que ocupa casi todo el encuadre no distingue la hoja del fondo: se descarta. Si
 * los dos coinciden (IoU >= 0,85) gana scanic. Si discrepan, gana el que tiene mas apoyo de borde en la imagen; con apoyo
 * parecido, el ligero si esta muy seguro (scanic puede agarrarse a un borde interior, p. ej. la banda de color de una
 * tarjeta o las vetas del escritorio) y, si no, scanic.
 */
export function chooseCorners(
  scanic: QuadCorners | null,
  live: QuadCorners | null,
  image?: { data: Uint8ClampedArray; width: number; height: number },
  liveConfidence = 0,
): QuadCorners | null {
  const trusted = (quad: QuadCorners | null): QuadCorners | null =>
    quad && !isDegenerateQuad(quad) && !isFullFrameQuad(quad, 0.03) && quadArea(quad) < MAX_TRUSTED_QUAD_AREA ? quad : null;
  const a = trusted(scanic);
  const b = trusted(live);
  if (!a) return b;
  if (!b) return a;
  if (quadIoU(a, b) >= 0.85) return a;
  if (image) {
    const sa = edgeSupport(image, a);
    const sb = edgeSupport(image, b);
    if (sb > sa + 0.08) return b;
    if (sa > sb + 0.08) return a;
  }
  // Apoyo parecido: el detector ligero (coherente por construccion) gana si esta muy seguro; si no, scanic.
  return liveConfidence >= LIVE_TRUST_CONFIDENCE ? b : a;
}
