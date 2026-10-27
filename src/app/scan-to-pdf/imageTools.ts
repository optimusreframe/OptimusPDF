/*
 * Utilidades de imagen de la interfaz del Escaner (solo navegador, sin red): componer la hoja de una identificacion
 * (anverso + reverso), partir la foto de un libro abierto y medir una foto. Todo con canvas; donde no hay canvas (jsdom) cada
 * funcion degrada de forma segura (devuelve el original) para que la logica de la interfaz se pueda probar sin pixeles.
 */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function newCanvas(width: number, height: number): AnyCanvas | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  try {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      return canvas;
    }
  } catch {
    return null;
  }
  return null;
}

async function toBlob(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob"))), type, quality);
  });
}

async function decode(blob: Blob): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Hoja A4 a 150 ppp con la identificacion de frente arriba y la de reverso debajo, centradas. Sin canvas: devuelve el anverso. */
export async function composeIdSheet(front: Blob, back: Blob): Promise<Blob> {
  const [a, b] = await Promise.all([decode(front), decode(back)]);
  const sheet = newCanvas(1240, 1754);
  const ctx = sheet?.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;
  if (!a || !b || !sheet || !ctx) {
    a?.close?.();
    b?.close?.();
    return front;
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  const slotW = 1000;
  const slotH = 720;
  const gap = 90;
  const total = slotH * 2 + gap;
  const top = (sheet.height - total) / 2;
  [a, b].forEach((bitmap, index) => {
    const scale = Math.min(slotW / bitmap.width, slotH / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    const x = (sheet.width - w) / 2;
    const y = top + index * (slotH + gap) + (slotH - h) / 2;
    ctx.drawImage(bitmap, x, y, w, h);
    ctx.strokeStyle = "#c8c8c8";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  });
  a.close?.();
  b.close?.();
  return toBlob(sheet, "image/jpeg", 0.92);
}

/** Parte una foto de libro abierto en dos mitades por el centro (la izquierda primero). Sin canvas: `null`. */
export async function splitSpreadFallback(source: Blob): Promise<[Blob, Blob] | null> {
  const bitmap = await decode(source);
  if (!bitmap) return null;
  const half = Math.floor(bitmap.width / 2);
  const parts: Blob[] = [];
  for (const [sx, sw] of [
    [0, half],
    [half, bitmap.width - half],
  ] as const) {
    const canvas = newCanvas(sw, bitmap.height);
    const ctx = canvas?.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null | undefined;
    if (!canvas || !ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, sx, 0, sw, bitmap.height, 0, 0, sw, bitmap.height);
    parts.push(await toBlob(canvas, "image/jpeg", 0.92));
  }
  bitmap.close?.();
  return [parts[0], parts[1]];
}
