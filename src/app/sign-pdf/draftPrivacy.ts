import type { SignerBlock } from "@/app/sign-pdf/docSet";
import type { CaptureMap } from "@/app/sign-pdf/captures";

/*
 * Privacidad del borrador con firmas (Fase 0 «Firma agil», U0.4), sin React ni IndexedDB.
 *
 * Los borradores de Firmar guardan, ademas del PDF y los campos, los TRAZOS de las firmas e iniciales ya recogidos (la
 * imagen de la firma de cada persona). Dos reglas los acotan:
 *
 *  - El ajuste «Guardar tambien las firmas recogidas» (`signaturesInDraft`, encendido por defecto): apagado, el borrador
 *    guarda TODO menos los trazos, y al retomarlo se piden de nuevo (`withoutBlockStrokes`, `withoutCaptureStrokes`).
 *  - La caducidad: un borrador CON trazos lleva `expiresAt` (7 dias despues de guardarse) y se purga solo al listar y al
 *    montar la herramienta (`isExpired`). Un borrador sin trazos no caduca (sigue la regla de siempre: tope de borradores
 *    y de bytes).
 */

/** Dias que vive un borrador con firmas guardadas. */
export const SIGNATURE_DRAFT_TTL_DAYS = 7;

/** Lo mismo en milisegundos. */
export const SIGNATURE_DRAFT_TTL_MS = SIGNATURE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

/** ¿Algun bloque de la sesion lleva un trazo (firma o iniciales)? */
export function blocksHaveStrokes(blocks: readonly SignerBlock[] | undefined): boolean {
  return (blocks ?? []).some((block) => Boolean(block.signature) || Boolean(block.initials));
}

/** ¿Alguna captura de un documento suelto lleva un trazo (firma o iniciales)? */
export function capturesHaveStrokes(captures: CaptureMap | undefined): boolean {
  return Object.values(captures ?? {}).some((capture) => Boolean(capture?.signature) || Boolean(capture?.initials));
}

/**
 * Los bloques sin sus trazos ni sellos: lo demas (firmante, alcance de documentos, modo automatico) se conserva tal cual.
 * `stripped` dice si habia algun trazo que quitar (si no, los bloques salen sin tocar).
 */
export function withoutBlockStrokes(blocks: readonly SignerBlock[]): { blocks: SignerBlock[]; stripped: boolean } {
  if (!blocksHaveStrokes(blocks)) return { blocks: [...blocks], stripped: false };
  return {
    blocks: blocks.map((block) => ({ ...block, signature: null, initials: null, stamps: {} })),
    stripped: true,
  };
}

/** Las capturas de un documento suelto sin trazos: una captura es solo trazos y su sello, asi que no queda ninguna. */
export function withoutCaptureStrokes(captures: CaptureMap): { captures: CaptureMap; stripped: boolean } {
  if (!capturesHaveStrokes(captures)) return { captures, stripped: false };
  return { captures: {}, stripped: true };
}

/** Cuando caduca un borrador con firmas guardado en `savedAt` (ISO 8601). */
export function expiryFor(savedAt: string): string {
  const saved = new Date(savedAt).getTime();
  // Una fecha de guardado ilegible no puede dejar el borrador sin fecha de salida: cuenta desde ahora.
  return new Date((Number.isFinite(saved) ? saved : Date.now()) + SIGNATURE_DRAFT_TTL_MS).toISOString();
}

/**
 * ¿Ya caduco? Un borrador sin `expiresAt` no caduca nunca. Un `expiresAt` ilegible (no es una fecha) se trata como
 * caducado: ese dato solo lo escribe esta misma herramienta, y ante un valor roto es preferible borrar las firmas que
 * dejarlas guardadas sin fecha de salida.
 */
export function isExpired(meta: { expiresAt?: unknown }, now: number): boolean {
  if (meta.expiresAt === undefined) return false;
  if (typeof meta.expiresAt !== "string") return true;
  const at = new Date(meta.expiresAt).getTime();
  return !Number.isFinite(at) || at <= now;
}
