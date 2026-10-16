import { MINHASH_SIZE } from "../fingerprintCore";
import type { DocumentInput } from "../store";
import { FINGERPRINT_VERSION, type Fingerprint, type PageFingerprint } from "../types";

/** Huellas y entradas ARMADAS A MANO para las pruebas del almacén y de la (de)serialización (sin pdf.js). */

const hex64 = (n: number) => n.toString(16).padStart(64, "0");

export function sampleMinhash(seed: number): number[] {
  return Array.from({ length: MINHASH_SIZE }, (_, i) => (seed * 7919 + i * 104729) >>> 0);
}

export function samplePage(seed: number): PageFingerprint {
  return { textHash: hex64(seed + 1), minhash: sampleMinhash(seed) };
}

export function sampleFingerprint(pages = 3, seed = 1, exact = hex64(seed * 99991)): Fingerprint {
  return {
    version: FINGERPRINT_VERSION,
    exact,
    pageCount: pages,
    pageSizes: Array.from({ length: pages }, () => ({ width: 612, height: 792 })),
    pages: Array.from({ length: pages }, (_, i) => samplePage(seed * 100 + i)),
  };
}

export function sampleInput(id: string, overrides: Partial<DocumentInput> = {}): DocumentInput {
  const fingerprint = overrides.fingerprint ?? sampleFingerprint(3, id.length + id.charCodeAt(id.length - 1));
  return {
    id,
    name: `Contrato ${id}`,
    docType: "contrato de servicio",
    fileName: `${id}.pdf`,
    pageCount: fingerprint.pageCount,
    pageSizes: fingerprint.pageSizes,
    fingerprint,
    templateIds: [],
    ...overrides,
  };
}

/** Bytes que parecen un PDF (el almacén no los interpreta). */
export function sampleBytes(length = 64, fill = 7): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n").subarray(0, length), 0);
  return bytes;
}
