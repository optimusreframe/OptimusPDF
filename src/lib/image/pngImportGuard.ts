import { pngCrc32 } from "@/lib/image/inkPng";

/**
 * Guarda de los PNG que entran por la IMPORTACION del respaldo (`lib/backup`). Los validadores del baul
 * (`signVault.ts`) solo miran cabecera, CRC del IHDR, dimensiones y el IEND final: un PNG con el IDAT corrupto, un APNG,
 * un `tEXt` de 100 KB o 4096x4096 que descomprime a 64 MB los pasa y falla (o gasta memoria) al pintarlo mucho despues.
 * Aqui se endurece SOLO ese camino (la subida local de una imagen ya pasa por su propio decodificador del navegador):
 *
 * 1. `inspectPngStructure` (sincrona, sin asignar nada grande): recorre TODOS los chunks y comprueba el CRC de cada uno,
 *    el orden (IHDR, [PLTE], IDAT contiguos, IEND al final y nada despues), las combinaciones validas de tipo de color y
 *    profundidad, rechaza APNG (`acTL`/`fcTL`/`fdAT`), chunks criticos desconocidos, texto (`tEXt`/`zTXt`/`iTXt`) de mas
 *    de 2 KB y metadatos auxiliares de mas de 64 KB en total, y limita pixeles (<= 16 MP) y memoria descomprimida.
 * 2. `verifyPngInflates` (asincrona): descomprime el IDAT en flujo (`DecompressionStream`, que tambien valida la cabecera
 *    zlib y el Adler-32), cuenta los bytes y corta en cuanto pasan de lo que declara el IHDR; exige que salgan EXACTAMENTE
 *    los esperados y que el filtro de cada fila sea 0..4.
 * 3. Si el navegador tiene `createImageBitmap`, decodifica de verdad (y descarta el resultado).
 *
 * Nunca lanza: devuelve un veredicto. Sin `DecompressionStream` (navegadores muy viejos) el paso 2 se omite y siguen
 * valiendo 1 y 3.
 */

/** Pixeles maximos de una imagen importada (4096x4096 = 16,8 MP queda fuera a proposito: es una bomba de 64 MB). */
export const IMPORT_MAX_PIXELS = 16_000_000;
/** Lado maximo (el mismo del baul, `MAX_VAULT_IMAGE_DIMENSION`). */
export const IMPORT_MAX_DIMENSION = 4096;
/** Bytes descomprimidos maximos que una imagen importada puede ocupar. */
export const IMPORT_MAX_RAW_BYTES = 64 * 1024 * 1024;
/** Un chunk de texto (`tEXt`, `zTXt`, `iTXt`) mayor que esto no es de una firma. */
export const IMPORT_MAX_TEXT_CHUNK_BYTES = 2048;
/** Suma de los chunks auxiliares (perfil de color, texto, fechas...) de una imagen. */
export const IMPORT_MAX_ANCILLARY_BYTES = 64 * 1024;

export type PngRejection =
  /** No es un PNG bien formado (cabecera, orden de chunks, CRC, IEND, combinacion de color). */
  | "malformed"
  | "animated"
  | "tooManyPixels"
  | "oversizedMetadata"
  /** Estructura correcta pero los datos de imagen no se descomprimen / no cuadran con el IHDR. */
  | "undecodable";

export type PngVerdict = { ok: true } | { ok: false; reason: PngRejection };

type Structure = {
  width: number;
  height: number;
  /** Longitud de cada fila de datos descomprimidos, filtro incluido (en orden de pase para Adam7). */
  rows: number[];
  rawBytes: number;
  idat: Uint8Array[];
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
/** [xInicial, yInicial, saltoX, saltoY] de los 7 pases de Adam7. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const VALID_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function fail(reason: PngRejection): { ok: false; reason: PngRejection } {
  return { ok: false, reason };
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function chunkType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Longitud de las filas (con su byte de filtro) para una imagen de `width` x `height`. */
function rowLengths(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number[] {
  const rowBytes = (pixels: number) => 1 + Math.ceil((pixels * bitsPerPixel) / 8);
  if (!interlaced) return Array.from({ length: height }, () => rowBytes(width));
  const rows: number[] = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    if (width <= x0 || height <= y0) continue;
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    for (let row = 0; row < passHeight; row += 1) rows.push(rowBytes(passWidth));
  }
  return rows;
}

/** Revisa la ESTRUCTURA del PNG sin descomprimir nada. */
export function inspectPngStructure(bytes: Uint8Array): ({ ok: true } & Structure) | { ok: false; reason: PngRejection } {
  if (!isUint8Array(bytes) || bytes.length < 8 + 25 + 12) return fail("malformed");
  for (let i = 0; i < SIGNATURE.length; i += 1) if (bytes[i] !== SIGNATURE[i]) return fail("malformed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let colorType = -1;
  let bitDepth = 0;
  let interlaced = false;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIend = false;
  let idatState: "before" | "inside" | "after" = "before";
  let ancillary = 0;
  const idat: Uint8Array[] = [];

  while (pos < bytes.length) {
    if (sawIend) return fail("malformed"); // bytes tras el IEND
    if (pos + 12 > bytes.length) return fail("malformed");
    const length = view.getUint32(pos);
    if (length > bytes.length - pos - 12) return fail("malformed");
    for (let i = 4; i < 8; i += 1) if (!isLetter(bytes[pos + i])) return fail("malformed");
    const type = chunkType(bytes, pos + 4);
    const dataStart = pos + 8;
    const crcAt = dataStart + length;
    if (pngCrc32(bytes.subarray(pos + 4, crcAt)) !== view.getUint32(crcAt)) return fail("malformed");

    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) return fail("malformed");
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (width < 1 || height < 1 || width > IMPORT_MAX_DIMENSION || height > IMPORT_MAX_DIMENSION) {
        return fail("malformed");
      }
      if (!(colorType in VALID_DEPTHS) || !VALID_DEPTHS[colorType].includes(bitDepth)) return fail("malformed");
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return fail("malformed");
      if (width * height > IMPORT_MAX_PIXELS) return fail("tooManyPixels");
      interlaced = interlace === 1;
      bitsPerPixel = CHANNELS[colorType] * bitDepth;
      sawIhdr = true;
    } else if (ANIMATION_CHUNKS.has(type)) {
      return fail("animated");
    } else if (type === "IHDR") {
      return fail("malformed");
    } else if (type === "IDAT") {
      if (idatState === "after") return fail("malformed"); // IDAT no contiguos
      idatState = "inside";
      idat.push(bytes.subarray(dataStart, crcAt));
    } else {
      if (idatState === "inside") idatState = "after";
      if (type === "IEND") {
        if (length !== 0 || idatState === "before") return fail("malformed");
        sawIend = true;
      } else if (type === "PLTE") {
        if (sawPlte || idat.length > 0) return fail("malformed"); // una sola, antes del IDAT
        if (colorType === 0 || colorType === 4) return fail("malformed");
        if (length === 0 || length % 3 !== 0 || length / 3 > 256) return fail("malformed");
        if (colorType === 3 && length / 3 > 2 ** bitDepth) return fail("malformed");
        sawPlte = true;
      } else if ((bytes[pos + 4] & 0x20) === 0) {
        // critico (primera letra mayuscula) y no reconocido
        return fail("malformed");
      } else {
        if (TEXT_CHUNKS.has(type) && length > IMPORT_MAX_TEXT_CHUNK_BYTES) return fail("oversizedMetadata");
        ancillary += length;
        if (ancillary > IMPORT_MAX_ANCILLARY_BYTES) return fail("oversizedMetadata");
      }
    }
    pos = crcAt + 4;
  }

  if (!sawIend || !sawIhdr || idat.length === 0) return fail("malformed");
  if (colorType === 3 && !sawPlte) return fail("malformed");

  const rows = rowLengths(width, height, bitsPerPixel, interlaced);
  const rawBytes = rows.reduce((sum, row) => sum + row, 0);
  if (rawBytes > IMPORT_MAX_RAW_BYTES) return fail("tooManyPixels");
  return { ok: true, width, height, rows, rawBytes, idat };
}

export function hasDecompressionStream(): boolean {
  return typeof DecompressionStream === "function" && typeof ReadableStream === "function";
}

/** Descomprime el IDAT en flujo y comprueba que cuadra con el IHDR. */
export async function verifyPngInflates(structure: Pick<Structure, "rows" | "rawBytes" | "idat">): Promise<boolean> {
  let compressedLength = 0;
  for (const part of structure.idat) compressedLength += part.length;
  const compressed = new Uint8Array(compressedLength);
  let offset = 0;
  for (const part of structure.idat) {
    compressed.set(part, offset);
    offset += part.length;
  }

  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Un zlib corrupto hace fallar tambien la escritura: se traga aqui y se juzga por la lectura.
  const writing = (async () => {
    try {
      await writer.write(compressed);
      await writer.close();
    } catch {
      // se detecta al leer
    }
  })();

  let total = 0;
  let row = 0;
  let rowPos = 0;
  let good = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > structure.rawBytes) {
        good = false;
        break;
      }
      let i = 0;
      while (i < value.length) {
        const length = structure.rows[row];
        if (rowPos === 0 && value[i] > 4) {
          good = false;
          break;
        }
        const take = Math.min(length - rowPos, value.length - i);
        rowPos += take;
        i += take;
        if (rowPos === length) {
          row += 1;
          rowPos = 0;
        }
      }
      if (!good) break;
    }
  } catch {
    good = false;
  }
  if (!good) {
    try {
      await reader.cancel();
    } catch {
      // ya cerrado
    }
  }
  await writing;
  return good && total === structure.rawBytes && row === structure.rows.length;
}

/** Decodificacion real del navegador (si la hay): un rechazo es una imagen que NO se podra pintar. */
async function browserDecodes(bytes: Uint8Array): Promise<boolean> {
  if (typeof createImageBitmap !== "function" || typeof Blob !== "function") return true;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
    bitmap.close?.();
    return true;
  } catch {
    return false;
  }
}

/** Veredicto completo para un PNG que viene de un paquete ajeno. */
export async function validatePngForImport(bytes: Uint8Array): Promise<PngVerdict> {
  try {
    const structure = inspectPngStructure(bytes);
    if (!structure.ok) return structure;
    if (hasDecompressionStream() && !(await verifyPngInflates(structure))) return fail("undecodable");
    if (!(await browserDecodes(bytes))) return fail("undecodable");
    return { ok: true };
  } catch {
    return fail("undecodable");
  }
}
