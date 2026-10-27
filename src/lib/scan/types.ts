/**
 * Contrato del «Escaner» (Escanear a PDF, version «ultimate»).
 *
 * Punto de encuentro entre el motor (`src/lib/scan/*`: filtros, analisis de pagina, deteccion de hojas en blanco/duplicadas,
 * orientacion, nombre inteligente, sesion persistente) y la interfaz (`src/app/scan-to-pdf/*`). Cada parte se construye
 * contra ESTE archivo. Cambios solo aditivos. Todo es local: ningun motor hace llamadas de red.
 */
import type { QuadCorners } from "@/lib/scan/perspective";

/** Modos de captura: ajustan la guia, el recorte, el filtro por defecto y el diseno de pagina. */
export type ScanMode = "document" | "id-card" | "receipt" | "book" | "whiteboard" | "photo";

/** Filtros de pagina. `auto` elige por analisis (documento de texto -> mejorado; foto -> color). */
export type ScanFilterMode = "auto" | "color" | "grayscale" | "bw" | "enhance" | "original";

export type ScanRotation = 0 | 90 | 180 | 270;

export type ScanPageSource = "camera" | "library" | "file";

/** Avisos de calidad de una pagina (se muestran como chips con accion: «Repetir», «Quitar»). */
export type ScanPageFlags = {
  blank?: boolean;
  blurry?: boolean;
  glare?: boolean;
  dark?: boolean;
  /** Parece repetida de la pagina con este id (mismo contenido capturado dos veces). */
  duplicateOf?: string;
  /** El documento no se detecto y se uso el cuadro completo. */
  noDocument?: boolean;
};

export type ScanPageAdjust = { brightness: number; contrast: number }; // -1..1

export type ScanPage = {
  id: string;
  createdAt: string; // ISO
  source: ScanPageSource;
  /** Foto original completa tal cual salio de la camara/biblioteca (con EXIF aplicado). No se modifica nunca. */
  original: Blob;
  originalWidth: number;
  originalHeight: number;
  /** Esquinas del documento 0..1 (detectadas o editadas); `null` = pagina completa. */
  corners: QuadCorners | null;
  rotation: ScanRotation;
  filter: ScanFilterMode;
  adjust: ScanPageAdjust;
  /** Resultado procesado (recorte + perspectiva + giro + filtro) en JPEG/PNG; `null` si aun no se calculo. */
  processed: Blob | null;
  /** Miniatura 360 px del resultado (o del original si aun no hay procesado). */
  thumb: Blob | null;
  flags: ScanPageFlags;
  /** Texto reconocido si se pidio PDF con texto buscable. */
  ocrText?: string;
};

export type ScanSettings = {
  mode: ScanMode;
  /** Captura automatica cuando el documento esta estable y bien encuadrado. */
  autoCapture: boolean;
  /** Tras cada captura se queda en la camara para la siguiente (rafaga de paginas). */
  batch: boolean;
  /** Filtro aplicado a las paginas nuevas. */
  defaultFilter: ScanFilterMode;
  /** PDF con texto buscable (OCR local, opcional y mas lento). */
  searchable: boolean;
};

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  mode: "document",
  autoCapture: true,
  batch: true,
  defaultFilter: "auto",
  searchable: false,
};

export type ScanSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Nombre del documento (editable); se propone uno inteligente. */
  name: string;
  nameSuggested?: { title: string | null; date: string | null; source: "ocr" | "date" };
  pages: ScanPage[];
  settings: ScanSettings;
};

export type FrameVerdict = {
  /** Cuadrilatero detectado en el fotograma (0..1) o `null`. */
  quad: QuadCorners | null;
  confidence: number;
  /** Cuadro estable: sin movimiento apreciable durante `stableMs`. */
  stable: boolean;
  stableMs: number;
  blurry: boolean;
  glare: boolean;
  dark: boolean;
  /** Cuanto del encuadre ocupa el documento (0..1). */
  coverage: number;
  /** Guia unica para el usuario (la mas importante ahora). */
  hint: "ok" | "move_closer" | "move_away" | "hold_steady" | "too_dark" | "glare" | "no_document" | "unknown";
  /** `true` cuando se debe disparar la captura automatica (estable, enfocado, cubierto, sin brillo). */
  shouldAutoCapture: boolean;
};

export type ScanSizeEstimate = { bytes: number; low: number; high: number };

/**
 * API publica del motor. La interfaz solo importa de `@/lib/scan/engine` (index): por defecto una implementacion
 * `unavailable` que lanza, sustituible con `setScanEngine(api)` para pruebas e integracion.
 */
export interface ScanEngineApi {
  /** Analiza un fotograma de camara (muestra reducida) y decide guia y captura automatica. Barato: se llama ~5-10 veces/s. */
  analyzeFrame(frame: ImageData, previous?: { quad: QuadCorners | null; at: number }, now?: number): FrameVerdict;
  /** Crea una pagina a partir de una foto: corrige orientacion EXIF, detecta documento y calidad, aplica el filtro por defecto. */
  createPage(source: Blob, info: { source: ScanPageSource; mode: ScanMode; settings: ScanSettings; signal?: AbortSignal }): Promise<ScanPage>;
  /** Recalcula `processed`/`thumb` tras cambiar esquinas, giro, filtro o ajustes. Siempre parte del original. */
  renderPage(page: ScanPage, options?: { signal?: AbortSignal; maxSide?: number }): Promise<ScanPage>;
  /** Marca hojas en blanco y paginas repetidas dentro de la sesion. */
  analyzeSession(pages: ScanPage[]): Promise<Record<string, ScanPageFlags>>;
  /** Orientacion que deja el texto derecho (0/90/180/270) o `null` si no se puede saber. */
  detectOrientation(page: ScanPage, signal?: AbortSignal): Promise<ScanRotation | null>;
  /** Propone nombre del documento (titulo del primer texto reconocible + fecha) sin enviar nada a la red. */
  suggestName(pages: ScanPage[], locale: "es" | "en", signal?: AbortSignal): Promise<ScanSession["nameSuggested"]>;
  /** Estimacion rapida del tamano del PDF final. */
  estimateSize(pages: ScanPage[], options: { preset: string; searchable: boolean }): ScanSizeEstimate;
  /** Construye el PDF (usa `prepareForPdf`, 1 pagina por hoja, texto buscable opcional) con progreso cancelable. */
  buildPdf(
    session: ScanSession,
    options: { preset: string; pageSize: "a4" | "letter" | "fit"; margin: "none" | "small" | "large"; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
  ): Promise<Blob>;
}

/** Persistencia de la sesion (IndexedDB `optimuspdf-scan-sessions`): nunca se pierde un escaneo (recarga, cierre, BACK). */
export interface ScanSessionStore {
  save(session: ScanSession): Promise<{ ok: true } | { ok: false; reason: "quota" | "unavailable" | "tooBig" }>;
  load(id: string): Promise<ScanSession | null>;
  list(): Promise<Array<{ id: string; name: string; updatedAt: string; pageCount: number; thumb: Blob | null }>>;
  remove(id: string): Promise<void>;
  /** Borra sesiones de mas de 14 dias. */
  purgeExpired(now?: number): Promise<number>;
}
