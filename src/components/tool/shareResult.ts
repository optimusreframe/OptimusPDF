/**
 * Plan B de la descarga en el movil: la hoja de compartir del sistema (`navigator.share({ files })`).
 *
 * `<a download>` con una URL de blob funciona en Safari de iPhone/iPad, pero no en todos los contextos: una web instalada en la
 * pantalla de inicio (modo `standalone`), el navegador interno de otra app o un Safari que bloquea las descargas dejan al
 * usuario sin archivo y sin explicacion. La hoja de compartir lo entrega siempre («Guardar en Archivos», AirDrop, Mensajes...).
 * Solo se ofrece cuando el navegador puede compartir ESTE archivo (`canShare`); donde no, la pantalla es la de siempre.
 */
type ShareNavigator = Navigator & {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

/** `true` si el navegador puede compartir ESTE archivo con la hoja del sistema. */
export function canShareResult(file: File): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as ShareNavigator;
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Abre la hoja de compartir. Debe llamarse DENTRO del manejador del toque (Safari exige un gesto reciente). Cerrar la hoja sin
 * elegir destino (`AbortError`) es `cancelled`: no es un fallo y no hay que descargar nada por detras.
 */
export async function shareResult(file: File): Promise<ShareOutcome> {
  try {
    await (navigator as ShareNavigator).share?.({ files: [file], title: file.name });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
