import type { ToolSlug } from "@/lib/tools-registry";

/**
 * Enlaces «continuar este trabajo» (Fase 0 «Firma agil», U0.6): `/<herramienta>?resume=<tipo>:<id>`.
 *
 * Recientes los emite (`resumeHref`) y la herramienta de destino los lee (`readResumeFromSearch`) para restaurar el
 * borrador guardado en ESTE navegador. La URL es entrada no confiable (cualquiera puede escribirla o pegarla): aqui se
 * decide que vale y que no, sin interpretar nada.
 *
 *  - El TIPO sale de una lista blanca cerrada (`RESUME_KINDS`); cualquier otro (`constructor`, `__proto__`,
 *    `javascript`, ...) se descarta.
 *  - El ID debe cumplir la expresion exacta de su tipo (huella SHA-256 en hexadecimal, o el id de sesion que genera
 *    Firmar): nada de rutas, espacios, comillas ni etiquetas. Con ello el id solo llega a IndexedDB como clave de
 *    lectura y jamas se pinta en la pantalla.
 *  - Una herramienta solo acepta los tipos que SON suyos: `/edit-pdf?resume=pro:<id>` no restaura nada.
 *
 * Modulo puro (sin React ni DOM): se prueba a fondo en `resumeLinks.test.ts`.
 */

/** Nombre del parametro de la URL. */
export const RESUME_PARAM = "resume";

/**
 * Tipos de trabajo recuperable (lista blanca):
 *  - `sign`: Firmar con UN documento (borrador v1, id = huella del PDF);
 *  - `session`: Firmar con VARIOS documentos (id de sesion `s-...`);
 *  - `edit`: Editar PDF (id = huella del PDF);
 *  - `pro`: PDF Pro (id = huella del PDF original abierto).
 */
export const RESUME_KINDS = ["sign", "session", "edit", "pro"] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];

export type ResumeTarget = { kind: ResumeKind; id: string };

/** Huella SHA-256 en hexadecimal minuscula (64 caracteres), como la que usan los tres almacenes de borradores. */
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** Id de sesion de Firmar (`newSessionId`: `s-<tiempo>-<contador><azar>`, solo [a-z0-9-]). */
const SESSION_ID = /^s-[a-z0-9]{1,16}-[a-z0-9]{1,24}$/;

const ID_PATTERNS: Readonly<Record<ResumeKind, RegExp>> = {
  sign: FINGERPRINT,
  session: SESSION_ID,
  edit: FINGERPRINT,
  pro: FINGERPRINT,
};

const TOOL_OF_KIND: Readonly<Record<ResumeKind, ToolSlug>> = {
  sign: "sign-pdf",
  session: "sign-pdf",
  edit: "edit-pdf",
  pro: "pdf-pro",
};

/** Un valor mas largo que esto no puede ser un enlace nuestro (tipo + `:` + id mas largo): ni se examina. */
const MAX_VALUE_LENGTH = 100;

function isResumeKind(value: string): value is ResumeKind {
  return (RESUME_KINDS as readonly string[]).includes(value);
}

/** Herramienta que sabe restaurar este tipo de trabajo. */
export function toolOfResumeKind(kind: ResumeKind): ToolSlug {
  return TOOL_OF_KIND[kind];
}

/** Tipos que restaura cada herramienta (`[]` = ninguna: no lee `?resume=`). */
export function resumeKindsOfTool(slug: ToolSlug): ResumeKind[] {
  return RESUME_KINDS.filter((kind) => TOOL_OF_KIND[kind] === slug);
}

/** ¿Es un id valido para ese tipo? (la misma regla del parseo, para quien arma enlaces o punteros). */
export function isValidResumeId(kind: ResumeKind, id: unknown): id is string {
  return typeof id === "string" && ID_PATTERNS[kind].test(id);
}

/** `<tipo>:<id>`, el valor del parametro. */
export function resumeValue(target: ResumeTarget): string {
  return `${target.kind}:${target.id}`;
}

/**
 * Lee el VALOR del parametro. `null` si no es un trabajo recuperable valido: no es texto, esta vacio, es demasiado
 * largo, no tiene `<tipo>:<id>`, el tipo no esta en la lista blanca o el id no cumple su expresion.
 */
export function parseResume(raw: unknown): ResumeTarget | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_VALUE_LENGTH) return null;
  const separator = raw.indexOf(":");
  if (separator <= 0) return null;
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!isResumeKind(kind) || !isValidResumeId(kind, id)) return null;
  return { kind, id };
}

/** Destino de «Continuar»: la herramienta del trabajo con el parametro. El valor no lleva nada que escapar (`:` y [a-z0-9-]). */
export function resumeHref(target: ResumeTarget): string {
  return `/${toolOfResumeKind(target.kind)}?${RESUME_PARAM}=${resumeValue(target)}`;
}

export type ResumeRead = {
  /** La URL trae `?resume=` (valido o no): hay que limpiarlo. */
  present: boolean;
  /** El trabajo a restaurar, o `null` si no hay parametro, es invalido o es de OTRA herramienta. */
  target: ResumeTarget | null;
};

/**
 * Lee `?resume=` de una cadena de busqueda (`location.search`) para una herramienta que solo restaura `allowed`.
 * Varios `resume=` a la vez, o un valor que no es de esta herramienta, no restauran nada (pero si estan `present`).
 */
export function readResumeFromSearch(search: string, allowed: readonly ResumeKind[]): ResumeRead {
  let values: string[];
  try {
    values = new URLSearchParams(search).getAll(RESUME_PARAM);
  } catch {
    return { present: false, target: null };
  }
  if (values.length === 0) return { present: false, target: null };
  if (values.length > 1) return { present: true, target: null };
  const target = parseResume(values[0]);
  return { present: true, target: target && allowed.includes(target.kind) ? target : null };
}

/** La misma URL sin `?resume=` (conserva el resto de parametros y el hash). */
export function withoutResume(href: string): string {
  const url = new URL(href, "http://resume.local");
  url.searchParams.delete(RESUME_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
