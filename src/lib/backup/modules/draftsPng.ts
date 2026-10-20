import { BIDI_CONTROLS, pngIhdrCrcValid, readPngSize } from "@/app/sign-pdf/signVault";
import { hasPngEnd } from "@/app/sign-pdf/signVaultFile";
import { base64ToBytes, bytesToBase64 } from "@/app/edit-pdf/editSession";

export { BIDI_CONTROLS };

/**
 * Ayudas de PNG del modulo «Borradores» (U4.6): los trazos de firma de un borrador viven en la base como
 * `data:image/png;base64,...`; en el paquete viajan como archivos `.png` (el indice no engorda ni mezcla datos binarios).
 */

const DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/;
/** Un `data:` mas largo que esto no cabe en `MAX_STROKE_BYTES` ni de lejos: ni se examina. */
const MAX_DATA_URL_CHARS = 2 * 1024 * 1024;

/**
 * Forma de un PNG de trazo: cabecera valida con CRC, IEND al final, dimensiones 1..`maxDimension` y tamano <= `maxBytes`.
 * Es la guarda barata y sincrona; la decodificacion real (IDAT, APNG, bombas) la hace `validateImage` en el plan.
 */
export function hasValidPngShape(
  bytes: Uint8Array,
  maxBytes: number,
  maxDimension: number,
): { width: number; height: number } | null {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
  const size = readPngSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > maxDimension || size.height > maxDimension) return null;
  return hasPngEnd(bytes) && pngIhdrCrcValid(bytes) ? size : null;
}

/** `data:image/png;base64,...` -> bytes del PNG, o `null` si no tiene EXACTAMENTE esa forma. */
export function pngBytesFromDataUrl(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_DATA_URL_CHARS) return null;
  const match = DATA_URL.exec(dataUrl);
  if (!match || match[1].length === 0 || match[1].length % 4 !== 0) return null;
  const bytes = base64ToBytes(match[1]);
  if (!bytes || bytes.byteLength === 0) return null;
  // Misma identidad que el original: si volver a codificar no da el mismo texto, no es canonico y no se exporta.
  return bytesToBase64(bytes) === match[1] ? bytes : null;
}

export function dataUrlFromPng(bytes: Uint8Array): string {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}
