/**
 * Rasters SINTETICOS (RGBA, sin canvas: corren igual en Node y en el navegador) para el corpus de firmas, iniciales, logos, fotos y
 * sellos del clasificador (U7.3): una firma «cursiva» con bucles dibujada con discos de bordes suavizados, un escaneo de firma con
 * papel ruidoso, un logo de colores planos, una foto de muchos colores y un sello circular. Todo es determinista (semilla).
 */

export type Raster = { width: number; height: number; data: Uint8ClampedArray };
export type Rgb = readonly [number, number, number];

/** PRNG pequeno y determinista (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blank(width: number, height: number, rgba: readonly [number, number, number, number] = [0, 0, 0, 0]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  if (rgba[3] !== 0 || rgba[0] || rgba[1] || rgba[2]) for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data };
}

/** Disco de borde suave: alfa = cobertura; compone con el color de debajo (sobre fondo transparente o con papel). */
function stamp(raster: Raster, cx: number, cy: number, radius: number, color: Rgb): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(raster.width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(raster.height - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      if (coverage <= 0) continue;
      const o = (y * raster.width + x) * 4;
      const baseAlpha = raster.data[o + 3] / 255;
      const outAlpha = coverage + baseAlpha * (1 - coverage);
      for (let c = 0; c < 3; c += 1) raster.data[o + c] = (color[c] * coverage + raster.data[o + c] * baseAlpha * (1 - coverage)) / (outAlpha || 1);
      raster.data[o + 3] = Math.round(outAlpha * 255);
    }
  }
}

/** Trazo (polilinea densa) con grosor constante. */
export function strokePolyline(raster: Raster, points: ReadonlyArray<readonly [number, number]>, thickness: number, color: Rgb): void {
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
    for (let s = 0; s <= steps; s += 1) stamp(raster, ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, thickness / 2, color);
  }
}

export type SignatureStyle = { seed: number; words?: number; loops?: number };

/**
 * Puntos de una firma cursiva: cada «letra» es un trocoide (bucles hacia atras) con amplitud y velocidad variables, inclinada, mas un
 * trazo final largo. Devuelve los puntos en el cuadro `width x height` (con margen).
 */
export function signaturePoints(width: number, height: number, style: SignatureStyle): Array<Array<[number, number]>> {
  const rand = mulberry32(style.seed);
  const words = style.words ?? 1;
  const strokes: Array<Array<[number, number]>> = [];
  const marginX = width * 0.06;
  const marginY = height * 0.12;
  const usableW = width - 2 * marginX;
  const usableH = height - 2 * marginY;
  let cursor = marginX;
  for (let w = 0; w < words; w += 1) {
    const wordWidth = (usableW / words) * (0.78 + rand() * 0.18);
    const letters = style.loops ?? 4 + Math.floor(rand() * 3);
    const points: Array<[number, number]> = [];
    const speed = wordWidth / (letters * 2 * Math.PI) * 0.55;
    const slant = 0.25 + rand() * 0.2;
    for (let step = 0; step <= letters * 60; step += 1) {
      const t = (step / 60) * 2 * Math.PI; // un bucle por vuelta
      const amp = usableH * (0.22 + 0.14 * Math.sin(t * 0.37 + w) + 0.06 * rand() * 0);
      const x = cursor + speed * t - amp * 0.9 * Math.sin(t) + (amp * slant) * Math.cos(t);
      const y = marginY + usableH * 0.5 - amp * Math.cos(t) - usableH * 0.12 * Math.sin(t * 0.23 + 1);
      points.push([Math.min(width - 1, Math.max(1, x)), Math.min(height - 1, Math.max(1, y))]);
    }
    strokes.push(points);
    // Trazo final: una raya larga ligeramente curva bajo la palabra.
    const underline: Array<[number, number]> = [];
    for (let s = 0; s <= 40; s += 1) {
      const u = s / 40;
      underline.push([cursor + u * wordWidth, marginY + usableH * (0.86 - 0.08 * Math.sin(u * Math.PI))]);
    }
    strokes.push(underline);
    cursor += usableW / words;
  }
  return strokes;
}

export type InkSignatureOptions = {
  seed: number;
  width?: number;
  height?: number;
  ink?: Rgb;
  thickness?: number;
  /** `transparent`: PNG recortado (OptimusPDF, DocuSign); `paper`: escaneo opaco con papel casi blanco y ruido. */
  background?: "transparent" | "paper" | "white";
  words?: number;
  loops?: number;
  /** Amplitud del ruido de papel (+-), 10 por defecto; un escaneo malo o un JPEG muy comprimido ronda 28. */
  noise?: number;
  /** Tono del papel (luminancia aproximada del fondo opaco). */
  paper?: number;
};

export const BLUE_PEN: Rgb = [20, 40, 120];
export const BLACK_PEN: Rgb = [18, 18, 22];

export function inkSignatureRaster(options: InkSignatureOptions): Raster {
  const width = options.width ?? 300;
  const height = options.height ?? 90;
  const background = options.background ?? "transparent";
  const ink = options.ink ?? BLUE_PEN;
  const paper = options.paper ?? 252;
  const raster = background === "transparent" ? blank(width, height) : blank(width, height, [paper, paper, Math.max(0, paper - 2), 255]);
  const strokes = signaturePoints(width, height, { seed: options.seed, words: options.words, loops: options.loops });
  const thickness = options.thickness ?? Math.max(1.6, width / 150);
  for (const points of strokes) strokePolyline(raster, points, thickness, ink);
  if (background === "paper") addPaperNoise(raster, options.seed + 99, options.noise ?? 10);
  return raster;
}

/** Papel de escaner: tono calido, sombra suave y ruido por pixel (+-5) sin tocar la tinta mas oscura. */
export function addPaperNoise(raster: Raster, seed: number, amplitude = 10): void {
  const rand = mulberry32(seed);
  for (let y = 0; y < raster.height; y += 1) {
    const shade = 1 - 0.06 * (y / raster.height);
    for (let x = 0; x < raster.width; x += 1) {
      const o = (y * raster.width + x) * 4;
      const noise = (rand() - 0.5) * amplitude;
      const lightness = raster.data[o] + raster.data[o + 1] + raster.data[o + 2];
      if (lightness > 600) {
        raster.data[o] = Math.max(0, Math.min(255, (raster.data[o] - 6) * shade + noise));
        raster.data[o + 1] = Math.max(0, Math.min(255, (raster.data[o + 1] - 8) * shade + noise));
        raster.data[o + 2] = Math.max(0, Math.min(255, (raster.data[o + 2] - 14) * shade + noise));
      }
    }
  }
}

/** Iniciales: dos o tres letras compactas (cuadro casi cuadrado). */
export function initialsRaster(options: { seed: number; size?: number; ink?: Rgb; background?: "transparent" | "paper"; thickness?: number }): Raster {
  const size = options.size ?? 110;
  return inkSignatureRaster({ seed: options.seed, width: size, height: Math.round(size * 0.8), ink: options.ink ?? BLUE_PEN, thickness: options.thickness ?? Math.max(1.8, size / 55), background: options.background, words: 1, loops: 3 });
}

export function fillRect(raster: Raster, x: number, y: number, w: number, h: number, color: Rgb, alpha = 255): void {
  for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(raster.height, Math.ceil(y + h)); yy += 1) {
    for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(raster.width, Math.ceil(x + w)); xx += 1) {
      raster.data.set([color[0], color[1], color[2], alpha], (yy * raster.width + xx) * 4);
    }
  }
}

export function fillCircle(raster: Raster, cx: number, cy: number, radius: number, color: Rgb): void {
  stamp(raster, cx, cy, radius, color);
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius - 0.5) raster.data.set([color[0], color[1], color[2], 255], (y * raster.width + x) * 4);
    }
  }
}

/** Logo de colores planos: bloque de color + circulo + barras (relleno solido, pocos colores). */
export function logoRaster(options: { seed: number; width?: number; height?: number; transparent?: boolean; palette?: readonly Rgb[] }): Raster {
  const width = options.width ?? 220;
  const height = options.height ?? 70;
  const palette = options.palette ?? [
    [0, 86, 163],
    [240, 150, 30],
    [40, 40, 44],
  ];
  const raster = options.transparent === false ? blank(width, height, [255, 255, 255, 255]) : blank(width, height);
  const rand = mulberry32(options.seed);
  fillRect(raster, 0, 0, width * 0.28, height, palette[0]);
  fillCircle(raster, width * 0.14, height * 0.5, height * 0.3, palette[1]);
  const bars = 3;
  for (let i = 0; i < bars; i += 1) {
    const w = width * (0.28 + rand() * 0.32);
    fillRect(raster, width * 0.34, height * (0.14 + i * 0.28), w, height * 0.17, palette[i % palette.length]);
  }
  return raster;
}

/** Foto sintetica: sumas de senos por canal con ruido: muchos colores distintos, opaca. */
export function photoRaster(options: { seed: number; width?: number; height?: number }): Raster {
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const rand = mulberry32(options.seed);
  const raster = blank(width, height, [0, 0, 0, 255]);
  const waves = Array.from({ length: 3 }, () => ({ fx: 0.01 + rand() * 0.04, fy: 0.01 + rand() * 0.04, phase: rand() * 6.28 }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const wave = waves[c];
        const base = 128 + 90 * Math.sin(x * wave.fx + y * wave.fy + wave.phase) + 30 * Math.sin((x + y) * 0.11 + c);
        raster.data[o + c] = Math.max(0, Math.min(255, base + (rand() - 0.5) * 36));
      }
    }
  }
  return raster;
}

/** Sello circular: aro doble de color saturado con barras de «texto» dentro, fondo transparente. */
export function stampRaster(options: { size?: number; color?: Rgb; seed?: number }): Raster {
  const size = options.size ?? 160;
  const color = options.color ?? [200, 30, 40];
  const raster = blank(size, size);
  const r = size / 2 - 3;
  const ring = (radius: number, thickness: number): void => {
    const points: Array<[number, number]> = [];
    for (let k = 0; k <= 180; k += 1) points.push([size / 2 + radius * Math.cos((k / 180) * 2 * Math.PI), size / 2 + radius * Math.sin((k / 180) * 2 * Math.PI)]);
    strokePolyline(raster, points, thickness, color);
  };
  ring(r, 5);
  ring(r - 11, 2);
  fillRect(raster, size * 0.22, size * 0.42, size * 0.56, size * 0.09, color);
  fillRect(raster, size * 0.3, size * 0.56, size * 0.4, size * 0.07, color);
  return raster;
}

/** Pagina escaneada sintetica: papel con lineas de «texto» grises y una firma a tinta azul abajo a la derecha. */
export function scannedPageRaster(options: { seed: number; width?: number; height?: number }): { raster: Raster; signatureBox: { x: number; y: number; width: number; height: number } } {
  const width = options.width ?? 612;
  const height = options.height ?? 792;
  const raster = blank(width, height, [250, 249, 245, 255]);
  const rand = mulberry32(options.seed);
  for (let line = 0; line < 36; line += 1) {
    const y = 60 + line * 16;
    const w = width * (0.55 + rand() * 0.3);
    fillRect(raster, 60, y, w, 4, [70, 70, 74]);
  }
  const box = { x: 330, y: 650, width: 200, height: 60 };
  const signature = inkSignatureRaster({ seed: options.seed + 5, width: box.width, height: box.height, ink: BLUE_PEN, background: "transparent" });
  for (let y = 0; y < signature.height; y += 1) {
    for (let x = 0; x < signature.width; x += 1) {
      const so = (y * signature.width + x) * 4;
      const a = signature.data[so + 3] / 255;
      if (a <= 0) continue;
      const o = ((box.y + y) * width + box.x + x) * 4;
      for (let c = 0; c < 3; c += 1) raster.data[o + c] = signature.data[so + c] * a + raster.data[o + c] * (1 - a);
    }
  }
  addPaperNoise(raster, options.seed + 7);
  return { raster, signatureBox: box };
}

/** Circulo VACIO de trazo fino (la casilla de unas iniciales dibujada), fondo transparente. */
export function emptyRingRaster(size = 96, color: Rgb = [30, 30, 34]): Raster {
  const raster = blank(size, size);
  const points: Array<[number, number]> = [];
  for (let k = 0; k <= 160; k += 1) points.push([size / 2 + (size / 2 - 4) * Math.cos((k / 160) * 2 * Math.PI), size / 2 + (size / 2 - 4) * Math.sin((k / 160) * 2 * Math.PI)]);
  strokePolyline(raster, points, 2.2, color);
  return raster;
}

/** Cuadro VACIO de trazo fino (la casilla de la firma dibujada), fondo transparente. */
export function emptyBoxRaster(width = 240, height = 80, color: Rgb = [30, 30, 34]): Raster {
  const raster = blank(width, height);
  strokePolyline(raster, [[3, 3], [width - 3, 3], [width - 3, height - 3], [3, height - 3], [3, 3]], 2.2, color);
  return raster;
}

/** Cenefa ornamental: una onda fina muy ancha (casi todo el ancho de la pagina), fondo transparente. */
export function dividerRaster(width = 600, height = 22, color: Rgb = [40, 40, 46]): Raster {
  const raster = blank(width, height);
  const points: Array<[number, number]> = [];
  for (let x = 4; x < width - 4; x += 2) points.push([x, height / 2 + (height / 2 - 4) * Math.sin(x / 9)]);
  strokePolyline(raster, points, 1.8, color);
  return raster;
}

/** Icono de sobre de trazo fino (sin etiqueta cerca no es una firma), fondo transparente. */
export function envelopeIconRaster(width = 80, height = 60, color: Rgb = [30, 30, 34]): Raster {
  const raster = blank(width, height);
  strokePolyline(raster, [[4, 6], [width - 4, 6], [width - 4, height - 6], [4, height - 6], [4, 6]], 2, color);
  strokePolyline(raster, [[4, 6], [width / 2, height / 2 + 4], [width - 4, 6]], 2, color);
  return raster;
}
