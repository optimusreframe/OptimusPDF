/**
 * Imagenes sinteticas para las PRUEBAS de Vitest (Node): JPEG validos y pequenos generados con `@napi-rs/canvas`. Nada de fotos
 * ni PDFs reales. Solo lo importan pruebas.
 */
import { createCanvas } from "@napi-rs/canvas";

export function tinyJpegBytes(width = 64, height = 80, seed = 1): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#222222";
  for (let line = 0; line < 6; line += 1) ctx.fillRect(6, 8 + line * 11, 20 + ((seed * 7 + line * 13) % 30), 4);
  return new Uint8Array(canvas.toBuffer("image/jpeg", 70));
}

export function tinyJpegFile(name: string, width = 64, height = 80, seed = 1): File {
  return new File([tinyJpegBytes(width, height, seed) as BlobPart], name, { type: "image/jpeg" });
}
