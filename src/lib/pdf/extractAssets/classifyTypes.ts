/**
 * Tipos y umbrales del clasificador heuristico de «Extraer elementos» (U7.3, docs/PLAN-FIRMA-AGIL.md §9.5).
 *
 * El clasificador NO toca pdf.js ni el DOM: recibe lo que devolvieron los motores (imagenes con su miniatura, anotaciones, candidatas
 * translucidas) y los HECHOS de cada pagina (texto con posiciones, grupos de trazos vectoriales) y decide el tipo de cada elemento con
 * motivos legibles y una confianza calibrada (0,85 o mas = «probable»; menos = «posible»).
 */

import type { ExtractedAsset, NormRect } from "./types";

/** Pixeles RGBA de 8 bits con alfa recto. */
export type RasterRGBA = { width: number; height: number; data: Uint8ClampedArray | Uint8Array };

/** Lo que se sabe de una pagina analizada (puntos de vista, origen ARRIBA-izquierda como el resto del contrato). */
export type TextLine = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageFacts = {
  pageIndex: number;
  /** Tamano de la vista a escala 1 (puntos, con `/Rotate` aplicado). */
  width: number;
  height: number;
  lines: TextLine[];
  /** Caracteres legibles de la pagina (una pagina sin texto es candidata a escaneo). */
  chars: number;
};

/** Candidato a firma dibujada como vectores (ver `vectors.ts`). Coordenadas en puntos de vista, origen arriba-izquierda. */
export type VectorCandidate = {
  pageIndex: number;
  /** Caja en puntos de vista. */
  bbox: { x: number; y: number; width: number; height: number };
  rect: NormRect;
  /** Curvas, segmentos y trazos que la forman. */
  curves: number;
  segments: number;
  strokes: number;
  /** Fraccion de los trazos que son marcadores cerrados y chicos (circulos, cuadros): un grafico de puntos. */
  shapeShare: number;
  /** Cambios de sentido en horizontal (bucles de la escritura cursiva). */
  xReversals: number;
  /** Cambios de sentido en vertical. */
  yReversals: number;
  /** Fraccion de segmentos horizontales o verticales (tablas, cuadros). */
  axisAligned: number;
  /** Grosor tipico del trazo en puntos (0 si es un relleno). */
  strokeWidth: number;
  /** `#rrggbb` dominante. */
  color: string;
  /** Rutas (en puntos de vista, ya con la matriz aplicada) para volver a dibujar el grupo. */
  paths: VectorPath[];
};

export type VectorPath = {
  /** Comandos en puntos de vista: `M x y`, `L x y`, `C x1 y1 x2 y2 x y`, `Q x1 y1 x y`, `Z`. */
  commands: ReadonlyArray<readonly [string, ...number[]]>;
  stroke: boolean;
  fill: boolean;
  color: string;
  lineWidth: number;
};

export type PageVectors = {
  pageIndex: number;
  candidates: VectorCandidate[];
  /** Rayas horizontales largas de la pagina (puntos de vista): candidatas a raya de firma. */
  lines: Array<{ x0: number; x1: number; y: number }>;
};

/** Un hallazgo de texto que parece una etiqueta de firma o iniciales. */
export type LabelFact = {
  kind: "signature" | "initials";
  /** 1 = etiqueta clara; menos = dentro de una frase o solo un rol («Asegurado»). */
  strength: number;
  text: string;
  box: { x: number; y: number; width: number; height: number };
  /** Alto de la linea de texto (puntos). */
  lineHeight: number;
  /** «Rubrica»: cuenta como etiqueta de iniciales Y de firma (la geometria decide cual de las dos es la imagen). */
  alsoSignature?: boolean;
};

/** Caracteristicas de los pixeles de una miniatura. */
export type PixelFeatures = {
  width: number;
  height: number;
  /** Fraccion de pixeles transparentes (alfa < 16). */
  transparent: number;
  hasAlpha: boolean;
  /** Fondo transparente o casi blanco y uniforme. */
  lightBackground: boolean;
  /** Pixeles de tinta / total. */
  inkFraction: number;
  /** Luminancia media de la tinta (0..255). */
  inkLuma: number;
  /** Saturacion media de la tinta (0..1). */
  inkSaturation: number;
  /** Fraccion de tinta oscura (luminancia < 120, de cualquier tono: negro, gris, burdeos, morado oscuro). */
  darkShare: number;
  /** Fraccion de tinta azul oscuro (boligrafo). */
  blueShare: number;
  /** Fraccion de tinta cromatica con el tono dominante (±30 grados). */
  dominantHueShare: number;
  /** Tono dominante (0..360) de la tinta cromatica; -1 si no hay. */
  dominantHue: number;
  /** Fraccion de la tinta que es cromatica (saturacion >= 0,3). */
  chromaticShare: number;
  /** Colores distintos (cubetas de 4 bits ocupadas con >= 0,05 % de los pixeles visibles). */
  colorBins: number;
  /** Fraccion de la tinta que es relleno (todos sus vecinos son tinta): trazos finos => bajo. */
  solidity: number;
  /** Fraccion de la tinta que esta en el borde de una elipse inscrita en su caja. */
  ringShare: number;
  /** Fraccion de la tinta que esta en el centro (dentro del 55 % del radio): un aro tiene el centro casi vacio. */
  centerShare: number;
  /** Fraccion de la tinta que esta pegada al borde de su caja (marco). */
  frameShare: number;
  /** Fraccion de columnas (o filas) de la caja de la tinta que son casi todo tinta: barras de un codigo de barras. */
  fullSpanShare: number;
  /** Cuantas BARRAS distintas forman esas columnas (o filas) casi enteras: una «I» o una «T» tienen un trazo; un codigo de barras, muchos. */
  fullSpanRuns: number;
  /** Minima cobertura de los cuatro bordes de la caja de la tinta (0..1): un marco de verdad tiene los cuatro lados, unas iniciales al ras no. */
  frameSides: number;
  /**
   * El fondo no es claro y uniforme en conjunto (sombra, foto oscura) pero SI lo es respecto a su entorno inmediato: papel con sombra
   * o gris. Solo aplica a imagenes opacas; la tinta se separa con el fondo local.
   */
  localPaper: boolean;
  /** Caja de la tinta como fraccion de la imagen. */
  inkBox: { x: number; y: number; width: number; height: number };
  /** Opacidad media de los pixeles no transparentes (0..1). */
  meanAlpha: number;
};

export type PageSize = { width: number; height: number };

export type ClassifyInput = {
  /** Elementos de los motores (imagenes y anotaciones), ya fusionados. */
  assets: ExtractedAsset[];
  /** Candidatas de la deteccion (d): imagen grande translucida repetida. */
  translucentImages?: ReadonlyArray<{ pageIndex: number; rect: NormRect; alpha: number }>;
  /** Hechos por pagina analizada (texto). */
  pages: ReadonlyArray<PageFacts>;
  /** Candidatas de firma vectorial por pagina. */
  vectors?: ReadonlyArray<PageVectors>;
  /** Paginas escaneadas (0-based). */
  scannedPages?: ReadonlyArray<number>;
  /** Cuantas paginas se analizaron (base de las proporciones de repeticion). */
  analyzedPages: number;
  /** Decodifica la miniatura PNG de un elemento. Por defecto el decodificador propio (`classifyPng.ts`). */
  decodeThumb?: (thumb: Blob) => Promise<RasterRGBA | null>;
  signal?: AbortSignal;
};

export type ClassifyOutput = {
  /** Elementos de entrada con el tipo, la confianza y los motivos decididos. */
  assets: ExtractedAsset[];
  /** Candidatas vectoriales aceptadas como firma o iniciales (sin pixeles: los genera `vectorsRender.ts`). */
  vectorSignatures: AcceptedVector[];
};

export type AcceptedVector = {
  candidate: VectorCandidate;
  kind: "signature" | "initials";
  confidence: number;
  reasons: string[];
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Umbrales (cada uno con su prueba y su mutacion)                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

/** Confianza a partir de la cual la interfaz dice «probable» (igual que `PROBABLE_BELOW` de la interfaz: 0,9 es el borde de «seguro»). */
export const PROBABLE_CONFIDENCE = 0.85;

/** Firma como imagen: proporcion ancho/alto. */
export const SIGNATURE_ASPECT = { min: 1.5, max: 8 } as const;
/** Iniciales: proporcion ancho/alto. */
export const INITIALS_ASPECT = { min: 0.6, max: 2.5 } as const;
/**
 * Altura de una firma o unas iniciales respecto al LADO LARGO de la pagina (1-8 %; hasta 15 % con una etiqueta de firma cerca: una firma
 * grande). El lado largo y no el alto: una firma de 53 pt es el 6,7 % de una carta vertical pero el 8,7 % de la misma carta apaisada.
 */
export const SIGNATURE_HEIGHT = { min: 0.01, max: 0.08, maxLabelled: 0.15 } as const;
/** Una firma no ocupa casi todo el ancho de la pagina (una cenefa o una raya ornamental si); con etiqueta de firma cerca, hasta el 60 %. */
export const SIGNATURE_MAX_WIDTH = 0.45;
export const SIGNATURE_MAX_WIDTH_LABELLED = 0.6;
/** Unas iniciales son pequenas: area maxima respecto a la pagina. */
export const INITIALS_MAX_AREA = 0.02;
/** Franja superior/inferior de una pagina donde viven cabeceras y pies (20 %). */
export const HEADER_FOOTER_BAND = 0.2;
/** Un logo ocupa menos de esta fraccion de la pagina. */
export const LOGO_MAX_AREA = 0.1;
/** Cercania a una etiqueta: lineas de texto (alto del cuerpo x 1,2 de interlineado) de distancia vertical y puntos de distancia horizontal. */
export const NEAR_LABEL_LINES = 2;
export const NEAR_LABEL_MAX_DX_PT = 90;
/** Marca de agua: area minima de la pagina y alfa medio maximo. */
export const WATERMARK_MIN_AREA = 0.2;
export const WATERMARK_MAX_ALPHA = 0.75;
/** Una imagen que cubre tanto de la pagina es la pagina entera (escaneo). */
export const FULL_PAGE_COVER = 0.85;
/** Foto: cubetas de color ocupadas minimas (una foto ocupa miles; un dibujo o un escaneo de firma, unas decenas). */
export const PHOTO_MIN_BINS = 150;
/** Tinta de una firma: fraccion maxima de pixeles de tinta y solidez maxima. */
export const SIGNATURE_MAX_INK = 0.45;
export const SIGNATURE_MAX_SOLIDITY = 0.6;
/** Una firma o unas iniciales halladas por heuristica nunca son «seguras»: tope por debajo de 0,9 (la interfaz dice «probable»). */
export const HEURISTIC_MAX_CONFIDENCE = 0.89;
/** Confianza maxima de una firma vectorial (beta): nunca «probable». */
export const VECTOR_MAX_CONFIDENCE = 0.7;

/** Orden de los tipos en el resultado (firmas e iniciales juntas, por confianza). */
export const KIND_ORDER: Record<ExtractedAsset["kind"], number> = {
  signature: 0,
  initials: 0,
  stamp: 1,
  logo: 2,
  watermark: 3,
  drawing: 4,
  photo: 4,
  image: 5,
};
