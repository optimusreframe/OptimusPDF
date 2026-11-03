/**
 * Tipos y límites de la biblioteca de documentos (Fase 2, U2.1). Sin dependencias: lo usan el almacén
 * (`store.ts`), la huella (`fingerprint*.ts`) y la (de)serialización (`persist.ts`), y mañana la interfaz.
 *
 * Posiciones y tamaños: los tamaños de página son puntos PDF (1/72 in) tal como los muestra el visor (con la
 * rotación de la página ya aplicada), con 2 decimales.
 */

/** Versión del ALGORITMO de huella. Si cambia la normalización o el hash, sube: las huellas viejas dejan de compararse. */
export const FINGERPRINT_VERSION = 1;

export type PageSize = { width: number; height: number };

export type PageFingerprint = {
  /** SHA-256 (hex) del texto normalizado de la página; `""` si la página no tiene texto útil. */
  textHash: string;
  /** MinHash de trigramas de palabras: 128 enteros sin signo de 32 bits; `[]` si la página no tiene texto útil. */
  minhash: number[];
  /** dHash de 64 bits (16 hex) de la página rasterizada a 32×32; solo en páginas SIN texto útil (escaneos). */
  dhash?: string;
};

export type Fingerprint = {
  version: typeof FINGERPRINT_VERSION;
  /** SHA-256 (hex) de los bytes del archivo. */
  exact: string;
  pageCount: number;
  /** Vacío si `partial`. */
  pageSizes: PageSize[];
  /** Una entrada por página; vacío si `partial`. */
  pages: PageFingerprint[];
  /** Solo se calcularon `exact` y `pageCount` (más páginas que el tope): no se puede comparar por estructura. */
  partial?: "tooManyPages";
};

export type MatchLevel = "exact" | "match" | "similar" | "none";

export type PageMatch = {
  /** Índice (0-based) de la página en la PLANTILLA (el documento guardado). */
  templatePage: number;
  /** Página del documento cargado que le corresponde, o `null` si no hay. */
  documentPage: number | null;
  /** 0..1 (Jaccard estimado de trigramas, o equivalente por dHash). 0 si no hay página correspondiente. */
  similarity: number;
  level: MatchLevel;
  /** Qué se comparó: texto, imagen (dHash), o nada comparable. */
  kind: "text" | "image" | "none";
  /** El texto normalizado es idéntico (hash igual) o el dHash es idéntico. */
  identical: boolean;
  /** Los campos de esta página NO deben aplicarse solos: hay que revisarla. */
  review: boolean;
  /**
   * El texto de la plantilla está COMPLETO en la página del documento y esta trae más (datos rellenados): la similitud no
   * es el Jaccard (que cae al añadir texto) sino `MATCH_THRESHOLDS.containedSimilarity`, siempre «se parece» y a revisar
   * (nunca «coincide»). Ver `comparePages`. Campo ADITIVO: ausente = comparación normal.
   */
  contained?: true;
};

export type MatchResult = {
  level: MatchLevel;
  /** Media de las similitudes de página (0..1), repartida entre `max(páginas)`. 1 si `exact`. */
  similarity: number;
  /** `similarity` en porcentaje entero (0..100). */
  percent: number;
  /** Por qué es `none`, si lo es por estructura. */
  reason?: "partial" | "empty" | "version" | "pages";
  /**
   * Con qué se decidió: `text` (texto de las páginas), `image` (escaneados: dHash, MUY poco discriminante entre
   * páginas de texto parecidas) o `mixed`. Ausente en `exact` y cuando no hubo páginas comparables.
   */
  basis?: "text" | "image" | "mixed";
  /** Una entrada por página de la plantilla. */
  pageMatches: PageMatch[];
  /** Por página de la plantilla: la página del documento cargado a la que se aplica, o `null`. */
  mappedPages: Array<number | null>;
  /** Páginas de la plantilla (0-based) que hay que revisar: sin correspondencia o con similitud < umbral de «Coincide». */
  reviewPages: number[];
  /** Solo con `findBestMatch`: id del candidato elegido. */
  candidateId?: string;
  /** Solo con `findBestMatch`: hay otro candidato igual de bueno (se eligió el más reciente). */
  ambiguous?: boolean;
  /** Solo con `findBestMatch`: ids de los otros candidatos empatados. */
  alternatives?: string[];
};

/**
 * La plantilla de un documento se configuró sobre OTRO PDF: se reemplazó el PDF base y el nuevo ya no coincide (nivel
 * «Coincide» sin páginas por revisar). Mientras exista, la plantilla NO se aplica a ciegas: se compara el PDF real con
 * `base` (la huella del PDF sobre el que se configuró). Se borra al reconfigurar la plantilla o al confirmar que sigue
 * valiendo. Campo ADITIVO de `DocumentEntry` (ausente = al día): las entradas de la v2 ya publicada no lo traen.
 */
export type TemplateStale = {
  /** ISO 8601: cuándo se reemplazó el PDF por primera vez desde la última vez que la plantilla estuvo al día. */
  since: string;
  /** Cómo se parece el PDF nuevo al sobre el que se configuró la plantilla, al reemplazarlo. */
  level: MatchLevel;
  percent: number;
  /** Huella del PDF sobre el que se configuró la plantilla (la de antes de reemplazar). */
  base: Fingerprint;
};

/** Lo que guarda la biblioteca por documento. Los bytes viven aparte (`blobs`). */
export type DocumentEntry = {
  id: string;
  name: string;
  /** Tipo libre del documento (p. ej. «contrato de servicio»). */
  docType: string;
  fileName: string;
  pageCount: number;
  pageSizes: PageSize[];
  fingerprint: Fingerprint;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  templateIds: string[];
  /** Presente solo si el PDF base se reemplazó y la plantilla ya no coincide con él (ver `TemplateStale`). */
  templateStale?: TemplateStale;
  /** Tamaño de la copia del PDF guardada; 0 = no hay copia. */
  byteLength: number;
  /** Versión de este registro: sube en cada escritura. Sirve para no pisar lo que escribió otra pestaña. */
  rev: number;
};

/** Límites de la biblioteca (D6: solo contratos en blanco, pocos documentos). */
export const LIBRARY_LIMITS = {
  /** Documentos como máximo. */
  maxDocuments: 50,
  /** Bytes de UN PDF base. */
  maxDocumentBytes: 100 * 1024 * 1024,
  /** Bytes de todos los PDF base juntos. */
  maxTotalBytes: 400 * 1024 * 1024,
  /** Máximo de plantillas por documento. */
  maxTemplatesPerDocument: 200,
  /** Longitud máxima de nombre / tipo / nombre de archivo. */
  maxNameLength: 200,
  /** Páginas con huella por texto; más → solo `exact` + `pageCount`. */
  maxFingerprintPages: 200,
} as const;

/** Umbrales de comparación (plan §3 Fase 2). */
export const MATCH_THRESHOLDS = {
  /** Jaccard por página a partir del cual la página «coincide». */
  match: 0.9,
  /** Jaccard por página a partir del cual la página «se parece» y se le busca correspondencia. */
  similar: 0.7,
  /**
   * Media de similitudes de página (sobre el mayor número de páginas) a partir de la cual el DOCUMENTO «se parece»
   * (`similar`). Más alta que el umbral por página a propósito: con 9 contratos reales de una misma empresa (mucho
   * texto común y páginas idénticas) los pares distintos dieron 0,62-0,67; 0,75 deja 8 puntos de margen.
   */
  documentSimilar: 0.75,
  /** Diferencia máxima de tamaño de página (puntos) en ancho y alto. */
  pageSizeTolerance: 1,
  /** dHash: distancia de Hamming (de 64 bits) máxima para «coincide». */
  dhashMatchBits: 10,
  /** dHash: distancia de Hamming máxima para «se parece». */
  dhashSimilarBits: 20,
  // Página «con datos rellenados»: el texto de la plantilla está contenido en la del documento, que además trae texto añadido.
  // Rescata una página que el Jaccard deja por debajo de `similar` solo porque se escribieron nombres, direcciones o notas
  // encima (medido con contratos sintéticos: ver la sección de la unidad W3-A2 en `docs/`). El rescate nunca llega a
  // «coincide»: la página queda en `containedSimilarity` (< `match`) y marcada para revisar.
  /** Jaccard mínimo para considerar el rescate (por debajo, ni siquiera comparten la mitad del texto). */
  containedMinJaccard: 0.45,
  /** El documento debe tener, al menos, esta proporción de trigramas más que la plantilla (si no, es una sustitución, no un añadido). */
  containedMinGrowth: 1.12,
  /** Fracción de los trigramas de la plantilla que debe estar en el documento. */
  containedMinCoverage: 0.9,
  /** Similitud que se le asigna a una página rescatada. */
  containedSimilarity: 0.85,
} as const;

export type LibraryErrorCode =
  /** El navegador agotó la cuota de almacenamiento (`QuotaExceededError`). */
  | "quota"
  /** El PDF supera el tamaño máximo de un documento. */
  | "tooBig"
  /** Biblioteca llena: demasiados documentos o demasiados bytes en total (`detail`). */
  | "full"
  /** No hay IndexedDB (modo privado de algunos navegadores) o no se pudo abrir. */
  | "unavailable"
  /** El documento no existe. */
  | "notFound"
  /** Otra pestaña lo modificó: la versión (`rev`) ya no es la que se leyó. */
  | "conflict"
  /** Datos inválidos (entrada mal formada). */
  | "invalid"
  /** Cualquier otro fallo del almacén. */
  | "failed";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;
  readonly detail?: "count" | "total";
  constructor(code: LibraryErrorCode, detail?: "count" | "total") {
    // El mensaje es el código: nunca lleva nombres de archivo ni contenido (sin PII).
    super(code);
    this.name = "LibraryError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export type FingerprintErrorCode = "empty" | "corrupt" | "encrypted" | "aborted" | "unavailable";

export class FingerprintError extends Error {
  readonly code: FingerprintErrorCode;
  constructor(code: FingerprintErrorCode, message?: string) {
    super(message ?? FINGERPRINT_MESSAGES[code]);
    this.name = "FingerprintError";
    this.code = code;
  }
}

/** Mensajes en español de los errores de huella (la interfaz puede traducirlos por `code`). */
export const FINGERPRINT_MESSAGES: Record<FingerprintErrorCode, string> = {
  empty: "El archivo está vacío.",
  corrupt: "No se pudo leer el PDF: está dañado o no es un PDF.",
  encrypted: "El PDF está protegido con contraseña: quítale la protección para guardarlo en tus documentos.",
  aborted: "Se canceló el cálculo.",
  unavailable: "No se pudo calcular la huella del documento en este navegador.",
};
