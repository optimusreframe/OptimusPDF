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

