/**
 * Contrato del AUTORRELLENO desde documentos (F3): leer nombre, direccion, telefono, correo, poliza, reclamo, fechas…
 * de un PDF, una imagen, la camara o una hoja escaneada, y proponer el valor de cada campo de texto de «Firmar PDF».
 *
 * Todo es LOCAL: ningun archivo ni valor sale del dispositivo. Dos piezas independientes que se unen por este contrato:
 *   - MOTOR (`src/lib/autofill/*`, puro, sin React): `extract` lee las fuentes y devuelve valores con confianza y evidencia;
 *     `planFill` decide que valor va a que campo.
 *   - INTERFAZ (`src/app/sign-pdf/autofill/*`): elegir fuentes, revisar/editar lo detectado, perfil del cliente y rellenar.
 *
 * Las claves (`key`) son las del registro `src/lib/docLibrary/dataKeys.ts` (insuredName1, insuredName2, phone, email, address,
 * insurer, policyNumber, claimNumber, claimType, lossDate, today…). El registro puede crecer: una clave desconocida se conserva.
 */

/** De donde viene la fuente (solo informativo para la interfaz y los avisos). */
export type AutofillOrigin = "file" | "camera" | "scan" | "paste";

export type AutofillSource =
  | { kind: "pdf"; file: File; origin: AutofillOrigin }
  | { kind: "image"; file: File; origin: AutofillOrigin }
  /** Texto pegado a mano (sin OCR): se trata como una pagina de texto. */
  | { kind: "text"; text: string; origin: "paste" };

/** Un dato detectado. PRECISION PRIMERO: mejor no proponer que proponer mal. */
export type ExtractedValue = {
  /** Estable dentro del resultado (para claves de React y para marcar «aceptado»). */
  id: string;
  /** Clave del registro de `dataKeys.ts`. */
  key: string;
  /** Valor ya limpio (sin etiqueta, sin espacios dobles, mayusculas/minusculas de un nombre normalizadas). */
  value: string;
  /** 0..1. */
  confidence: number;
  /** `high` = se marca aceptado por defecto; `review` = aparece sin marcar para que la persona lo decida. */
  tier: "high" | "review";
  /** Por que se propone, en una linea y en el idioma pedido: «junto a «Insured:» en la pagina 1». */
  reason: string;
  evidence: {
    /** Indice de la fuente dentro de `sources`. */
    sourceIndex: number;
    pageIndex: number;
    /** Fragmento de texto leido que contiene el dato (para que la persona lo compruebe); maximo 120 caracteres. */
    snippet: string;
    origin: "text-layer" | "ocr" | "pasted";
    /**
     * OPCIONAL (solo en lecturas de OCR: foto o pagina escaneada). Zona de la pagina donde se leyo el dato, en fracciones 0..1 del ancho y
     * del alto de la IMAGEN LEIDA (la ya preparada: enderezada y escalada).
     */
    box?: { x0: number; y0: number; x1: number; y1: number };
    /** OPCIONAL (solo en lecturas de OCR). Como `box`, pero solo la zona del VALOR (sin su etiqueta): es la que se vuelve a leer para confirmarlo. */
    valueBox?: { x0: number; y0: number; x1: number; y1: number };
    /** OPCIONAL (solo en lecturas de OCR). La menor confianza (0..100) de las palabras leidas del dato. */
    ocrConfidence?: number;
    /** OPCIONAL (solo en lecturas de OCR). `true` si una segunda lectura independiente de la zona reprodujo el valor; `false` si no. */
    verified?: boolean;
    /**
     * OPCIONAL (solo en lecturas de OCR). Recorte de esa zona como imagen JPEG en una URL `data:`: la persona comprueba de un vistazo lo
     * que se leyo. Nunca se guarda (ni en perfiles ni en borradores): vive solo en el resultado de la lectura.
     */
    crop?: string;
  };
};

export type ExtractWarningCode =
  /** PDF/imagen sin texto y el OCR no esta disponible (sin red la primera vez). */
  | "ocr-unavailable"
  | "no-data"
  | "page-skipped"
  | "too-many-pages"
  | "unreadable-source";

export type ExtractWarning = { code: ExtractWarningCode; sourceIndex?: number; message: string };

export type ExtractResult = {
  values: ExtractedValue[];
  warnings: ExtractWarning[];
  pagesRead: number;
  usedOcr: boolean;
};

export type ExtractOptions = {
  locale: "es" | "en";
  signal?: AbortSignal;
  /** 0..1, para la barra de progreso. */
  onProgress?: (fraction: number) => void;
  /** Paginas maximas que se leen por fuente (por defecto 12). */
  maxPages?: number;
};

export type ExtractEngine = (sources: readonly AutofillSource[], options: ExtractOptions) => Promise<ExtractResult>;

/** Un campo de texto del documento que se podria rellenar. */
export type FillTarget = {
  fieldId: string;
  /** Etiqueta detectada junto al campo («Cliente:», «Fecha de perdida»). */
  label?: string;
  /** Origen de dato fijado por la plantilla (gana sobre la etiqueta). */
  dataKey?: string;
  type: "text" | "date";
  /** Lo que ya tiene escrito la persona ("" = vacio). */
  currentValue: string;
};

export type FillProposal = {
  fieldId: string;
  key: string;
  value: string;
  /** `dataKey` = la plantilla lo fijo; `label` = salio del texto de la etiqueta. */
  via: "dataKey" | "label";
  /** El campo ya tenia algo escrito distinto: NUNCA se pisa sin que la persona lo acepte. */
  overwrites: boolean;
};

/** Datos de un cliente guardados en el dispositivo para reutilizarlos entre documentos. */
export type ClientProfileValue = { value: string; updatedAt: string; source: "extracted" | "typed" };

export type ClientProfile = {
  id: string;
  /** Nombre para reconocerlo en la lista («Perez, Maria»). */
  name: string;
  values: Record<string, ClientProfileValue>;
  updatedAt: string;
};
