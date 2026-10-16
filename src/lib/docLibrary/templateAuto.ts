import type { AutoField, AutoMapResult } from "../pdf/autoMapTypes";
import { TODAY_DATA_KEY, suggestDataKey } from "./dataKeys";
import { ID_PATTERN } from "./schema";
import {
  DEFAULT_ROLES,
  TEMPLATE_LIMITS,
  type Rect,
  type TemplateDraft,
  type TemplateRole,
  type TemplateSignField,
  type TemplateTextField,
  type Variant,
  type VariantKey,
} from "./templateTypes";

/**
 * Del automapeo (U2.8) a una plantilla (U2.2), y fusión de borradores cuando la persona edita (Fase 2).
 *
 * `templateFromAutoMap` convierte lo que el automapeo propuso en un BORRADOR de plantilla (`createTemplate` lo guarda):
 *   - `tier: "high"`   → campo normal; `tier: "review"` → campo con `needsReview: true` (no se aplica solo al cargar
 *     el documento: ver `applyTemplate`); `tier: "ignore"` → no entra.
 *   - firma/iniciales con `signerIndex` → `variants[<nº de firmantes>].fields` (`roleIndex = signerIndex`);
 *   - firma de la otra parte (sin `signerIndex`) → no tiene rol, no entra (se cuenta en `stats.noRole`);
 *   - fecha → campo de texto `date` con `rule: "today"` y `dataKey: "today"`; texto → campo `text` con el `dataKey`
 *     sugerido por la etiqueta (solo sugerencia).
 *   - `source: "auto"` en todos, con `confidence` y el id del automapeo (`am-<página>-<n>`) para poder fusionar.
 * Solo se rellena la variante pedida (la del nº de firmantes con que se automapeó); la otra queda vacía y
 * `applyTemplate` usará su respaldo hasta que la persona la configure.
 */

export type AutoTemplateOptions = {
  documentId: string | null;
  /** Con cuántos firmantes se automapeó (decide la variante que se rellena). */
  signers: 1 | 2;
  name?: string;
  roles?: TemplateRole[];
};

export type AutoTemplateStats = {
  /** Campos de firma/iniciales que entraron. */
  signFields: number;
  /** Campos de texto/fecha que entraron. */
  textFields: number;
  /** De ellos, los marcados para revisar (`tier: "review"`). */
  needsReview: number;
  /** Propuestas `ignore` (no entran). */
  ignored: number;
  /** Firmas sin firmante (la otra parte) o de un firmante que la variante no tiene: no entran. */
  noRole: number;
  /** Propuestas que no cupieron por el tope de campos de la variante. */
  overflow: number;
};

export type AutoTemplateResult = { draft: TemplateDraft; stats: AutoTemplateStats };

const DEFAULT_AUTO_NAME = "Plantilla automática";

function autoId(field: AutoField, used: Set<string>): string | undefined {
  if (!ID_PATTERN.test(field.id) || used.has(field.id)) return undefined;
  used.add(field.id);
  return field.id;
}

function clampLabel(label: string | undefined): string {
  if (!label) return "";
  // Sin controles ni marcas bidi (el esquema los rechaza); recortado al máximo.
  const clean = label.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, TEMPLATE_LIMITS.maxFieldLabelLength);
}

export function templateFromAutoMap(result: AutoMapResult, options: AutoTemplateOptions): AutoTemplateResult {
  const key: VariantKey = options.signers === 1 ? "1" : "2";
  const variant: Variant = { fields: [], textFields: [] };
  const stats: AutoTemplateStats = { signFields: 0, textFields: 0, needsReview: 0, ignored: 0, noRole: 0, overflow: 0 };
  const used = new Set<string>();

  for (const field of result.fields) {
    if (field.tier === "ignore") {
      stats.ignored += 1;
      continue;
    }
    if (variant.fields.length + variant.textFields.length >= TEMPLATE_LIMITS.maxFieldsPerVariant) {
      stats.overflow += 1;
      continue;
    }
    const review = field.tier === "review";
    if (field.type === "signature" || field.type === "initials") {
      if (field.signerIndex === undefined || field.signerIndex >= options.signers) {
        stats.noRole += 1;
        continue;
      }
      const sign: TemplateSignField = {
        roleIndex: field.signerIndex,
        pageIndex: field.pageIndex,
        type: field.type,
        rect: { ...field.rect },
        required: true,
        source: "auto",
        confidence: clamp01(field.confidence),
      };
      const id = autoId(field, used);
      if (id) sign.id = id;
      if (review) sign.needsReview = true;
      variant.fields.push(sign);
      stats.signFields += 1;
      if (review) stats.needsReview += 1;
      continue;
    }
    // Fecha o texto: sin rol, pero un campo de la firmante 2 con 1 firmante no tiene sentido.
    if (field.signerIndex !== undefined && field.signerIndex >= options.signers) {
      stats.noRole += 1;
      continue;
    }
    const label = clampLabel(field.label);
    const text: TemplateTextField =
      field.type === "date"
        ? { pageIndex: field.pageIndex, rect: { ...field.rect }, type: "date", label: label || "Fecha", dataKey: TODAY_DATA_KEY, required: false, rule: "today", source: "auto", confidence: clamp01(field.confidence) }
        : { pageIndex: field.pageIndex, rect: { ...field.rect }, type: "text", label, required: false, source: "auto", confidence: clamp01(field.confidence) };
    if (field.type === "text") {
      const dataKey = suggestDataKey(label);
      if (dataKey) text.dataKey = dataKey;
    }
    const id = autoId(field, used);
    if (id) text.id = id;
    if (review) text.needsReview = true;
    variant.textFields.push(text);
    stats.textFields += 1;
    if (review) stats.needsReview += 1;
  }

  const draft: TemplateDraft = {
    documentId: options.documentId,
    name: options.name ?? DEFAULT_AUTO_NAME,
    roles: options.roles ?? DEFAULT_ROLES.map((role) => ({ ...role })),
    variants: { [key]: variant },
  };
  return { draft, stats };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/* ------------------------------------------------------------------ *
 * Fusión de borradores
 * ------------------------------------------------------------------ */

type Mergeable = { variants: { "1": Variant; "2": Variant } };

export type MergeOptions = {
  /** Ids (del automapeo) que la persona quitó a propósito: no se vuelven a añadir. */
  dismissed?: readonly string[];
  /** Solapamiento mínimo (IoU) para considerar que dos campos del mismo tipo/rol/página son el mismo (por defecto 0,3). */
  minOverlap?: number;
};

export type MergeStats = {
  /** Campos de la propuesta nueva que se añadieron. */
  added: number;
  /** Campos de la propuesta nueva que ya estaban (mismo id o mismo sitio): se respetó la versión de la persona. */
  matched: number;
  /** Propuestas descartadas por estar en `dismissed`. */
  dismissed: number;
  /** Campos que no cupieron por el tope de la variante. */
  overflow: number;
};

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/**
 * Fusiona la edición de una persona (`edited`) con una propuesta nueva del automapeo (`fresh`). La edición MANDA:
 *   1. Todo lo que hay en `edited` se conserva tal cual (mover, borrar a mano y añadir a mano se respetan; un campo
 *      automático que ya no aparece en `fresh` también se conserva: pudo haberlo aceptado).
 *   2. Un campo de `fresh` se considera ya presente si `edited` tiene uno con el mismo id, o del mismo tipo, rol y página
 *      con solapamiento (IoU) ≥ `minOverlap`. No se duplica.
 *   3. Los demás de `fresh` se AÑADEN (con `source: "auto"`), salvo los ids de `dismissed`.
 * Devuelve las dos variantes fusionadas; no modifica las entradas.
 */
export function mergeTemplateDrafts(edited: Mergeable, fresh: Mergeable, options: MergeOptions = {}): { variants: { "1": Variant; "2": Variant }; stats: MergeStats } {
  const dismissed = new Set(options.dismissed ?? []);
  const minOverlap = options.minOverlap ?? 0.3;
  const stats: MergeStats = { added: 0, matched: 0, dismissed: 0, overflow: 0 };
  const merged: { "1": Variant; "2": Variant } = { "1": cloneVariant(edited.variants["1"]), "2": cloneVariant(edited.variants["2"]) };

  for (const key of ["1", "2"] as const) {
    const target = merged[key];
    const incoming = fresh.variants[key];
    const usedIds = new Set<string>([...target.fields, ...target.textFields].flatMap((field) => (field.id ? [field.id] : [])));

    const room = (): boolean => target.fields.length + target.textFields.length < TEMPLATE_LIMITS.maxFieldsPerVariant;

    for (const field of incoming.fields) {
      if (field.id && dismissed.has(field.id)) {
        stats.dismissed += 1;
        continue;
      }
      const present = target.fields.some((own) => (field.id !== undefined && own.id === field.id) || (own.type === field.type && own.roleIndex === field.roleIndex && own.pageIndex === field.pageIndex && iou(own.rect, field.rect) >= minOverlap));
      if (present) {
        stats.matched += 1;
        continue;
      }
      if (!room()) {
        stats.overflow += 1;
        continue;
      }
      const copy: TemplateSignField = { ...field, rect: { ...field.rect }, source: "auto" };
      if (copy.id !== undefined && usedIds.has(copy.id)) delete copy.id;
      else if (copy.id !== undefined) usedIds.add(copy.id);
      target.fields.push(copy);
      stats.added += 1;
    }

    for (const field of incoming.textFields) {
      if (field.id && dismissed.has(field.id)) {
        stats.dismissed += 1;
        continue;
      }
      const present = target.textFields.some((own) => (field.id !== undefined && own.id === field.id) || (own.type === field.type && own.pageIndex === field.pageIndex && iou(own.rect, field.rect) >= minOverlap));
      if (present) {
        stats.matched += 1;
        continue;
      }
      if (!room()) {
        stats.overflow += 1;
        continue;
      }
      const copy: TemplateTextField = { ...field, rect: { ...field.rect }, source: "auto" };
      if (copy.id !== undefined && usedIds.has(copy.id)) delete copy.id;
      else if (copy.id !== undefined) usedIds.add(copy.id);
      target.textFields.push(copy);
      stats.added += 1;
    }
  }
  return { variants: merged, stats };
}

function cloneVariant(variant: Variant): Variant {
  return { fields: variant.fields.map((field) => ({ ...field, rect: { ...field.rect } })), textFields: variant.textFields.map((field) => ({ ...field, rect: { ...field.rect } })) };
}

/**
 * Trazabilidad al guardar una edición: un campo `auto` que cambió de sitio, tipo, rol o página respecto a la versión
 * anterior pasa a `manual` (lo tocó una persona). Se compara por `id`; los campos sin id no se tocan. No modifica las
 * entradas.
 */
export function reconcileSources(previous: Mergeable, next: Mergeable): { "1": Variant; "2": Variant } {
  const result = { "1": cloneVariant(next.variants["1"]), "2": cloneVariant(next.variants["2"]) };
  for (const key of ["1", "2"] as const) {
    const before = previous.variants[key];
    const beforeSign = new Map(before.fields.flatMap((field) => (field.id ? [[field.id, field] as const] : [])));
    const beforeText = new Map(before.textFields.flatMap((field) => (field.id ? [[field.id, field] as const] : [])));
    for (const field of result[key].fields) {
      const old = field.id ? beforeSign.get(field.id) : undefined;
      if (field.source === "auto" && old && old.source === "auto" && (old.type !== field.type || old.roleIndex !== field.roleIndex || old.pageIndex !== field.pageIndex || !sameRect(old.rect, field.rect))) {
        field.source = "manual";
        delete field.confidence;
        delete field.needsReview;
      }
    }
    for (const field of result[key].textFields) {
      const old = field.id ? beforeText.get(field.id) : undefined;
      if (field.source === "auto" && old && old.source === "auto" && (old.type !== field.type || old.pageIndex !== field.pageIndex || !sameRect(old.rect, field.rect))) {
        field.source = "manual";
        delete field.confidence;
        delete field.needsReview;
      }
    }
  }
  return result;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
