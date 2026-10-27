/**
 * La sesion del Escaner en la direccion: `/scan-to-pdf?scan=<id>` (mismo patron que Firmar con `?s=`). Al haber paginas se AÑADE
 * una entrada al historial (`pushState`) detras de la cual queda `/scan-to-pdf` sin parametro: el «Atras» del navegador (o el
 * gesto del borde en el iPad) vuelve a esa entrada SIN desmontar la pagina y la herramienta pregunta en vez de perder el trabajo.
 * Recargar con `?scan=` restaura la sesion guardada. `?resume=scan:<id>` (el enlace de «Recientes») se lee igual.
 *
 * La URL es entrada NO confiable: solo se acepta un id con la forma exacta de un id de sesion (minusculas, digitos y guiones, 8-64: la misma regla que el almacen real).
 * Funciones sin React; `window.history` es lo unico que tocan.
 */

export const SCAN_PARAM = "scan";
const MARK = "optimusScan";
const BASE = "optimusScanBase";
const CLEARED = "-";
const ID = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function isValidScanId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export type ScanUrlRead = { present: boolean; id: string | null };

/** Lee `?scan=<id>` o `?resume=scan:<id>` de una cadena de busqueda. Varios valores a la vez no restauran nada. */
export function readScanFromSearch(search: string): ScanUrlRead {
  let direct: string[];
  let resume: string[];
  try {
    const params = new URLSearchParams(search);
    direct = params.getAll(SCAN_PARAM);
    resume = params.getAll("resume").filter((value) => value.startsWith("scan:"));
  } catch {
    return { present: false, id: null };
  }
  const values = [...direct, ...resume.map((value) => value.slice("scan:".length))];
  if (values.length === 0) return { present: false, id: null };
  if (values.length > 1) return { present: true, id: null };
  return { present: true, id: isValidScanId(values[0]) ? values[0] : null };
}

function currentHref(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function withParam(href: string, id: string): string {
  const url = new URL(href, "http://scan.local");
  url.searchParams.delete("resume");
  url.searchParams.set(SCAN_PARAM, id);
  return `${url.pathname}${url.search}${url.hash}`;
}

function withoutParams(href: string): string {
  const url = new URL(href, "http://scan.local");
  url.searchParams.delete(SCAN_PARAM);
  url.searchParams.delete("resume");
  return `${url.pathname}${url.search}${url.hash}`;
}

function stateObject(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
}

export function isBaseEntry(): boolean {
  try {
    return stateObject()[BASE] === true;
  } catch {
    return false;
  }
}

function currentMark(): string | null {
  try {
    const mark = stateObject()[MARK];
    return typeof mark === "string" ? mark : null;
  } catch {
    return null;
  }
}

export function hasScanInUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has(SCAN_PARAM);
  } catch {
    return false;
  }
}

function currentScanParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(SCAN_PARAM);
  } catch {
    return null;
  }
}

export type ShowOutcome = "pushed" | "same" | "replaced" | "rebased" | "unavailable";

/** Deja la direccion en `?scan=<id>`. Idempotente: llamarla otra vez con la misma sesion no añade entradas. */
export function showScanInUrl(id: string): ShowOutcome {
  const href = currentHref();
  if (href === null) return "unavailable";
  try {
    const target = withParam(href, id);
    const present = currentScanParam();
    const mark = currentMark();
    if (present === id) {
      if (mark === id) return "same";
      // Llegada con `?scan=` sin pasar por nosotros (recarga o enlace): se crea la entrada base detras.
      const base = withoutParams(href);
      window.history.replaceState({ ...stateObject(), [BASE]: true }, "", base);
      window.history.pushState({ [MARK]: id }, "", target);
      return "rebased";
    }
    if (present !== null || mark === CLEARED) {
      window.history.replaceState({ [MARK]: id }, "", target);
      return "replaced";
    }
    window.history.replaceState({ ...stateObject(), [BASE]: true }, "", href);
    window.history.pushState({ [MARK]: id }, "", target);
    return "pushed";
  } catch {
    return "unavailable";
  }
}

/** Quita `scan=`/`resume=` de la direccion SIN añadir una entrada. Devuelve si habia algo que quitar. */
export function hideScanFromUrl(): boolean {
  const href = currentHref();
  if (href === null) return false;
  try {
    const has = new URLSearchParams(window.location.search).has(SCAN_PARAM) || new URLSearchParams(window.location.search).has("resume");
    if (!has) return false;
    window.history.replaceState(currentMark() !== null ? { [MARK]: CLEARED } : null, "", withoutParams(href));
    return true;
  } catch {
    return false;
  }
}
