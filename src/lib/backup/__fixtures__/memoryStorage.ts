/**
 * `Storage` en memoria para las pruebas del modulo «Ajustes» (entorno node, sin `window`). `failOn` hace que
 * `setItem` lance (cuota llena) cuando se escribe esa clave; `writes` registra TODA clave escrita (para comprobar que
 * nunca se escribe una clave fuera de la lista blanca).
 */
export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  readonly writes: string[] = [];
  failOn: string | null = null;
  failAfter: number | null = null;

  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failOn === key) throw new DOMException("cuota llena", "QuotaExceededError");
    if (this.failAfter !== null) {
      if (this.failAfter <= 0) throw new DOMException("cuota llena", "QuotaExceededError");
      this.failAfter -= 1;
    }
    this.writes.push(key);
    this.data.set(key, String(value));
  }
  keys(): string[] {
    return Array.from(this.data.keys()).sort();
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(Array.from(this.data.entries()).sort(([a], [b]) => a.localeCompare(b)));
  }
}
