/** Utilidades de las operaciones de documento de PDF Pro: bytes ⇄ `File`/`Blob` de los motores. */

export function asPdfFile(bytes: Uint8Array, name = "documento.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Dos arreglos de bytes con el mismo contenido (para detectar «sin cambios» tras un motor). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
