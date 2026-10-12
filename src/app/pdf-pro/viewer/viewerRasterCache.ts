/*
 * Cache LRU GLOBAL de las paginas ya dibujadas por el visor (Wave 7 · U3). Una sola para todo el visor:
 * 500 paginas no pueden acumular 500 bitmaps. Limita entradas Y bytes (PNG de cada pagina); la URL que
 * el DOM esta mostrando esta ANCLADA (`setPinned`) y nunca se expulsa ni se revoca: quitarsela a una
 * <img> viva la dejaria en blanco.
 */

export type ViewerRasterEntry = {
  url: string;
  /** Bytes del blob (lo que ocupa en memoria; el bitmap decodificado lo suelta el navegador). */
  bytes: number;
  width: number;
  height: number;
};

export type ViewerRasterCacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  /** Libera una URL de objeto (por defecto `URL.revokeObjectURL`). */
  revoke?: (url: string) => void;
};

export const VIEWER_CACHE_MAX_ENTRIES = 48;
export const VIEWER_CACHE_MAX_BYTES = 128 * 1024 * 1024;

function defaultRevoke(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

export class ViewerRasterCache {
  private readonly entries = new Map<string, ViewerRasterEntry>();
  private pinned: ReadonlySet<string> = new Set();
  /** URL expulsadas de la cache mientras seguian ancladas: se liberan al soltarlas. */
  private readonly orphans = new Set<string>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly revoke: (url: string) => void;

  constructor(options: ViewerRasterCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? VIEWER_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? VIEWER_CACHE_MAX_BYTES;
    this.revoke = options.revoke ?? defaultRevoke;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Devuelve la entrada y la marca como la mas reciente. */
  get(key: string): ViewerRasterEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /** Lee sin tocar el orden de uso. */
  peek(key: string): ViewerRasterEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: ViewerRasterEntry): void {
    const previous = this.entries.get(key);
    if (previous) this.drop(key, previous);
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    this.trim();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.drop(key, entry);
  }

  /** Sustituye el conjunto de URL que el DOM esta mostrando (ancladas) y ajusta los limites. */
  setPinned(urls: Iterable<string>): void {
    this.pinned = new Set(urls);
    for (const url of [...this.orphans]) {
      if (!this.pinned.has(url)) {
        this.orphans.delete(url);
        this.revoke(url);
      }
    }
    this.trim();
  }

  private drop(key: string, entry: ViewerRasterEntry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    if (this.pinned.has(entry.url)) this.orphans.add(entry.url);
    else this.revoke(entry.url);
  }

  private trim(): void {
    // Los mas antiguos primero; las ancladas se saltan y la ultima insertada nunca se expulsa.
    const newest = [...this.entries.keys()].pop();
    for (const [key, entry] of [...this.entries]) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
      if (key === newest || this.pinned.has(entry.url)) continue;
      this.drop(key, entry);
    }
  }

  /** Vacia la cache y libera TODAS las URL (el consumidor ya no existe). */
  clear(): void {
    for (const entry of this.entries.values()) this.revoke(entry.url);
    for (const url of this.orphans) this.revoke(url);
    this.entries.clear();
    this.orphans.clear();
    this.pinned = new Set();
    this.totalBytes = 0;
  }
}

/** La cache unica del visor. */
export const viewerRasterCache = new ViewerRasterCache();
