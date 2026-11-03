import { isRecord } from "./schema";
import { createTemplate, listTemplates } from "./templatesStore";
import { own } from "./templateSchema";
import {
  DEFAULT_ROLES,
  TEMPLATE_LIMITS,
  TEXT_FIELD_TYPES,
  type DocTemplate,
  type Rect,
  type TemplateDraft,
  type TemplateRole,
  type TemplateSignField,
  type TemplateTextField,
  type TextFieldType,
  type Variant,
} from "./templateTypes";
import { LibraryError } from "./types";

/**
 * Migración de las plantillas ANTIGUAS de `localStorage` (`signTemplates.ts`, clave `optimuspdf.signTemplates`) a la
 * biblioteca (Fase 2, U2.2).
 *
 *  - `migrateLocalTemplates()` las COPIA como plantillas «sin documento» (`documentId: null`, reasignables con
 *    `attachTemplate`), con `origin: { kind: "local", legacyId, savedAt }`. NO borra las originales.
 *  - Es IDEMPOTENTE: lo ya migrado (mismo `legacyId`) se salta; se puede llamar en cada arranque.
 *  - `markMigrated()` borra de `localStorage` las originales YA migradas, y solo cuando la persona lo confirma. Las que
 *    no se pudieron migrar (dañadas) se dejan.
 *  - `localStorage` no disponible (modo privado, `window` ausente, acceso que lanza) o con datos corruptos NO rompe: se
 *    devuelve un `status`.
 *
 * Conversión: los firmantes (como mucho 2) pasan a roles; con 1 firmante los huecos van a la variante «1» y con 2 a la
 * «2» (la «1» queda vacía y `applyTemplate` usa el firmante 1 de la «2» con aviso); los campos de texto van a la misma
 * variante. Un rectángulo ligeramente fuera de 0..1 (el formato antiguo toleraba ±1 %) se recorta; si queda sin tamaño,
 * el campo se descarta y se cuenta en `droppedFields`.
 */

/** Clave de `localStorage` de `signTemplates.ts` (una prueba comprueba que sigue siendo la misma). */
export const LEGACY_TEMPLATES_STORAGE_KEY = "optimuspdf.signTemplates";
const LEGACY_SCHEMA_VERSION = 1;
const MAX_LEGACY_ITEMS = 200;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" || !window.localStorage ? null : window.localStorage;
  } catch {
    return null;
  }
}

type LegacyRead = { status: "ok"; items: unknown[] } | { status: "unavailable" | "none" | "corrupt" };

function readLegacy(storage: StorageLike | null): LegacyRead {
  if (!storage) return { status: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_TEMPLATES_STORAGE_KEY);
  } catch {
    return { status: "unavailable" };
  }
  if (raw === null || raw === "") return { status: "none" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || own(parsed, "version") !== LEGACY_SCHEMA_VERSION) return { status: "corrupt" };
    const templates = own(parsed, "templates");
    if (!Array.isArray(templates) || templates.length > MAX_LEGACY_ITEMS) return { status: "corrupt" };
    return { status: "ok", items: templates };
  } catch {
    return { status: "corrupt" };
  }
}

function clean(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Recorta a 0..1 (el formato antiguo toleraba -1 %..101 %). `null` si no queda tamaño. */
function clampRect(raw: unknown): Rect | null {
  if (!isRecord(raw)) return null;
  const values = ["x", "y", "width", "height"].map((key) => own(raw, key));
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return null;
  const [rx, ry, rw, rh] = values;
  const x = Math.min(Math.max(rx, 0), 1);
  const y = Math.min(Math.max(ry, 0), 1);
  const width = Math.min(rw, 1 - x);
  const height = Math.min(rh, 1 - y);
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

type LegacyParsed = {
  legacyId: string;
  name: string;
  savedAt: string;
  signerNames: string[];
  fields: Array<{ signerIndex: number; pageIndex: number; type: "signature" | "initials"; rect: Rect }>;
  textFields: Array<{ pageIndex: number; rect: Rect; label: string; type: TextFieldType }>;
  droppedFields: number;
};

function parseLegacy(raw: unknown): LegacyParsed | null {
  if (!isRecord(raw)) return null;
  const legacyId = clean(own(raw, "id"), 80);
  const name = clean(own(raw, "name"), TEMPLATE_LIMITS.maxNameLength);
  const savedAtRaw = own(raw, "savedAt");
  const signers = own(raw, "signers");
  const fields = own(raw, "fields");
  const textFields = own(raw, "textFields");
  if (legacyId === "" || name === "" || typeof savedAtRaw !== "string" || Number.isNaN(Date.parse(savedAtRaw))) return null;
  if (!Array.isArray(signers) || !Array.isArray(fields) || !Array.isArray(textFields)) return null;
  if (signers.length > MAX_LEGACY_ITEMS || fields.length > MAX_LEGACY_ITEMS || textFields.length > MAX_LEGACY_ITEMS) return null;
  const signerNames = signers.map((signer) => (isRecord(signer) ? clean(own(signer, "name"), TEMPLATE_LIMITS.maxRoleLabelLength) : ""));
  let droppedFields = 0;
  const outFields: LegacyParsed["fields"] = [];
  for (const item of fields) {
    if (!isRecord(item)) return null;
    const signerIndex = own(item, "signerIndex");
    const pageIndex = own(item, "pageIndex");
    const type = own(item, "type");
    const rect = clampRect(own(item, "rect"));
    if (!Number.isInteger(signerIndex) || (signerIndex as number) < 0 || !Number.isInteger(pageIndex) || (pageIndex as number) < 0 || (type !== "signature" && type !== "initials")) return null;
    if (!rect || (signerIndex as number) > 1 || (pageIndex as number) > TEMPLATE_LIMITS.maxPageIndex) {
      droppedFields += 1;
      continue;
    }
    outFields.push({ signerIndex: signerIndex as number, pageIndex: pageIndex as number, type, rect });
  }
  const outText: LegacyParsed["textFields"] = [];
  for (const item of textFields) {
    if (!isRecord(item)) return null;
    const pageIndex = own(item, "pageIndex");
    const type = own(item, "type");
    const rect = clampRect(own(item, "rect"));
    if (!Number.isInteger(pageIndex) || (pageIndex as number) < 0) return null;
    if (type !== undefined && !(typeof type === "string" && TEXT_FIELD_TYPES.includes(type as TextFieldType))) return null;
    if (!rect || (pageIndex as number) > TEMPLATE_LIMITS.maxPageIndex) {
      droppedFields += 1;
      continue;
    }
    outText.push({ pageIndex: pageIndex as number, rect, label: clean(own(item, "label"), TEMPLATE_LIMITS.maxFieldLabelLength), type: (type as TextFieldType | undefined) ?? "text" });
  }
  return { legacyId, name, savedAt: new Date(savedAtRaw).toISOString(), signerNames, fields: outFields, textFields: outText, droppedFields };
}

/** Convierte una plantilla antigua ya leída en un borrador de la nueva (puro). */
function toDraft(legacy: LegacyParsed): TemplateDraft {
  const maxIndex = legacy.fields.reduce((max, field) => Math.max(max, field.signerIndex), -1);
  const roleCount = Math.min(2, Math.max(1, legacy.signerNames.length, maxIndex + 1));
  const roles: TemplateRole[] = Array.from({ length: roleCount }, (_, index) => {
    const label = legacy.signerNames[index] ?? "";
    return { key: DEFAULT_ROLES[index].key, label: label === "" ? DEFAULT_ROLES[index].label : label };
  });
  const variant: Variant = {
    fields: legacy.fields
      .filter((field) => field.signerIndex < roleCount)
      .map<TemplateSignField>((field) => ({ roleIndex: field.signerIndex, pageIndex: field.pageIndex, type: field.type, rect: field.rect, required: true, source: "manual" })),
    textFields: legacy.textFields.map<TemplateTextField>((field) => ({ pageIndex: field.pageIndex, rect: field.rect, type: field.type, label: field.label, required: false, source: "manual" })),
  };
  return {
    documentId: null,
    name: legacy.name,
    roles,
    variants: roleCount === 1 ? { "1": variant } : { "2": variant },
    origin: { kind: "local", legacyId: legacy.legacyId, savedAt: legacy.savedAt },
  };
}

export type MigrateLocalOptions = {
  /** Para pruebas: el `Storage` a leer (por defecto `window.localStorage`). */
  storage?: StorageLike | null;
  now?: () => Date;
  newId?: () => string;
};

export type MigrateLocalResult =
  | { status: "unavailable" | "none" | "corrupt" | "storeUnavailable" }
  | {
      status: "ok";
      /** Plantillas creadas ahora. */
      created: DocTemplate[];
      /** `legacyId` de las que ya estaban migradas (no se repiten). */
      alreadyMigrated: string[];
      /** Entradas antiguas inservibles (dañadas): se dejan en `localStorage`. */
      skipped: number;
      /** Campos antiguos que no se pudieron conservar (fuera de página, tamaño nulo, tercer firmante…). */
      droppedFields: number;
      /** Plantillas que no se pudieron guardar (biblioteca llena, cuota…): se reintentan en la próxima llamada. */
      failed: number;
    };

/** Copia las plantillas de `localStorage` a la biblioteca como plantillas «sin documento». Idempotente; no borra nada. */
export async function migrateLocalTemplates(options: MigrateLocalOptions = {}): Promise<MigrateLocalResult> {
  const read = readLegacy(options.storage === undefined ? defaultStorage() : options.storage);
  if (read.status !== "ok") return { status: read.status };
  const existing = await listTemplates();
  if (!existing.available) return { status: "storeUnavailable" };
  const migrated = new Set<string>();
  for (const template of existing.templates) if (template.origin?.kind === "local") migrated.add(template.origin.legacyId);

  const result = { created: [] as DocTemplate[], alreadyMigrated: [] as string[], skipped: 0, droppedFields: 0, failed: 0 };
  for (const item of read.items) {
    const legacy = parseLegacy(item);
    if (!legacy) {
      result.skipped += 1;
      continue;
    }
    if (migrated.has(legacy.legacyId)) {
      result.alreadyMigrated.push(legacy.legacyId);
      continue;
    }
    try {
      const created = await createTemplate(toDraft(legacy), { now: options.now, newId: options.newId });
      migrated.add(legacy.legacyId);
      result.created.push(created);
      result.droppedFields += legacy.droppedFields;
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      result.failed += 1;
    }
  }
  return { status: "ok", ...result };
}

export type MarkMigratedResult = { status: "ok" | "unavailable" | "none" | "corrupt" | "storeUnavailable"; removed: number; kept: number };

/**
 * Borra de `localStorage` las plantillas antiguas que YA están migradas (se comprueba en la biblioteca, una por una); deja
 * las demás. Con `onlyLossless`, además deja las que se migraron PERDIENDO algún campo (fuera de página, tamaño nulo, tercer
 * firmante…): la copia nueva está en la biblioteca, pero la original no se toca. Llamar SOLO cuando la persona lo confirma.
 * Después, la interfaz debe refrescar `signTemplates.ts` (`refreshSignTemplates()`), porque este módulo escribe `localStorage`
 * directamente.
 */
export async function markMigrated(options: { storage?: StorageLike | null; onlyLossless?: boolean } = {}): Promise<MarkMigratedResult> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const read = readLegacy(storage);
  if (read.status !== "ok" || !storage) return { status: read.status === "ok" ? "unavailable" : read.status, removed: 0, kept: 0 };
  const existing = await listTemplates();
  if (!existing.available) return { status: "storeUnavailable", removed: 0, kept: read.items.length };
  const migrated = new Set<string>();
  for (const template of existing.templates) if (template.origin?.kind === "local") migrated.add(template.origin.legacyId);

  const remaining = read.items.filter((item) => {
    const legacy = parseLegacy(item);
    return !(legacy && migrated.has(legacy.legacyId) && (!options.onlyLossless || legacy.droppedFields === 0));
  });
  const removed = read.items.length - remaining.length;
  if (removed === 0) return { status: "ok", removed: 0, kept: remaining.length };
  try {
    if (remaining.length === 0) storage.removeItem(LEGACY_TEMPLATES_STORAGE_KEY);
    else storage.setItem(LEGACY_TEMPLATES_STORAGE_KEY, JSON.stringify({ version: LEGACY_SCHEMA_VERSION, templates: remaining }));
  } catch {
    return { status: "unavailable", removed: 0, kept: read.items.length };
  }
  return { status: "ok", removed, kept: remaining.length };
}
