import { DATA_KEY_PATTERN } from "./dataKeys";
import { ID_PATTERN, cleanText, isIsoDate, isRecord } from "./schema";
import {
  DEFAULT_ROLES,
  RECT_EPSILON,
  SIGN_FIELD_TYPES,
  TEMPLATE_LIMITS,
  TEMPLATE_SCHEMA_VERSION,
  TEXT_FIELD_TYPES,
  emptyVariant,
  type DocTemplate,
  type InitialsLayout,
  type Rect,
  type SignFieldType,
  type StoredTemplate,
  type TemplateContent,
  type TemplateLayout,
  type TemplateOrigin,
  type TemplateRole,
  type TemplateSignField,
  type TemplateSnapshot,
  type TemplateDraft,
  type TemplateSource,
  type TemplateTextField,
  type TextFieldType,
  type Variant,
  type VariantInput,
  type VariantKey,
} from "./templateTypes";

/**
 * Validación ESTRICTA de plantillas (IndexedDB e importación). Cada `parse*` devuelve una COPIA hecha campo a campo con
 * una lista blanca (lo desconocido no pasa) o `null`. Reglas de seguridad:
 *  - Toda lectura de una propiedad de datos externos pasa por `own()` (`Object.hasOwn`): una propiedad heredada, o una
 *    clave `__proto__`/`constructor` puesta por JSON hostil, nunca se interpreta como dato.
 *  - Nada recursivo sobre la entrada: el esquema tiene una profundidad fija, así que JSON muy anidado no se recorre.
 *  - Longitudes y cantidades acotadas (`TEMPLATE_LIMITS`); rectángulos finitos y dentro de 0..1.
 */

/** Lee una propiedad PROPIA (nunca heredada). */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const GROUP_PATTERN = /^[A-Z]{1,3}$/;
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1 + RECT_EPSILON;
}

/** Rectángulo normalizado: cuatro números finitos, ancho y alto > 0, todo dentro de 0..1. */
export function parseRect(raw: unknown): Rect | null {
  if (!isRecord(raw)) return null;
  const x = own(raw, "x");
  const y = own(raw, "y");
  const width = own(raw, "width");
  const height = own(raw, "height");
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  if (!isUnit(x) || !isUnit(y) || !(width > 0) || !(height > 0) || !isUnit(width) || !isUnit(height)) return null;
  if (!isUnit(x + width) || !isUnit(y + height)) return null;
  return { x, y, width, height };
}

function parseSource(raw: unknown): TemplateSource | null {
  return raw === "auto" || raw === "manual" ? raw : null;
}

function parseOptionalId(raw: unknown): { ok: true; id?: string } | { ok: false } {
  if (raw === undefined) return { ok: true };
  return typeof raw === "string" && ID_PATTERN.test(raw) ? { ok: true, id: raw } : { ok: false };
}

function parseConfidence(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? { ok: true, value: raw } : { ok: false };
}

function parseSignField(raw: unknown, roleCount: number, maxRole: number): TemplateSignField | null {
  if (!isRecord(raw)) return null;
  const roleIndex = own(raw, "roleIndex");
  const pageIndex = own(raw, "pageIndex");
  const type = own(raw, "type");
  if (!isInt(roleIndex, 0, Math.min(roleCount, maxRole + 1) - 1)) return null;
  if (!isInt(pageIndex, 0, TEMPLATE_LIMITS.maxPageIndex)) return null;
  if (typeof type !== "string" || !SIGN_FIELD_TYPES.includes(type as SignFieldType)) return null;
  const rect = parseRect(own(raw, "rect"));
  if (!rect) return null;
  const required = own(raw, "required");
  if (typeof required !== "boolean") return null;
  const source = parseSource(own(raw, "source"));
  if (!source) return null;
  const id = parseOptionalId(own(raw, "id"));
  if (!id.ok) return null;
  const group = own(raw, "group");
  if (group !== undefined && !(typeof group === "string" && GROUP_PATTERN.test(group))) return null;
  const needsReview = own(raw, "needsReview");
  if (needsReview !== undefined && typeof needsReview !== "boolean") return null;
  const confidence = parseConfidence(own(raw, "confidence"));
  if (!confidence.ok) return null;
  const field: TemplateSignField = { roleIndex, pageIndex, type: type as SignFieldType, rect, required, source };
  if (id.id !== undefined) field.id = id.id;
  if (group !== undefined) field.group = group as string;
  if (needsReview !== undefined) field.needsReview = needsReview;
  if (confidence.value !== undefined) field.confidence = confidence.value;
  return field;
}

function parseTextField(raw: unknown): TemplateTextField | null {
  if (!isRecord(raw)) return null;
  const pageIndex = own(raw, "pageIndex");
  const type = own(raw, "type");
  if (!isInt(pageIndex, 0, TEMPLATE_LIMITS.maxPageIndex)) return null;
  if (typeof type !== "string" || !TEXT_FIELD_TYPES.includes(type as TextFieldType)) return null;
  const rect = parseRect(own(raw, "rect"));
  if (!rect) return null;
  const label = cleanText(own(raw, "label"), TEMPLATE_LIMITS.maxFieldLabelLength);
  if (label === null) return null;
  const required = own(raw, "required");
  if (typeof required !== "boolean") return null;
  const source = parseSource(own(raw, "source"));
  if (!source) return null;
  const id = parseOptionalId(own(raw, "id"));
  if (!id.ok) return null;
  const dataKey = own(raw, "dataKey");
  if (dataKey !== undefined && !(typeof dataKey === "string" && DATA_KEY_PATTERN.test(dataKey))) return null;
  const rule = own(raw, "rule");
  if (rule !== undefined && rule !== "today") return null;
  const needsReview = own(raw, "needsReview");
  if (needsReview !== undefined && typeof needsReview !== "boolean") return null;
  const confidence = parseConfidence(own(raw, "confidence"));
  if (!confidence.ok) return null;
  const field: TemplateTextField = { pageIndex, rect, type: type as TextFieldType, label, required, source };
  if (id.id !== undefined) field.id = id.id;
  if (dataKey !== undefined) field.dataKey = dataKey as string;
  if (rule !== undefined) field.rule = "today";
  if (needsReview !== undefined) field.needsReview = needsReview;
  if (confidence.value !== undefined) field.confidence = confidence.value;
  return field;
}

/** Una variante: ≤ 500 campos en total, ids únicos y `roleIndex` acorde con el nº de firmantes de la variante. */
export function parseVariant(raw: unknown, key: VariantKey, roleCount: number): Variant | null {
  if (!isRecord(raw)) return null;
  const fieldsRaw = own(raw, "fields");
  const textRaw = own(raw, "textFields");
  if (!Array.isArray(fieldsRaw) || !Array.isArray(textRaw)) return null;
  if (fieldsRaw.length + textRaw.length > TEMPLATE_LIMITS.maxFieldsPerVariant) return null;
  const maxRole = Number(key) - 1;
  const ids = new Set<string>();
  const fields: TemplateSignField[] = [];
  for (const item of fieldsRaw) {
    const field = parseSignField(item, roleCount, maxRole);
    if (!field) return null;
    if (field.id !== undefined) {
      if (ids.has(field.id)) return null;
      ids.add(field.id);
    }
    fields.push(field);
  }
  const textFields: TemplateTextField[] = [];
  for (const item of textRaw) {
    const field = parseTextField(item);
    if (!field) return null;
    if (field.id !== undefined) {
      if (ids.has(field.id)) return null;
      ids.add(field.id);
    }
    textFields.push(field);
  }
  return { fields, textFields };
}

export function parseRoles(raw: unknown): TemplateRole[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  const roles: TemplateRole[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const key = own(item, "key");
    const label = cleanText(own(item, "label"), TEMPLATE_LIMITS.maxRoleLabelLength);
    if (typeof key !== "string" || !ROLE_KEY_PATTERN.test(key) || label === null || label.trim() === "") return null;
    if (roles.some((role) => role.key === key)) return null;
    roles.push({ key, label });
  }
  return roles;
}

function parseAdjustList(raw: unknown): InitialsLayout["adjust"] | null {
  if (!Array.isArray(raw) || raw.length > TEMPLATE_LIMITS.maxLayoutPages) return null;
  const out: InitialsLayout["adjust"] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const page = own(item, "page");
    const dx = own(item, "dx");
    const dy = own(item, "dy");
    if (!isInt(page, 0, TEMPLATE_LIMITS.maxPageIndex) || seen.has(page)) return null;
    if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
    seen.add(page);
    out.push({ page, dx, dy });
  }
  return out;
}

function parseInitialsLayout(raw: unknown): InitialsLayout | null {
  if (!isRecord(raw)) return null;
  const fromPage = own(raw, "fromPage");
  if (!isInt(fromPage, 0, TEMPLATE_LIMITS.maxPageIndex)) return null;
  const base = parseRect(own(raw, "base"));
  if (!base) return null;
  const toRaw = own(raw, "toPage");
  let toPage: InitialsLayout["toPage"];
  if (toRaw === "all") toPage = "all";
  else if (isInt(toRaw, 0, TEMPLATE_LIMITS.maxPageIndex)) toPage = toRaw;
  else if (Array.isArray(toRaw) && toRaw.length <= TEMPLATE_LIMITS.maxLayoutPages && toRaw.every((page) => isInt(page, 0, TEMPLATE_LIMITS.maxPageIndex))) {
    toPage = [...(toRaw as number[])];
  } else return null;
  const gap = own(raw, "gap");
  if (gap !== undefined && !(typeof gap === "number" && Number.isFinite(gap) && gap >= 0 && gap <= 0.5)) return null;
  const adjust = parseAdjustList(own(raw, "adjust"));
  if (!adjust) return null;
  const layout: InitialsLayout = { fromPage, toPage, base, adjust };
  if (gap !== undefined) layout.gap = gap as number;
  return layout;
}

function parseLayout(raw: unknown): TemplateLayout | null {
  if (!isRecord(raw)) return null;
  const initialsRaw = own(raw, "initials");
  if (initialsRaw === undefined) return {};
  const initials = parseInitialsLayout(initialsRaw);
  return initials ? { initials } : null;
}

function parseOrigin(raw: unknown): TemplateOrigin | null {
  if (!isRecord(raw)) return null;
  const kind = own(raw, "kind");
  if (kind === "local") {
    const legacyId = cleanText(own(raw, "legacyId"), 80);
    const savedAt = own(raw, "savedAt");
    if (legacyId === null || legacyId === "" || !isIsoDate(savedAt)) return null;
    return { kind: "local", legacyId, savedAt };
  }
  if (kind === "clone") {
    const fromTemplateId = own(raw, "fromTemplateId");
    const fromDocumentId = own(raw, "fromDocumentId");
    if (typeof fromTemplateId !== "string" || !ID_PATTERN.test(fromTemplateId)) return null;
    if (fromDocumentId !== null && !(typeof fromDocumentId === "string" && ID_PATTERN.test(fromDocumentId))) return null;
    return { kind: "clone", fromTemplateId, fromDocumentId };
  }
  return null;
}

/** Nombre de plantilla: sin controles ni marcas bidi, no vacío (tras recortar) y ≤ 120 caracteres. */
export function parseTemplateName(raw: unknown): string | null {
  const name = cleanText(raw, TEMPLATE_LIMITS.maxNameLength);
  return name === null || name.trim() === "" ? null : name;
}

/** El contenido editable de una versión (nombre, roles, variantes, diseño). */
export function parseContent(raw: unknown): TemplateContent | null {
  if (!isRecord(raw)) return null;
  const name = parseTemplateName(own(raw, "name"));
  const roles = parseRoles(own(raw, "roles"));
  if (name === null || !roles) return null;
  const variantsRaw = own(raw, "variants");
  if (!isRecord(variantsRaw)) return null;
  const one = parseVariant(own(variantsRaw, "1"), "1", roles.length);
  const two = parseVariant(own(variantsRaw, "2"), "2", roles.length);
  if (!one || !two) return null;
  const content: TemplateContent = { name, roles, variants: { "1": one, "2": two } };
  const layoutRaw = own(raw, "layout");
  if (layoutRaw !== undefined) {
    const layout = parseLayout(layoutRaw);
    if (!layout) return null;
    if (layout.initials) content.layout = layout;
  }
  return content;
}

function parseSnapshot(raw: unknown): TemplateSnapshot | null {
  if (!isRecord(raw)) return null;
  const content = parseContent(raw);
  const version = own(raw, "version");
  const updatedAt = own(raw, "updatedAt");
  if (!content || !isInt(version, 1, Number.MAX_SAFE_INTEGER) || !isIsoDate(updatedAt)) return null;
  return { ...content, version, updatedAt };
}

/** Una plantilla completa tal como sale de IndexedDB o de un paquete (sin su historial). */
export function parseTemplate(raw: unknown): DocTemplate | null {
  if (!isRecord(raw)) return null;
  if (own(raw, "schemaVersion") !== TEMPLATE_SCHEMA_VERSION) return null;
  const id = own(raw, "id");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  const documentId = own(raw, "documentId");
  if (documentId !== null && !(typeof documentId === "string" && ID_PATTERN.test(documentId))) return null;
  const content = parseContent(raw);
  if (!content) return null;
  const version = own(raw, "version");
  const rev = own(raw, "rev");
  const createdAt = own(raw, "createdAt");
  const updatedAt = own(raw, "updatedAt");
  if (!isInt(version, 1, Number.MAX_SAFE_INTEGER) || !isInt(rev, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isIsoDate(createdAt) || !isIsoDate(updatedAt)) return null;
  const template: DocTemplate = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id,
    documentId: documentId as string | null,
    ...content,
    version,
    createdAt,
    updatedAt,
    rev,
  };
  const originRaw = own(raw, "origin");
  if (originRaw !== undefined) {
    const origin = parseOrigin(originRaw);
    if (!origin) return null;
    template.origin = origin;
  }
  return template;
}

/** La fila completa: plantilla + historial (≤ `maxVersions - 1` versiones anteriores, números distintos y menores). */
export function parseStoredTemplate(raw: unknown): StoredTemplate | null {
  const template = parseTemplate(raw);
  if (!template || !isRecord(raw)) return null;
  const historyRaw = own(raw, "history");
  if (!Array.isArray(historyRaw) || historyRaw.length > TEMPLATE_LIMITS.maxVersions - 1) return null;
  const history: TemplateSnapshot[] = [];
  const seen = new Set<number>([template.version]);
  for (const item of historyRaw) {
    const snapshot = parseSnapshot(item);
    if (!snapshot || seen.has(snapshot.version) || snapshot.version > template.version) return null;
    seen.add(snapshot.version);
    history.push(snapshot);
  }
  return { ...template, history };
}

function completeVariant(input: VariantInput | undefined): unknown {
  if (input === undefined) return emptyVariant();
  if (!isRecord(input)) return input;
  const fields = own(input, "fields");
  const textFields = own(input, "textFields");
  return {
    fields: fields === undefined ? [] : Array.isArray(fields) ? fields.map((field: unknown) => (isRecord(field) ? { ...field, required: own(field, "required") ?? true, source: own(field, "source") ?? "manual" } : field)) : fields,
    textFields:
      textFields === undefined
        ? []
        : Array.isArray(textFields)
          ? textFields.map((field: unknown) =>
              isRecord(field) ? { ...field, type: own(field, "type") ?? "text", label: own(field, "label") ?? "", required: own(field, "required") ?? false, source: own(field, "source") ?? "manual" } : field,
            )
          : textFields,
  };
}

/**
 * De un borrador (campos opcionales sin rellenar) a un contenido COMPLETO y validado: `null` si algo no cumple.
 * Por defecto: roles «Asegurado / Co-asegurado», variantes vacías, `required` = true en firmas/iniciales y false en
 * texto, `source` = «manual», tipo de campo de texto = «text» y etiqueta vacía.
 */
export function buildContent(input: Pick<TemplateDraft, "name" | "roles" | "variants" | "layout">): TemplateContent | null {
  if (!isRecord(input)) return null;
  const variants = own(input, "variants");
  const variantsRecord = isRecord(variants) ? variants : {};
  const raw: Record<string, unknown> = {
    name: own(input, "name"),
    roles: own(input, "roles") ?? DEFAULT_ROLES.map((role) => ({ ...role })),
    variants: {
      "1": completeVariant(own(variantsRecord, "1") as VariantInput | undefined),
      "2": completeVariant(own(variantsRecord, "2") as VariantInput | undefined),
    },
  };
  const layout = own(input, "layout");
  if (layout !== undefined) raw.layout = layout;
  return parseContent(raw);
}

/** Igualdad de contenido (el JSON de dos contenidos ya validados tiene el mismo orden de claves). */
export function sameContent(a: TemplateContent, b: TemplateContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
