/*
 * Tipos publicos del automapeo (U2.8): identificar, en un documento que la app no conoce, las lineas de iniciales,
 * de firma, de fecha y los campos de texto con etiqueta clara. Sin interfaz ni IA: todo es explicable (cada campo
 * lleva `reason` y `source`).
 */

import type { NormalizedRect } from "@/lib/pdf/core";

export type AutoFieldType = "signature" | "initials" | "date" | "text";
/** `high`: se propone ya colocado; `review`: hay que revisarlo; `ignore`: no se propone (solo con `includeIgnored`). */
export type AutoTier = "high" | "review" | "ignore";
/** Senal dominante: etiqueta de texto, geometria vectorial/raster o repeticion entre paginas. */
export type AutoSource = "label" | "geometry" | "repetition";

export type AutoField = {
  /** Estable dentro de un resultado (`am-<pagina>-<n>`). */
  id: string;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la VISTA (origen arriba-izquierda, ya con la rotacion de pagina), igual que `SignatureField.rect`. */
  rect: NormalizedRect;
  type: AutoFieldType;
  /** 0 = firmante 1, 1 = firmante 2. Ausente en campos que no son de un firmante (p. ej. la firma de la empresa). */
  signerIndex?: 0 | 1;
  /** Etiqueta del documento (recortada) o descripcion corta. Nunca contiene datos del cliente. */
  label?: string;
  /** 0..1, derivada de las senales (ver `autoMap.ts`). */
  confidence: number;
  tier: AutoTier;
  /** Frase corta que explica por que se propone (en el idioma pedido). */
  reason: string;
  source: AutoSource;
};

export type AutoMapPageSummary = {
  pageIndex: number;
  /** La pagina tiene una linea (o hueco) de iniciales propuesto con nivel `high` o `review`. */
  hasInitialsLine: boolean;
  /** Numero de lineas de firma propuestas (`high` o `review`) en la pagina, de cualquier firmante. */
  signatureLines: number;
  /** Sin texto extraible: solo se miro la geometria raster. */
  scanned?: boolean;
};

export type AutoMapWarning = {
  code:
    | "page-skipped"
    | "page-too-complex"
    | "scanned-page"
    | "page-field-cap"
    | "document-field-cap"
    | "too-many-pages"
    | "aborted-page"
    | "no-fields";
  pageIndex?: number;
  message: string;
};

export type AutoMapResult = {
  fields: AutoField[];
  pages: AutoMapPageSummary[];
  confidenceSummary: {
    high: number;
    review: number;
    ignore: number;
    byType: Record<AutoFieldType, number>;
    /** Media de `confidence` de los `high` (0 si no hay). */
    meanHighConfidence: number;
    /** Maximo de campos (high+review) en una sola pagina. */
    maxPerPage: number;
  };
  warnings: AutoMapWarning[];
};

/** Hueco de pixeles ya renderizado de una pagina escaneada (RGBA, como `ImageData`). */
export type RasterPage = { data: ArrayLike<number>; width: number; height: number };
export type Rasterizer = (page: import("pdfjs-dist").PDFPageProxy, pageIndex: number) => Promise<RasterPage | null>;

/** Tabla `OPS` de pdf.js (`pdfjs.OPS`); se acepta cualquiera de sus builds (normal o legacy). */
export type OpsTable = Readonly<Record<string, number>>;

export type AutoMapOptions = {
  signers: 1 | 2;
  locale?: "es" | "en";
  /** Tabla `OPS` de pdf.js. Sin ella se carga con `getPdfJs()` (solo navegador). */
  ops?: OpsTable;
  /** Devuelve tambien los candidatos `ignore` (solo para evaluar / depurar). */
  includeIgnored?: boolean;
  /** Renderiza una pagina sin texto para la heuristica raster. Sin ella, las paginas escaneadas no se analizan. */
  rasterizer?: Rasterizer;
  /** Tope de paginas que se analizan (por defecto 200). */
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
  /** Cede el control al hilo principal cuando lleva mas de este tiempo seguido (ms; por defecto 30). */
  yieldEveryMs?: number;
};
