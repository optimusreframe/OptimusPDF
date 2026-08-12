"use client";

/**
 * Plantillas de disposicion reutilizables entre documentos: firmantes +
 * huecos + campos de texto, sin valores ni ids ni colores. Mismo patron
 * de store que `src/lib/valueHistory.ts` (cache + version + listeners +
 * `storage` para otras pestañas), pero SIN el "REGLA DURA" de ese
 * archivo: una plantilla es forma, no contenido -- por eso `textValues`
 * (lo escrito, potencial PII de una persona concreta) queda fuera a
 * proposito. Igual que el historial de valores, se borra desde
 * `PrivacyNotice.tsx`.
 */

import { useSyncExternalStore } from "react";
import { isValidRect } from "@/app/sign-pdf/signConfig";
import type { NormalizedRect } from "@/lib/pdf/core";
import { signerColorAt, type Signer, type SignatureField, type SignatureFieldType } from "@/lib/pdf/sign";
import {
  DETECTED_FIELD_TYPES,
  type DetectedField,
  type DetectedFieldType,
} from "@/lib/pdf/detectFields";

export const SIGN_TEMPLATES_STORAGE_KEY = "optimuspdf.signTemplates";
const SCHEMA_VERSION = 1;
/** Plantillas guardadas simultaneamente: son artefactos con nombre que la persona creo a proposito, no un cache automatico -- por eso se rechaza en el limite en vez de expulsar la mas vieja en silencio (ver `saveTemplate`). */
export const MAX_TEMPLATES = 10;
export const TEMPLATE_NAME_MAX = 60;
/** Cota defensiva ante un blob corrupto o manipulado, no un limite de uso real. */
const MAX_ITEMS_PER_TEMPLATE = 200;

export type SignTemplateField = {
  /** Indice dentro de `signers` de ESTA plantilla, no un id real. */
  signerIndex: number;
  pageIndex: number;
  type: SignatureFieldType;
  rect: NormalizedRect;
};

export type SignTemplateTextField = {
  pageIndex: number;
  rect: NormalizedRect;
  label?: string;
  /** Ausente = "text", mismo criterio que `DetectedField.type` (ver `fieldTypeOf`). */
  type?: DetectedFieldType;
};

export type SignTemplate = {
  id: string;
  name: string;
  /** ISO 8601. */
  savedAt: string;
  /** Solo informativo (se muestra en la lista); no se usa para decidir nada al aplicar. */
  sourcePageCount: number;
  signers: { name: string }[];
  fields: SignTemplateField[];
  textFields: SignTemplateTextField[];
};

type Store = SignTemplate[];

const EMPTY_STORE: Store = [];

let cache: Store | null = null;
let version = 0;
const listeners = new Set<() => void>();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const SIGNATURE_FIELD_TYPE_VALUES: readonly SignatureFieldType[] = [
  "signature",
  "initials",
];

function isValidTemplateSigner(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

function isValidTemplateField(value: unknown): value is SignTemplateField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  return (
    isFiniteNumber(field.signerIndex) &&
    field.signerIndex >= 0 &&
    Number.isInteger(field.pageIndex) &&
    (field.pageIndex as number) >= 0 &&
    typeof field.type === "string" &&
    SIGNATURE_FIELD_TYPE_VALUES.includes(field.type as SignatureFieldType) &&
    isValidRect(field.rect)
  );
}

function isValidTemplateTextField(
  value: unknown,
): value is SignTemplateTextField {
  if (typeof value !== "object" || value === null) return false;
  const field = value as Record<string, unknown>;
  if (
    !Number.isInteger(field.pageIndex) ||
    (field.pageIndex as number) < 0 ||
    !isValidRect(field.rect)
  ) {
    return false;
  }
  if (
    field.type !== undefined &&
    (typeof field.type !== "string" ||
      !DETECTED_FIELD_TYPES.includes(field.type as DetectedFieldType))
  ) {
    return false;
  }
  return field.label === undefined || typeof field.label === "string";
}

function isSignTemplate(value: unknown): value is SignTemplate {
  if (typeof value !== "object" || value === null) return false;
  const template = value as Record<string, unknown>;
  return (
    typeof template.id === "string" &&
    typeof template.name === "string" &&
    typeof template.savedAt === "string" &&
    isFiniteNumber(template.sourcePageCount) &&
    Array.isArray(template.signers) &&
    template.signers.length <= MAX_ITEMS_PER_TEMPLATE &&
    template.signers.every(isValidTemplateSigner) &&
    Array.isArray(template.fields) &&
    template.fields.length <= MAX_ITEMS_PER_TEMPLATE &&
    template.fields.every(isValidTemplateField) &&
    Array.isArray(template.textFields) &&
    template.textFields.length <= MAX_ITEMS_PER_TEMPLATE &&
    template.textFields.every(isValidTemplateTextField)
  );
}

function isStore(value: unknown): value is Store {
  return Array.isArray(value) && value.every(isSignTemplate);
}

function readStorage(): Store {
  if (typeof window === "undefined") return EMPTY_STORE;
  try {
    const raw = window.localStorage.getItem(SIGN_TEMPLATES_STORAGE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STORE;
    const { version: storedVersion, templates } = parsed as Record<
      string,
      unknown
    >;
    if (storedVersion !== SCHEMA_VERSION || !isStore(templates)) {
      return EMPTY_STORE;
    }
    return templates;
  } catch {
    return EMPTY_STORE;
  }
}

function writeStorage(store: Store): "ok" | "unavailable" {
  try {
    window.localStorage.setItem(
      SIGN_TEMPLATES_STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, templates: store }),
    );
    return "ok";
  } catch {
    // Storage lleno o bloqueado (privado/cuota agotada).
    return "unavailable";
  }
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Store {
  cache ??= readStorage();
  return cache;
}

/** Igual que `valueHistory.ts`: otra pestaña pudo borrar o guardar plantillas. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== SIGN_TEMPLATES_STORAGE_KEY) return;
    cache = null;
    emit();
  });
}

function getVersion(): number {
  return version;
}

/** Lista reactiva de plantillas guardadas, para el panel "Plantillas". */
export function useSignTemplates(): readonly SignTemplate[] {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  return getSnapshot();
}

/** Lectura puntual, no reactiva (ej. para validar antes de guardar). */
export function listTemplates(): readonly SignTemplate[] {
  return getSnapshot();
}

export type SaveTemplateInput = {
  name: string;
  pageCount: number;
  signers: readonly Signer[];
  fields: readonly SignatureField[];
  textFields: readonly DetectedField[];
};

/**
 * Guarda la disposicion actual como plantilla con nombre. Sin valores
 * (`textValues`), sin ids ni colores (se reconstruyen al aplicar) --
 * una plantilla es forma, no contenido de una persona concreta.
 * Sobrescribe si ya existe una con el mismo nombre (mismo criterio que
 * "guardar borrador": el nombre es la clave para la persona, no un id
 * que nunca ve).
 */
export function saveTemplate(
  input: SaveTemplateInput,
): "ok" | "limit" | "unavailable" {
  if (typeof window === "undefined") return "unavailable";
  const name = input.name.trim().slice(0, TEMPLATE_NAME_MAX);
  if (!name) return "unavailable";

  const signerIndexById = new Map(
    input.signers.map((signer, index) => [signer.id, index]),
  );

  const template: SignTemplate = {
    id: `tpl-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    name,
    savedAt: new Date().toISOString(),
    sourcePageCount: input.pageCount,
    signers: input.signers.map((signer) => ({ name: signer.name })),
    fields: input.fields
      .filter((field) => signerIndexById.has(field.signerId))
      .map((field) => ({
        signerIndex: signerIndexById.get(field.signerId)!,
        pageIndex: field.pageIndex,
        type: field.type,
        rect: field.rect,
      })),
    textFields: input.textFields.map((field) => ({
      pageIndex: field.pageIndex,
      rect: field.rect,
      label: field.label,
      type: field.type,
    })),
  };

  const current = getSnapshot();
  const withoutSameName = current.filter(
    (existing) => existing.name !== name,
  );
  if (
    withoutSameName.length === current.length &&
    current.length >= MAX_TEMPLATES
  ) {
    return "limit";
  }

  const next = [template, ...withoutSameName];
  const result = writeStorage(next);
  if (result !== "ok") return result;
  cache = next;
  emit();
  return "ok";
}

export function deleteTemplate(id: string): void {
  if (typeof window === "undefined") return;
  const next = getSnapshot().filter((template) => template.id !== id);
  cache = next;
  writeStorage(next);
  emit();
}

export function clearAllTemplates(): void {
  if (typeof window === "undefined") return;
  cache = EMPTY_STORE;
  try {
    window.localStorage.removeItem(SIGN_TEMPLATES_STORAGE_KEY);
  } catch {
    // Ignorado a proposito, igual que `valueHistory.ts`.
  }
  emit();
}

export type InstantiateTemplateDeps = {
  /** Numero de paginas del documento AL QUE se aplica (no el de origen). */
  pageCount: number;
  mintSignerId: () => string;
  mintFieldId: () => string;
  mintTextFieldId: () => string;
};

export type InstantiatedTemplate = {
  signers: Signer[];
  fields: SignatureField[];
  textFields: DetectedField[];
  /** Cuantos huecos/campos no encajaban en el documento actual (pagina fuera de rango) y se descartaron. */
  dropped: number;
};

/**
 * Puro y sincrono: no toca `localStorage`. Ids siempre nuevos (nunca los
 * guardados en la plantilla, que pueden colisionar con los del
 * documento actual) via los acuñadores inyectados -- este modulo no
 * importa `FieldPlacer.tsx`/`SignerManager.tsx` a proposito, para no
 * arrastrar su arbol de React/pdf.js a un modulo que solo maneja datos.
 *
 * Paginas fuera de rango del documento actual: se descartan (nunca se
 * recortan a la ultima pagina -- una firma en la pagina equivocada es
 * peor que una firma ausente y visible). Si la plantilla tenia algun
 * hueco/campo pero NINGUNO encaja, no se aplica nada (`null`): perder
 * todos los firmantes actuales para terminar sin ningun campo nuevo es
 * pura perdida, no una plantilla parcialmente util.
 */
export function instantiateTemplate(
  template: SignTemplate,
  deps: InstantiateTemplateDeps,
): InstantiatedTemplate | null {
  const totalSource = template.fields.length + template.textFields.length;

  const fittingFields = template.fields.filter(
    (field) => field.pageIndex < deps.pageCount,
  );
  const fittingTextFields = template.textFields.filter(
    (field) => field.pageIndex < deps.pageCount,
  );
  const dropped =
    totalSource - (fittingFields.length + fittingTextFields.length);

  if (
    totalSource > 0 &&
    fittingFields.length === 0 &&
    fittingTextFields.length === 0
  ) {
    return null;
  }

  const signers: Signer[] = template.signers.map((signer, index) => ({
    id: deps.mintSignerId(),
    name: signer.name,
    color: signerColorAt(index),
  }));

  const fields: SignatureField[] = fittingFields
    .filter((field) => field.signerIndex < signers.length)
    .map((field) => ({
      id: deps.mintFieldId(),
      signerId: signers[field.signerIndex].id,
      pageIndex: field.pageIndex,
      type: field.type,
      rect: field.rect,
    }));

  const textFields: DetectedField[] = fittingTextFields.map((field) => ({
    id: deps.mintTextFieldId(),
    pageIndex: field.pageIndex,
    rect: field.rect,
    label: field.label,
    type: field.type,
    source: "manual",
    confidence: "high",
  }));

  return { signers, fields, textFields, dropped };
}

/** Solo para tests: fuerza a releer `localStorage` en el siguiente acceso. */
export function __resetSignTemplatesCacheForTests(): void {
  cache = null;
}
