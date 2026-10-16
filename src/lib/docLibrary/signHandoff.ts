/**
 * Traspaso de «Mis documentos» (y de Recientes) a Firmar: quien abre Firmar desde la biblioteca deja aqui QUE documentos
 * (ids de la biblioteca) y para QUE (firmar con su plantilla o configurar la plantilla); Firmar lo recoge UNA vez al
 * montar. Sin bytes ni datos de clientes: solo ids opacos de la biblioteca local.
 *
 * Contrato (lo implementan dos unidades por separado):
 *  - productor: `setSignHandoff({ documentIds, mode })` justo antes de navegar a `/sign-pdf`.
 *  - consumidor: `takeSignHandoff()` en Firmar al montar (devuelve `null` si no hay, esta caducado o ya se recogio).
 */

export type SignHandoffMode = "sign" | "configure";

export interface SignHandoff {
  /** Ids de `DocumentEntry` de la biblioteca (1..10). */
  documentIds: string[];
  mode: SignHandoffMode;
  createdAt: number;
}

export const SIGN_HANDOFF_KEY = "optimuspdf.signHandoff";
/** Pasado este tiempo el traspaso se ignora (no debe «resucitar» horas despues). */
export const SIGN_HANDOFF_TTL_MS = 2 * 60 * 1000;
export const SIGN_HANDOFF_MAX_DOCUMENTS = 10;

const ID = /^[A-Za-z0-9_-]{1,80}$/;

let memory: SignHandoff | null = null;

function store(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function valid(value: unknown, now: number): SignHandoff | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ids = v.documentIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > SIGN_HANDOFF_MAX_DOCUMENTS) return null;
  if (!ids.every((id) => typeof id === "string" && ID.test(id))) return null;
  if (v.mode !== "sign" && v.mode !== "configure") return null;
  const createdAt = v.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (now - createdAt > SIGN_HANDOFF_TTL_MS || createdAt - now > 5_000) return null;
  return { documentIds: [...(ids as string[])], mode: v.mode, createdAt };
}

/** Deja el traspaso (sustituye a cualquiera anterior). Devuelve `false` si los ids no son validos. */
export function setSignHandoff(input: { documentIds: string[]; mode: SignHandoffMode }, now: number = Date.now()): boolean {
  const handoff = valid({ ...input, createdAt: now }, now);
  if (!handoff) return false;
  memory = handoff;
  try {
    store()?.setItem(SIGN_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* sin sessionStorage: basta la memoria (misma pestana) */
  }
  return true;
}

/** Recoge y BORRA el traspaso (una sola vez). `null` si no hay, caduco o esta corrupto. */
export function takeSignHandoff(now: number = Date.now()): SignHandoff | null {
  let found = valid(memory, now);
  memory = null;
  const s = store();
  if (s) {
    try {
      const raw = s.getItem(SIGN_HANDOFF_KEY);
      s.removeItem(SIGN_HANDOFF_KEY);
      if (!found && raw) found = valid(JSON.parse(raw), now);
    } catch {
      /* JSON corrupto: se ignora */
    }
  }
  return found;
}

/** Solo para pruebas. */
export function resetSignHandoffForTests(): void {
  memory = null;
  try {
    store()?.removeItem(SIGN_HANDOFF_KEY);
  } catch {
    /* nada */
  }
}
