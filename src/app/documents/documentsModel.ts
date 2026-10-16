import type { DocumentEntry, Fingerprint } from "@/lib/docLibrary/types";
import { LIBRARY_LIMITS } from "@/lib/docLibrary/types";
import { compareFingerprints } from "@/lib/docLibrary/match";
import { SIGN_HANDOFF_MAX_DOCUMENTS } from "@/lib/docLibrary/signHandoff";
import type { TemplateState, TemplateStatus } from "@/lib/docLibrary/templatesStore";

/**
 * Logica pura de «Mis documentos» (U2.5): sin React ni IndexedDB, para probarla a fondo y que la interfaz solo pinte.
 */

/** Documentos que se pueden firmar a la vez: el limite del traspaso a Firmar. */
export const MAX_SELECTION = SIGN_HANDOFF_MAX_DOCUMENTS;
/** Documentos en la seccion compacta de Inicio. */
export const HOME_LIMIT = 4;

/** `✓` lista, `✓` parcial (solo 1 firmante), `⚠` desactualizada (se reemplazó el PDF) o `✗` sin plantilla. */
export type TemplateBadgeKind = "ready" | "single" | "none" | "stale";

/** `stale`: el PDF se reemplazó y ya no coincide con la plantilla; sin plantilla no hay nada desactualizado. */
export function badgeKind(status: Pick<TemplateStatus, "state"> | undefined, stale = false): TemplateBadgeKind {
  const state: TemplateState = status?.state ?? "none";
  return stale && state !== "none" ? "stale" : state;
}

/** ¿La tarjeta de este documento avisa de que su plantilla esta desactualizada? */
export function isTemplateStale(doc: Pick<DocumentEntry, "templateStale">, status: Pick<TemplateStatus, "state"> | undefined): boolean {
  return doc.templateStale !== undefined && badgeKind(status, true) === "stale";
}

/** Orden de la lista: el mas recientemente tocado primero (la biblioteca ya lo trae asi; se asegura aqui). */
export function sortDocuments(documents: readonly DocumentEntry[]): DocumentEntry[] {
  return [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Los ids elegidos que SIGUEN existiendo, en el orden de la lista (el orden de firma es el que se ve). */
export function pruneSelection(selected: ReadonlySet<string>, documents: readonly DocumentEntry[]): string[] {
  return documents.filter((doc) => selected.has(doc.id)).map((doc) => doc.id);
}

/** Alterna un id respetando el tope; devuelve la misma seleccion si ya esta llena y se intenta anadir uno mas. */
export function toggleSelection(selected: ReadonlySet<string>, id: string, max: number = MAX_SELECTION): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else if (next.size < max) {
    next.add(id);
  }
  return next;
}

/** Nombre sugerido para un archivo: sin la extension `.pdf` ni espacios sobrantes. */
export function suggestedName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return base.slice(0, LIBRARY_LIMITS.maxNameLength);
}

export function looksLikePdf(file: { name: string; type?: string }): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** Id opaco y valido (`[A-Za-z0-9_-]{1,64}`) para un documento nuevo. */
export function newDocumentId(random: () => number = Math.random, now: () => number = Date.now): string {
  const part = () => Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `d-${now().toString(36)}-${part()}${part()}`;
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** `1,5 MB` / `1.5 MB` segun el idioma; sin decimales en bytes ni desde 100 unidades. */
export function formatBytes(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let value = safe;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)} ${UNITS[unit]}`;
}

export type PersistView = "granted" | "denied" | "unsupported" | "unknown";

/** Lo que se le dice a la persona sobre el borrado automatico (la ultima respuesta guardada del navegador). */
export function persistView(persistence: { granted: boolean; supported: boolean } | null): PersistView {
  if (!persistence) return "unknown";
  if (!persistence.supported) return "unsupported";
  return persistence.granted ? "granted" : "denied";
}

export type ReplaceVerdict =
  | { kind: "ok" }
  /** La plantilla ya no coincide con el PDF nuevo. */
  | { kind: "mismatch" }
  /** Coincide en parte: `pages` paginas de la plantilla hay que revisarlas. */
  | { kind: "review"; pages: number };

/**
 * Tras reemplazar el PDF de un documento CON plantilla: ¿sigue valiendo? Compara la huella nueva (el documento) con la
 * vieja (la plantilla). `exact`/`match` sin paginas por revisar = sigue valiendo. Sin plantilla no hay nada que avisar.
 */
export function replaceVerdict(before: Fingerprint, after: Fingerprint, hasTemplate: boolean): ReplaceVerdict {
  if (!hasTemplate) return { kind: "ok" };
  const result = compareFingerprints(after, before);
  if (result.level === "none") return { kind: "mismatch" };
  if (result.level === "exact") return { kind: "ok" };
  if (result.level === "match" && result.reviewPages.length === 0) return { kind: "ok" };
  return { kind: "review", pages: Math.max(1, result.reviewPages.length) };
}

/** Codigo de `LibraryError` / `FingerprintError` -> clave de texto de `documents.error*`. */
export type ErrorKey =
  | "errorNotPdf"
  | "errorTooBig"
  | "errorFull"
  | "errorQuota"
  | "errorUnavailable"
  | "errorEncrypted"
  | "errorCorrupt"
  | "errorConflict"
  | "errorNotFound"
  | "errorGeneric";

const ERROR_KEYS: Readonly<Record<string, ErrorKey>> = {
  tooBig: "errorTooBig",
  full: "errorFull",
  quota: "errorQuota",
  unavailable: "errorUnavailable",
  encrypted: "errorEncrypted",
  corrupt: "errorCorrupt",
  empty: "errorCorrupt",
  conflict: "errorConflict",
  notFound: "errorNotFound",
};

export function errorKeyOf(error: unknown): ErrorKey {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : "errorGeneric";
}
