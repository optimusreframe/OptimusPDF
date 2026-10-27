/**
 * ¿WebKit de iPhone/iPad? Ahi la memoria de la pagina es la mas ajustada (un WebContent de ~1 GB puede cerrarse sin avisar),
 * asi que algunos avisos solo se dan en esas plataformas. Un iPad con «sitio de escritorio» se presenta como Mac: se detecta por
 * `maxTouchPoints`. Se puede forzar en pruebas con `setIosWebkitOverride`.
 */
let override: boolean | null = null;

export function setIosWebkitOverride(value: boolean | null): void {
  override = value;
}

export function isIosWebKit(): boolean {
  if (override !== null) return override;
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}
