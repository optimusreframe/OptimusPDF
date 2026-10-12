/**
 * Orientacion EXIF de un JPEG (Wave 7 · U8, ronda de correcciones): las fotos del movil se guardan con los pixeles
 * «de lado» y una etiqueta EXIF dice como girarlas. pdf-lib incrusta el JPEG tal cual, sin mirar la etiqueta, asi que
 * la imagen salia sin girar (y la pagina con la orientacion equivocada). Aqui se lee la etiqueta y se calcula la
 * matriz que la dibuja bien. Todo puro (sin canvas): se prueba en Node.
 *
 * Valores EXIF (de los pixeles guardados a la imagen que se ve):
 *  1 normal · 2 espejo horizontal · 3 giro 180° · 4 espejo vertical · 5 transpuesta · 6 giro 90° a la derecha ·
 *  7 transversa · 8 giro 90° a la izquierda.
 */

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Orientacion EXIF (1..8) de un JPEG, o 1 si no hay etiqueta o no es legible. Nunca lanza. */
export function readJpegOrientation(bytes: Uint8Array): ExifOrientation {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return 1;
      const marker = bytes[offset + 1];
      // Relleno 0xFF repetido.
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // SOI/EOI/RSTn/TEM no llevan longitud; SOS (0xDA) abre los datos de imagen: ya no hay mas cabeceras.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return 1;
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2) return 1;
      if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) {
        return readTiffOrientation(bytes, offset + 10, offset + 2 + length);
      }
      offset += 2 + length;
    }
  } catch {
    // Una etiqueta danada nunca impide crear el PDF: se trata como «sin orientacion».
  }
  return 1;
}

function isExifHeader(bytes: Uint8Array, at: number): boolean {
  return (
    bytes[at] === 0x45 && // E
    bytes[at + 1] === 0x78 && // x
    bytes[at + 2] === 0x69 && // i
    bytes[at + 3] === 0x66 && // f
    bytes[at + 4] === 0x00 &&
    bytes[at + 5] === 0x00
  );
}

function readTiffOrientation(bytes: Uint8Array, tiff: number, end: number): ExifOrientation {
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const u16 = (at: number) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = (at: number) =>
    little
      ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
      : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      // Tipo SHORT (3): el valor va en los dos primeros bytes del campo de valor.
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1;
    }
  }
  return 1;
}

/** Las orientaciones 5..8 intercambian ancho y alto de la imagen que se ve. */
export function orientationSwapsSides(orientation: ExifOrientation): boolean {
  return orientation >= 5;
}

/** Tamano de la imagen YA girada para una imagen guardada de `width` x `height` pixeles. */
export function orientedSize(width: number, height: number, orientation: ExifOrientation): { width: number; height: number } {
  return orientationSwapsSides(orientation) ? { width: height, height: width } : { width, height };
}

/** Matriz PDF `[a b c d e f]`. */
export type PdfMatrix = readonly [number, number, number, number, number, number];

/**
 * Matriz que dibuja la imagen (cuadrado unidad del XObject, pixeles guardados `width` x `height`) con su orientacion
 * aplicada dentro del rectangulo `x, y, boxWidth, boxHeight` (que es del tamano de la imagen YA girada).
 */
export function orientationMatrix(
  orientation: ExifOrientation,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
): PdfMatrix {
  const display = orientedSize(width, height, orientation);
  /** Pixel guardado (x hacia la derecha, y hacia abajo) -> pixel de la imagen que se ve. */
  const toDisplay = (px: number, py: number): [number, number] => {
    switch (orientation) {
      case 2:
        return [width - px, py];
      case 3:
        return [width - px, height - py];
      case 4:
        return [px, height - py];
      case 5:
        return [py, px];
      case 6:
        return [height - py, px];
      case 7:
        return [height - py, width - px];
      case 8:
        return [py, width - px];
      default:
        return [px, py];
    }
  };
  /** Punto (s, t) del cuadrado unidad del XObject (t hacia arriba) -> coordenadas de la pagina. */
  const toPage = (s: number, t: number): [number, number] => {
    const [u, v] = toDisplay(s * width, (1 - t) * height);
    return [box.x + (u / display.width) * box.width, box.y + box.height - (v / display.height) * box.height];
  };
  const [e, f] = toPage(0, 0);
  const [x1, y1] = toPage(1, 0);
  const [x2, y2] = toPage(0, 1);
  return [x1 - e, y1 - f, x2 - e, y2 - f, e, f];
}
