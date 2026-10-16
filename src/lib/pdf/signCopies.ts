/**
 * Copias de un documento firmado (Firma agil, U1.1). Modulo puro y sin dependencias: lo usan el modelo de sesion
 * (`docSet.ts`), las validaciones (`assignment.ts`) y el motor del ZIP (`signBatch.ts`).
 *
 * Una «copia» es un archivo IDENTICO al firmado (mismos bytes, mismo hash): se firma una vez y se escribe N veces con
 * nombres distintos. Si las copias deben firmarse por separado (originales distintos) se cargan como documentos.
 */

/** Copias maximas por documento (la primera cuenta: `copies = 2` = el original y una copia). */
export const MAX_COPIES = 5;

/** Valor por defecto: el documento se entrega una vez. */
export const DEFAULT_COPIES = 1;

/**
 * Archivos maximos que entrega UNA ronda (suma de las copias de todos los documentos). 10 documentos x 5 copias = 50:
 * el tope de documentos de la herramienta con el tope de copias llenan exactamente el limite, ni uno mas.
 */
export const MAX_OUTPUT_FILES = 50;

/** `value` es un numero de copias valido tal cual: entero entre 1 y `MAX_COPIES`. */
export function isValidCopies(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_COPIES;
}

/**
 * Lo que viene de fuera (borrador, configuracion, un campo de la interfaz) se lleva a 1..`MAX_COPIES`: ausente, no
 * numerico o menor que 1 = 1; con decimales se queda la parte entera; por encima del tope, el tope.
 */
export function normalizeCopies(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COPIES;
  return Math.min(MAX_COPIES, Math.max(DEFAULT_COPIES, Math.trunc(value)));
}

/** Archivos que se entregan: la suma de las copias (cada una normalizada; sin dato = 1). */
export function outputFileCount(copies: readonly unknown[]): number {
  return copies.reduce<number>((sum, value) => sum + normalizeCopies(value), 0);
}
