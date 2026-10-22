/**
 * Tipos y constantes del motor de anotaciones, sellos, firmas `/Sig`, marcas de agua y capas opcionales de «Extraer
 * elementos» (U7.2, docs/PLAN-FIRMA-AGIL.md §9.5). El contrato con la interfaz y el orquestador es `types.ts`; esto es lo
 * propio de este motor (contexto de ejecucion, raster, referencias internas).
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { AssetRef, ExtractOptions, ExtractedAsset } from "./types";

/** Subconjunto de `OPS` de pdf.js que usa el recorrido de operadores (se inyecta: en Node es el build «legacy»). */
export type PdfOps = Record<string, number>;

/** Pixeles RGBA de 8 bits con alfa recto (como `ImageData`). */
export type RasterImage = { width: number; height: number; data: Uint8ClampedArray };

/** Contexto 2D minimo que usan el motor y pdf.js (cubre `CanvasRenderingContext2D`, `OffscreenCanvasRenderingContext2D` y `@napi-rs/canvas`). */
export type Context2D = {
  canvas: unknown;
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number };
  putImageData(image: unknown, x: number, y: number): void;
  [key: string]: unknown;
};

/** Superficie de dibujo. `release()` libera la memoria del bitmap (Safari limita los canvas vivos). */
export type Surface = {
  width: number;
  height: number;
  context: Context2D;
  release(): void;
};

export type SurfaceFactory = (width: number, height: number) => Surface;

/** Contexto que el orquestador pasa a `findAnnotationAssets` / `renderAnnotationAsset`. Todo es opcional salvo en Node. */
export type AnnotationContext = {
  /** Tabla `OPS` de pdf.js. Por defecto, la de `getPdfJs()` (navegador). En pruebas Node se pasa la del build legacy. */
  ops?: PdfOps;
  /** Bytes del PDF para leer con pdf-lib (`/V` de las firmas, anotaciones `/Watermark`, apariencias). Sin ellos esas lecturas se omiten. */
  bytes?: Uint8Array;
  /** Fabrica de superficies. Por defecto, canvas del navegador. */
  createSurface?: SurfaceFactory;
  /** Opciones del orquestador: rango de paginas, topes, cancelacion y progreso. */
  options?: ExtractOptions;
  /** Elementos que ya llevan otros motores (se usa para respetar `maxAssets` global). */
  assetsAlreadyFound?: number;
  /**
   * Lista de operadores de una pagina que el orquestador ya pidio a pdf.js (se reutiliza para no analizarla dos veces). Con
   * anotaciones activas o apagadas: este motor ignora lo que va entre `beginAnnotation` y `endAnnotation`. Sin ella se pide con
   * `page.getOperatorList({ annotationMode: 0 })`.
   */
  /** Plazo (ms) de cada paso de pdf.js por pagina; si se agota se avisa de esa pagina y se sigue con la siguiente. Por defecto 30 s. */
  stepTimeoutMs?: number;
  getOperatorList?: (page: PdfPage, pageIndex: number) => Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
};

/** Escala (px por punto) con la que se analiza una pagina al DETECTAR (miniaturas y limpieza). */
export const ANALYSIS_SCALE = 3;
/** Escala de los archivos que se regeneran bajo demanda: ~288 ppp. */
export const EXPORT_SCALE = 4;
/** Techo de pixeles de cualquier render intermedio (RGBA: 4 bytes por pixel). */
export const MAX_RENDER_PIXELS = 12_000_000;
/** Lado maximo de un render. */
export const MAX_RENDER_SIDE = 4096;

/** Banderas de anotacion que las hacen invisibles. */
export const ANNOT_FLAG_HIDDEN = 2;
export const ANNOT_FLAG_NOVIEW = 32;

/** Modos de anotacion de pdf.js (`AnnotationMode`). */
export const ANNOTATION_MODE = { DISABLE: 0, ENABLE: 1 } as const;

/** Referencia de una marca de agua de texto con lo necesario para dibujar su vista previa (campos opcionales y aditivos). */
export type TextWatermarkRef = Extract<AssetRef, { engine: "text" }> & {
  /** Grados, antihorario tal como se ve en pantalla. */
  angleDeg?: number;
  /** Tamano efectivo en puntos. */
  fontSizePt?: number;
  /** 0..1 (la `ca` del estado grafico). */
  opacity?: number;
  /** Tamano de pagina (puntos de vista) donde se vio; para componer la vista previa. */
  pageSize?: { width: number; height: number };
};

/** Candidata de imagen grande y translucida repetida (deteccion (d)). La entrega el motor de imagenes; el clasificador la enlaza por `objectId`. */
export type TranslucentImageCandidate = {
  pageIndex: number;
  /** Nombre del objeto en pdf.js (`g_…`/`img_…`), el mismo que usa el motor de imagenes. */
  objectId: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Opacidad (`ca`) con que se pinta. */
  alpha: number;
};

/** Resultado del motor: el `PartialExtraction` del contrato mas las candidatas de la deteccion (d). */
export type AnnotationExtraction = {
  assets: ExtractedAsset[];
  scannedPages?: number[];
  warnings: import("./types").ExtractWarning[];
  /** Imagenes grandes translucidas repetidas en >= 50 % de las paginas: solo candidatas, sin pixeles. */
  translucentImages?: TranslucentImageCandidate[];
};

export type PdfDocument = PDFDocumentProxy;
export type PdfPage = PDFPageProxy;

/** Error del motor con codigo estable (la interfaz lo traduce). */
export class AnnotationRenderError extends Error {
  readonly code: "unsupported-format" | "not-found" | "no-pixels" | "cancelled" | "too-large" | "timeout";
  constructor(code: AnnotationRenderError["code"], message?: string) {
    super(message ?? code);
    this.name = "AnnotationRenderError";
    this.code = code;
  }
}

/** Nombres de capas/marcas que se tratan como marca de agua; se aplica a `foldText(nombre)` (sin acentos, minusculas). */
export const WATERMARK_NAME_PATTERN =
  /(?<![a-z])(water[\s_-]?marks?|marcas?[\s_-]?(de[\s_-]?)?agua|draft|borrador|confidencial|confidential|do[\s_-]?not[\s_-]?copy|sample|muestra)(?![a-z])/;

/** Quita acentos y pasa a minusculas (para comparar nombres). */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Lo que usa este motor de una anotacion de `page.getAnnotations()` (pdf.js 6). */
export type PdfJsAnnotation = {
  subtype?: string;
  id?: string;
  rect?: ArrayLike<number>;
  annotationFlags?: number;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  inkLists?: ReadonlyArray<ArrayLike<number> | ReadonlyArray<{ x: number; y: number }>> | null;
  color?: ArrayLike<number> | null;
  borderStyle?: { width?: number } | null;
  opacity?: number;
  hasAppearance?: boolean;
  oc?: unknown;
};
