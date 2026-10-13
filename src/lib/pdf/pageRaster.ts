import type { PDFPageProxy } from "pdfjs-dist";

/*
 * Render NITIDO de una pagina para verla en pantalla (W6-A).
 *
 * Antes la vista de Firmar pedia `renderPageToDataUrl(page, { maxWidth: 900 })`:
 * un JPEG 0,72 cuyo ancho real era el de la pagina a escala 1 (~595 px en un A4)
 * estirado por CSS a 640 px de maquetacion, y a 1920 px al hacer zoom. Aqui la
 * pagina se dibuja al TAMANO REAL en que se ve (`ancho mostrado x zoom x
 * devicePixelRatio`), sin perdida (PNG), con tope de memoria, y se puede repetir
 * al cambiar el zoom o el ancho. Funciones puras y una cache LRU con limite.
 */

/** Pixeles maximos por pagina (16 MP = 64 MB de RGBA). */
export const MAX_RASTER_PIXELS = 16_000_000;
/** Lado maximo del bitmap: los navegadores recortan o fallan por encima de 4096-16384. */
export const MAX_RASTER_SIDE = 4096;
/** Densidad maxima: por encima de 3 no se distingue y la memoria se dispara. */
export const MAX_PIXEL_RATIO = 3;
/** Un zoom se redondea hacia arriba a pasos de 0,25: el pellizco continuo no lanza un render por pixel. */
export const ZOOM_BUCKET = 0.25;

export type RasterRequest = {
  /** Ancho (px CSS) con que se maqueta la hoja, SIN contar el zoom. */
  cssWidth: number;
  zoom: number;
  /** `window.devicePixelRatio`. */
  pixelRatio: number;
  maxPixels?: number;
  maxSide?: number;
};

export type RasterPlan = {
  /** Escala de pdf.js (px de bitmap por punto PDF). */
  scale: number;
  /** Tamano del bitmap en px. */
  width: number;
  height: number;
  /** Densidad efectiva usada. */
  pixelRatio: number;
  /** `true` si un tope de memoria o de lado redujo el tamano pedido. */
  capped: boolean;
};

/** Zoom redondeado hacia arriba al paso de la cache. */
export function bucketZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 1) return 1;
  return Math.round(Math.ceil(zoom / ZOOM_BUCKET - 1e-9) * ZOOM_BUCKET * 1000) / 1000;
}

/** Tamano del bitmap para ver la pagina con nitidez, con los topes de memoria aplicados. */
export function planRaster(
  view: { width: number; height: number },
  request: RasterRequest,
): RasterPlan {
  const ratio = Math.min(
    MAX_PIXEL_RATIO,
    Math.max(1, Number.isFinite(request.pixelRatio) ? request.pixelRatio : 1),
  );
  const maxPixels = request.maxPixels ?? MAX_RASTER_PIXELS;
  const maxSide = request.maxSide ?? MAX_RASTER_SIDE;
  const width = Math.max(1, view.width);
  const height = Math.max(1, view.height);
  const cssWidth = Math.max(1, Number.isFinite(request.cssWidth) ? request.cssWidth : 640);
  let scale = (cssWidth * bucketZoom(request.zoom) * ratio) / width;
  let capped = false;

  const area = width * scale * (height * scale);
  if (area > maxPixels) {
    scale *= Math.sqrt(maxPixels / area);
    capped = true;
  }
  const side = Math.max(width, height) * scale;
  if (side > maxSide) {
    scale *= maxSide / side;
    capped = true;
  }
  // Nunca por debajo de 0,1: una pagina enorme (carteles) seguiria siendo un bitmap util.
  scale = Math.max(0.1, scale);
  return {
    scale,
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    pixelRatio: ratio,
    capped,
  };
}

/** El motor de render no esta disponible aqui (sin canvas o sin `render`): se usa el respaldo. */
export class RasterUnavailableError extends Error {
  constructor(message = "raster-unavailable") {
    super(message);
    this.name = "RasterUnavailableError";
  }
}

/** El render se cancelo (cambio de pagina, de zoom o desmontaje): no es un fallo. */
export class RasterCancelledError extends Error {
  constructor() {
    super("raster-cancelled");
    this.name = "RasterCancelledError";
  }
}

export function isRasterCancelled(error: unknown): boolean {
  return (
    error instanceof RasterCancelledError ||
    (error instanceof Error && error.name === "RenderingCancelledException")
  );
}

export type RasterResult = {
  blob: Blob;
  width: number;
  height: number;
};

export type RasterOptions = {
  signal?: AbortSignal;
  /** "print" avanza con microtareas y termina aunque la pestana no pinte; "display" usa requestAnimationFrame. */
  intent?: "display" | "print";
};

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new RasterUnavailableError("no-toBlob"));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new RasterUnavailableError("toBlob-null"));
    }, "image/png");
  });
}

/**
 * Dibuja la pagina segun `plan` en un canvas fuera de pantalla y lo devuelve como
 * PNG (sin perdida). Cancelable por `signal`. Lanza `RasterUnavailableError` si
 * no hay motor de render (la pagina no tiene `render`, no hay canvas 2D).
 */
export async function renderPageRaster(
  page: Pick<PDFPageProxy, "getViewport" | "render">,
  plan: RasterPlan,
  options: RasterOptions = {},
): Promise<RasterResult> {
  if (typeof page.render !== "function" || typeof document === "undefined") {
    throw new RasterUnavailableError();
  }
  if (options.signal?.aborted) throw new RasterCancelledError();

  const viewport = page.getViewport({ scale: plan.scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  // El contexto se crea AQUI, antes de `render`, y NO opaco (`alpha: true`, el valor por defecto, escrito para que no
  // se pierda). Si no existe, pdf.js crea el suyo con `{ alpha: false, willReadFrequently: true }` y, al ser un lienzo
  // opaco, Chromium en Linux (fontconfig de Ubuntu: `10-sub-pixel-rgb.conf`) y en Windows (ClearType) rasteriza el
  // texto con antialiasing LCD: el PNG sale con franjas de color (R, G y B desplazados un tercio de pixel) pegadas
  // para siempre al bitmap, que se vera igual en pantallas BGR, rotadas, con zoom por CSS, impresas o capturadas. Con
  // un lienzo no opaco el antialiasing es en escala de grises, identico en macOS, Linux y Windows (medido en Linux
  // con Docker: 0 pixeles distintos frente a la misma pagina con `alpha: true`; 23.767 con `alpha: false`).
  if (!canvas.getContext("2d", { alpha: true })) throw new RasterUnavailableError("no-2d-context");

  const task = page.render({
    canvas,
    viewport,
    intent: options.intent ?? "print",
  });
  const onAbort = () => task.cancel();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await task.promise;
    if (options.signal?.aborted) throw new RasterCancelledError();
    const blob = await canvasToBlob(canvas);
    if (options.signal?.aborted) throw new RasterCancelledError();
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Libera la memoria del bitmap en cuanto termina (los navegadores tardan en recoger canvas grandes).
    canvas.width = 0;
    canvas.height = 0;
  }
}

/* ------------------------------------------------------------------ *
 * Cache LRU con limite
 * ------------------------------------------------------------------ */

export type RasterEntry = {
  url: string;
  bytes: number;
  width: number;
  height: number;
};

export type RasterCacheOptions = {
  maxEntries?: number;
  maxBytes?: number;
  /** Libera una URL de objeto al expulsarla (por defecto `URL.revokeObjectURL`). */
  revoke?: (url: string) => void;
};

/**
 * Cache de bitmaps ya dibujados, por clave, con limite de entradas Y de bytes:
 * en un documento de 100+ paginas o con 10 documentos no crece sin fin. La URL
 * que se esta mostrando esta ANCLADA (`pin`) y no se expulsa nunca.
 */
export class RasterCache {
  private readonly entries = new Map<string, RasterEntry>();
  private pinned: string | null = null;
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly revoke: (url: string) => void;

  constructor(options: RasterCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 6;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.revoke =
      options.revoke ??
      ((url) => {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(url);
        }
      });
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

  /** Devuelve la entrada y la marca como la mas reciente. */
  get(key: string): RasterEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: RasterEntry): void {
    const previous = this.entries.get(key);
    if (previous) this.drop(key, previous);
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    this.trim();
  }

  /** Ancla la URL mostrada ahora (no se expulsa mientras siga anclada). */
  pin(url: string | null): void {
    this.pinned = url;
  }

  private drop(key: string, entry: RasterEntry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    if (entry.url !== this.pinned) this.revoke(entry.url);
  }

  private trim(): void {
    // Los mas antiguos primero; el ultimo insertado y la URL anclada se respetan.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
      if (entry.url === this.pinned) continue;
      if (this.entries.size === 1) return;
      this.drop(key, entry);
    }
  }

  /** Vacia la cache y libera todas las URL (tambien la anclada: el consumidor ya no existe). */
  clear(): void {
    for (const entry of this.entries.values()) this.revoke(entry.url);
    this.entries.clear();
    this.totalBytes = 0;
    this.pinned = null;
  }
}
