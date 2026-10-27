import { sniffImageFormat } from "@/lib/image/inkDecode";

/**
 * Comprobacion ESTRUCTURAL de una foto, sin decodificarla: dice si el archivo es de verdad una imagen y si esta COMPLETA.
 *
 * Por que existe: un `.jpg` con basura, un `.png` que es texto o un JPEG cortado a medias (descarga interrumpida, tarjeta
 * danada) llegaban al PDF o lo abortaban entero sin decir cual de las fotos era. Los navegadores decodifican un JPEG
 * truncado «con lo que haya» (la parte de abajo sale gris) y `pdf-lib` incrusta los bytes sin mirarlos, asi que ni la
 * decodificacion ni la libreria lo detectan: la unica forma fiable es recorrer la estructura y comprobar que termina.
 *
 *   JPEG  recorre los segmentos hasta `SOS`, salta los datos entropicos (con `indexOf` nativo: rapido incluso con 12 MB) y
 *         exige llegar al marcador `EOI` (`FFD9`) de la imagen principal. Los datos que hay DESPUES (miniaturas MPF de
 *         iPhone, mapas de ganancia, bloques de Samsung) no importan.
 *   PNG   recorre los chunks (`IHDR` ... `IDAT` ... `IEND`) saltando por longitud.
 *   WebP  el tamano RIFF declarado no puede pasar del archivo.
 *   HEIC  solo la firma `ftyp`: si el navegador puede abrirlo lo decide la decodificacion.
 *
 * Puro y sincrono (se usa en el hilo principal con los bytes que ya se leyeron y en el worker de miniaturas).
 */

/**
 * Por que una foto no se puede usar. Esta funcion solo devuelve los cuatro primeros; `heic` (este navegador no abre HEIC) y
 * `unreadable` (estructura correcta pero el navegador no pudo decodificarla) los marca quien intenta decodificar.
 */
export type ImageProblem = "empty" | "notImage" | "truncated" | "corrupt" | "heic" | "unreadable";

export type IntegrityVerdict = { ok: true } | { ok: false; problem: ImageProblem };

const OK: IntegrityVerdict = { ok: true };
const bad = (problem: ImageProblem): IntegrityVerdict => ({ ok: false, problem });

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let index = start; index < end && index < bytes.length; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** Marcadores `SOFn` (cabecera de imagen), sin `DHT` (C4), `JPG` (C8) ni `DAC` (CC). */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function checkJpeg(bytes: Uint8Array): IntegrityVerdict {
  const length = bytes.length;
  let at = 2; // tras SOI (FFD8)
  let sawFrame = false;
  let sawScan = false;
  for (;;) {
    if (at >= length) return bad("truncated");
    if (bytes[at] !== 0xff) {
      // Relleno o basura entre segmentos: los navegadores lo toleran; se busca el siguiente marcador.
      const next = bytes.indexOf(0xff, at);
      if (next < 0) return bad("truncated");
      at = next;
    }
    while (at < length && bytes[at] === 0xff) at += 1; // bytes de relleno FF
    if (at >= length) return bad("truncated");
    const marker = bytes[at];
    at += 1;
    if (marker === 0xd9) return sawFrame && sawScan ? OK : bad("corrupt"); // EOI
    if (marker === 0x00) return bad("corrupt");
    // Sin longitud: TEM (01), RSTn (D0-D7) y un SOI (D8) anidado.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (at + 2 > length) return bad("truncated");
    const segment = (bytes[at] << 8) | bytes[at + 1];
    if (segment < 2) return bad("corrupt");
    if (at + segment > length) return bad("truncated");
    if (isFrameMarker(marker)) {
      // precision (1) alto (2) ancho (2)
      if (segment < 8) return bad("corrupt");
      const height = (bytes[at + 3] << 8) | bytes[at + 4];
      const width = (bytes[at + 5] << 8) | bytes[at + 6];
      if (width === 0 || height === 0) return bad("corrupt");
      sawFrame = true;
    }
    at += segment;
    if (marker !== 0xda) continue;
    // SOS: datos entropicos hasta el siguiente marcador real (FF00 = FF escapado, FFD0-D7 = reinicio, FFFF = relleno).
    sawScan = true;
    for (;;) {
      const ff = bytes.indexOf(0xff, at);
      if (ff < 0 || ff + 1 >= length) return bad("truncated");
      const next = bytes[ff + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        at = ff + 2;
        continue;
      }
      if (next === 0xff) {
        at = ff + 1;
        continue;
      }
      at = ff;
      break;
    }
  }
}

function checkPng(bytes: Uint8Array): IntegrityVerdict {
  const length = bytes.length;
  if (length < 33) return bad("truncated"); // firma (8) + chunk IHDR (25)
  let at = 8;
  let first = true;
  let sawData = false;
  while (at + 12 <= length) {
    const size = u32(bytes, at);
    const type = ascii(bytes, at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return bad("corrupt");
    if (first) {
      if (type !== "IHDR" || size !== 13) return bad("corrupt");
      if (u32(bytes, at + 8) === 0 || u32(bytes, at + 12) === 0) return bad("corrupt");
      first = false;
    }
    const next = at + 12 + size;
    if (next > length) return bad("truncated");
    if (type === "IDAT") sawData = true;
    if (type === "IEND") return sawData ? OK : bad("corrupt");
    at = next;
  }
  return bad("truncated");
}

function checkWebp(bytes: Uint8Array): IntegrityVerdict {
  if (bytes.length < 20) return bad("truncated");
  const declared = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
  if (declared < 12) return bad("corrupt");
  // El tamano RIFF cuenta desde el byte 8; un byte de relleno final de mas o de menos es normal.
  if (declared + 8 > bytes.length + 1) return bad("truncated");
  return OK;
}

/**
 * Veredicto estructural de los bytes de una foto. `ok` no garantiza que el navegador la pueda decodificar (eso se ve al
 * decodificar), pero `ok: false` si garantiza que NO hay que meterla en un PDF tal cual.
 */
export function checkImageBytes(bytes: Uint8Array): IntegrityVerdict {
  if (bytes.length === 0) return bad("empty");
  const format = sniffImageFormat(bytes);
  if (format === "jpeg") return checkJpeg(bytes);
  if (format === "png") return checkPng(bytes);
  if (format === "webp") return checkWebp(bytes);
  if (format === "heic") return OK;
  // Formatos que el navegador abre aunque esta herramienta no los ofrezca: AVIF, GIF y BMP.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 12))) return OK;
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === "GIF") return OK;
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return OK;
  return bad("notImage");
}
