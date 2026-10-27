import { renderAsset } from "@/lib/pdf/extractAssets";
import type { ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import { isCancellation, type DownloadChoice } from "@/app/extract-assets/model";

/**
 * Descarga de un elemento (F7): lo que pide el motor y, para las firmas e iniciales que salen de una imagen incrustada, la LIMPIEZA con
 * `inkExtract` (la misma que «Guardar en Firmas guardadas»): fondo transparente, tinta completa, recorte ajustado con un margen pequeno
 * y sin deformar. Sin esto, la descarga era la imagen incrustada tal cual (con margenes y, en un JPEG, con el fondo blanco opaco).
 */

export type PreparedDownload = {
  blob: Blob;
  /** Se limpio el fondo. */
  cleaned: boolean;
  /** Se pidio limpiar pero no se pudo (sin tinta, demasiado oscura...): se entrega la imagen original. */
  fellBack: boolean;
};

/** PNG limpio de una imagen de firma (sin los topes del baul: PNG sin perdida, hasta 4096 px de lado). */
export async function cleanSignaturePng(source: Blob, hasAlpha: boolean, signal?: AbortSignal): Promise<Blob> {
  const ink = await import("@/lib/image/inkExtract");
  const decoded = await ink.decodeImageFile(source);
  const result = await ink.extractInkAsync(decoded, { ink: "original", evenLighting: !hasAlpha, crop: "auto", margin: "auto" }, { signal });
  const bytes = await ink.encodePngBytes(result.image);
  return new Blob([bytes as unknown as BlobPart], { type: "image/png" });
}

/** Bytes de una descarga: lo que devuelve el motor y, si hay que limpiarlo, su version limpia (con respaldo al original si no se puede). */
export async function prepareDownload(file: File, asset: ExtractedAsset, choice: DownloadChoice, signal?: AbortSignal): Promise<PreparedDownload> {
  const raw = await renderAsset(file, asset, choice.format);
  if (!choice.clean) return { blob: raw, cleaned: false, fellBack: false };
  try {
    return { blob: await cleanSignaturePng(raw, asset.pixel?.hasAlpha ?? false, signal), cleaned: true, fellBack: false };
  } catch (error) {
    if (isCancellation(error)) throw error;
    return { blob: raw, cleaned: false, fellBack: true };
  }
}
