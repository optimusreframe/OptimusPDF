/**
 * Imagenes de firma SINTETICAS para los E2E de «Subir firma o iniciales» (F6 · U6.2): un garabato azul oscuro sobre papel
 * blanco, con sombra, como PNG con fondo opaco, como JPG (con artefactos de compresion) y como SVG. Se generan aqui, en
 * Node, con `@napi-rs/canvas`: ningun dato real y los mismos bytes en cada ejecucion. Solo para pruebas.
 */
import { createCanvas } from "@napi-rs/canvas";

export type SyntheticImage = { name: string; mimeType: string; buffer: Buffer };

const WIDTH = 900;
const HEIGHT = 360;
/** Azul de tinta de las imagenes (el que «Original» conserva). */
export const INK_RGB = { r: 20, g: 48, b: 138 };

function scribble(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, scale = 1): void {
  context.strokeStyle = `rgb(${INK_RGB.r},${INK_RGB.g},${INK_RGB.b})`;
  context.lineWidth = 7 * scale;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(110 * scale, 230 * scale);
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60;
    const x = (110 + t * 680) * scale;
    const y = (200 + Math.sin(t * Math.PI * 7) * 70 * (1 - t * 0.4) - t * 40) * scale;
    context.lineTo(x, y);
  }
  context.stroke();
  context.beginPath();
  context.moveTo(120 * scale, 285 * scale);
  context.lineTo(780 * scale, 270 * scale);
  context.stroke();
}

type Variant = "white" | "shadow";

function paper(variant: Variant) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  if (variant === "shadow") {
    // Sombra de la mano / del movil sobre el papel: degradado suave de izquierda a derecha.
    const gradient = context.createLinearGradient(0, 0, WIDTH, 0);
    gradient.addColorStop(0, "rgba(90,90,90,0.55)");
    gradient.addColorStop(0.55, "rgba(90,90,90,0.18)");
    gradient.addColorStop(1, "rgba(90,90,90,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, WIDTH, HEIGHT);
  }
  scribble(context);
  return canvas;
}

export function jpgSignature(variant: Variant, name = `firma-${variant}.jpg`): SyntheticImage {
  return { name, mimeType: "image/jpeg", buffer: paper(variant).toBuffer("image/jpeg", 62) };
}

export function pngSignature(name = "firma.png"): SyntheticImage {
  return { name, mimeType: "image/png", buffer: paper("white").toBuffer("image/png") };
}

export function svgSignature(name = "firma.svg"): SyntheticImage {
  const points: string[] = [];
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60;
    const x = (110 + t * 680) * (600 / WIDTH);
    const y = (200 + Math.sin(t * Math.PI * 7) * 70 * (1 - t * 0.4) - t * 40) * (240 / HEIGHT);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240">` +
    `<rect width="600" height="240" fill="#ffffff"/>` +
    `<polyline points="${points.join(" ")}" fill="none" stroke="rgb(${INK_RGB.r},${INK_RGB.g},${INK_RGB.b})" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;
  return { name, mimeType: "image/svg+xml", buffer: Buffer.from(svg) };
}

/** Una hoja EN BLANCO (sin tinta): debe rechazarse con «No se encontró tinta». */
export function blankPaper(name = "blanco.png"): SyntheticImage {
  const canvas = createCanvas(400, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 400, 200);
  return { name, mimeType: "image/png", buffer: canvas.toBuffer("image/png") };
}

/** Una «foto» grande (5,2 MP) con sombra: obliga al motor a usar su Web Worker y a repartir el trabajo en trozos. */
export function jpgLargePhoto(name = "foto-grande.jpg"): SyntheticImage {
  const scale = 4;
  const canvas = createCanvas(WIDTH * scale, HEIGHT * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, "rgba(90,90,90,0.5)");
  gradient.addColorStop(1, "rgba(90,90,90,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  scribble(context, scale);
  return { name, mimeType: "image/jpeg", buffer: canvas.toBuffer("image/jpeg", 70) };
}

/** Un archivo que dice ser JPG y pesa mas de 10 MB (el tope de entrada). */
export function oversizedJpg(name = "enorme.jpg"): SyntheticImage {
  const buffer = Buffer.alloc(11 * 1024 * 1024, 0x41);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buffer, 0);
  return { name, mimeType: "image/jpeg", buffer };
}
