/**
 * Codificador BMP de 24 bits (sin compresion, sin paleta). Ningun navegador codifica BMP con `canvas.toBlob`, y el formato es
 * tan simple que escribirlo aqui sale mas barato que una dependencia.
 *
 * Disposicion: cabecera de archivo (14 B) + `BITMAPINFOHEADER` (40 B) + filas de abajo arriba, en orden BGR y rellenadas a
 * multiplos de 4 bytes. BMP de 24 bits no tiene transparencia: la imagen se aplana sobre `background` (el mismo color de fondo
 * que se usa para JPG), asi que el resultado nunca depende de lo que el visor haga con un canal alfa inexistente.
 */

export const BMP_HEADER_BYTES = 54;

/** Peso exacto de un BMP de 24 bits de `width` x `height`. */
export function bmpByteLength(width: number, height: number): number {
  const stride = Math.ceil((width * 3) / 4) * 4;
  return BMP_HEADER_BYTES + stride * height;
}

/** `#rgb` / `#rrggbb` a [r, g, b]; cualquier otra cosa es blanco. */
export function parseHexColor(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return [255, 255, 255];
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

/** `rgba` son los pixeles de `ImageData` (RGBA, fila a fila, de arriba abajo). */
export function encodeBmp(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, background = "#ffffff"): Uint8Array {
  if (!(width > 0 && height > 0) || rgba.length < width * height * 4) throw new RangeError("bmp: dimensiones o pixeles no validos");
  const [bgR, bgG, bgB] = parseHexColor(background);
  const stride = Math.ceil((width * 3) / 4) * 4;
  const total = BMP_HEADER_BYTES + stride * height;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // "B"
  out[1] = 0x4d; // "M"
  view.setUint32(2, total, true);
  view.setUint32(10, BMP_HEADER_BYTES, true); // donde empiezan los pixeles
  view.setUint32(14, 40, true); // tamano del BITMAPINFOHEADER
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positivo: filas de abajo arriba
  view.setUint16(26, 1, true); // planos
  view.setUint16(28, 24, true); // bits por pixel
  view.setUint32(34, stride * height, true);
  view.setInt32(38, 2835, true); // ~72 ppp
  view.setInt32(42, 2835, true);
  for (let y = 0; y < height; y += 1) {
    let src = y * width * 4;
    let dst = BMP_HEADER_BYTES + (height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const alpha = rgba[src + 3];
      if (alpha === 255) {
        out[dst] = rgba[src + 2];
        out[dst + 1] = rgba[src + 1];
        out[dst + 2] = rgba[src];
      } else {
        // Mezcla sobre el fondo: c = (pixel * a + fondo * (255 - a)) / 255.
        const inverse = 255 - alpha;
        out[dst] = Math.round((rgba[src + 2] * alpha + bgB * inverse) / 255);
        out[dst + 1] = Math.round((rgba[src + 1] * alpha + bgG * inverse) / 255);
        out[dst + 2] = Math.round((rgba[src] * alpha + bgR * inverse) / 255);
      }
      src += 4;
      dst += 3;
    }
  }
  return out;
}
