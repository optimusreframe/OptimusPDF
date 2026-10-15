import { isValidResumeId, type ResumeTarget } from "@/lib/resumeLinks";

/**
 * La sesion de Firmar en la direccion (Fase 0 «Firma agil», U0.3): `/sign-pdf?s=<id>`.
 *
 *  - El `<id>` es el del BORRADOR que ya hay guardado (el id de sesion `s-...` con varios documentos; la huella SHA-256 con
 *    uno): opaco, sin nombres de archivo ni de firmantes. Recargar con `?s=` restaura solo.
 *  - Al haber progreso se AÑADE una entrada al historial (`pushState`), detras de la cual queda `/sign-pdf` sin `s`. El
 *    «Atras» del navegador (o el gesto de deslizar desde el borde del iPad) vuelve a esa entrada SIN desmontar la pagina
 *    (misma ruta) y la herramienta puede preguntar «¿Salir de la firma?» en vez de perder el trabajo de vista.
 *  - Se usa la API nativa del historial, que el router de Next 16 integra (sincroniza `usePathname`/`useSearchParams` y
 *    conserva su propio estado en la entrada): `01-app/01-getting-started/04-linking-and-navigating.md`, «Native History API».
 *
 * La entrada que añadimos lleva una marca en `history.state` (`optimusSign`). Sirve para no duplicar entradas: tras una
 * recarga la entrada sigue siendo la nuestra y no se vuelve a empujar; si alguien llega con un `?s=` pegado a mano (sin la
 * marca) se crea la entrada base detras. Funciones sin React; `window.history` es lo unico que tocan.
 *
 * La URL es entrada NO confiable: solo se acepta un id con la forma exacta de un id de sesion o de una huella.
 */

/** Nombre del parametro de la URL. */
export const SESSION_PARAM = "s";

/** Clave de la marca en `history.state`. */
const MARK = "optimusSign";

/** Clave de la marca de la entrada BASE (la de `/sign-pdf` sin `s`, detras de la nuestra). */
const BASE = "optimusSignBase";

/** Un id valido de borrador: sesion (`s-...`) o huella SHA-256 de un documento; `null` si no es ninguno. */
export function sessionTargetOf(id: unknown): ResumeTarget | null {
  if (isValidResumeId("session", id)) return { kind: "session", id };
  if (isValidResumeId("sign", id)) return { kind: "sign", id };
  return null;
}

export type SessionRead = {
  /** La URL trae `s=` (valido o no): hay que limpiarlo si no se restaura. */
  present: boolean;
  /** El borrador al que apunta, o `null` si falta, es invalido o hay varios `s=`. */
  target: ResumeTarget | null;
};

/** Lee `?s=` de una cadena de busqueda (`location.search`). Varios `s=` a la vez no restauran nada. */
export function readSessionFromSearch(search: string): SessionRead {
  let values: string[];
  try {
    values = new URLSearchParams(search).getAll(SESSION_PARAM);
  } catch {
    return { present: false, target: null };
  }
  if (values.length === 0) return { present: false, target: null };
  if (values.length > 1) return { present: true, target: null };
  return { present: true, target: sessionTargetOf(values[0]) };
}

/** La misma direccion con `s=<id>` (conserva la ruta, el resto de parametros y el hash). */
export function withSessionParam(href: string, id: string): string {
  const url = new URL(href, "http://session.local");
  url.searchParams.set(SESSION_PARAM, id);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** La misma direccion sin `s=`. */
export function withoutSessionParam(href: string): string {
  const url = new URL(href, "http://session.local");
  url.searchParams.delete(SESSION_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Direccion de ahora (ruta + busqueda + hash), o `null` sin navegador. */
function currentHref(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Marca la entrada de ahora como BASE de la sesion (la que queda detras de la entrada `?s=`). Asi, si la sesion termina y la
 * persona vuelve atras hasta ella (`isBaseEntry`), la herramienta sabe que es una entrada suya sin nada que mostrar y puede
 * saltarla. Conserva el resto del estado de la entrada (el del router de Next incluido: su patch lo vuelve a fusionar).
 */
function markBaseEntry(href: string): void {
  const state: unknown = window.history.state;
  const base = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  window.history.replaceState({ ...base, [BASE]: true }, "", href);
}

/** La entrada de ahora es una base marcada por `showSessionInUrl` (ver `markBaseEntry`). */
export function isBaseEntry(): boolean {
  try {
    const state: unknown = window.history.state;
    return typeof state === "object" && state !== null && (state as Record<string, unknown>)[BASE] === true;
  } catch {
    return false;
  }
}

function currentMark(): string | null {
  try {
    const state: unknown = window.history.state;
    if (typeof state !== "object" || state === null) return null;
    const mark = (state as Record<string, unknown>)[MARK];
    return typeof mark === "string" ? mark : null;
  } catch {
    return null;
  }
}

/** `s=` de la direccion de ahora, valido o no (`null` si no hay). */
export function currentSessionParam(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(SESSION_PARAM);
  } catch {
    return null;
  }
}

/** La direccion de ahora lleva `s=`. */
export function hasSessionInUrl(): boolean {
  return currentSessionParam() !== null;
}

export type ShowOutcome =
  /** Se añadio una entrada nueva al historial. */
  | "pushed"
  /** La direccion ya tenia ESTA sesion y la entrada es nuestra: no se hace nada (nunca se duplica). */
  | "same"
  /**
   * Se reescribio la entrada de ahora sin añadir otra: la direccion tenia OTRA sesion (del documento suelto a la sesion de
   * varios) o era nuestra entrada ya limpiada por `hideSessionFromUrl` (el progreso se fue y volvio).
   */
  | "replaced"
  /** La direccion tenia esta sesion pero la entrada no era nuestra (enlace pegado): se creo la entrada base detras. */
  | "rebased"
  | "unavailable";

/** Marca de «entrada nuestra, ya sin sesion en la direccion» (ver `hideSessionFromUrl`). */
const CLEARED = "-";

/**
 * Deja la direccion en `?s=<id>`. Idempotente: llamarla otra vez con la misma sesion no añade entradas (un efecto que se
 * repite no puede llenar el historial) y, si el progreso se va y vuelve, REUTILIZA la entrada que ya era nuestra en vez
 * de apilar otra. Devuelve que hizo.
 */
export function showSessionInUrl(id: string): ShowOutcome {
  const href = currentHref();
  if (href === null) return "unavailable";
  try {
    const target = withSessionParam(href, id);
    const present = currentSessionParam();
    const mark = currentMark();
    if (present === id) {
      if (mark === id) return "same";
      // Llegada con `?s=` sin pasar por nosotros: la entrada base (sin `s`) no existe todavia.
      const base = withoutSessionParam(href);
      window.history.replaceState(null, "", base);
      markBaseEntry(base);
      window.history.pushState({ [MARK]: id }, "", target);
      return "rebased";
    }
    if (present !== null || mark === CLEARED) {
      window.history.replaceState({ [MARK]: id }, "", target);
      return "replaced";
    }
    markBaseEntry(href);
    window.history.pushState({ [MARK]: id }, "", target);
    return "pushed";
  } catch {
    return "unavailable";
  }
}

/**
 * Quita `s=` de la direccion SIN añadir una entrada (`replaceState`): la misma convencion que usa `?resume=` (U0.6). Si la
 * entrada era nuestra la deja marcada para que `showSessionInUrl` la reutilice. Devuelve si habia algo que quitar.
 */
export function hideSessionFromUrl(): boolean {
  const href = currentHref();
  if (href === null || !hasSessionInUrl()) return false;
  try {
    window.history.replaceState(currentMark() !== null ? { [MARK]: CLEARED } : null, "", withoutSessionParam(href));
    return true;
  } catch {
    return false;
  }
}
