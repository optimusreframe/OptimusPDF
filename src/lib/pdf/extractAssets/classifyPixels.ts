/**
 * Caracteristicas de los PIXELES de una miniatura (<= 256 px) para el clasificador (U7.3): fondo (transparente o casi blanco),
 * tinta (oscura, azul, cromatica), colores distintos (una foto tiene muchos), solidez (los trazos finos de una firma casi no tienen
 * interior; un logo de relleno si) y forma (aro o marco: sellos). Todo puro y sin canvas: corre en Node, en el navegador y en un worker.
 */

import type { PixelFeatures, RasterRGBA } from "./classifyTypes";

/** Alfa bajo el cual un pixel cuenta como transparente. */
const TRANSPARENT_BELOW = 16;
/** Alfa desde el cual un pixel puede ser tinta. */
const INK_ALPHA = 64;
/** Diferencia de luminancia con el fondo para contar como tinta. */
const INK_CONTRAST = 55;
/** Luminancia minima del fondo para considerarlo claro. */
const LIGHT_BACKGROUND_LUMA = 190;
/** Cuanto se aleja un pixel del tono del papel (percentil 92) para seguir siendo fondo, y que parte de la imagen ha de serlo. */
const BACKGROUND_TOLERANCE = 28;
const BACKGROUND_MIN_SHARE = 0.5;
/** Una cubeta de color cuenta si tiene al menos esta fraccion de los pixeles visibles (una foto ocupa miles de cubetas). */
const BIN_MIN_SHARE = 0.0005;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Tono (0..360), saturacion (0..1) y valor (0..255) de un color. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const EMPTY: PixelFeatures = {
  width: 0,
  height: 0,
  transparent: 1,
  hasAlpha: true,
  lightBackground: true,
  inkFraction: 0,
  inkLuma: 255,
  inkSaturation: 0,
  darkShare: 0,
  blueShare: 0,
  dominantHueShare: 0,
  dominantHue: -1,
  chromaticShare: 0,
  colorBins: 0,
  solidity: 0,
  ringShare: 0,
  centerShare: 0,
  frameShare: 0,
  fullSpanShare: 0,
  fullSpanRuns: 0,
  frameSides: 0,
  localPaper: false,
  inkBox: { x: 0, y: 0, width: 0, height: 0 },
  meanAlpha: 0,
};

/** Luminancia minima del fondo LOCAL para contar como papel (una foto oscura o con sombra sigue siendo papel; un cuadro negro no). */
const LOCAL_PAPER_MIN_LUMA = 110;
/** Fraccion de los pixeles que ha de estar cerca de su fondo local para que la imagen cuente como papel con sombra. */
const LOCAL_PAPER_MIN_SHARE = 0.6;
/** Saturacion media maxima del fondo local: el papel es casi neutro (blanco, gris, amarillento); un cuadro de color liso no es papel. */
const LOCAL_PAPER_MAX_SATURATION = 0.3;

/**
 * Fondo LOCAL de una imagen opaca: en cada celda (1/8 del lado mayor) el percentil 85 de la luminancia de sus pixeles visibles (la
 * tinta ocupa poco), interpolado entre centros de celda. Sigue una sombra o un degradado de iluminacion que el percentil global no ve.
 */
function localBackground(lumas: Uint8Array, data: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const cell = Math.min(40, Math.max(8, Math.round(Math.max(width, height) / 8)));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const grid = new Float32Array(cols * rows).fill(255);
  const hist = new Uint32Array(256);
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      hist.fill(0);
      let n = 0;
      for (let y = cy * cell; y < Math.min(height, (cy + 1) * cell); y += 1) {
        for (let x = cx * cell; x < Math.min(width, (cx + 1) * cell); x += 1) {
          const i = y * width + x;
          if (data[i * 4 + 3] < TRANSPARENT_BELOW) continue;
          hist[lumas[i]] += 1;
          n += 1;
        }
      }
      if (n === 0) continue;
      let cumulative = 0;
      const target = n * 0.85;
      for (let l = 0; l < 256; l += 1) {
        cumulative += hist[l];
        if (cumulative >= target) {
          grid[cy * cols + cx] = l;
          break;
        }
      }
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const fx = gx - x0;
      const top = grid[y0 * cols + x0] * (1 - fx) + grid[y0 * cols + x1] * fx;
      const bottom = grid[y1 * cols + x0] * (1 - fx) + grid[y1 * cols + x1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

export function analyzePixels(image: RasterRGBA): PixelFeatures {
  const { width, height, data } = image;
  const total = width * height;
  if (total <= 0 || data.length < total * 4) return { ...EMPTY, width, height };

  let transparentCount = 0;
  let alphaSum = 0;
  let visible = 0;
  let hasAlpha = false;
  const lumas = new Uint8Array(total);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const a = data[o + 3];
    if (a < 250) hasAlpha = true;
    if (a < TRANSPARENT_BELOW) {
      transparentCount += 1;
      continue;
    }
    visible += 1;
    alphaSum += a;
    const l = Math.round(luma(data[o], data[o + 1], data[o + 2]));
    lumas[i] = l;
    histogram[l] += 1;
  }
  const transparent = transparentCount / total;
  if (visible === 0) return { ...EMPTY, width, height, transparent: 1 };

  const mask = new Uint8Array(total);
  let lightBackground: boolean;
  let localPaper = false;
  let backgroundLuma = 255;
  const transparentMode = transparent >= 0.15;
  if (transparentMode) {
    lightBackground = true;
    for (let i = 0; i < total; i += 1) if (data[i * 4 + 3] >= INK_ALPHA) mask[i] = 1;
  } else {
    // Fondo: el percentil 92 de la luminancia (una firma o un logo ocupa poco; el resto es papel).
    let cumulative = 0;
    const target = visible * 0.92;
    let p92 = 255;
    for (let l = 0; l < 256; l += 1) {
      cumulative += histogram[l];
      if (cumulative >= target) {
        p92 = l;
        break;
      }
    }
    backgroundLuma = p92;
    // Fondo uniforme: la mayor parte de los pixeles esta cerca del tono del papel (un escaneo con ruido o sombra suave sigue siendo fondo).
    let near = 0;
    for (let i = 0; i < total; i += 1) {
      if (data[i * 4 + 3] >= TRANSPARENT_BELOW && Math.abs(lumas[i] - p92) <= BACKGROUND_TOLERANCE) near += 1;
    }
    lightBackground = p92 >= LIGHT_BACKGROUND_LUMA && near / visible >= BACKGROUND_MIN_SHARE;
    let masked = false;
    if (!lightBackground) {
      // Foto con sombra o papel gris: el fondo no es claro en conjunto pero si respecto a su entorno. La tinta se separa con el fondo local.
      const local = localBackground(lumas, data, width, height);
      let nearLocal = 0;
      let localSum = 0;
      let saturationSum = 0;
      for (let i = 0; i < total; i += 1) {
        if (data[i * 4 + 3] < TRANSPARENT_BELOW) continue;
        localSum += local[i];
        if (Math.abs(lumas[i] - local[i]) <= BACKGROUND_TOLERANCE) {
          nearLocal += 1;
          const r = data[i * 4];
          const g = data[i * 4 + 1];
          const b = data[i * 4 + 2];
          const max = Math.max(r, g, b);
          if (max > 0) saturationSum += (max - Math.min(r, g, b)) / max;
        }
      }
      if (nearLocal / visible >= LOCAL_PAPER_MIN_SHARE && localSum / visible >= LOCAL_PAPER_MIN_LUMA && saturationSum / Math.max(1, nearLocal) <= LOCAL_PAPER_MAX_SATURATION) {
        localPaper = true;
        masked = true;
        for (let i = 0; i < total; i += 1) {
          if (data[i * 4 + 3] >= INK_ALPHA && lumas[i] < local[i] - INK_CONTRAST) mask[i] = 1;
        }
      }
    }
    if (!masked) {
      for (let i = 0; i < total; i += 1) {
        if (data[i * 4 + 3] >= INK_ALPHA && lumas[i] < backgroundLuma - INK_CONTRAST) mask[i] = 1;
      }
    }
  }

  // Estadisticas de la tinta.
  let inkCount = 0;
  let lumaSum = 0;
  let satSum = 0;
  let dark = 0;
  let blue = 0;
  let chromatic = 0;
  const hueBins = new Uint32Array(36);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      inkCount += 1;
      const o = i * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const l = luma(r, g, b);
      const hsv = rgbToHsv(r, g, b);
      lumaSum += l;
      satSum += hsv.s;
      if (l < 120) dark += 1;
      if (hsv.h >= 195 && hsv.h <= 265 && hsv.s >= 0.25 && l < 170) blue += 1;
      if (hsv.s >= 0.3 && hsv.v > 40) {
        chromatic += 1;
        hueBins[Math.min(35, Math.floor(hsv.h / 10))] += 1;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  // Tono dominante: la ventana de 7 cubetas (70 grados) con mas tinta cromatica.
  let dominantHue = -1;
  let dominantHueShare = 0;
  if (chromatic > 0) {
    let best = 0;
    let bestAt = 0;
    for (let start = 0; start < 36; start += 1) {
      let window = 0;
      for (let k = 0; k < 7; k += 1) window += hueBins[(start + k) % 36];
      if (window > best) {
        best = window;
        bestAt = start;
      }
    }
    // Tono medio (circular) de la ventana ganadora, ponderado por la tinta de cada cubeta.
    let sin = 0;
    let cos = 0;
    for (let k = 0; k < 7; k += 1) {
      const count = hueBins[(bestAt + k) % 36];
      const angle = (((bestAt + k) % 36) * 10 + 5) * (Math.PI / 180);
      sin += count * Math.sin(angle);
      cos += count * Math.cos(angle);
    }
    dominantHue = (((Math.atan2(sin, cos) * 180) / Math.PI) + 360) % 360;
    dominantHueShare = best / chromatic;
  }

  // Colores distintos con peso.
  const bins = new Uint32Array(4096);
  let counted = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (data[o + 3] < INK_ALPHA) continue;
    bins[((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4)] += 1;
    counted += 1;
  }
  let colorBins = 0;
  const minBin = Math.max(1, counted * BIN_MIN_SHARE);
  for (let k = 0; k < 4096; k += 1) if (bins[k] >= minBin) colorBins += 1;

  // Solidez: tinta con los cuatro vecinos tambien tinta.
  let interior = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) interior += 1;
    }
  }

  // Forma: aro (elipse inscrita) y marco (borde de la caja).
  let ring = 0;
  let center = 0;
  let frame = 0;
  let inkBox = { x: 0, y: 0, width: 0, height: 0 };
  let fullSpan = 0;
  let fullSpanRuns = 0;
  let frameSides = 0;
  if (inkCount > 0) {
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const cx = minX + boxW / 2;
    const cy = minY + boxH / 2;
    const a = boxW / 2;
    const b = boxH / 2;
    const edgeX = Math.max(2, boxW * 0.1);
    const edgeY = Math.max(2, boxH * 0.1);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!mask[y * width + x]) continue;
        const dx = (x + 0.5 - cx) / a;
        const dy = (y + 0.5 - cy) / b;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r >= 0.8 && r <= 1.05) ring += 1;
        if (r < 0.55) center += 1;
        if (x - minX < edgeX || maxX - x < edgeX || y - minY < edgeY || maxY - y < edgeY) frame += 1;
      }
    }
    inkBox = { x: minX / width, y: minY / height, width: boxW / width, height: boxH / height };
    // Barras (codigo de barras, rayas): columnas o filas casi enteras de tinta.
    let fullColumns = 0;
    let columnRuns = 0;
    let inColumnRun = false;
    for (let x = minX; x <= maxX; x += 1) {
      let count = 0;
      for (let y = minY; y <= maxY; y += 1) count += mask[y * width + x];
      const full = count >= boxH * 0.85;
      if (full) fullColumns += 1;
      if (full && !inColumnRun) columnRuns += 1;
      inColumnRun = full;
    }
    let fullRows = 0;
    let rowRuns = 0;
    let inRowRun = false;
    for (let y = minY; y <= maxY; y += 1) {
      let count = 0;
      for (let x = minX; x <= maxX; x += 1) count += mask[y * width + x];
      const full = count >= boxW * 0.85;
      if (full) fullRows += 1;
      if (full && !inRowRun) rowRuns += 1;
      inRowRun = full;
    }
    fullSpan = Math.max(fullColumns / boxW, fullRows / boxH);
    fullSpanRuns = Math.max(columnRuns, rowRuns);
    // Cobertura de cada borde: fraccion de filas (o columnas) del lado que tienen tinta dentro de la franja del borde.
    const bandX = Math.max(2, Math.round(edgeX));
    const bandY = Math.max(2, Math.round(edgeY));
    const rowHas = (xFrom: number, xTo: number): number => {
      let n = 0;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = xFrom; x <= xTo; x += 1) {
          if (mask[y * width + x]) {
            n += 1;
            break;
          }
        }
      }
      return n / boxH;
    };
    const colHas = (yFrom: number, yTo: number): number => {
      let n = 0;
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = yFrom; y <= yTo; y += 1) {
          if (mask[y * width + x]) {
            n += 1;
            break;
          }
        }
      }
      return n / boxW;
    };
    frameSides = Math.min(
      rowHas(minX, Math.min(maxX, minX + bandX - 1)),
      rowHas(Math.max(minX, maxX - bandX + 1), maxX),
      colHas(minY, Math.min(maxY, minY + bandY - 1)),
      colHas(Math.max(minY, maxY - bandY + 1), maxY),
    );
  }

  return {
    width,
    height,
    transparent,
    hasAlpha,
    lightBackground,
    inkFraction: inkCount / total,
    inkLuma: inkCount > 0 ? lumaSum / inkCount : 255,
    inkSaturation: inkCount > 0 ? satSum / inkCount : 0,
    darkShare: inkCount > 0 ? dark / inkCount : 0,
    blueShare: inkCount > 0 ? blue / inkCount : 0,
    dominantHueShare,
    dominantHue,
    chromaticShare: inkCount > 0 ? chromatic / inkCount : 0,
    colorBins,
    solidity: inkCount > 0 ? interior / inkCount : 0,
    ringShare: inkCount > 0 ? ring / inkCount : 0,
    centerShare: inkCount > 0 ? center / inkCount : 0,
    frameShare: inkCount > 0 ? frame / inkCount : 0,
    fullSpanShare: fullSpan,
    fullSpanRuns,
    frameSides,
    localPaper,
    inkBox,
    meanAlpha: alphaSum / visible / 255,
  };
}
