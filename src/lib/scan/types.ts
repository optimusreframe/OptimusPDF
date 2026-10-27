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
  /**
   * ADITIVO (motor real). Modo con el que se creo la pagina (`createPage`): `renderPage`, la orientacion y el tamano lo
   * usan (una sesion puede mezclar documentos, tarjetas y fotos). Sin el, se asume `document`.
   */
  mode?: ScanMode;
  /** ADITIVO. Dimensiones (px) de `processed`, para estimar el tamano del PDF sin decodificar. */
  processedSize?: { width: number; height: number };
  /**
   * ADITIVO. Filtro realmente aplicado la ultima vez que se proceso (`auto` ya resuelto). Con `original`/`color`, sin recorte,
   * giro ni ajuste, `processed` ES el `original` (sus bytes no se tocan) y el PDF «Original» conserva el archivo tal cual.
   */
  resolvedFilter?: ScanResolvedFilter;
  /**
   * ADITIVO. Peso por pixel de un parche del resultado medido a la RESOLUCION NATIVA del original (JPEG calidad 0,9, con el
   * filtro y el ajuste de la pagina): permite estimar el PDF antes de procesar la pagina entera sin que el ruido de la foto
   * se pierda por reducirla. `side` = lado del parche (px).
   */
  jpegSample?: { side: number; bytesPerPixel: number };
};

/** Filtro ya resuelto (lo que se aplico de verdad). */
export type ScanResolvedFilter = "color" | "grayscale" | "bw" | "enhance" | "original" | "whiteboard";

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
  /**
   * `title`: primer texto reconocible (o `null`); `date`: AAAA-MM-DD (la del documento si es creible, si no la del
   * escaneo); `source`: `ocr` si hay titulo, `date` si solo hay fecha. ADITIVO: `name` es el nombre COMPLETO ya saneado
   * para archivo («Contrato de servicio · 2026-10-26» o «Escaneo 2026-10-26 14.32»).
   */
  nameSuggested?: { title: string | null; date: string | null; source: "ocr" | "date"; name?: string };
  pages: ScanPage[];
  settings: ScanSettings;
  /**
   * ADITIVO. Paginas que NO se pudieron recuperar al cargar una sesion guardada (su original falto o estaba danado):
   * la interfaz puede avisar «N paginas no se recuperaron». Solo lo rellena `ScanSessionStore.load`.
   */
  lostPages?: number;
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

/**
 * ADITIVO. Aviso de `buildPdf`: el PDF se entrego pero SIN (todo) el texto buscable pedido.
 *  - `model-missing`: el modelo de OCR no esta en local y no se pidio descargarlo;
 *  - `offline`: hace falta descargarlo y no hay conexion;
 *  - `network`: la descarga fallo (CDN inalcanzable, bloqueador, proxy);
 *  - `engine`: el OCR fallo por otra razon.
 * `pagesWithText` de `total` paginas llevan texto (las demas, no).
 */
export type ScanBuildWarning = { code: "searchable-unavailable"; reason: "model-missing" | "offline" | "network" | "engine"; pagesWithText: number; total: number };

export type ScanSizeEstimate = { bytes: number; low: number; high: number };

/**
 * API publica del motor. La interfaz solo importa de `@/lib/scan/engine` (index): por defecto una implementacion
 * `unavailable` que lanza, sustituible con `setScanEngine(api)` para pruebas e integracion.
 */
export interface ScanEngineApi {
  /** Analiza un fotograma de camara (muestra reducida) y decide guia y captura automatica. Barato: se llama ~5-10 veces/s. */
  analyzeFrame(
    frame: ImageData,
    previous?: { quad: QuadCorners | null; at: number },
    now?: number,
    /** ADITIVO: el modo ajusta la cobertura esperada (tarjeta, recibo) y en `photo` no se busca documento. */
    options?: { mode?: ScanMode },
  ): FrameVerdict;
  /** Crea una pagina a partir de una foto: corrige orientacion EXIF, detecta documento y calidad, aplica el filtro por defecto. */
  createPage(source: Blob, info: { source: ScanPageSource; mode: ScanMode; settings: ScanSettings; signal?: AbortSignal }): Promise<ScanPage>;
  /**
   * Recalcula `processed`/`thumb` tras cambiar esquinas, giro, filtro o ajustes. Siempre parte del original.
   * `maxSide <= 480` (miniatura rapida) solo recalcula `thumb` y deja `processed` en `null` (queda por recalcular);
   * sin `maxSide` se calcula el resultado completo (lado largo <= 3508 px) y la miniatura.
   */
  renderPage(page: ScanPage, options?: { signal?: AbortSignal; maxSide?: number }): Promise<ScanPage>;
  /** Marca hojas en blanco y paginas repetidas dentro de la sesion. */
  analyzeSession(pages: ScanPage[]): Promise<Record<string, ScanPageFlags>>;
  /**
   * Valor de `ScanPage.rotation` (ABSOLUTO, 0/90/180/270) que deja el texto derecho, calculado sobre el recorte sin girar de
   * la pagina; `null` si no se puede saber (no se gira a ciegas).
   */
  detectOrientation(page: ScanPage, signal?: AbortSignal): Promise<ScanRotation | null>;
  /** Propone nombre del documento (titulo del primer texto reconocible + fecha) sin enviar nada a la red. */
  suggestName(pages: ScanPage[], locale: "es" | "en", signal?: AbortSignal): Promise<ScanSession["nameSuggested"]>;
  /** Estimacion rapida del tamano del PDF final. */
  estimateSize(pages: ScanPage[], options: { preset: string; searchable: boolean }): ScanSizeEstimate;
  /** Construye el PDF (usa `prepareForPdf`, 1 pagina por hoja, texto buscable opcional) con progreso cancelable. */
  buildPdf(
    session: ScanSession,
    options: {
      preset: string;
      pageSize: "a4" | "letter" | "fit";
      margin: "none" | "small" | "large";
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
      /**
       * ADITIVO. Con texto buscable el motor SOLO usa el OCR si el modelo ya esta en local (`ocrModelAvailable()`); descargarlo
       * (una peticion a la red) exige que la persona lo acepte: la interfaz pone `true` tras esa confirmacion. Sin modelo y sin
       * permiso el PDF sale normal y se avisa por `onWarning` (no es un error).
       */
      allowModelDownload?: boolean;
      /** ADITIVO. Avisos que NO impiden entregar el PDF (p. ej. no se pudo anadir el texto buscable). */
      onWarning?: (warning: ScanBuildWarning) => void;
    },
  ): Promise<Blob>;
  /**
   * ADITIVO (modo `book`): parte la foto de un libro abierto en DOS paginas (izquierda, derecha) por el lomo detectado o por
   * el centro. Cada una comparte el mismo original y lleva sus esquinas; ids nuevos. Opcional: un motor sin el no parte.
   */
  splitSpread?(source: ScanPage, options?: { signal?: AbortSignal }): Promise<[ScanPage, ScanPage]>;
}

/** Persistencia de la sesion (IndexedDB `optimuspdf-scan-sessions`): nunca se pierde un escaneo (recarga, cierre, BACK). */
export interface ScanSessionStore {
  /**
   * Guarda la sesion (solo escribe lo que cambio: paginas nuevas/modificadas y el orden). ADITIVO en el resultado:
   * `forkedAs` = otra pestana modifico esta misma sesion mas recientemente y NO se piso: la copia de esta pestana se guardo
   * con ese id (la interfaz puede seguir con el); `rev` = revision guardada.
   */
  save(session: ScanSession): Promise<{ ok: true; forkedAs?: string; rev?: number } | { ok: false; reason: "quota" | "unavailable" | "tooBig" }>;
  load(id: string): Promise<ScanSession | null>;
  list(): Promise<Array<{ id: string; name: string; updatedAt: string; pageCount: number; thumb: Blob | null }>>;
  remove(id: string): Promise<void>;
  /** Borra sesiones de mas de 14 dias. */
  purgeExpired(now?: number): Promise<number>;
  /**
   * ADITIVO. Apunta la ULTIMA version de la sesion SIN escribir nada (barato: solo guarda la referencia). La interfaz lo llama en
   * cada cambio y `save` (con su espera de autoguardado) cuando toque: si la pagina se cierra o se recarga antes, el almacen
   * escribe lo apuntado al instante (`pagehide`, `visibilitychange`, `beforeunload`).
   */
  stage?(session: ScanSession): void;
  /** ADITIVO. Escribe ya lo apuntado con `stage` (y espera a los guardados en vuelo). Nunca lanza. */
  flush?(): Promise<void>;
}
