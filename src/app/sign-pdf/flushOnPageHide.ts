/**
 * Volcado inmediato al irse de la pagina (best effort): con un debounce de unos
 * cientos de ms, recargar o cerrar la pestana justo despues de editar perderia
 * lo ultimo hecho (huecos, alcances).
 *
 * LIMITE FISICO (medido en Chromium headless, 10 intentos por evento): una
 * escritura a IndexedDB lanzada desde `pagehide` o `visibilitychange` ya NO
 * sobrevive a una recarga (0/10); desde `beforeunload` si (10/10), y
 * `localStorage` en `pagehide` tambien. Por eso se escucha `beforeunload`
 * (cerrar/recargar/navegar en escritorio), ademas de `pagehide` y
 * `visibilitychange -> hidden`, que cubren el movil y el cambio de pestana,
 * donde la pagina sigue viva y la escritura si se completa. Cerrar el
 * navegador a la fuerza o descartar la pestana no emite ningun evento: ahi lo
 * ultimo no se puede guardar.
 *
 * `flush` debe ser idempotente y respetar la generacion del autoguardado; aqui
 * nada lanza hacia el navegador. Devuelve la funcion que quita los oyentes
 * (quien llama la usa tambien en cuanto el volcado normal ya se hizo: sin nada
 * pendiente no hace falta oyente de `beforeunload`, que no conviene dejar
 * puesto por el bfcache).
 */
export function flushOnPageHide(flush: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const run = () => {
    try {
      flush();
    } catch {
      // El autoguardado es prescindible: jamas interrumpe.
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") run();
  };
  window.addEventListener("beforeunload", run);
  window.addEventListener("pagehide", run);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("beforeunload", run);
    window.removeEventListener("pagehide", run);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
