/**
 * Contrato de la herramienta «Extraer elementos» (F7, docs/PLAN-FIRMA-AGIL.md §9.5).
 *
 * Es el punto de encuentro entre los motores (imagenes incrustadas, anotaciones/OCG, clasificador, recorte manual) y la
 * interfaz: cada parte se construye contra ESTE archivo. Cambios solo aditivos.
 *
 * Todo es local: ningun motor hace llamadas de red. Los pixeles completos NO viajan en el resultado (memoria acotada): se
 * regeneran bajo demanda con `renderAsset` al descargar o guardar.
 */

export type AssetKind = "image" | "signature" | "initials" | "logo" | "stamp" | "watermark" | "drawing" | "photo";

export type AssetSource = "xobject" | "inline" | "mask" | "form" | "ink-annot" | "stamp-annot" | "sig-widget" | "ocg" | "text" | "vector" | "region";

/** Formatos en que se puede obtener un elemento. `jpg-original` = el stream JPEG del PDF sin recomprimir. */
export type AssetFormat = "png" | "jpg-original" | "jpg" | "svg" | "txt";

/** Rectangulo normalizado 0..1 sobre la pagina (origen arriba a la izquierda, igual que el resto del proyecto). */
export type NormRect = { x: number; y: number; width: number; height: number };

export type AssetOccurrence = { pageIndex: number; rect: NormRect };

export type ExtractedAsset = {
  /** Estable dentro de una extraccion (hash corto del contenido + origen). */
  id: string;
  kind: AssetKind;
  /** 0..1. Para `image` puro es la certeza de que es una imagen (alta); para firmas/sellos/logos, la del clasificador. */
  confidence: number;
  /** Motivos legibles («transparente», «cerca de “Signature”», «repetida en 5 paginas»). Se muestran en la interfaz. */
  reasons: string[];
  source: AssetSource;
  occurrences: AssetOccurrence[];
  /** `null` para elementos solo de texto/vectoriales sin pixeles propios. */
  pixel: { width: number; height: number; hasAlpha: boolean } | null;
  formats: AssetFormat[];
  /** Tamano aproximado del archivo en el formato por defecto (primer elemento de `formats`). */
  bytesEstimate: number;
  /** Miniatura de hasta 256 px (PNG, con alfa si lo tiene). */
  thumb: Blob | null;
  /** Dato interno del motor que lo encontro, necesario para `renderAsset` (opaco para la interfaz). */
  ref: AssetRef;
};

/** Referencia opaca: cada motor define la suya; la interfaz solo la devuelve a `renderAsset`. */
export type AssetRef =
  | { engine: "image"; objectId: string; pageIndex: number }
  | { engine: "annotation"; pageIndex: number; annotationIndex: number; annotationId?: string }
  | { engine: "ocg"; groupId: string }
  | { engine: "text"; text: string }
  | { engine: "vector"; pageIndex: number; rect: NormRect }
  | { engine: "region"; pageIndex: number; rect: NormRect };

export type ExtractWarningCode =
  | "scanned-page" // pagina que es una sola imagen: se ofrece recortar region
  | "too-many-pages" // se paso el tope de paginas: se uso un rango
  | "too-many-assets" // se alcanzo el tope de elementos
  | "too-many-annotations" // una pagina trae mas anotaciones de las que se revisan (`detail` = cuantas trae)
  | "image-too-large" // imagen > 50 MP: solo original o se omite
  | "decode-failed" // una imagen no se pudo decodificar
  | "digital-signature" // /Sig con /V: «firmado digitalmente» (no se verifica criptograficamente)
  | "encrypted"
  | "cancelled";

export type ExtractWarning = { code: ExtractWarningCode; pageIndex?: number; detail?: string };

export type ExtractProgress = { pageIndex: number; pageCount: number; assetsSoFar: number };

export type ExtractOptions = {
  /** Rango 0-based inclusivo de paginas; por defecto todas hasta `maxPages`. */
  pageRange?: { from: number; to: number };
  maxPages?: number; // 300
  maxAssets?: number; // 500
  signal?: AbortSignal;
  onProgress?: (progress: ExtractProgress) => void;
};

export type ExtractResult = {
  pageCount: number;
  assets: ExtractedAsset[];
  /** Paginas (0-based) cuyo contenido es una sola imagen (escaneadas). */
  scannedPages: number[];
  warnings: ExtractWarning[];
  /** `true` si se recorto por topes de paginas o elementos. */
  truncated: boolean;
};

export const EXTRACT_LIMITS = {
  maxPages: 300,
  maxAssets: 500,
  maxImageMegapixels: 50,
  thumbPx: 256,
  /** Anotaciones que se revisan por pagina (mas: aviso `too-many-annotations`). */
  maxAnnotationsPerPage: 300,
} as const;

/** Lo que un motor parcial devuelve al orquestador (`extractAssets`). */
export type PartialExtraction = { assets: ExtractedAsset[]; scannedPages?: number[]; warnings?: ExtractWarning[] };

/**
 * API publica del orquestador (`src/lib/pdf/extractAssets/index.ts`), contra la que se construye la interfaz.
 * La construyen: U7.1 (imagenes), U7.2 (anotaciones/OCG), U7.3 (clasificador + orquestador) y U7.4 (recorte manual).
 */
export interface ExtractAssetsApi {
  extractAssets(file: File | Uint8Array, options?: ExtractOptions): Promise<ExtractResult>;
  /** Bytes del elemento en el formato pedido (PNG con alfa por defecto). Regenera los pixeles bajo demanda. */
  renderAsset(file: File | Uint8Array, asset: ExtractedAsset, format?: AssetFormat): Promise<Blob>;
  /** Recorte manual: renderiza la zona a `dpi` (300-600), limpia el fondo con `inkExtract` y devuelve PNG transparente. */
  cropRegion(
    file: File | Uint8Array,
    pageIndex: number,
    rect: NormRect,
    options?: { dpi?: number; signal?: AbortSignal; cleanBackground?: boolean },
  ): Promise<{ png: Blob; width: number; height: number }>;
}
