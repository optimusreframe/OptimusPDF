import { boxBlur, clampByte, downscaleGray, histogram256, lumaOf, percentileOf, toGray, type Gray, type Rgba } from "@/lib/scan/pixels";
import type { ScanFilterMode, ScanMode, ScanPageAdjust, ScanResolvedFilter } from "@/lib/scan/types";

/**
 * Filtros de pagina del Escaner (puros, sobre buffers RGBA, sin canvas): los clasicos de `scanToPdf.ts` (`color`,
 * `grayscale`, `bw`, `enhance`) y los nuevos (`auto`, `original`, correccion de fondo/sombras, pizarra) con brillo y
 * contraste. Todos trabajan EN EL SITIO sobre una copia que el llamador ya hizo: el ORIGINAL nunca se toca.
 */

/* ------------------------------------------------------------------ *
 * Filtros clasicos (movidos de scanToPdf.ts sin cambiar su resultado)
 * ------------------------------------------------------------------ */

/** Contraste aplicado en modo blanco y negro. */
const BW_CONTRAST = 1.35;
const BW_BRIGHTNESS = 8;
/** Percentil recortado en cada extremo al estirar el histograma. */
const ENHANCE_CLIP = 0.005;
/** Recorrido minimo entre los percentiles para que estirar tenga sentido. */
const ENHANCE_MIN_RANGE = 8;

function luminanceOf(data: Uint8ClampedArray, index: number): number {
  return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
}

/** Escala de grises pura: solo luminancia, sin tocar el contraste. */
export function toGrayscale(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    const value = clampByte(luminanceOf(data, index));
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
}

/** Blanco y negro de escaner: luminancia + curva de contraste fija. */
export function toBlackAndWhite(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    const adjusted = (luminanceOf(data, index) - 128) * BW_CONTRAST + 128 + BW_BRIGHTNESS;
    const value = clampByte(adjusted);
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
}

/**
 * Auto-contraste: estira el histograma de luminancia entre sus percentiles extremos y aplica el mismo mapeo a los tres
 * canales, para que la foto gane cuerpo sin virar de color. Si la imagen ya usa todo el rango (o es plana) se deja intacta.
 */
export function toEnhanced(data: Uint8ClampedArray): void {
  const histogram = new Uint32Array(256);
  let pixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    histogram[clampByte(luminanceOf(data, index)) | 0] += 1;
    pixels += 1;
  }
  if (pixels === 0) return;
  const cut = Math.floor(pixels * ENHANCE_CLIP);
  let low = 0;
  let high = 255;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value];
    if (seen > cut) {
      low = value;
      break;
    }
  }
  seen = 0;
  for (let value = 255; value >= 0; value -= 1) {
    seen += histogram[value];
    if (seen > cut) {
      high = value;
      break;
    }
  }
  if (high - low < ENHANCE_MIN_RANGE) return;
  const scale = 255 / (high - low);
  const lookup = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) lookup[value] = clampByte((value - low) * scale);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = lookup[data[index]];
    data[index + 1] = lookup[data[index + 1]];
    data[index + 2] = lookup[data[index + 2]];
  }
}

/* ------------------------------------------------------------------ *
 * Fondo: correccion de sombras (aplanado de campo)
 * ------------------------------------------------------------------ */

/** Dilatacion (maximo) separable de un mapa de baja resolucion: borra el texto fino y deja el fondo. */
function dilateMax(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const tmp = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k += 1) best = Math.max(best, source[y * width + k]);
      tmp[y * width + x] = best;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k += 1) best = Math.max(best, tmp[k * width + x]);
      out[y * width + x] = best;
    }
  }
  return out;
}

/** Fondo ya calculado de la imagen ENTERA y posicion (x, y) del fragmento que se esta filtrando dentro de ella. */
export type BackgroundContext = { maps: BackgroundMap[]; x: number; y: number };

export type BackgroundMap = { data: Float32Array; width: number; height: number; scaleX: number; scaleY: number };

/** Fondo de las tres componentes de color de una imagen, calculado sobre `image` (que puede ser una copia reducida) pero expresado en las coordenadas de una imagen de `fullWidth` x `fullHeight`. */
export function backgroundMapsFor(image: Rgba, fullWidth: number, fullHeight: number): BackgroundMap[] {
  return ([0, 1, 2] as const).map((channel) => {
    const plane = new Uint8Array(image.width * image.height);
    for (let i = 0, p = channel; i < plane.length; i += 1, p += 4) plane[i] = image.data[p];
    return backgroundOfPlane({ data: plane, width: image.width, height: image.height }, fullWidth, fullHeight);
  });
}

/** Fondo de UN canal (0 = R, 1 = G, 2 = B, 3 = luminancia) a baja resolucion. */
export function estimateBackground(image: Rgba, channel: 0 | 1 | 2 | 3 = 3): BackgroundMap {
  const plane: Gray =
    channel === 3
      ? toGray(image)
      : (() => {
          const out = new Uint8Array(image.width * image.height);
          for (let i = 0, p = channel; i < out.length; i += 1, p += 4) out[i] = image.data[p];
          return { data: out, width: image.width, height: image.height };
        })();
  return backgroundOfPlane(plane, image.width, image.height);
}

/** Fondo estimado de un plano de un canal (a baja resolucion), en las coordenadas de una imagen de `width` x `height`. */
function backgroundOfPlane(plane: Gray, width: number, height: number): BackgroundMap {
  const small = downscaleGray(plane, 160);
  const asFloat = new Float32Array(small.data.length);
  for (let i = 0; i < asFloat.length; i += 1) asFloat[i] = small.data[i];
  // La dilatacion borra el texto fino (queda el papel) y el desenfoque suaviza los escalones.
  const dilated = dilateMax(asFloat, small.width, small.height, 3);
  const smooth = boxBlur(dilated, small.width, small.height, 4);
  return { data: smooth, width: small.width, height: small.height, scaleX: small.width / width, scaleY: small.height / height };
}

function backgroundAt(map: BackgroundMap, x: number, y: number): number {
  const fx = Math.min(map.width - 1, Math.max(0, x * map.scaleX - 0.5));
  const fy = Math.min(map.height - 1, Math.max(0, y * map.scaleY - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = map.data[y0 * map.width + x0] * (1 - tx) + map.data[y0 * map.width + x1] * tx;
  const b = map.data[y1 * map.width + x0] * (1 - tx) + map.data[y1 * map.width + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Curva razon-de-fondo -> salida del documento mejorado (blanco puro desde ~0.88, tinta mas oscura y definida). */
const DOC_CURVE = (() => {
  const curve = new Uint8ClampedArray(1100);
  for (let i = 0; i < curve.length; i += 1) {
    const ratio = i / 1000;
    const t = Math.min(1, Math.max(0, (ratio - 0.22) / 0.66));
    curve[i] = Math.round(255 * (0.15 * t + 0.85 * t * t * (3 - 2 * t)));
  }
  return curve;
})();

/**
 * Documento «mejorado»: divide cada canal por su fondo local (quita sombras, degradados y el tinte del papel: el papel
 * queda blanco) y refuerza el contraste de la tinta, que conserva su color (azul, sellos). Procesa por bandas de filas para
 * que quien llama ceda el hilo entre ellas (`onBand`).
 */
export async function enhanceDocument(image: Rgba, options: { onBand?: () => Promise<void> | void; band?: number; background?: BackgroundContext } = {}): Promise<void> {
  const { data, width, height } = image;
  const maps = options.background?.maps ?? [estimateBackground(image, 0), estimateBackground(image, 1), estimateBackground(image, 2)];
  const ox = options.background?.x ?? 0;
  const oy = options.background?.y ?? 0;
  const band = Math.max(16, options.band ?? 128);
  for (let y0 = 0; y0 < height; y0 += band) {
    const y1 = Math.min(height, y0 + band);
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          const bg = Math.max(40, backgroundAt(maps[c], x + ox, y + oy));
          data[o + c] = DOC_CURVE[Math.min(1099, Math.round((data[o + c] / bg) * 1000))];
        }
      }
    }
    if (options.onBand && y1 < height) await options.onBand();
  }
}

/** Pizarra: aplanado de fondo fuerte, blanco limpio y rotuladores saturados. */
export async function enhanceWhiteboard(image: Rgba, options: { onBand?: () => Promise<void> | void; band?: number; background?: BackgroundContext } = {}): Promise<void> {
  const { data, width, height } = image;
  const maps = options.background?.maps ?? [estimateBackground(image, 0), estimateBackground(image, 1), estimateBackground(image, 2)];
  const ox = options.background?.x ?? 0;
  const oy = options.background?.y ?? 0;
  const band = Math.max(16, options.band ?? 128);
  for (let y0 = 0; y0 < height; y0 += band) {
    const y1 = Math.min(height, y0 + band);
    for (let y = y0; y < y1; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          const bg = Math.max(40, backgroundAt(maps[c], x + ox, y + oy));
          const ratio = Math.min(1.1, data[o + c] / bg);
          const t = Math.min(1, Math.max(0, (ratio - 0.3) / 0.62));
          // Curva en S fuerte: el fondo a 255, el trazo mas oscuro y vivo.
          data[o + c] = clampByte(255 * t * t * (3 - 2 * t));
        }
      }
    }
    if (options.onBand && y1 < height) await options.onBand();
  }
}

/* ------------------------------------------------------------------ *
 * Decision del filtro automatico
 * ------------------------------------------------------------------ */

export type AutoDecision = { kind: "document" | "photo"; paperLevel: number; colorfulShare: number; paperShare: number; inkShare: number };

/**
 * `auto`: ¿es un documento de texto sobre papel (-> mejorado) o una foto/pieza de color (-> color)? Papel claro y
 * dominante (la mayoria de los pixeles cerca de la mediana), poco color y algo de tinta.
 */
export function decideAutoFilter(image: Rgba): AutoDecision {
  const small = downscaleGrayFromRgba(image, 240);
  const { gray, colorful } = small;
  const hist = histogram256(gray.data);
  const median = percentileOf(hist, 0.5);
  // Frente al FONDO LOCAL (no al tono global): una hoja con sombra sigue siendo «papel con tinta».
  const background = backgroundOfPlane(gray, gray.width, gray.height);
  let near = 0;
  let ink = 0;
  for (let y = 0; y < gray.height; y += 1) {
    for (let x = 0; x < gray.width; x += 1) {
      const bg = Math.max(30, backgroundAt(background, x, y));
      const ratio = gray.data[y * gray.width + x] / bg;
      if (ratio >= 0.84) near += 1;
      else if (ratio < 0.6) ink += 1;
    }
  }
  const total = gray.data.length;
  const paperShare = near / total;
  const inkShare = ink / total;
  const document = median >= 55 && colorful < 0.08 && paperShare >= 0.6 && inkShare >= 0.002 && inkShare <= 0.45;
  return { kind: document ? "document" : "photo", paperLevel: median, colorfulShare: colorful, paperShare, inkShare };
}

function downscaleGrayFromRgba(image: Rgba, side: number): { gray: Gray; colorful: number } {
  const scale = Math.max(image.width, image.height) / side;
  const w = Math.max(1, Math.round(image.width / Math.max(1, scale)));
  const h = Math.max(1, Math.round(image.height / Math.max(1, scale)));
  const out = new Uint8Array(w * h);
  let colorful = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * (image.width / w)));
      const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * (image.height / h)));
      const o = (sy * image.width + sx) * 4;
      const r = image.data[o];
      const g = image.data[o + 1];
      const b = image.data[o + 2];
      out[y * w + x] = lumaOf(r, g, b);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 45) colorful += 1;
    }
  }
  return { gray: { data: out, width: w, height: h }, colorful: colorful / (w * h) };
}

/* ------------------------------------------------------------------ *
 * Brillo y contraste, y aplicacion de un filtro
 * ------------------------------------------------------------------ */

export const BRIGHTNESS_SPAN = 64;
export const CONTRAST_SPAN = 0.8;

/** Recorre `data` por bandas de filas (para ceder el hilo entre ellas). */
async function inBands(data: Uint8ClampedArray, width: number, band: number, apply: (chunk: Uint8ClampedArray) => void, yieldFn?: () => Promise<void> | void): Promise<void> {
  const rowBytes = width * 4;
  const step = Math.max(1, band) * rowBytes;
  for (let start = 0; start < data.length; start += step) {
    apply(data.subarray(start, Math.min(data.length, start + step)));
    if (yieldFn && start + step < data.length) await yieldFn();
  }
}

/** Tabla de brillo y contraste (-1..1), o `null` si no hay nada que hacer. */
export function adjustLookup(adjust: ScanPageAdjust): Uint8ClampedArray | null {
  const brightness = Math.max(-1, Math.min(1, adjust.brightness));
  const contrast = Math.max(-1, Math.min(1, adjust.contrast));
  if (brightness === 0 && contrast === 0) return null;
  const factor = 1 + contrast * CONTRAST_SPAN;
  const shift = brightness * BRIGHTNESS_SPAN;
  const lookup = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) lookup[value] = clampByte((value - 128) * factor + 128 + shift);
  return lookup;
}

/** Brillo y contraste (-1..1) en una tabla: no toca nada con (0, 0). */
export function applyAdjust(data: Uint8ClampedArray, adjust: ScanPageAdjust): void {
  const lookup = adjustLookup(adjust);
  if (!lookup) return;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = lookup[data[index]];
    data[index + 1] = lookup[data[index + 1]];
    data[index + 2] = lookup[data[index + 2]];
  }
}

/** Filtro realmente aplicado tras resolver `auto` y el modo (para mostrarlo y para probarlo). */
export type ResolvedFilter = ScanResolvedFilter;

export function resolveFilter(filter: ScanFilterMode, mode: ScanMode, image: Rgba): ResolvedFilter {
  if (mode === "photo") return "original";
  if (filter === "auto") {
    if (mode === "whiteboard") return "whiteboard";
    if (mode === "id-card") return "color";
    return decideAutoFilter(image).kind === "document" ? "enhance" : "color";
  }
  return filter;
}

/**
 * Aplica el filtro (ya resuelto) y el ajuste a la imagen, EN EL SITIO. `original` no toca nada (ni siquiera el ajuste).
 * `onBand` cede el hilo en los filtros que lo permiten (los largos).
 */
export async function applyFilterTo(
  image: Rgba,
  filter: ResolvedFilter,
  adjust: ScanPageAdjust,
  hooks: { onBand?: () => Promise<void> | void; band?: number; background?: BackgroundContext } = {},
): Promise<void> {
  const band = Math.max(16, hooks.band ?? Math.floor(600_000 / Math.max(1, image.width)));
  switch (filter) {
    case "original":
      return;
    case "color":
      break;
    case "grayscale":
      await inBands(image.data, image.width, band, toGrayscale, hooks.onBand);
      break;
    case "bw":
      await inBands(image.data, image.width, band, toBlackAndWhite, hooks.onBand);
      break;
    case "enhance":
      await enhanceDocument(image, { onBand: hooks.onBand, band, background: hooks.background });
      break;
    case "whiteboard":
      await enhanceWhiteboard(image, { onBand: hooks.onBand, band, background: hooks.background });
      break;
  }
  const lookup = adjustLookup(adjust);
  if (lookup) {
    await inBands(
      image.data,
      image.width,
      band * 2,
      (chunk) => {
        for (let index = 0; index < chunk.length; index += 4) {
          chunk[index] = lookup[chunk[index]];
          chunk[index + 1] = lookup[chunk[index + 1]];
          chunk[index + 2] = lookup[chunk[index + 2]];
        }
      },
      hooks.onBand,
    );
  }
}
