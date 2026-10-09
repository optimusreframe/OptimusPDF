/**
 * Texto de la region viva de borradores: el aviso de «demasiado grande para
 * guardarse» y el de lo ocurrido al retomar (recortes, sellos descartados...)
 * pueden coincidir; se muestran AMBOS, no uno tapa al otro.
 */
export function draftStatusLine(
  tooBig: boolean,
  tooBigText: string,
  notice: string | null,
): string {
  return [tooBig ? tooBigText : null, notice]
    .filter((text): text is string => Boolean(text))
    .join(" ");
}
