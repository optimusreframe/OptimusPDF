import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { downscaleRgba, type Rgba } from "@/lib/scan/pixels";

/**
 * Paginas SINTETICAS de texto (nunca datos reales) a distintas resoluciones y con desenfoque gaussiano, mas hojas en blanco
 * (digital, con degradado de luz, con numero de pagina, con sello), para medir «borrosa» y «en blanco» en la resolucion en la que
 * el motor mira (el original decodificado a 1280 px de lado largo).
 */

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
  g.font = `bold ${40 * K}px sans-serif`;
  g.fillText(`CONTRATO DE SERVICIOS ${seed}`, 90 * K, 120 * K);
  g.font = `${23 * K}px sans-serif`;
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
    x.font = "28px sans-serif";
    x.fillText("12", 1100, 1560);
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
