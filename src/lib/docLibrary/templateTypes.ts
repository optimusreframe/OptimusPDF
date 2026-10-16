/**
 * Modelo de las PLANTILLAS DE CAMPOS por documento (Fase 2, U2.2). Solo tipos y constantes: sin IndexedDB, sin
 * dependencias. Lo usan el almacén (`templates.ts`), la validación (`templateSchema.ts`), la aplicación a un documento
 * (`templateApply.ts`), la repetición de iniciales (`templateRepeat.ts`), el automapeo (`templateAuto.ts`) y la migración
 * de las plantillas antiguas de `localStorage` (`templateLegacy.ts`).
 *
 * Posiciones: rectángulos normalizados 0..1 sobre la VISTA de cada página (origen arriba-izquierda), los mismos que
 * `SignatureField.rect` y `DetectedField.rect` en Firmar.
 */

/** Versión del formato de una plantilla guardada (cada fila lleva `schemaVersion`). */
export const TEMPLATE_SCHEMA_VERSION = 1;

export const TEMPLATE_LIMITS = {
  /** Plantillas en toda la biblioteca. */
  maxTemplates: 200,
  /** Plantillas por documento. */
  maxPerDocument: 20,
  /** Versiones conservadas por plantilla: la actual + las anteriores (para deshacer). */
  maxVersions: 5,
  /** Campos (firmas/iniciales + texto) por variante. */
  maxFieldsPerVariant: 500,
  maxNameLength: 120,
  maxRoleLabelLength: 60,
  maxFieldLabelLength: 120,
  /** Índice de página más alto aceptado. */
  maxPageIndex: 9_999,
  /** Páginas citadas a mano en un diseño de iniciales. */
  maxLayoutPages: 500,
} as const;

/** Tolerancia numérica al comprobar que un rectángulo cabe en 0..1 (errores de redondeo de coma flotante). */
export const RECT_EPSILON = 1e-6;

export type Rect = { x: number; y: number; width: number; height: number };

/** `auto`: lo propuso el automapeo; `manual`: lo puso o lo movió una persona. */
export type TemplateSource = "auto" | "manual";

export type VariantKey = "1" | "2";
export const VARIANT_KEYS: readonly VariantKey[] = ["1", "2"] as const;

export type TemplateRole = { key: string; label: string };

export type SignFieldType = "signature" | "initials";
export type TextFieldType = "text" | "date" | "checkbox" | "initials";
export const SIGN_FIELD_TYPES: readonly SignFieldType[] = ["signature", "initials"] as const;
export const TEXT_FIELD_TYPES: readonly TextFieldType[] = ["text", "date", "checkbox", "initials"] as const;

export type TemplateSignField = {
  /** Identificador estable dentro de la variante (opcional; lo usan el automapeo y la repetición de iniciales). */
  id?: string;
  /** Índice del rol en `roles` (0 = firmante 1). En la variante «1» solo puede ser 0. */
  roleIndex: number;
  pageIndex: number;
  type: SignFieldType;
  rect: Rect;
  required: boolean;
  /** Grupo de asignación («A», «B»…) previsto por el campo, si lo hay (letras mayúsculas, hasta 3). */
  group?: string;
  source: TemplateSource;
  /** El campo viene de una propuesta de confianza media: la persona debe revisarlo. */
  needsReview?: boolean;
  /** 0..1, solo en campos `auto`. */
  confidence?: number;
};

export type TemplateTextField = {
  id?: string;
  pageIndex: number;
  rect: Rect;
  type: TextFieldType;
  label: string;
  /** Origen de dato previsto (ver `dataKeys.ts`); solo dato, lo usa la Fase 3. */
  dataKey?: string;
  required: boolean;
  /** `today`: se rellena sola con la fecha de firma. */
  rule?: "today";
  source: TemplateSource;
  needsReview?: boolean;
  confidence?: number;
};

export type Variant = {
  fields: TemplateSignField[];
  textFields: TemplateTextField[];
};

/** Cómo se colocaron las iniciales «mismo lugar en todas las páginas» (para volver a editarlo). Solo metadato. */
export type InitialsLayout = {
  fromPage: number;
  toPage: number | "all" | number[];
  base: Rect;
  /** Hueco entre las iniciales de los dos firmantes, como fracción del ancho de `base` (0..0,5). */
  gap?: number;
  /** Ajuste fino por página (fracciones de página). */
  adjust: Array<{ page: number; dx: number; dy: number }>;
};

export type TemplateLayout = { initials?: InitialsLayout };

/** De dónde viene una plantilla que no se creó desde cero. */
export type TemplateOrigin =
  | { kind: "local"; legacyId: string; savedAt: string }
  | { kind: "clone"; fromTemplateId: string; fromDocumentId: string | null };

/** Lo que se puede editar de una plantilla (el contenido de una versión). */
export type TemplateContent = {
  name: string;
  roles: TemplateRole[];
  variants: { "1": Variant; "2": Variant };
  layout?: TemplateLayout;
};

export type DocTemplate = TemplateContent & {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  id: string;
  /** Documento de la biblioteca al que pertenece; `null` = «sin documento» (p. ej. migrada de `localStorage`). */
  documentId: string | null;
  /** Número de versión del CONTENIDO: sube en cada edición (1, 2, 3…). */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Versión del REGISTRO: sube en cada escritura; sirve para no pisar lo de otra pestaña. */
  rev: number;
  origin?: TemplateOrigin;
};

/** Una versión anterior guardada para deshacer. */
export type TemplateSnapshot = TemplateContent & { version: number; updatedAt: string };

/** Fila tal como se guarda en IndexedDB: la plantilla + sus versiones anteriores (más reciente primero). */
export type StoredTemplate = DocTemplate & { history: TemplateSnapshot[] };

/** Lo que se necesita para crear una plantilla; los campos opcionales toman su valor por defecto. */
export type TemplateDraft = {
  documentId: string | null;
  name: string;
  roles?: TemplateRole[];
  variants?: { "1"?: VariantInput; "2"?: VariantInput };
  layout?: TemplateLayout;
  origin?: TemplateOrigin;
};

export type SignFieldInput = Omit<TemplateSignField, "required" | "source"> & { required?: boolean; source?: TemplateSource };
export type TextFieldInput = Omit<TemplateTextField, "required" | "source" | "type" | "label"> & {
  type?: TextFieldType;
  label?: string;
  required?: boolean;
  source?: TemplateSource;
};
export type VariantInput = { fields?: SignFieldInput[]; textFields?: TextFieldInput[] };

/** Roles por defecto (el contrato típico: asegurado y co-asegurado). */
export const DEFAULT_ROLES: readonly TemplateRole[] = [
  { key: "signer1", label: "Asegurado" },
  { key: "signer2", label: "Co-asegurado" },
] as const;

export function emptyVariant(): Variant {
  return { fields: [], textFields: [] };
}
