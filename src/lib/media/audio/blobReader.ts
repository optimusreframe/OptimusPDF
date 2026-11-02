/**
 * Lectura de un `Blob` por trozos con una ventana pequena en memoria: los lectores de contenedores (MP4, WebM) piden
 * unos bytes sueltos y nunca cargan el archivo entero. Pensado para videos de cientos de MB.
 */
export class BlobReader {
  private windowStart = 0;
  private windowBytes = new Uint8Array(0);

  constructor(
    private readonly blob: Blob,
    private readonly windowSize = 256 * 1024,
  ) {}

  get size(): number {
    return this.blob.size;
  }

  /** `len` bytes desde `pos` (menos si el archivo acaba antes). El resultado es una VISTA: copiarlo si se guarda. */
  async bytes(pos: number, len: number): Promise<Uint8Array> {
    const end = Math.min(this.blob.size, pos + len);
    if (pos < 0 || pos >= end) return new Uint8Array(0);
    const wEnd = this.windowStart + this.windowBytes.length;
    if (pos >= this.windowStart && end <= wEnd) return this.windowBytes.subarray(pos - this.windowStart, end - this.windowStart);
    const readLen = Math.max(len, this.windowSize);
    const readEnd = Math.min(this.blob.size, pos + readLen);
    this.windowStart = pos;
    this.windowBytes = new Uint8Array(await this.blob.slice(pos, readEnd).arrayBuffer());
    return this.windowBytes.subarray(0, end - pos);
  }

  /** Lectura directa de un trozo grande (sin pasar por la ventana). Devuelve una copia propia. */
  async copy(pos: number, len: number): Promise<Uint8Array> {
    const end = Math.min(this.blob.size, pos + len);
    if (pos < 0 || pos >= end) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(pos, end).arrayBuffer());
  }
}
