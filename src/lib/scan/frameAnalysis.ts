/**
 * Analisis del fotograma en vivo de la camara.
 *
 * Modulo puro (sin React): reduce cada fotograma a una miniatura y saca de
 * ella tres numeros —nitidez, brillo y movimiento— con los que la interfaz
 * decide si el encuadre esta listo para capturar. Todo ocurre sobre un
 * canvas local: ni el video ni las miniaturas salen del dispositivo.
 */

export type FrameMetrics = {
  /** Varianza de un laplaciano sobre la luminancia: a mas alto, mas nitido. */
  sharpness: number;
  /** Luminancia media del fotograma, 0-255. */
  brightness: number;
  /** Diferencia media de luminancia contra el fotograma anterior, 0-255. */
  motionDelta: number;
};

/**
 * Pixeles RGBA ya reducidos de un fotograma. `ImageData` encaja tal cual,
 * pero el tipo es estructural para poder construir casos en los tests sin
 * un DOM detras.
 */
export type FrameSample = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type CaptureHint = "ok" | "hold_steady" | "too_dark" | "unknown";

/* ------------------------------------------------------------------ *
 * Umbrales
 * ------------------------------------------------------------------ */

/** Ancho al que se reduce el fotograma antes de analizarlo. */
export const ANALYSIS_WIDTH = 160;

/** Varianza del laplaciano a partir de la cual el encuadre se ve nitido. */
export const SHARPNESS_OK_THRESHOLD = 40;

/** Luminancia media por debajo de la cual falta luz para leer el documento. */
export const BRIGHTNESS_TOO_DARK_THRESHOLD = 55;

/** Movimiento medio por debajo del cual la camara se considera quieta. */
export const MOTION_STABLE_THRESHOLD = 3.5;

/** Metricas de un fotograma que no se ha podido medir. */
export const UNKNOWN_METRICS: FrameMetrics = {
  sharpness: Number.NaN,
  brightness: Number.NaN,
  motionDelta: Number.NaN,
};

/* ------------------------------------------------------------------ *
 * Muestreo
 * ------------------------------------------------------------------ */

// Un unico canvas de trabajo para todo el modulo: a ~10 analisis por
// segundo, crear uno nuevo cada vez llena el heap de canvas huerfanos.
let scratchCanvas: HTMLCanvasElement | null = null;
let scratchContext: CanvasRenderingContext2D | null = null;

function getScratchContext(
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!scratchCanvas) {
    scratchCanvas = document.createElement("canvas");
    scratchContext = scratchCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }
  if (!scratchContext) return null;
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
  }
  return scratchContext;
}

/**
 * Reduce el fotograma a `ANALYSIS_WIDTH` y devuelve sus pixeles. Devuelve
 * `null` cuando la fuente todavia no tiene dimensiones o el entorno no
 * ofrece Canvas 2D.
 */
export function sampleFrame(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): FrameSample | null {
  if (!sourceWidth || !sourceHeight) return null;

  const width = Math.min(ANALYSIS_WIDTH, Math.max(1, Math.round(sourceWidth)));
  const height = Math.max(1, Math.round((sourceHeight * width) / sourceWidth));
  const context = getScratchContext(width, height);
  if (!context) return null;

  try {
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } catch {
    // Un fotograma aun sin decodificar deja `drawImage` a medias.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Metricas
 * ------------------------------------------------------------------ */

function toLuminance(sample: FrameSample): Float32Array {
  const { data, width, height } = sample;
  const luminance = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < luminance.length; index += 1, pixel += 4) {
    luminance[index] =
      data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114;
  }
  return luminance;
}

/** Mide un fotograma ya reducido, opcionalmente contra el anterior. */
export function analyzeSample(
  sample: FrameSample,
  previous?: FrameSample | null,
): FrameMetrics {
  const { width, height } = sample;
  // El laplaciano necesita vecinos por los cuatro lados.
  if (width < 3 || height < 3 || sample.data.length < width * height * 4) {
    return UNKNOWN_METRICS;
  }

  const luminance = toLuminance(sample);

  let brightnessSum = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    brightnessSum += luminance[index];
  }

  let laplacianSum = 0;
  let laplacianSquares = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value =
        4 * luminance[index] -
        luminance[index - 1] -
        luminance[index + 1] -
        luminance[index - width] -
        luminance[index + width];
      laplacianSum += value;
      laplacianSquares += value * value;
      samples += 1;
    }
  }

  const laplacianMean = laplacianSum / samples;
  const variance = laplacianSquares / samples - laplacianMean * laplacianMean;

  let motionDelta = 0;
  if (
    previous &&
    previous.width === width &&
    previous.height === height &&
    previous.data.length >= width * height * 4
  ) {
    const before = toLuminance(previous);
    let difference = 0;
    for (let index = 0; index < luminance.length; index += 1) {
      difference += Math.abs(luminance[index] - before[index]);
    }
    motionDelta = difference / luminance.length;
  }

  return {
    sharpness: Math.max(0, variance),
    brightness: brightnessSum / luminance.length,
    motionDelta,
  };
}

/**
 * Atajo sobre un canvas ya pintado: lo reduce y lo mide de una vez. La
 * vista en vivo usa `sampleFrame` + `analyzeSample` porque necesita
 * guardar la miniatura para comparar con el fotograma siguiente.
 */
export function analyzeFrame(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  previous?: FrameSample | null,
): FrameMetrics {
  const sample = sampleFrame(canvas, canvas.width, canvas.height);
  return sample ? analyzeSample(sample, previous) : UNKNOWN_METRICS;
}

/** Traduce las metricas al consejo que se le muestra a quien escanea. */
export function getCaptureHint(metrics: FrameMetrics): CaptureHint {
  const { sharpness, brightness, motionDelta } = metrics;
  if (
    !Number.isFinite(sharpness) ||
    !Number.isFinite(brightness) ||
    !Number.isFinite(motionDelta)
  ) {
    return "unknown";
  }

  // Sin luz suficiente el resto de metricas no significan nada: una foto
  // a oscuras tambien sale "quieta" y "plana".
  if (brightness < BRIGHTNESS_TOO_DARK_THRESHOLD) return "too_dark";

  // Un fotograma borroso casi siempre es la mano moviendose, no el
  // enfoque: el consejo util es el mismo que para el movimiento.
  if (motionDelta > MOTION_STABLE_THRESHOLD) return "hold_steady";
  if (sharpness < SHARPNESS_OK_THRESHOLD) return "hold_steady";

  return "ok";
}
