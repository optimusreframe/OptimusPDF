import { loadPdf, sha256Hex } from "@/lib/pdf/core";
import type { NameLang } from "@/lib/pdf/signOutputNames";

/**
 * Registro de firmas APARTE (`registro-firmas.json`): el rastro opcional de
 * una ronda de firmas, SIEMPRE fuera del PDF. Por cada PDF firmado: su hash
 * SHA-256 (el del archivo tal como se entrega, asi que se puede volver a
 * calcular con cualquier herramienta y comparar), la fecha, los nombres de los
 * firmantes y el numero de paginas.
 *
 * Es informacion informal, NO una firma certificada: solo deja constancia de
 * quien firmo y cuando. Modulo sin DOM ni React; los nombres de archivo y la
 * nota son los del idioma activo (igual que `signOutputNames.ts`).
 */

export const SIGNING_RECORD_TYPE = "optimuspdf-signing-record";
export const SIGNING_RECORD_VERSION = 1;

/** Nombre del archivo: dentro del ZIP de varios documentos o suelto con un documento. */
const RECORD_FILENAME: Record<NameLang, string> = {
  es: "registro-firmas.json",
  en: "signing-record.json",
};

const RECORD_NOTE: Record<NameLang, string> = {
  es: "No es una firma certificada: solo registra quién firmó y cuándo. El hash SHA-256 es el del archivo PDF tal como se entregó, y se puede volver a calcular para comprobar que no cambió.",
  en: "This is not a certified signature: it only records who signed and when. The SHA-256 hash is that of the PDF file as delivered, and it can be recomputed to check the file did not change.",
};

export function signingRecordFilename(lang: NameLang): string {
  return RECORD_FILENAME[lang];
}

/** Una fila del registro: un PDF firmado. */
export type SigningRecordEntry = {
  /** Nombre del PDF (el de la entrada del ZIP o el de la descarga). */
  file: string;
  /** SHA-256 hexadecimal de los bytes del PDF entregado. */
  sha256: string;
  /** Fecha y hora de la firma (ISO 8601, UTC). */
  signedAt: string;
  /** Firmantes que aplican a ESE documento; vacio en «Solo yo». */
  signers: string[];
  /** Paginas del PDF entregado; `null` si no se pudieron contar. */
  pages: number | null;
};

export type SigningRecord = {
  type: typeof SIGNING_RECORD_TYPE;
  version: typeof SIGNING_RECORD_VERSION;
  generatedAt: string;
  hashAlgorithm: "SHA-256";
  note: string;
  documents: SigningRecordEntry[];
};

/** Paginas de un PDF ya generado; `null` si no se pueden contar (el registro no debe tumbar un documento bien firmado). */
async function countPages(bytes: Uint8Array): Promise<number | null> {
  try {
    return (await loadPdf(bytes, { ignoreEncryption: true })).getPageCount();
  } catch {
    return null;
  }
}

export type SigningRecordEntryInput = {
  file: string;
  bytes: Uint8Array;
  signerNames: readonly string[];
  /** Texto para un firmante sin nombre (el mismo que usa la pagina «Registro de firmas»). */
  noSignerName: string;
  now?: Date;
};

/** La fila de UN PDF firmado: hash y paginas del archivo exacto que se entrega. */
export async function buildSigningRecordEntry(
  input: SigningRecordEntryInput,
): Promise<SigningRecordEntry> {
  const [sha256, pages] = await Promise.all([
    sha256Hex(input.bytes),
    countPages(input.bytes),
  ]);
  return {
    file: input.file,
    sha256,
    signedAt: (input.now ?? new Date()).toISOString(),
    signers: input.signerNames.map((name) => name.trim() || input.noSignerName),
    pages,
  };
}

export function buildSigningRecord(
  documents: readonly SigningRecordEntry[],
  lang: NameLang,
  now: Date = new Date(),
): SigningRecord {
  return {
    type: SIGNING_RECORD_TYPE,
    version: SIGNING_RECORD_VERSION,
    generatedAt: now.toISOString(),
    hashAlgorithm: "SHA-256",
    note: RECORD_NOTE[lang],
    documents: [...documents],
  };
}

/** El JSON legible (sangrado) que se guarda en el ZIP o se descarga. */
export function serializeSigningRecord(record: SigningRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function signingRecordBlob(record: SigningRecord): Blob {
  return new Blob([serializeSigningRecord(record)], { type: "application/json" });
}
