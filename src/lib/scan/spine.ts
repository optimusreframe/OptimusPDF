import { boxBlur, type Gray } from "@/lib/scan/pixels";

/**
 * Lomo de un libro abierto: en la hoja ya enderezada el lomo es la franja vertical mas oscura cerca del centro (la
 * costura y la sombra de la curvatura). Devuelve su posicion (0..1 del ancho) y la confianza; si no hay una franja
 * clara, el centro (0,5) con confianza 0.
 */

export type SpineReading = { position: number; confidence: number };

export function findSpine(gray: Gray): SpineReading {
  const { data, width, height } = gray;
  if (width < 32 || height < 32) return { position: 0.5, confidence: 0 };
  // Brillo medio por columna (ignorando el 8 % superior e inferior, donde cae la sombra del borde).
  const columns = new Float32Array(width);
  const y0 = Math.floor(height * 0.08);
  const y1 = Math.ceil(height * 0.92);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = y0; y < y1; y += 1) sum += data[y * width + x];
    columns[x] = sum / (y1 - y0);
  }
  const smooth = boxBlur(columns, width, 1, Math.max(2, Math.round(width * 0.012)));
  // Busca el minimo entre el 30 % y el 70 % del ancho.
  const from = Math.floor(width * 0.3);
  const to = Math.ceil(width * 0.7);
  let best = from;
  for (let x = from; x <= to; x += 1) if (smooth[x] < smooth[best]) best = x;
  // Contraste con las paginas: media de las franjas a 12-25 % del lomo, a cada lado.
  const side = (center: number, dir: 1 | -1) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.round(width * 0.12); k <= Math.round(width * 0.25); k += 1) {
      const x = center + dir * k;
      if (x >= 0 && x < width) {
        sum += smooth[x];
        count += 1;
      }
    }
    return count ? sum / count : smooth[center];
  };
  const pages = (side(best, 1) + side(best, -1)) / 2;
  const contrast = (pages - smooth[best]) / Math.max(1, pages);
  // Un minimo en el borde de la ventana no es un lomo.
  const interior = best > from + 2 && best < to - 2;
  const confidence = interior ? Math.max(0, Math.min(1, contrast / 0.25)) : 0;
  return confidence >= 0.4 ? { position: best / width, confidence } : { position: 0.5, confidence };
}
