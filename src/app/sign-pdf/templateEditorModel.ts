import type { DetectedField } from "@/lib/pdf/detectFields";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { signerColorAt, type SignatureField, type Signer } from "@/lib/pdf/sign";
import { TODAY_DATA_KEY } from "@/lib/docLibrary/dataKeys";
import { ID_PATTERN } from "@/lib/docLibrary/schema";
import { repeatInitials, initialsFieldId } from "@/lib/docLibrary/templateRepeat";
import { mergeTemplateDrafts, templateFromAutoMap } from "@/lib/docLibrary/templateAuto";
import {
  DEFAULT_ROLES,
  TEMPLATE_LIMITS,
  emptyVariant,
  type DocTemplate,
  type InitialsLayout,
  type Rect,
  type TemplateDraft,
  type TemplateRole,
  type TemplateSignField,
  type TemplateTextField,
  type Variant,
  type VariantKey,
} from "@/lib/docLibrary/templateTypes";

/*
 * Modelo PURO del editor de plantillas (Fase 2 · U2.3): el contenido que se edita, su historial de deshacer/rehacer y las
 * operaciones de alto nivel (repetir iniciales, igualar a la pagina anterior, copiar de una variante a otra, detectar
 * campos). Sin React ni IndexedDB: el lienzo (`DocumentCanvas`) y los paneles solo llaman a estas funciones.
 *
 * El lienzo habla de `SignatureField` (con `signerId`) y `DetectedField`; una plantilla habla de `roleIndex` y de campos
 * con `dataKey`/`rule`. Aqui se traduce de ida y vuelta (`projectVariant` / `foldSlots` / `foldTextFields`) conservando lo
 * que el lienzo no conoce (`required`, `dataKey`, `rule`, `confidence`...) por `id`.
 */

export type EditorContent = {
  name: string;
  /** Siempre DOS roles (la variante «1» solo usa el primero). */
  roles: TemplateRole[];
  variants: { "1": Variant; "2": Variant };
  layout?: InitialsLayout;
};

/* ------------------------------------------------------------------ *
 * Contenido inicial
 * ------------------------------------------------------------------ */

export function defaultRoles(language: "es" | "en"): TemplateRole[] {
  return language === "en"
    ? [
        { key: "signer1", label: "Insured" },
        { key: "signer2", label: "Co-insured" },
      ]
    : DEFAULT_ROLES.map((role) => ({ ...role }));
}

/** Dos roles completos: una plantilla con un solo rol recibe el segundo por defecto. */
export function fullRoles(roles: readonly TemplateRole[] | undefined, language: "es" | "en"): TemplateRole[] {
  const base = defaultRoles(language);
  const first = roles?.[0] ?? base[0];
  const second = roles?.[1] ?? { ...base[1], key: first.key === base[1].key ? "signer3" : base[1].key };
  return [{ ...first }, { ...second }];
}

function cloneVariant(variant: Variant): Variant {
  return {
    fields: variant.fields.map((field) => ({ ...field, rect: { ...field.rect } })),
    textFields: variant.textFields.map((field) => ({ ...field, rect: { ...field.rect } })),
  };
}

export type Minter = { sign: () => string; text: () => string };

function usedIds(variant: Variant): Set<string> {
  return new Set([...variant.fields, ...variant.textFields].flatMap((field) => (field.id ? [field.id] : [])));
}

/** Da un `id` unico a cada campo (el lienzo trabaja por id). Los que ya tienen uno lo conservan. */
export function ensureIds(variant: Variant, mint: Minter): Variant {
  const out = cloneVariant(variant);
  const seen = new Set<string>();
  for (const field of out.fields) {
    if (!field.id || !ID_PATTERN.test(field.id) || seen.has(field.id)) field.id = mint.sign();
    seen.add(field.id);
  }
  for (const field of out.textFields) {
    if (!field.id || !ID_PATTERN.test(field.id) || seen.has(field.id)) field.id = mint.text();
    seen.add(field.id);
  }
  return out;
}

export function contentFromTemplate(template: DocTemplate, language: "es" | "en", mint: Minter): EditorContent {
  return {
    name: template.name,
    roles: fullRoles(template.roles, language),
    variants: { "1": ensureIds(template.variants["1"], mint), "2": ensureIds(template.variants["2"], mint) },
    ...(template.layout?.initials ? { layout: structuredClone(template.layout.initials) } : {}),
  };
}

export function emptyContent(name: string, language: "es" | "en"): EditorContent {
  return { name, roles: defaultRoles(language), variants: { "1": emptyVariant(), "2": emptyVariant() } };
}

/** El borrador que entiende `createTemplate` / `saveTemplateVersion`. */
export function contentToDraft(content: EditorContent, documentId: string | null): TemplateDraft {
  return {
    documentId,
    name: content.name.trim(),
    roles: content.roles.map((role) => ({ ...role, label: role.label.trim() })),
    variants: { "1": cloneVariant(content.variants["1"]), "2": cloneVariant(content.variants["2"]) },
    ...(content.layout ? { layout: { initials: structuredClone(content.layout) } } : {}),
  };
}

export function signersOf(key: VariantKey): 1 | 2 {
  return key === "1" ? 1 : 2;
}

/* ------------------------------------------------------------------ *
 * Lienzo <-> variante
 * ------------------------------------------------------------------ */

/** Los firmantes que ve el lienzo: un rol por firmante de la variante. El `id` del firmante es la `key` del rol. */
export function canvasSigners(roles: readonly TemplateRole[], key: VariantKey): Signer[] {
  return roles.slice(0, signersOf(key)).map((role, index) => ({ id: role.key, name: role.label, color: signerColorAt(index) }));
}

export function projectVariant(variant: Variant, roles: readonly TemplateRole[]): { slots: SignatureField[]; textFields: DetectedField[] } {
  const slots: SignatureField[] = [];
  for (const field of variant.fields) {
    const role = roles[field.roleIndex];
    if (!role || !field.id) continue;
    slots.push({ id: field.id, signerId: role.key, pageIndex: field.pageIndex, type: field.type, rect: { ...field.rect } });
  }
  const textFields: DetectedField[] = variant.textFields.flatMap((field) => {
    if (!field.id) return [];
    const detected: DetectedField = {
      id: field.id,
      pageIndex: field.pageIndex,
      rect: { ...field.rect },
      source: "manual",
      confidence: "high",
    };
    if (field.label !== "") detected.label = field.label;
    if (field.type !== "text") detected.type = field.type;
    return [detected];
  });
  return { slots, textFields };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Un campo `auto` que la persona toco pasa a ser suyo (`manual`) y pierde la marca de revision. */
function takeOwnership<T extends { source: "auto" | "manual"; needsReview?: boolean; confidence?: number }>(field: T): T {
  if (field.source !== "auto") return field;
  const next = { ...field, source: "manual" as const };
  delete next.needsReview;
  delete next.confidence;
  return next;
}

/** Lo que el lienzo devuelve (huecos de firma) -> la variante. Conserva por `id` lo que el lienzo no conoce. */
export function foldSlots(variant: Variant, slots: readonly SignatureField[], roles: readonly TemplateRole[]): Variant {
  const before = new Map(variant.fields.map((field) => [field.id ?? "", field] as const));
  const fields: TemplateSignField[] = [];
  for (const slot of slots) {
    const roleIndex = roles.findIndex((role) => role.key === slot.signerId);
    if (roleIndex < 0) continue;
    const old = before.get(slot.id);
    const moved = !old || old.roleIndex !== roleIndex || old.pageIndex !== slot.pageIndex || old.type !== slot.type || !sameRect(old.rect, slot.rect);
    if (old && !moved) {
      fields.push(old);
      continue;
    }
    const base: TemplateSignField = old ?? { id: slot.id, roleIndex, pageIndex: slot.pageIndex, type: slot.type, rect: { ...slot.rect }, required: true, source: "manual" };
    fields.push(takeOwnership({ ...base, id: slot.id, roleIndex, pageIndex: slot.pageIndex, type: slot.type, rect: { ...slot.rect } }));
  }
  return { fields, textFields: variant.textFields };
}

/** Lo que el lienzo devuelve (campos de texto) -> la variante. */
export function foldTextFields(variant: Variant, fields: readonly DetectedField[]): Variant {
  const before = new Map(variant.textFields.map((field) => [field.id ?? "", field] as const));
  const textFields: TemplateTextField[] = [];
  for (const field of fields) {
    const type = field.type ?? "text";
    const old = before.get(field.id);
    const label = (field.label ?? "").slice(0, TEMPLATE_LIMITS.maxFieldLabelLength);
    if (old) {
      const changed = old.pageIndex !== field.pageIndex || old.type !== type || !sameRect(old.rect, field.rect) || old.label !== label;
      if (!changed) {
        textFields.push(old);
        continue;
      }
      // Cambiar a «fecha» estrena la regla «hoy»; salir de «fecha» la quita.
      const next: TemplateTextField = { ...old, pageIndex: field.pageIndex, type, rect: { ...field.rect }, label };
      if (type === "date" && old.type !== "date" && next.rule === undefined && next.dataKey === undefined) {
        next.rule = "today";
        next.dataKey = TODAY_DATA_KEY;
      }
      if (type !== "date" && old.type === "date" && next.rule === "today") {
        delete next.rule;
        if (next.dataKey === TODAY_DATA_KEY) delete next.dataKey;
      }
      textFields.push(takeOwnership(next));
      continue;
    }
    const created: TemplateTextField = { id: field.id, pageIndex: field.pageIndex, type, rect: { ...field.rect }, label, required: false, source: "manual" };
    if (type === "date") {
      created.rule = "today";
      created.dataKey = TODAY_DATA_KEY;
    }
    textFields.push(created);
  }
  return { fields: variant.fields, textFields };
}

/* ------------------------------------------------------------------ *
 * Historial (deshacer / rehacer)
 * ------------------------------------------------------------------ */

export const HISTORY_LIMIT = 100;
/** Ventana en la que varios cambios del MISMO campo (un arrastre) cuentan como uno solo. */
export const COALESCE_MS = 700;

export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Con que se hizo el ultimo cambio (para fundir un arrastre en un solo paso). */
  lastKey: string | null;
  lastAt: number;
};

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

export function commitHistory<T>(history: History<T>, next: T, options: { key?: string | null; now?: number } = {}): History<T> {
  if (next === history.present) return history;
  const now = options.now ?? Date.now();
  const key = options.key ?? null;
  if (key !== null && history.lastKey === key && now - history.lastAt <= COALESCE_MS && history.past.length > 0) {
    return { ...history, present: next, future: [], lastAt: now };
  }
  const past = [...history.past, history.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], lastKey: null, lastAt: 0 };
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1), lastKey: null, lastAt: 0 };
}

/** Clave de fusion de un cambio: los ids de campos que cambiaron respecto a `before` (si es UNO solo, un arrastre). */
export function changeKey(before: Variant, after: Variant): string | null {
  const changed: string[] = [];
  const index = (variant: Variant) => new Map([...variant.fields, ...variant.textFields].map((field) => [field.id ?? "", JSON.stringify(field)] as const));
  const a = index(before);
  const b = index(after);
  if (a.size !== b.size) return null;
  for (const [id, json] of b) {
    if (!a.has(id)) return null;
    if (a.get(id) !== json) changed.push(id);
  }
  return changed.length === 1 ? `edit:${changed[0]}` : null;
}

/* ------------------------------------------------------------------ *
 * Iniciales
 * ------------------------------------------------------------------ */

function union(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
}

/**
 * La LINEA de iniciales de una pagina: el rectangulo que cubre las iniciales ya colocadas ahi (de los firmantes de la
 * variante). Con dos firmantes y un solo hueco colocado, ese hueco ES la linea completa (se partira en dos mitades).
 * `null` si la pagina no tiene iniciales.
 */
export function initialsBase(variant: Variant, signers: 1 | 2, page: number): Rect | null {
  const own = variant.fields.filter((field) => field.type === "initials" && field.pageIndex === page && field.roleIndex < signers);
  return own.length === 0 ? null : union(own.map((field) => field.rect));
}

/** Paginas (0-based) donde la variante tiene iniciales, en orden. */
export function initialsPages(variant: Variant, signers: 1 | 2): number[] {
  return [...new Set(variant.fields.filter((field) => field.type === "initials" && field.roleIndex < signers).map((field) => field.pageIndex))].sort((a, b) => a - b);
}

export type RepeatOutcome = { content: EditorContent; pages: number[]; skippedPages: number[] } | { error: "noBase" | "range" | "tooMany" };

/**
 * «Repetir iniciales» desde la pagina `fromPageOfBase` (la que lleva la linea colocada) a las paginas `fromPage..toPage`
 * (0-based, `toPage` incluida) o a todas. Con 2 firmantes: una al lado de la otra, firmante 1 a la izquierda.
 */
export function repeatInitialsIn(
  content: EditorContent,
  key: VariantKey,
  options: { basePage: number; fromPage?: number; toPage?: number | "all"; pageCount: number },
): RepeatOutcome {
  const signers = signersOf(key);
  const variant = content.variants[key];
  const base = initialsBase(variant, signers, options.basePage);
  if (!base) return { error: "noBase" };
  const fromPage = options.fromPage ?? 0;
  const toPage = options.toPage ?? "all";
  if (toPage !== "all" && (!Number.isInteger(toPage) || toPage < fromPage)) return { error: "range" };
  if (!Number.isInteger(fromPage) || fromPage < 0 || fromPage >= options.pageCount) return { error: "range" };
  try {
    const result = repeatInitials(variant, { signers, base, fromPage, toPage, pageCount: options.pageCount, source: "manual" });
    return {
      content: { ...content, variants: { ...content.variants, [key]: result.variant }, layout: result.layout },
      pages: result.pages,
      skippedPages: result.skippedPages,
    };
  } catch {
    return { error: "tooMany" };
  }
}

/** «Igualar a la pagina anterior»: las iniciales de `page` quedan donde estan las de `page - 1`. */
export function matchPreviousPage(content: EditorContent, key: VariantKey, page: number): EditorContent | null {
  if (page < 1) return null;
  const signers = signersOf(key);
  const variant = content.variants[key];
  const previous = variant.fields.filter((field) => field.type === "initials" && field.pageIndex === page - 1 && field.roleIndex < signers);
  if (previous.length === 0) return null;
  const kept = variant.fields.filter((field) => !(field.type === "initials" && field.pageIndex === page && field.roleIndex < signers));
  const copies: TemplateSignField[] = previous.map((field) => ({
    id: initialsFieldId(page, field.roleIndex),
    roleIndex: field.roleIndex,
    pageIndex: page,
    type: "initials",
    rect: { ...field.rect },
    required: field.required,
    source: "manual",
  }));
  // Un id propio de otra pagina nunca choca con el de esta (`ini-p<pagina>-r<rol>`), salvo que el campo ya fuera uno de estos.
  const taken = new Set(kept.flatMap((field) => (field.id ? [field.id] : [])));
  const fields = [...kept, ...copies.filter((copy) => !taken.has(copy.id ?? ""))].sort((a, b) => a.pageIndex - b.pageIndex || a.roleIndex - b.roleIndex);
  return { ...content, variants: { ...content.variants, [key]: { fields, textFields: variant.textFields } } };
}

/** ¿La pagina anterior tiene iniciales que igualar? */
export function canMatchPrevious(content: EditorContent, key: VariantKey, page: number): boolean {
  return page >= 1 && initialsBase(content.variants[key], signersOf(key), page - 1) !== null;
}

/* ------------------------------------------------------------------ *
 * De una variante a la otra
 * ------------------------------------------------------------------ */

/**
 * Copia lo configurado en la variante `from` a la variante vacia `to`. De 1 a 2: las firmas y los textos pasan tal cual
 * y las iniciales se REPARTEN en dos mitades (firmante 1 a la izquierda); de 2 a 1: solo lo del firmante 1 (y las
 * iniciales del 1 ocupan la linea entera). Devuelve `null` si no hay nada que copiar.
 */
export function copyVariant(content: EditorContent, from: VariantKey, to: VariantKey, pageCount: number): EditorContent | null {
  if (from === to) return null;
  const source = content.variants[from];
  if (source.fields.length + source.textFields.length === 0) return null;
  const target: Variant = { fields: [], textFields: source.textFields.filter((field) => to === "2" || field.dataKey !== "insuredName2").map((field) => ({ ...field, rect: { ...field.rect } })) };
  for (const field of source.fields) {
    if (field.type === "initials") continue;
    if (field.roleIndex >= signersOf(to)) continue;
    target.fields.push({ ...field, rect: { ...field.rect } });
  }
  let next: Variant = target;
  const pages = initialsPages(source, signersOf(from));
  const toSigners = signersOf(to);
  if (pages.length > 0) {
    for (const page of pages) {
      const base = initialsBase(source, signersOf(from), page);
      if (!base || page >= pageCount) continue;
      try {
        next = repeatInitials(next, { signers: toSigners, base, fromPage: page, toPage: page, pageCount, source: "manual" }).variant;
      } catch {
        // Una pagina con un rectangulo raro no impide copiar el resto.
      }
    }
  }
  return { ...content, variants: { ...content.variants, [to]: next } };
}

/* ------------------------------------------------------------------ *
 * Detectar campos automaticamente
 * ------------------------------------------------------------------ */

/** Una propuesta de confianza media: se ofrece, no se coloca sola. */
export type Suggestion = {
  /** Estable dentro de una pasada. */
  id: string;
  variant: VariantKey;
  field: { kind: "sign"; value: TemplateSignField } | { kind: "text"; value: TemplateTextField };
};

export type DetectOutcome = {
  content: EditorContent;
  suggestions: Suggestion[];
  placed: number;
  suggested: number;
  ignored: number;
};

/**
 * Mezcla lo que propone el automapeo con lo que ya hay: lo de confianza ALTA se coloca (sin duplicar lo que la persona ya
 * puso: `mergeTemplateDrafts`); lo de revision pasa a `suggestions` para aceptarlo una a una.
 */
export function applyDetection(
  content: EditorContent,
  key: VariantKey,
  result: AutoMapResult,
  options: { dismissed?: readonly string[] } = {},
): DetectOutcome {
  const signers = signersOf(key);
  const { draft, stats } = templateFromAutoMap(result, { documentId: null, signers, roles: content.roles });
  const fresh = draft.variants?.[key] ?? emptyVariant();
  const solid: Variant = {
    fields: ((fresh.fields ?? []) as TemplateSignField[]).filter((f) => !f.needsReview),
    textFields: ((fresh.textFields ?? []) as TemplateTextField[]).filter((f) => !f.needsReview),
  };
  const review: Suggestion[] = [
    ...(fresh.fields ?? []).filter((f) => f.needsReview).map((f, index) => ({ id: `s-${f.id ?? `f${index}`}`, variant: key, field: { kind: "sign" as const, value: f as TemplateSignField } })),
    ...(fresh.textFields ?? []).filter((f) => f.needsReview).map((f, index) => ({ id: `s-${f.id ?? `t${index}`}`, variant: key, field: { kind: "text" as const, value: f as TemplateTextField } })),
  ];
  const empty = emptyVariant();
  const merged = mergeTemplateDrafts(
    { variants: { "1": key === "1" ? content.variants["1"] : empty, "2": key === "2" ? content.variants["2"] : empty } },
    { variants: { "1": key === "1" ? solid : empty, "2": key === "2" ? solid : empty } },
    { dismissed: options.dismissed },
  );
  const placedVariant = merged.variants[key];
  return {
    content: { ...content, variants: { ...content.variants, [key]: placedVariant } },
    suggestions: review,
    placed: merged.stats.added,
    suggested: review.length,
    ignored: stats.ignored + stats.noRole,
  };
}

/** Acepta una sugerencia: pasa a ser un campo de la variante (sin la marca de revision), con id propio. */
export function acceptSuggestion(content: EditorContent, suggestion: Suggestion, mint: Minter): EditorContent {
  const variant = cloneVariant(content.variants[suggestion.variant]);
  const taken = usedIds(variant);
  if (suggestion.field.kind === "sign") {
    const value: TemplateSignField = { ...suggestion.field.value, rect: { ...suggestion.field.value.rect } };
    delete value.needsReview;
    value.id = value.id && !taken.has(value.id) ? value.id : mint.sign();
    variant.fields.push(value);
  } else {
    const value: TemplateTextField = { ...suggestion.field.value, rect: { ...suggestion.field.value.rect } };
    delete value.needsReview;
    value.id = value.id && !taken.has(value.id) ? value.id : mint.text();
    variant.textFields.push(value);
  }
  if (variant.fields.length + variant.textFields.length > TEMPLATE_LIMITS.maxFieldsPerVariant) return content;
  return { ...content, variants: { ...content.variants, [suggestion.variant]: variant } };
}

/** Cuantas paginas distintas tienen algun campo en la variante. */
export function pagesWithFields(variant: Variant): number {
  return new Set([...variant.fields.map((f) => f.pageIndex), ...variant.textFields.map((f) => f.pageIndex)]).size;
}

export function fieldCount(variant: Variant): number {
  return variant.fields.length + variant.textFields.length;
}

/** ¿Hay algo que guardar? Una plantilla sin ninguna firma ni iniciales no sirve para firmar. */
export function hasSignFields(content: EditorContent): boolean {
  return content.variants["1"].fields.length > 0 || content.variants["2"].fields.length > 0;
}

/** Edita un campo de texto de la variante (etiqueta, origen de dato, regla «hoy»). */
export function patchTextField(
  content: EditorContent,
  key: VariantKey,
  id: string,
  patch: { label?: string; dataKey?: string | null; rule?: "today" | null; required?: boolean },
): EditorContent {
  const variant = content.variants[key];
  const textFields = variant.textFields.map((field) => {
    if (field.id !== id) return field;
    const next: TemplateTextField = { ...field };
    if (patch.label !== undefined) next.label = patch.label.slice(0, TEMPLATE_LIMITS.maxFieldLabelLength);
    if (patch.dataKey !== undefined) {
      if (patch.dataKey === null || patch.dataKey === "") delete next.dataKey;
      else next.dataKey = patch.dataKey;
    }
    if (patch.rule !== undefined) {
      if (patch.rule === null) delete next.rule;
      else next.rule = patch.rule;
    }
    if (patch.required !== undefined) next.required = patch.required;
    return takeOwnership(next);
  });
  return { ...content, variants: { ...content.variants, [key]: { fields: variant.fields, textFields } } };
}

export function setRoleLabel(content: EditorContent, index: number, label: string): EditorContent {
  if (index < 0 || index > 1) return content;
  const roles = content.roles.map((role, i) => (i === index ? { ...role, label: label.slice(0, TEMPLATE_LIMITS.maxRoleLabelLength) } : role));
  return { ...content, roles };
}
