/**
 * Utilidades de PIXELES del Escaner: aritmetica pura sobre buffers (sin canvas ni DOM), para poder probarlas en Node con
 * documentos sinteticos y ejecutarlas igual en el hilo principal que dentro de un Web Worker.
 */

/** Buffer RGBA plano (estructural: un `ImageData` real encaja sin conversion). */
export type Rgba = { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

/** Imagen de un canal (0-255). */
export type Gray = { data: Uint8Array; width: number; height: number };

export function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** Luminancia entera (Rec. 601) de un pixel RGB. */
export function lumaOf(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

export function toGray(image: Rgba): Gray {
  const { data, width, height } = image;
  const out = new Uint8Array(width * height);
  for (let index = 0, pixel = 0; index < out.length; index += 1, pixel += 4) {
    out[index] = lumaOf(data[pixel], data[pixel + 1], data[pixel + 2]);
  }
  return { data: out, width, height };
}

/** Tamano que cabe en `maxSide` (nunca amplia). */
export function fitSide(width: number, height: number, maxSide: number): { width: number; height: number; scale: number } {
  const largest = Math.max(width, height);
  if (largest <= maxSide) return { width, height, scale: 1 };
  const scale = maxSide / largest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** Reduce por promedio de bloques (area): estable y barato; sin alias al bajar de golpe. */
export function downscaleRgba(image: Rgba, maxSide: number): Rgba {
  const target = fitSide(image.width, image.height, maxSide);
  if (target.scale === 1) return image;
  const { width: dw, height: dh } = target;
  const sx = image.width / dw;
  const sy = image.height / dh;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let offset = (yy * image.width + x0) * 4;
        for (let xx = x0; xx < x1; xx += 1) {
          r += image.data[offset];
          g += image.data[offset + 1];
          b += image.data[offset + 2];
          offset += 4;
          count += 1;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / count;
      out[o + 1] = g / count;
      out[o + 2] = b / count;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

export function downscaleGray(image: Gray, maxSide: number): Gray {
  const target = fitSide(image.width, image.height, maxSide);
  if (target.scale === 1) return image;
  const { width: dw, height: dh } = target;
  const sx = image.width / dw;
  const sy = image.height / dh;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          sum += image.data[yy * image.width + xx];
          count += 1;
        }
      }
      out[y * dw + x] = sum / count;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** Desenfoque de caja separable (ventana `2*radius+1`, bordes replicados). Devuelve Float32 para no perder precision. */
export function boxBlur(source: Float32Array | Uint8Array, width: number, height: number, radius: number): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const window = 2 * r + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += source[row + Math.min(width - 1, Math.max(0, k))];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / window;
      const add = Math.min(width - 1, x + r + 1);
      const remove = Math.max(0, x - r);
      sum += source[row + add] - source[row + remove];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -r; k <= r; k += 1) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / window;
      const add = Math.min(height - 1, y + r + 1);
      const remove = Math.max(0, y - r);
      sum += tmp[add * width + x] - tmp[remove * width + x];
    }
  }
  return out;
}

export function histogram256(gray: Uint8Array): Uint32Array {
  const hist = new Uint32Array(256);
  for (let index = 0; index < gray.length; index += 1) hist[gray[index]] += 1;
  return hist;
}

/** Umbral de Otsu sobre un histograma de 256 niveles. */
export function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  let sumAll = 0;
  for (let level = 0; level < 256; level += 1) {
    total += hist[level];
    sumAll += level * hist[level];
  }
  if (total === 0) return 128;
  let weightBack = 0;
  let sumBack = 0;
  let best = 0;
  let threshold = 128;
  for (let level = 0; level < 256; level += 1) {
    weightBack += hist[level];
    if (weightBack === 0) continue;
    const weightFront = total - weightBack;
    if (weightFront === 0) break;
    sumBack += level * hist[level];
    const meanBack = sumBack / weightBack;
    const meanFront = (sumAll - sumBack) / weightFront;
    const between = weightBack * weightFront * (meanBack - meanFront) ** 2;
    if (between > best) {
      best = between;
      threshold = level;
    }
  }
  return threshold;
}

/** Percentil `p` (0..1) del histograma. */
export function percentileOf(hist: Uint32Array, p: number): number {
  let total = 0;
  for (let level = 0; level < 256; level += 1) total += hist[level];
  const target = total * p;
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += hist[level];
    if (seen >= target) return level;
  }
  return 255;
}

/** Gira `quarters` cuartos de vuelta en sentido horario (0..3). */
export function rotateRgba(image: Rgba, quarters: number): Rgba {
  const turns = ((Math.round(quarters) % 4) + 4) % 4;
  if (turns === 0) return image;
  const { width, height, data } = image;
  const swap = turns % 2 === 1;
  const dw = swap ? height : width;
  const dh = swap ? width : height;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = height - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = width - 1 - x;
        ny = height - 1 - y;
      } else {
        nx = y;
        ny = width - 1 - x;
      }
      const from = (y * width + x) * 4;
      const to = (ny * dw + nx) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return { data: out, width: dw, height: dh };
}

export function rotateGray(image: Gray, quarters: number): Gray {
  const turns = ((Math.round(quarters) % 4) + 4) % 4;
  if (turns === 0) return image;
  const { width, height, data } = image;
  const swap = turns % 2 === 1;
  const dw = swap ? height : width;
  const dh = swap ? width : height;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = height - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = width - 1 - x;
        ny = height - 1 - y;
      } else {
        nx = y;
        ny = width - 1 - x;
      }
      out[ny * dw + nx] = data[y * width + x];
    }
  }
  return { data: out, width: dw, height: dh };
}

/** Recorta un rectangulo en pixeles (se acota a la imagen). */
export function cropRgba(image: Rgba, x: number, y: number, width: number, height: number): Rgba {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const w = Math.max(1, Math.min(image.width - x0, Math.round(width)));
  const h = Math.max(1, Math.min(image.height - y0, Math.round(height)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const from = ((y0 + row) * image.width + x0) * 4;
    out.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h };
}
