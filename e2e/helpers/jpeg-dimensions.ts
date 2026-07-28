/**
 * Lee el ancho/alto de un JPEG a partir de su cabecera (marcador SOF),
 * sin decodificar la imagen entera. Suficiente para verificar que una
 * pagina rotada 90 grados produjo un JPEG con ancho/alto intercambiados,
 * sin anadir un decodificador JPEG completo como dependencia.
 */
export function readJpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("No es un JPEG valido (falta el marcador SOI 0xFFD8).");
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0..SOF15, excluyendo DHT(C4)/JPG(C8)/DAC(CC), que no son SOF real.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    const length = bytes.readUInt16BE(offset + 2);
    if (isSof) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  throw new Error("No se encontro un marcador SOF en el JPEG.");
}
