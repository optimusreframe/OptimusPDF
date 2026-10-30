import { createCanvas } from "@napi-rs/canvas";
import type { Rgba } from "@/lib/scan/pixels";
import type { QuadCorners } from "@/lib/scan/perspective";

/**
 * Escenas SINTETICAS de «hoja sobre una mesa» para medir el recorte automatico (sin datos reales): papel con su cuadrilatero
 * verdadero, membretes oscuros o de color pegados al borde de la hoja, giros de 0 a 30 grados, mesas oscuras, claras o de
 * madera, sombras, tarjetas y 4 marcadores negros dentro del papel (para comprobar que no se pierde contenido).
 */

type Pt = [number, number];
export type DeskName = "wood-dark" | "gray-dark" | "beige" | "gray-light" | "white-ish" | "blue";

export type SceneSpec = {
  bg: DeskName;
  paper: { cx: number; cy: number; ph: number; pw?: number; asp?: number; rot?: number; persp?: number };
  shadow?: 0 | 1;
  header?: string;
  header2?: string;
  headerH?: number;
  paperColor?: string;
  portrait?: boolean;
  gradient?: boolean;
  clutter?: boolean;
  innerFrame?: boolean;
};

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function quadOf(spec: { cx: number; cy: number; pw: number; ph: number; rot: number; persp: number }): Pt[] {
  const c = Math.cos(spec.rot);
  const s = Math.sin(spec.rot);
  const pts: Pt[] = [[-spec.pw / 2, -spec.ph / 2], [spec.pw / 2, -spec.ph / 2], [spec.pw / 2, spec.ph / 2], [-spec.pw / 2, spec.ph / 2]];
  return pts.map(([x, y], i) => {
    const k = i < 2 ? 1 - spec.persp : 1;
    const xx = x * k;
    return [spec.cx + xx * c - y * s, spec.cy + xx * s + y * c] as Pt;
  });
}

export type SceneRender = { image: Rgba; quad: QuadCorners; truth: Pt[]; width: number; height: number };

const DESKS: Record<DeskName, [number, number, number]> = { "wood-dark": [74, 52, 36], "gray-dark": [70, 72, 76], beige: [201, 184, 150], "gray-light": [196, 198, 200], "white-ish": [238, 238, 234], blue: [40, 70, 120] };

/** Dibuja la escena (por defecto 1600 x 1200; 1200 x 1600 si `portrait`). Reproducible por `seed`. */
export function renderScene(spec: SceneSpec, seed = 1, size: { W: number; H: number } = { W: 1600, H: 1200 }): SceneRender {
  let { W, H } = size;
  if (spec.portrait) [W, H] = [H, W];
  const r = rng(seed * 7919 + 13);
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  const bgc = DESKS[spec.bg];
  ctx.fillStyle = `rgb(${bgc})`;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i += 1) {
    const d = (r() - 0.5) * 26;
    ctx.fillStyle = `rgba(${bgc[0] + d},${bgc[1] + d},${bgc[2] + d},0.5)`;
    ctx.fillRect(r() * W, r() * H, 6 + r() * 120, 1 + r() * 2);
  }
  const p = spec.paper;
  const phpx = p.ph * H;
  const pwpx = p.pw ? p.pw * W : phpx * (p.asp ?? 0.707);
  const q = quadOf({ cx: p.cx * W, cy: p.cy * H, pw: pwpx, ph: phpx, rot: p.rot ?? 0, persp: p.persp ?? 0 });
  const path = (quad: Pt[]): void => {
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(quad[i][0], quad[i][1]);
    ctx.closePath();
  };
  if (spec.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetX = 14;
    ctx.shadowOffsetY = 18;
    ctx.fillStyle = "#000";
    path(q);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  path(q);
  ctx.clip();
  ctx.fillStyle = spec.paperColor ?? "#f7f7f5";
  ctx.fillRect(0, 0, W, H);
  if (spec.gradient) {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, "rgba(0,0,0,0.38)");
    g.addColorStop(1, "rgba(255,255,255,0.05)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
  const ox = q[0][0];
  const oy = q[0][1];
  const ux = q[1][0] - q[0][0];
  const uy = q[1][1] - q[0][1];
  const vx = q[3][0] - q[0][0];
  const vy = q[3][1] - q[0][1];
  const pwid = Math.hypot(ux, uy);
  const phei = Math.hypot(vx, vy);
  ctx.save();
  path(q);
  ctx.clip();
  ctx.setTransform(ux / pwid, uy / pwid, vx / phei, vy / phei, ox, oy);
  const PW = pwid;
  const PH = phei;
  if (spec.header) {
    const hh = PH * (spec.headerH ?? 0.14);
    const g = ctx.createLinearGradient(0, 0, PW, 0);
    g.addColorStop(0, spec.header);
    g.addColorStop(1, spec.header2 ?? spec.header);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, PW, hh);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(hh * 0.5)}px sans-serif`;
    ctx.fillText("MEMBRETE EMPRESA", PW * 0.08, hh * 0.65);
  }
  if (spec.innerFrame) {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(4, PW * 0.008);
    ctx.strokeRect(PW * 0.05, PH * 0.04, PW * 0.9, PH * 0.92);
  }
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `${Math.round(PH * 0.024)}px sans-serif`;
  for (let l = 0; l < 26; l += 1) ctx.fillText(`Clausula ${l + 1}. El asegurado acepta las condiciones generales importe ${(l * 53 + seed * 211) % 977} USD referencia ${(seed * 37 + l * 19) % 9973}`, PW * 0.1, PH * (0.27 + l * 0.026));
  const m = PW * 0.045;
  const off = 0.035;
  for (const [u, v] of [[off, off], [1 - off, off], [off, 1 - off], [1 - off, 1 - off]]) {
    ctx.fillStyle = "#000";
    ctx.fillRect(PW * u - m / 2, PH * v - m / 2, m, m);
  }
  ctx.restore();
  if (spec.clutter) {
    ctx.fillStyle = "#223";
    ctx.beginPath();
    ctx.ellipse(W * 0.88, H * 0.2, 70, 40, 0.5, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#c33";
    ctx.fillRect(W * 0.04, H * 0.8, 150, 18);
    ctx.fillStyle = "#eee";
    ctx.fillRect(W * 0.86, H * 0.78, 90, 60);
  }
  const data = ctx.getImageData(0, 0, W, H);
  // El lienzo nativo (Skia) no lo ve el recolector de basura de V8: sin liberarlo ya, cientos de escenas sumaban GB de memoria residente.
  cv.width = 0;
  cv.height = 0;
  const norm = (pt: Pt) => ({ x: pt[0] / W, y: pt[1] / H });
  return {
    image: { data: new Uint8ClampedArray(data.data), width: W, height: H },
    quad: { topLeft: norm(q[0]), topRight: norm(q[1]), bottomRight: norm(q[2]), bottomLeft: norm(q[3]) },
    truth: q,
    width: W,
    height: H,
  };
}

export function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i += 1) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Interseccion de un poligono con un clip convexo (Sutherland-Hodgman). */
export function clipPoly(subject: Pt[], clipper: Pt[]): Pt[] {
  let a2 = 0;
  for (let i = 0; i < clipper.length; i += 1) {
    const [x1, y1] = clipper[i];
    const [x2, y2] = clipper[(i + 1) % clipper.length];
    a2 += x1 * y2 - x2 * y1;
  }
  const ccw = a2 > 0;
  let out = subject;
  for (let i = 0; i < clipper.length; i += 1) {
    const A = clipper[i];
    const B = clipper[(i + 1) % clipper.length];
    const inside = (P: Pt): boolean => {
      const c = (B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0]);
      return ccw ? c >= 0 : c <= 0;
    };
    const inter = (P: Pt, Q: Pt): Pt => {
      const a1 = B[1] - A[1];
      const b1 = A[0] - B[0];
      const c1 = a1 * A[0] + b1 * A[1];
      const a2b = Q[1] - P[1];
      const b2 = P[0] - Q[0];
      const c2 = a2b * P[0] + b2 * P[1];
      const d = a1 * b2 - a2b * b1;
      return [(b2 * c1 - b1 * c2) / d, (a1 * c2 - a2b * c1) / d];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j += 1) {
      const P = input[j];
      const Q = input[(j + 1) % input.length];
      if (inside(Q)) {
        if (!inside(P)) out.push(inter(P, Q));
        out.push(Q);
      } else if (inside(P)) out.push(inter(P, Q));
    }
    if (!out.length) break;
  }
  return out;
}

export const quadPoints = (q: QuadCorners): Pt[] => [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft].map((p) => [p.x, p.y] as Pt);

/** Fraccion del papel verdadero que queda dentro del recorte (coordenadas normalizadas). */
export function paperKept(truth: QuadCorners, crop: QuadCorners): number {
  const t = quadPoints(truth);
  const inter = clipPoly(t, quadPoints(crop));
  return inter.length ? polyArea(inter) / polyArea(t) : 0;
}

/** Fuzz reproducible: genera `count` escenas variadas (membretes, giros 0-30, mesas, sombras, tarjetas). */
export function fuzzSpecs(count: number, seed = 12345): Array<{ name: string; spec: SceneSpec }> {
  let s = seed;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)];
  const out: Array<{ name: string; spec: SceneSpec }> = [];
  for (let i = 0; i < count; i += 1) {
    const bg = pick<DeskName>(["wood-dark", "gray-dark", "beige", "gray-light"]);
    const rot = ((rnd() * 60 - 30) * Math.PI) / 180;
    const card = i % 10 === 9;
    const asp = card ? 1.586 : pick([0.707, 0.77, 0.707, 1.3]);
    const ph = card ? 0.42 + rnd() * 0.08 : asp > 1 ? 0.5 + rnd() * 0.12 : 0.66 + rnd() * 0.26;
    const header = !card && rnd() < 0.4 ? pick(["#1f4e8c", "#c0392b", "#222831", "#2e7d32", "#444b57", "#6b1f1f"]) : undefined;
    const cx = 0.42 + rnd() * 0.16;
    const cy = 0.42 + rnd() * 0.16;
    // La hoja entera cabe en la foto (con un margen de 1,5 %): se reduce hasta que su caja girada cabe.
    let fit = ph;
    for (let k = 0; k < 40; k += 1) {
      const w = fit * asp * 1200; // la escena horizontal mide 1600 x 1200 (la proporcion del papel se mide sobre el alto)
      const h = fit * 1200;
      const ex = (Math.abs(Math.cos(rot)) * w + Math.abs(Math.sin(rot)) * h) / 2 / 1600;
      const ey = (Math.abs(Math.sin(rot)) * w + Math.abs(Math.cos(rot)) * h) / 2 / 1200;
      if (cx - ex > 0.015 && cx + ex < 0.985 && cy - ey > 0.015 && cy + ey < 0.985) break;
      fit *= 0.95;
    }
    const spec: SceneSpec = {
      bg,
      shadow: rnd() < 0.8 ? 1 : 0,
      paper: { cx, cy, ph: fit, asp, rot },
      ...(header ? { header, header2: rnd() < 0.5 ? header : "#444b57", headerH: 0.05 + rnd() * 0.09 } : {}),
      ...(card ? { paperColor: pick(["#d8e4f0", "#e8d8c0", "#f2f2f2"]) } : {}),
      ...(rnd() < 0.15 ? { clutter: true } : {}),
      ...(rnd() < 0.2 ? { gradient: true } : {}),
    };
    out.push({ name: `fuzz-${i}${header ? "-hdr" : ""}${card ? "-card" : ""}`, spec });
  }
  return out;
}

/**
 * Fuzz de TARJETAS de identificacion (modo `id-card`): proporcion 1,586, cabecera oscura o de color a sangre arriba (como las
 * tarjetas reales), mesas de todo tipo incluida una azul, giros de 0 a 30 grados y sombra.
 */
export function fuzzCardSpecs(count: number, seed = 4321): Array<{ name: string; spec: SceneSpec }> {
  let s = seed;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)];
  const out: Array<{ name: string; spec: SceneSpec }> = [];
  for (let i = 0; i < count; i += 1) {
    const bg = pick<DeskName>(["wood-dark", "gray-dark", "beige", "gray-light", "blue"]);
    const rot = ((rnd() * 60 - 30) * Math.PI) / 180;
    const ph = 0.4 + rnd() * 0.12;
    const cx = 0.42 + rnd() * 0.16;
    const cy = 0.42 + rnd() * 0.16;
    let fit = ph;
    for (let k = 0; k < 40; k += 1) {
      const w = fit * 1.586 * 1200;
      const h = fit * 1200;
      const ex = (Math.abs(Math.cos(rot)) * w + Math.abs(Math.sin(rot)) * h) / 2 / 1600;
      const ey = (Math.abs(Math.sin(rot)) * w + Math.abs(Math.cos(rot)) * h) / 2 / 1200;
      if (cx - ex > 0.015 && cx + ex < 0.985 && cy - ey > 0.015 && cy + ey < 0.985) break;
      fit *= 0.95;
    }
    const header = rnd() < 0.65 ? pick(["#34495e", "#222831", "#1f4e8c", "#c0392b", "#2e7d32", "#111111", "#8a1c1c", "#5b2a86"]) : undefined;
    out.push({
      name: `card-${i}${header ? "-hdr" : ""}`,
      spec: {
        bg,
        shadow: rnd() < 0.8 ? 1 : 0,
        paper: { cx, cy, ph: fit, asp: 1.586, rot },
        paperColor: pick(["#d8e4f0", "#e8d8c0", "#f2f2f2", "#f7f7f5", "#e6efe0"]),
        ...(header ? { header, header2: header, headerH: 0.16 + rnd() * 0.18 } : {}),
      },
    });
  }
  return out;
}
