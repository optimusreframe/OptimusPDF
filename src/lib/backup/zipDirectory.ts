import { PACKAGE_LIMITS, PackageError } from "@/lib/backup/types";

/**
 * Lector minimo del DIRECTORIO CENTRAL de un zip, propio y estricto. Sirve
 * para decidir si un zip ajeno es seguro de abrir ANTES de inflar un solo
 * byte: numero de entradas, tamaños descomprimidos declarados, relacion de
 * compresion y rutas salen de aqui, no de JSZip (que ademas se contrasta
 * despues: si JSZip ve otra cosa que este lector, el zip se rechaza).
 *
 * No soporta ZIP64, varios discos ni cifrado de zip: nada de eso lo produce
 * este modulo ni cabe en los topes de un respaldo (250 MB). Lanza siempre
 * `PackageError`; nunca devuelve datos a medias.
 */

export type ZipDirectoryEntry = {
  name: string;
  isDir: boolean;
  /** 0 = almacenado, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const EOCD_MIN = 22;
const CENTRAL_MIN = 46;
const MAX_COMMENT = 0xffff;
const MAX_NAME_BYTES = PACKAGE_LIMITS.maxPathLength;

/** Caracteres de control (C0, DEL, C1) en una ruta. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** Marcas de direccion Unicode (sin `g`: `test` con `g` guarda estado). */
const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;

/**
 * Una ruta es SEGURA si no puede escapar de donde se descomprima ni
 * disfrazar su nombre: sin barras invertidas, sin `/` inicial, sin letra de
 * unidad, sin segmentos vacios / `.` / `..`, sin caracteres de control ni
 * marcas bidireccionales. Una ruta segura todavia puede ser DESCONOCIDA
 * (se ignora); una insegura rechaza todo el paquete.
 */
export function isSafeEntryPath(name: string): boolean {
  if (name.length === 0 || name.length > PACKAGE_LIMITS.maxPathLength) return false;
  if (CONTROL_CHARS.test(name) || BIDI_MARKS.test(name)) return false;
  // `/abs` queda fuera por el segmento vacio de despues; `C:` por la letra de unidad.
  if (name.includes("\\") || /^[A-Za-z]:/.test(name)) return false;
  const body = name.endsWith("/") ? name.slice(0, -1) : name;
  if (body.length === 0) return false;
  return body.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  try {
    if (utf8) return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackageError("unsafePath");
  }
  // Sin la bandera UTF-8: solo ASCII imprimible es inequivoco; cualquier otro
  // byte se interpreta como Latin-1 (igual que hace JSZip) y la contrastacion
  // posterior con JSZip decide si coincide.
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * Lee y valida el directorio central. `bytes` es el zip completo.
 * Comprueba, en este orden y sin inflar nada: forma del EOCD, numero de
 * entradas, limites de cada registro, rutas seguras, duplicados, metodo de
 * compresion, tamaños declarados, suma descomprimida y relacion de
 * compresion (por entrada y global).
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectoryEntry[] {
  const length = bytes.byteLength;
  if (length < EOCD_MIN) throw new PackageError("badZip");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD: la ULTIMA firma del final (igual que JSZip), con el comentario cabiendo.
  let eocd = -1;
  const lowest = Math.max(0, length - EOCD_MIN - MAX_COMMENT);
  for (let i = length - EOCD_MIN; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PackageError("badZip");

  const diskNumber = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new PackageError("badZip");
  }
  // 0xFFFF / 0xFFFFFFFF = ZIP64: no soportado (ni necesario).
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PackageError("badZip");
  }
  if (totalEntries === 0) throw new PackageError("badZip");
  if (totalEntries > PACKAGE_LIMITS.maxEntries) throw new PackageError("tooManyEntries");
  if (cdOffset + cdSize > eocd) throw new PackageError("badZip");

  const entries: ZipDirectoryEntry[] = [];
  const seen = new Set<string>();
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (let n = 0; n < totalEntries; n += 1) {
    if (pos + CENTRAL_MIN > cdEnd) throw new PackageError("badZip");
    if (view.getUint32(pos, true) !== SIG_CENTRAL) throw new PackageError("badZip");
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const next = pos + CENTRAL_MIN + nameLength + extraLength + commentLength;
    if (nameLength === 0 || nameLength > MAX_NAME_BYTES || next > cdEnd) {
      throw new PackageError(nameLength > MAX_NAME_BYTES ? "unsafePath" : "badZip");
    }
    // Bit 0 = cifrado de zip (ZipCrypto/AES); sin soporte.
    if ((flags & 0x1) !== 0) throw new PackageError("badZip");
    if (method !== 0 && method !== 8) throw new PackageError("badZip");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new PackageError("badZip");
    }

    const name = decodeName(
      bytes.subarray(pos + CENTRAL_MIN, pos + CENTRAL_MIN + nameLength),
      (flags & 0x800) !== 0,
    );
    if (!isSafeEntryPath(name)) throw new PackageError("unsafePath");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new PackageError("duplicateEntry");
    seen.add(key);

    const isDir = name.endsWith("/");
    if (isDir && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new PackageError("badZip");
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new PackageError("bomb");
    }
    // Datos declarados sin bytes comprimidos: imposible (ni el deflate vacio mide 0).
    if (method === 8 && uncompressedSize > 0 && compressedSize === 0) {
      throw new PackageError("bomb");
    }
    // Deflate nunca engorda mas que unos bytes por bloque: un comprimido MUY
    // mayor que lo que declara descomprimir es un directorio central que
    // miente para que se infle mucho mas de lo que dice (la lectura se corta
    // al pasar de lo declarado, pero cada trozo de entrada puede inflar ~16 MB).
    if (
      method === 8 &&
      compressedSize > uncompressedSize + (uncompressedSize >>> 8) + 64
    ) {
      throw new PackageError("bomb");
    }
    if (
      uncompressedSize > PACKAGE_LIMITS.ratioFloorBytes &&
      uncompressedSize / compressedSize > PACKAGE_LIMITS.maxRatio
    ) {
      throw new PackageError("bomb");
    }
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    if (totalUncompressed > PACKAGE_LIMITS.maxUncompressedBytes) {
      throw new PackageError("tooLarge");
    }

    entries.push({ name, isDir, method, compressedSize, uncompressedSize });
    pos = next;
  }

  if (
    totalUncompressed > PACKAGE_LIMITS.ratioFloorBytes &&
    totalUncompressed / Math.max(1, totalCompressed) > PACKAGE_LIMITS.maxRatio
  ) {
    throw new PackageError("bomb");
  }
  return entries;
}
