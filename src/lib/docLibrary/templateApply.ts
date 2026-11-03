import type { DetectedField } from "../pdf/detectFields";
import type { SignatureField } from "../pdf/sign";
import { DATA_KEY_PATTERN } from "./dataKeys";
import {
  TEMPLATE_LIMITS,
  type DocTemplate,
  type Rect,
  type SignFieldType,
  type TemplateDraft,
  type TemplateSignField,
  type TemplateTextField,
  type TextFieldType,
  type Variant,
  type VariantKey,
} from "./templateTypes";

/**
 * Aplicar una plantilla a un documento y clonarla a otro (Fase 2, U2.2). Puro: sin IndexedDB.
 *
 * `applyTemplate` convierte UNA variante (1 o 2 firmantes) al formato que ya usa Firmar HOY (sin cambiar
 * `SignToolClient.tsx`):
 *   - `fields`      → `SignatureField[]` (`{ id, signerId, pageIndex, type, rect }`), listos para `docState.fields`;
 *   - `textFields`  → `DetectedField[]` con `source: "manual"` (el mismo patrón que `instantiateTemplate` de
 *                     `signTemplates.ts`: el tipo `"text"` no se escribe, la ausencia ya significa texto libre).
 * Los ids se acuñan nuevos (`mintFieldId`/`mintTextFieldId`; por defecto contadores `tpl-s-N`/`tpl-t-N`): nunca se
 * reutilizan los de la plantilla, que podrían chocar con los del documento. Lo que no se pueda aplicar solo NO se pierde:
 * va a `reviewFields` para que la interfaz lo ofrezca como «Revisar».
 */

export type ApplyOptions = {
  signers: 1 | 2;
  /**
   * Por página de la PLANTILLA, la página del documento a la que se aplica (`MatchResult.mappedPages` de
   * `compareFingerprints`); `null` = sin correspondencia. Sin él, la identidad (misma página).
   */
  pageMapping?: ReadonlyArray<number | null>;
  /** Páginas de la plantilla (0-based) que hay que revisar: sus campos no se aplican solos (`MatchResult.reviewPages`). */
  reviewPages?: readonly number[];
  /** Atajo: `{ mappedPages, reviewPages }` de un `MatchResult`; `pageMapping`/`reviewPages` sueltos mandan sobre él. */
  match?: { mappedPages: ReadonlyArray<number | null>; reviewPages: readonly number[] };
  /** Páginas del documento: con la identidad, una página ≥ `pageCount` no existe y sus campos van a «Revisar». */
  pageCount?: number;
  /** El `signerId` real de cada rol (índice = `roleIndex`). Sin él se usa la `key` del rol de la plantilla. */
  roles?: ReadonlyArray<{ signerId: string }>;
  mintFieldId?: () => string;
  mintTextFieldId?: () => string;
};

export type ReviewReason = "needsReview" | "pageReview" | "noPageMatch" | "outOfRange";

/** Un campo que NO se aplicó solo: la interfaz lo muestra como «Revisar». */
export type ReviewField = {
  kind: "signature" | "text";
  reason: ReviewReason;
  /** Página en la plantilla. */
  templatePage: number;
  /** Página del documento a la que correspondería, o `null` si no hay. */
  documentPage: number | null;
  roleIndex?: number;
  type: SignFieldType | TextFieldType;
  rect: Rect;
  label?: string;
  templateFieldId?: string;
};

export type ApplyWarning =
  /** Solo hay variante de 2 firmantes y se pidió 1: se usaron los campos del firmante 1. */
  | { code: "fallbackFromTwoSigners"; droppedFields: number }
  /** Se pidieron 2 firmantes pero solo hay variante de 1: el firmante 2 queda sin campos. */
  | { code: "missingSecondSigner" }
  /** La plantilla no tiene ningún campo de firma ni de iniciales. */
  | { code: "noSignFields" };

export type ApplyResult = {
  fields: SignatureField[];
  textFields: DetectedField[];
  /** `required`/`group` de cada campo de firma aplicado, por su id nuevo. */
  fieldMeta: Record<string, { required: boolean; group?: string; templateFieldId?: string }>;
  /** Origen de dato, `required` y regla de cada campo de texto aplicado, por su id nuevo (lo usa la Fase 3). */
  textMeta: Record<string, { dataKey?: string; required: boolean; rule?: "today"; templateFieldId?: string }>;
  reviewFields: ReviewField[];
  /** Páginas de la plantilla CON campos que no tienen página correspondiente (no se aplicó nada de ellas). */
  skippedPages: number[];
  /** Páginas de la plantilla CON campos que se emparejaron pero hay que revisar (no se aplicó nada de ellas). */
  reviewPages: number[];
  /** Variante realmente usada. */
  variant: VariantKey;
  warnings: ApplyWarning[];
};

export function variantHasSignFields(variant: Variant): boolean {
  return variant.fields.length > 0;
}

export type VariantSelection = {
  key: VariantKey;
  variant: Variant;
  warnings: ApplyWarning[];
};

/**
 * Qué variante corresponde a `signers` firmantes. 2 firmantes → variante «2» (si no tiene firmas pero la «1» sí, se usa
 * la «1» y el firmante 2 queda sin campos, con aviso). 1 firmante → variante «1» (si no la hay pero la «2» sí, se usan
 * los campos del firmante 1 de la «2» y se descartan los del firmante 2 y los textos del asegurado 2, con aviso).
 */
export function selectVariant(template: Pick<DocTemplate, "variants">, signers: 1 | 2): VariantSelection {
  const one = template.variants["1"];
  const two = template.variants["2"];
  const warnings: ApplyWarning[] = [];
  if (signers === 2) {
    if (variantHasSignFields(two)) return { key: "2", variant: two, warnings };
    if (variantHasSignFields(one)) return { key: "1", variant: one, warnings: [{ code: "missingSecondSigner" }] };
    warnings.push({ code: "noSignFields" });
    return one.textFields.length > 0 && two.textFields.length === 0 ? { key: "1", variant: one, warnings } : { key: "2", variant: two, warnings };
  }
  if (variantHasSignFields(one)) return { key: "1", variant: one, warnings };
  if (variantHasSignFields(two)) {
    const keptFields = two.fields.filter((field) => field.roleIndex === 0);
    const keptText = two.textFields.filter((field) => field.dataKey !== "insuredName2");
    const dropped = two.fields.length - keptFields.length + (two.textFields.length - keptText.length);
    return { key: "2", variant: { fields: keptFields, textFields: keptText }, warnings: [{ code: "fallbackFromTwoSigners", droppedFields: dropped }] };
  }
  warnings.push({ code: "noSignFields" });
  return two.textFields.length > 0 && one.textFields.length === 0 ? { key: "2", variant: two, warnings } : { key: "1", variant: one, warnings };
}

function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** Aplica la variante que corresponde a `options.signers` al documento (ver cabecera del archivo). */
export function applyTemplate(template: Pick<DocTemplate, "variants" | "roles">, options: ApplyOptions): ApplyResult {
  const selection = selectVariant(template, options.signers);
  const mapping = options.pageMapping ?? options.match?.mappedPages;
  const reviewSet = new Set(options.reviewPages ?? options.match?.reviewPages ?? []);
  const mintField = options.mintFieldId ?? counter("tpl-s-");
  const mintText = options.mintTextFieldId ?? counter("tpl-t-");

  const fields: SignatureField[] = [];
  const textFields: DetectedField[] = [];
  const fieldMeta: ApplyResult["fieldMeta"] = {};
  const textMeta: ApplyResult["textMeta"] = {};
  const reviewFields: ReviewField[] = [];
  const skipped = new Set<number>();
  const reviewed = new Set<number>();

  /** Página del documento (o `null`) y por qué no se aplica, si no se aplica. */
  const place = (templatePage: number, needsReview: boolean | undefined): { documentPage: number | null; reason?: ReviewReason } => {
    let documentPage: number | null;
    if (mapping) {
      const mapped = templatePage < mapping.length ? mapping[templatePage] : null;
      documentPage = typeof mapped === "number" && Number.isInteger(mapped) && mapped >= 0 ? mapped : null;
      if (documentPage === null) return { documentPage, reason: "noPageMatch" };
    } else {
      documentPage = templatePage;
      if (options.pageCount !== undefined && templatePage >= options.pageCount) return { documentPage: null, reason: "outOfRange" };
    }
    if (options.pageCount !== undefined && documentPage >= options.pageCount) return { documentPage: null, reason: "outOfRange" };
    if (reviewSet.has(templatePage)) return { documentPage, reason: "pageReview" };
    if (needsReview) return { documentPage, reason: "needsReview" };
    return { documentPage };
  };

  const note = (reason: ReviewReason, templatePage: number): void => {
    if (reason === "noPageMatch" || reason === "outOfRange") skipped.add(templatePage);
    else if (reason === "pageReview") reviewed.add(templatePage);
  };

  for (const field of selection.variant.fields) {
    const placed = place(field.pageIndex, field.needsReview);
    if (placed.reason || placed.documentPage === null) {
      const reason = placed.reason ?? "noPageMatch";
      note(reason, field.pageIndex);
      reviewFields.push(toReviewSign(field, reason, placed.documentPage));
      continue;
    }
    const role = options.roles?.[field.roleIndex]?.signerId ?? template.roles[field.roleIndex]?.key ?? `signer${field.roleIndex + 1}`;
    const id = mintField();
    fields.push({ id, signerId: role, pageIndex: placed.documentPage, type: field.type, rect: { ...field.rect } });
    const meta: ApplyResult["fieldMeta"][string] = { required: field.required };
    if (field.group !== undefined) meta.group = field.group;
    if (field.id !== undefined) meta.templateFieldId = field.id;
    fieldMeta[id] = meta;
  }

  for (const field of selection.variant.textFields) {
    const placed = place(field.pageIndex, field.needsReview);
    if (placed.reason || placed.documentPage === null) {
      const reason = placed.reason ?? "noPageMatch";
      note(reason, field.pageIndex);
      reviewFields.push(toReviewText(field, reason, placed.documentPage));
      continue;
    }
    const id = mintText();
    const detected: DetectedField = {
      id,
      pageIndex: placed.documentPage,
      rect: { ...field.rect },
      source: "manual",
      confidence: "high",
    };
    if (field.label !== "") detected.label = field.label;
    if (field.type !== "text") detected.type = field.type;
    // El origen de dato de la plantilla es la ETIQUETA del campo (W3-A1): el campo nace etiquetado, listo para recordar y propagar.
    if (field.dataKey !== undefined && DATA_KEY_PATTERN.test(field.dataKey)) detected.tag = field.dataKey;
    textFields.push(detected);
    const meta: ApplyResult["textMeta"][string] = { required: field.required };
    if (field.dataKey !== undefined) meta.dataKey = field.dataKey;
    if (field.rule !== undefined) meta.rule = field.rule;
    if (field.id !== undefined) meta.templateFieldId = field.id;
    textMeta[id] = meta;
  }

  const sortPages = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
  return {
    fields,
    textFields,
    fieldMeta,
    textMeta,
    reviewFields,
    skippedPages: sortPages(skipped),
    reviewPages: sortPages(reviewed),
    variant: selection.key,
    warnings: selection.warnings,
  };
}

function toReviewSign(field: TemplateSignField, reason: ReviewReason, documentPage: number | null): ReviewField {
  const review: ReviewField = { kind: "signature", reason, templatePage: field.pageIndex, documentPage, roleIndex: field.roleIndex, type: field.type, rect: { ...field.rect } };
  if (field.id !== undefined) review.templateFieldId = field.id;
  return review;
}

function toReviewText(field: TemplateTextField, reason: ReviewReason, documentPage: number | null): ReviewField {
  const review: ReviewField = { kind: "text", reason, templatePage: field.pageIndex, documentPage, type: field.type, rect: { ...field.rect } };
  if (field.label !== "") review.label = field.label;
  if (field.id !== undefined) review.templateFieldId = field.id;
  return review;
}

/* ------------------------------------------------------------------ *
 * «Usar esta plantilla en otro documento»
 * ------------------------------------------------------------------ */

export type CloneOptions = {
  /** Documento destino (`null` = sin documento). */
  documentId: string | null;
  /** Por página de la PLANTILLA, la página del documento destino (`MatchResult.mappedPages`). */
  mappedPages: ReadonlyArray<number | null>;
  /** Páginas de la plantilla a revisar: sus campos se copian con `needsReview: true` (`MatchResult.reviewPages`). */
  reviewPages?: readonly number[];
  /** Páginas del documento destino: una página mapeada fuera de rango se trata como sin correspondencia. */
  targetPageCount?: number;
  name?: string;
};

export type CloneResult = {
  draft: TemplateDraft;
  /** Campos copiados. */
  kept: number;
  /** Campos copiados que quedaron marcados para revisar (página parecida, no igual). */
  flagged: number;
  /** Campos descartados porque su página no tiene correspondencia en el destino. */
  dropped: number;
  /** Páginas de la plantilla con campos que se descartaron. */
  droppedPages: number[];
};

/**
 * Copia una plantilla a OTRO documento casi igual, recolocando las páginas con `mappedPages`. Los campos de páginas sin
 * correspondencia se descartan (se cuentan); los de páginas «parecidas» se copian marcados `needsReview`. El diseño de
 * iniciales (`layout`) solo se conserva si el mapa es la identidad. Devuelve un BORRADOR (`createTemplate` lo guarda).
 */
export function cloneTemplate(template: DocTemplate, options: CloneOptions): CloneResult {
  const reviewSet = new Set(options.reviewPages ?? []);
  const droppedPages = new Set<number>();
  let kept = 0;
  let flagged = 0;
  let dropped = 0;

  const target = (page: number): number | null => {
    const mapped = page < options.mappedPages.length ? options.mappedPages[page] : null;
    if (typeof mapped !== "number" || !Number.isInteger(mapped) || mapped < 0 || mapped > TEMPLATE_LIMITS.maxPageIndex) return null;
    if (options.targetPageCount !== undefined && mapped >= options.targetPageCount) return null;
    return mapped;
  };

  const mapVariant = (variant: Variant): Variant => {
    const out: Variant = { fields: [], textFields: [] };
    for (const field of variant.fields) {
      const mapped = target(field.pageIndex);
      if (mapped === null) {
        dropped += 1;
        droppedPages.add(field.pageIndex);
        continue;
      }
      const copy: TemplateSignField = { ...field, rect: { ...field.rect }, pageIndex: mapped };
      if (reviewSet.has(field.pageIndex)) {
        copy.needsReview = true;
        flagged += 1;
      }
      kept += 1;
      out.fields.push(copy);
    }
    for (const field of variant.textFields) {
      const mapped = target(field.pageIndex);
      if (mapped === null) {
        dropped += 1;
        droppedPages.add(field.pageIndex);
        continue;
      }
      const copy: TemplateTextField = { ...field, rect: { ...field.rect }, pageIndex: mapped };
      if (reviewSet.has(field.pageIndex)) {
        copy.needsReview = true;
        flagged += 1;
      }
      kept += 1;
      out.textFields.push(copy);
    }
    return out;
  };

  const variants = { "1": mapVariant(template.variants["1"]), "2": mapVariant(template.variants["2"]) };
  const identity = options.mappedPages.every((mapped, page) => mapped === page);
  const suffix = " (copia)";
  const baseName = options.name ?? template.name;
  const name = options.name !== undefined ? baseName : baseName.slice(0, TEMPLATE_LIMITS.maxNameLength - suffix.length) + suffix;
  const draft: TemplateDraft = {
    documentId: options.documentId,
    name,
    roles: template.roles.map((role) => ({ ...role })),
    variants,
    origin: { kind: "clone", fromTemplateId: template.id, fromDocumentId: template.documentId },
  };
  if (identity && template.layout) draft.layout = structuredClone(template.layout);
  return { draft, kept, flagged, dropped, droppedPages: [...droppedPages].sort((a, b) => a - b) };
}
