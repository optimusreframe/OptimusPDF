/**
 * Fecha y hora cortas («14 oct 2026, 10:32») para listas. Un ISO que no se puede leer (un valor manipulado en
 * `localStorage` o en IndexedDB) da `""` en vez de lanzar `RangeError: Invalid time value`, que rompia la pantalla entera.
 */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return "";
  }
}
