/** Utilidades de las operaciones de documento de PDF Pro: bytes ⇄ `File`/`Blob` de los motores. */

export function asPdfFile(bytes: Uint8Array, name = "documento.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/**
 * Un `File` de SOLO LECTURA que sirve los bytes del snapshot SIN copiarlos (Wave 9 · memoria). `asPdfFile` mete los bytes
 * en un `File` real: con un PDF de 100 MB son 100 MB copiados al almacen de blobs del navegador (decenas de ms en el
 * hilo principal) y otros 100 MB cuando el motor llama a `arrayBuffer()`. Los motores de marca de agua, numeracion,
 * encabezado y pie, recorte y giro SOLO leen el archivo con `loadPdf` (→ `readFileBytes` → `arrayBuffer()`); a ellos se
 * les da este `File`, cuyo `arrayBuffer()` devuelve el buffer del propio snapshot (o la copia exacta de su tramo si los
 * bytes son una vista de un buffer mayor).
 *
 * NO usar con un motor que mande el archivo a otro sitio (un worker, `FormData`, `URL.createObjectURL`, pdf.js): el
 * `File` real que hay por debajo esta vacio, y transferir ese buffer dejaria el snapshot inutilizable. `size`, `slice`,
 * `stream` y `text` dicen la verdad, pero lo que reciba un API nativo (no una llamada de JavaScript) vera un archivo vacio.
 */
class BytesBackedFile extends File {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array, name: string) {
    super([], name, { type: "application/pdf" });
    this.#bytes = bytes;
    Object.defineProperty(this, "size", { value: bytes.byteLength, enumerable: true });
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    const { buffer, byteOffset, byteLength } = this.#bytes;
    if (byteOffset === 0 && byteLength === buffer.byteLength) return Promise.resolve(buffer as ArrayBuffer);
    return Promise.resolve((buffer as ArrayBuffer).slice(byteOffset, byteOffset + byteLength));
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    return new Blob([this.#bytes.subarray(start ?? 0, end ?? this.#bytes.byteLength) as unknown as BlobPart], {
      type: contentType ?? this.type,
    });
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new Blob([this.#bytes as unknown as BlobPart]).stream();
  }

  override text(): Promise<string> {
    return new Blob([this.#bytes as unknown as BlobPart]).text();
  }
}

export function asEngineFile(bytes: Uint8Array, name = "documento.pdf"): File {
  return new BytesBackedFile(bytes, name);
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
