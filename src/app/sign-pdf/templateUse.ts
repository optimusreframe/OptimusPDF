/*
 * Cuando se uso por ultima vez cada plantilla de «Mis documentos» (W3-A2): solo para ordenar la hoja «Plantillas» (a igual parecido,
 * la que se usa mas a menudo sale primero). Un dato de interfaz de ESTE navegador: ids opacos y fechas, sin PII ni contenido, que
 * no viaja en ningun paquete. Nunca rompe el flujo si no hay almacenamiento.
 */

export const TEMPLATE_USE_KEY = "optimuspdf.sign.templateUse";
/** Solo se recuerdan las usadas mas recientemente (el resto no cambia el orden de forma util). */
const MAX_REMEMBERED = 200;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export type TemplateUse = Record<string, string>;

export function readTemplateUse(): TemplateUse {
  try {
    const raw = window.localStorage.getItem(TEMPLATE_USE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: TemplateUse = {};
    for (const [id, when] of Object.entries(parsed as Record<string, unknown>)) {
      if (ID.test(id) && typeof when === "string" && !Number.isNaN(Date.parse(when))) out[id] = when;
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberTemplateUse(id: string, now: Date = new Date()): void {
  if (!ID.test(id)) return;
  try {
    const next: TemplateUse = { ...readTemplateUse(), [id]: now.toISOString() };
    const kept = Object.entries(next)
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .slice(0, MAX_REMEMBERED);
    window.localStorage.setItem(TEMPLATE_USE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Sin almacenamiento: el orden se queda por parecido y por fecha de la plantilla.
  }
}
