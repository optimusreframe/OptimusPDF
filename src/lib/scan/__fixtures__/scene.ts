import type { Canvas } from "@napi-rs/canvas";
import { orderCorners } from "@/lib/scan/geometry";
import { makeRng } from "@/lib/scan/__fixtures__/rng";
import { boxBlur, clampByte, rotateRgba, type Rgba } from "@/lib/scan/pixels";
import type { QuadCorners, ScanPoint } from "@/lib/scan/perspective";

/**
 * Simulador de "foto de un documento": coloca una pagina sobre un escritorio con perspectiva, giro, sombra, brillo,
 * ruido y desenfoque, y la gira 0/90/180/270 como si el telefono se sostuviera de lado. Devuelve la foto (RGBA) y la
 * VERDAD (cuadrilatero normalizado de la hoja en la foto final y giro que la deja derecha).
 */

export type DeskKind = "dark" | "wood" | "light" | "blue";

export type SceneParams = {
  seed: number;
  width?: number;
  height?: number;
  desk?: DeskKind;
  /** Fraccion del ancho de la escena que ocupa la hoja (0.5-0.9). */
  scale?: number;
  angleDeg?: number;
  /** Fuga de perspectiva: -0.12 .. 0.12 (positivo = borde superior mas estrecho). */
  keystone?: number;
  /** 0-1: sombra en degradado sobre la escena. */
  shadow?: number;
  noise?: number;
  /** Radio del desenfoque de caja (px de la escena); 0 = nitida. */
  blur?: number;
  glare?: { x: number; y: number; radius: number; strength: number } | null;
  /** Multiplicador global de luz (0.3 = muy oscuro). */
  light?: number;
  /** Cuartos de vuelta horarios de la FOTO (telefono de lado). */
  turns?: 0 | 1 | 2 | 3;
  /** Desplazamiento del centro, en fracciones de la escena. */
  offset?: { x: number; y: number };
};

export type SceneResult = {
  image: Rgba;
  /** Esquinas de la hoja en la foto final, normalizadas, en orden TL TR BR BL de la FOTO. */
  quad: QuadCorners;
  /** Giro horario (grados) que hay que aplicar a la foto para que el texto quede derecho. */
  neededRotation: 0 | 90 | 180 | 270;
};

type Matrix3 = number[];

function solve8(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[p], a[c]] = [a[c], a[p]];
    [b[p], b[c]] = [b[c], b[p]];
    for (let r = c + 1; r < n; r += 1) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < n; k += 1) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = b[r];
    for (let k = r + 1; k < n; k += 1) s -= a[r][k] * x[k];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Homografia que lleva `from[i]` a `to[i]`. */
function homography(from: ScanPoint[], to: ScanPoint[]): Matrix3 {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solve8(a, b);
  return [...h, 1];
}

function apply(h: Matrix3, x: number, y: number): ScanPoint {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function deskPixel(kind: DeskKind, x: number, y: number, noise: number): [number, number, number] {
  switch (kind) {
    case "wood": {
      const stripe = Math.sin(y * 0.09 + Math.sin(x * 0.012) * 3) * 12;
      return [110 + stripe + noise, 78 + stripe * 0.7 + noise, 48 + stripe * 0.4 + noise];
    }
    case "light":
      return [196 + noise, 192 + noise, 186 + noise];
    case "blue":
      return [48 + noise, 72 + noise, 110 + noise];
    default:
      return [54 + noise, 56 + noise, 62 + noise];
  }
}

export function composeScene(page: Canvas | Rgba, params: SceneParams): SceneResult {
  const pageImage: Rgba = "getContext" in page ? (() => {
    const ctx = page.getContext("2d");
    const data = ctx.getImageData(0, 0, page.width, page.height);
    return { data: new Uint8ClampedArray(data.data), width: page.width, height: page.height };
  })() : page;
  const rng = makeRng(params.seed);
  const width = params.width ?? 800;
  const height = params.height ?? 1100;
  const desk = params.desk ?? "dark";
  const angle = ((params.angleDeg ?? rng.range(-6, 6)) * Math.PI) / 180;
  const keystone = params.keystone ?? rng.range(-0.06, 0.06);
  const aspect = pageImage.height / pageImage.width;
  let quadW = (params.scale ?? rng.range(0.66, 0.82)) * width;
  let quadH = quadW * aspect;
  const maxH = height * 0.88;
  if (quadH > maxH) {
    quadH = maxH;
    quadW = quadH / aspect;
  }
  const cx = width / 2 + (params.offset?.x ?? 0) * width;
  const cy = height / 2 + (params.offset?.y ?? 0) * height;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const half: ScanPoint[] = [
    { x: -quadW / 2, y: -quadH / 2 },
    { x: quadW / 2, y: -quadH / 2 },
    { x: quadW / 2, y: quadH / 2 },
    { x: -quadW / 2, y: quadH / 2 },
  ];
  const corners = half.map((p, index) => {
    const squeeze = index < 2 ? 1 - keystone : 1 + keystone;
    const x = p.x * squeeze;
    const y = p.y;
    return { x: cx + x * cos - y * sin + rng.range(-3, 3), y: cy + x * sin + y * cos + rng.range(-3, 3) };
  });
  const pageCorners: ScanPoint[] = [
    { x: 0, y: 0 },
    { x: pageImage.width, y: 0 },
    { x: pageImage.width, y: pageImage.height },
    { x: 0, y: pageImage.height },
  ];
  // Escena -> pagina.
  const toPage = homography(corners, pageCorners);
  const light = params.light ?? 1;
  const shadow = params.shadow ?? rng.range(0, 0.25);
  const shadowAngle = rng.range(0, Math.PI * 2);
  const sx = Math.cos(shadowAngle);
  const sy = Math.sin(shadowAngle);
  const diag = Math.hypot(width, height);
  const noiseSigma = params.noise ?? rng.range(1.5, 4);
  const data = new Uint8ClampedArray(width * height * 4);
  const src = pageImage.data;
  // Cuadrilatero para saber si un punto cae dentro (se usa el rango de la pagina).
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const p = apply(toPage, x + 0.5, y + 0.5);
      let r: number;
      let g: number;
      let b: number;
      if (p.x >= 0 && p.y >= 0 && p.x < pageImage.width - 1 && p.y < pageImage.height - 1) {
        const x0 = Math.floor(p.x);
        const y0 = Math.floor(p.y);
        const fx = p.x - x0;
        const fy = p.y - y0;
        const i00 = (y0 * pageImage.width + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + pageImage.width * 4;
        const i11 = i01 + 4;
        r = (src[i00] * (1 - fx) + src[i10] * fx) * (1 - fy) + (src[i01] * (1 - fx) + src[i11] * fx) * fy;
        g = (src[i00 + 1] * (1 - fx) + src[i10 + 1] * fx) * (1 - fy) + (src[i01 + 1] * (1 - fx) + src[i11 + 1] * fx) * fy;
        b = (src[i00 + 2] * (1 - fx) + src[i10 + 2] * fx) * (1 - fy) + (src[i01 + 2] * (1 - fx) + src[i11 + 2] * fx) * fy;
      } else {
        const d = deskPixel(desk, x, y, 0);
        r = d[0];
        g = d[1];
        b = d[2];
      }
      // Luz: degradado de sombra y vineta suave.
      const t = ((x - width / 2) * sx + (y - height / 2) * sy) / diag + 0.5;
      const gradient = 1 - shadow * Math.min(1, Math.max(0, t));
      const vignette = 1 - 0.12 * (Math.hypot(x - width / 2, y - height / 2) / (diag / 2)) ** 2;
      const k = light * gradient * vignette;
      data[o] = r * k;
      data[o + 1] = g * k;
      data[o + 2] = b * k;
      data[o + 3] = 255;
    }
  }
  if (params.glare) {
    const gl = params.glare;
    const gx = gl.x * width;
    const gy = gl.y * height;
    const radius = gl.radius * width;
    for (let y = Math.max(0, Math.floor(gy - radius * 2.5)); y < Math.min(height, gy + radius * 2.5); y += 1) {
      for (let x = Math.max(0, Math.floor(gx - radius * 2.5)); x < Math.min(width, gx + radius * 2.5); x += 1) {
        const d2 = ((x - gx) ** 2 + (y - gy) ** 2) / (2 * radius * radius);
        const add = gl.strength * 255 * Math.exp(-d2);
        const o = (y * width + x) * 4;
        data[o] = clampByte(data[o] + add);
        data[o + 1] = clampByte(data[o + 1] + add);
        data[o + 2] = clampByte(data[o + 2] + add);
      }
    }
  }
  let image: Rgba = { data, width, height };
  if (params.blur && params.blur > 0) {
    for (let channel = 0; channel < 3; channel += 1) {
      const plane = new Float32Array(width * height);
      for (let i = 0; i < plane.length; i += 1) plane[i] = image.data[i * 4 + channel];
      let blurred: Float32Array = plane;
      for (let pass = 0; pass < 3; pass += 1) blurred = boxBlur(blurred, width, height, params.blur);
      for (let i = 0; i < plane.length; i += 1) image.data[i * 4 + channel] = blurred[i];
    }
  }
  // Ruido: tabla gaussiana precalculada (mucho mas barata que un gaussiano por pixel).
  const table = new Float32Array(4096);
  for (let i = 0; i < table.length; i += 1) table[i] = rng.gauss();
  let cursor = rng.int(0, 4095);
  const step = 1 + 2 * rng.int(0, 600);
  for (let i = 0; i < width * height; i += 1) {
    cursor = (cursor + step) & 4095;
    const n = table[cursor] * noiseSigma;
    const c = table[(cursor * 7 + 13) & 4095] * 0.5;
    image.data[i * 4] = clampByte(image.data[i * 4] + n + c);
    image.data[i * 4 + 1] = clampByte(image.data[i * 4 + 1] + n);
    image.data[i * 4 + 2] = clampByte(image.data[i * 4 + 2] + n - c);
  }
  let normalized = corners.map((p) => ({ x: p.x / width, y: p.y / height }));
  const turns = params.turns ?? 0;
  if (turns) {
    image = rotateRgba(image, turns);
    for (let t = 0; t < turns; t += 1) normalized = normalized.map((p) => ({ x: 1 - p.y, y: p.x }));
  }
  const neededRotation = ((360 - turns * 90) % 360) as 0 | 90 | 180 | 270;
  return { image, quad: orderCorners(normalized), neededRotation };
}
