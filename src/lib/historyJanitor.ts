/**
 * Barrido LIGERO de historiales huerfanos de PDF Pro (Wave 8 · F2 menor 5, privacidad).
 *
 * Cerrar la pestana con el historial volcado a IndexedDB y sin cerrar el documento deja la base
 * `optimuspdf-pro-history-*` en el disco hasta la siguiente visita a /pdf-pro. Este modulo corre en CUALQUIER
 * pagina de la app, pero no cuesta nada si no hay nada que limpiar: solo pregunta a
 * `indexedDB.databases()` y, unicamente si existe alguna base con ese prefijo, carga `proHistoryStore`
 * (import dinamico) y le pide purgar las de sesiones muertas (las reconoce por su Web Lock: la base de otra
 * pestana VIVA no se toca). Nunca toca `optimuspdf-pro-drafts` (los borradores).
 */

/** Mismo valor que `PRO_HISTORY_DB_PREFIX` (un test lo comprueba): aqui no se importa el modulo pesado. */
export const HISTORY_DB_PREFIX = "optimuspdf-pro-history-";

/** Devuelve cuantas bases huerfanas se borraron (0 si no hay soporte, ninguna base o algo fallo). */
export async function sweepDeadHistoryDatabases(): Promise<number> {
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null || typeof indexedDB.databases !== "function") return 0;
    const names = (await indexedDB.databases()).map((info) => info.name);
    if (!names.some((name) => typeof name === "string" && name.startsWith(HISTORY_DB_PREFIX))) return 0;
    const { purgeStaleProHistoryDatabases } = await import("@/app/pdf-pro/proHistoryStore");
    return await purgeStaleProHistoryDatabases();
  } catch {
    return 0;
  }
}
