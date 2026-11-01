import path from "node:path";
import { GlobalFonts, createCanvas, type Canvas } from "@napi-rs/canvas";
import { downscaleRgba, type Rgba } from "@/lib/scan/pixels";

/**
 * Paginas SINTETICAS de texto (nunca datos reales) a distintas resoluciones y con desenfoque gaussiano, mas hojas en blanco
 * (digital, con degradado de luz, con numero de pagina, con sello), para medir «borrosa» y «en blanco» en la resolucion en la que
 * el motor mira (el original decodificado a 1280 px de lado largo).
 */

/**
 * Fuentes del propio repo (Liberation, public/fonts) registradas con un alias propio: `sans-serif`/`serif` dependen de lo que tenga
 * instalado el sistema (macOS, Docker, el runner) y el borde de «borrosa» cambia segun el trazo de la letra. Con estas, el texto del fixture
 * es identico en cualquier maquina.
 */
const FIXTURE_FONTS = path.join(process.cwd(), "public", "fonts");
for (const file of ["LiberationSans-Regular", "LiberationSans-Bold"]) GlobalFonts.registerFromPath(path.join(FIXTURE_FONTS, `${file}.ttf`), "FixtureSans");
for (const file of ["LiberationSerif-Regular", "LiberationSerif-Italic"]) GlobalFonts.registerFromPath(path.join(FIXTURE_FONTS, `${file}.ttf`), "FixtureSerif");

/** Texto a K x (1200 x 1600) px; `sigma` = desenfoque gaussiano en px de ESA imagen. */
export function textDocument(K: number, sigma: number, seed = 1): Canvas {
  const W = 1200 * K;
  const H = 1600 * K;
  const out = createCanvas(W, H);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const text = createCanvas(W, H);
  const g = text.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#111";
  g.font = `bold ${40 * K}px FixtureSans`;
  g.fillText(`CONTRATO DE SERVICIOS ${seed}`, 90 * K, 120 * K);
  g.font = `${23 * K}px FixtureSans`;
  for (let line = 0; line < 52; line += 1) g.fillText(`Clausula ${line + 1}: el asegurado acepta las condiciones generales y particulares ${(seed * 31 + line * 17) % 997} USD segun anexo`, 90 * K, (190 + line * 28) * K);
  if (sigma) ctx.filter = `blur(${sigma}px)`;
  ctx.drawImage(text, 0, 0);
  return out;
}

export type BlankKind = "digital" | "gradient" | "page-number" | "stamp";

/** Hoja en blanco 1200 x 1600. */
export function blankDocument(kind: BlankKind): Canvas {
  const c = createCanvas(1200, 1600);
  const x = c.getContext("2d");
  x.fillStyle = kind === "digital" ? "#ffffff" : "#f3f1ea";
  x.fillRect(0, 0, 1200, 1600);
  if (kind === "gradient") {
    const g = x.createLinearGradient(0, 0, 1200, 0);
    g.addColorStop(0, "rgba(0,0,0,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 1200, 1600);
  }
  if (kind === "page-number") {
    x.fillStyle = "#222";
    x.font = "32px FixtureSans";
    x.fillText("12", 580, 1500);
  }
  if (kind === "stamp") {
    x.fillStyle = "#335";
    x.beginPath();
    x.arc(900, 1300, 60, 0, 7);
    x.fill();
  }
  return c;
}

/** Lo que mira el motor: el original decodificado a <= 1280 px de lado largo. */
export function decodedLikeEngine(canvas: Canvas): Rgba {
  const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return downscaleRgba({ data: new Uint8ClampedArray(d.data), width: canvas.width, height: canvas.height }, 1280);
}

/** Paginas de contenido ESCASO (informe del verificador): nunca «en blanco». `sparse` = deben salir «casi vacias»; las demas, con contenido normal. */
export const SPARSE_PAGES: Record<string, { sparse: boolean; draw: (c: CanvasRenderingContext2D, W: number, H: number) => void }> = {
  "una linea arriba": { sparse: true, draw: (c, W, H) => { c.fillStyle = "#111"; c.font = `${H * 0.022}px FixtureSans`; c.fillText("Anexo 3 - Conforme del asegurado", W * 0.1, H * 0.1); } },
  "solo firma": { sparse: true, draw: (c, W, H) => { c.strokeStyle = "#0a1a6e"; c.lineWidth = W * 0.004; c.beginPath(); c.moveTo(W * 0.3, H * 0.78); for (let k = 1; k <= 14; k += 1) c.quadraticCurveTo(W * (0.3 + k * 0.012), H * (0.78 + (k % 2 ? -0.03 : 0.03)), W * (0.3 + k * 0.014), H * 0.78); c.stroke(); } },
  "logo": { sparse: true, draw: (c, W, H) => { c.fillStyle = "#c0392b"; c.fillRect(W * 0.08, H * 0.06, W * 0.14, H * 0.05); } },
  "numero de pagina": { sparse: true, draw: (c, W, H) => { c.fillStyle = "#222"; c.font = `${H * 0.02}px FixtureSans`; c.fillText("12", W * 0.49, H * 0.95); } },
  "sello": { sparse: true, draw: (c, W, H) => { c.strokeStyle = "#1d4fa8"; c.lineWidth = W * 0.008; c.beginPath(); c.arc(W * 0.75, H * 0.8, W * 0.09, 0, 7); c.stroke(); c.fillStyle = "#1d4fa8"; c.font = `bold ${W * 0.03}px FixtureSans`; c.fillText("PAGADO", W * 0.69, H * 0.805); } },
  "una palabra": { sparse: true, draw: (c, W, H) => { c.fillStyle = "#222"; c.font = `bold ${H * 0.04}px FixtureSans`; c.fillText("APROBADO", W * 0.35, H * 0.5); } },
  "iniciales": { sparse: true, draw: (c, W, H) => { c.fillStyle = "#1a1a6e"; c.font = `italic ${H * 0.03}px FixtureSerif`; c.fillText("J.R.", W * 0.8, H * 0.93); } },
  "notas a lapiz": { sparse: false, draw: (c, W, H) => { c.fillStyle = "#a8a8a8"; c.font = `${H * 0.02}px FixtureSans`; for (let l = 0; l < 6; l += 1) c.fillText(`nota a lapiz ${l + 1} revisar el importe pendiente`, W * 0.12, H * (0.3 + l * 0.04)); } },
  "tabla sin texto": { sparse: false, draw: (c, W, H) => { c.strokeStyle = "#444"; c.lineWidth = W * 0.0015; for (let k = 0; k < 8; k += 1) c.strokeRect(W * 0.1, H * (0.2 + k * 0.06), W * 0.8, H * 0.06); } },
  "degradado grande": { sparse: false, draw: (c, W, H) => { const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#ffffff"); g.addColorStop(1, "#8fa9c4"); c.fillStyle = g; c.fillRect(W * 0.1, H * 0.15, W * 0.8, H * 0.6); } },
};

/** Hoja de 1200 x 1600 con el dibujo dado sobre papel claro. */
export function sparsePage(draw: (c: CanvasRenderingContext2D, W: number, H: number) => void, W = 1200, H = 1600): Canvas {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, W, H);
  draw(ctx, W, H);
  return canvas;
}

/** Hojas VACIAS de verdad (informe del verificador): blanco puro, papel con ruido, degradado de sombra y texto del reverso casi invisible. */
export const EMPTY_PAGES: Record<string, (c: CanvasRenderingContext2D, W: number, H: number) => void> = {
  "blanco puro": () => {},
  "papel con ruido": (c, W, H) => { let s = 7; const r = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); for (let i = 0; i < 4000; i += 1) { const d = (r() - 0.5) * 10; c.fillStyle = `rgba(${235 + d},${233 + d},${226 + d},0.4)`; c.fillRect(r() * W, r() * H, 3, 3); } },
  "degradado de sombra": (c, W, H) => { const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, "rgba(0,0,0,0.22)"); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(0, 0, W, H); },
  "reverso transparentado": (c, W, H) => { c.fillStyle = "rgba(0,0,0,0.04)"; c.font = `${H * 0.02}px FixtureSans`; for (let l = 0; l < 30; l += 1) c.fillText("texto del reverso transparentado por el papel", W * 0.12, H * (0.1 + l * 0.027)); },
};
