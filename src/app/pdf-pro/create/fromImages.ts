import type { ProgressCallback } from "@/lib/pdf/core";
import type { ImageLayout } from "@/lib/pdf/imagesToPdf";

/** «Nuevo PDF desde imágenes» (Wave 7 · U8): hasta cuantas imagenes caben a la vez. */
export const MAX_NEW_IMAGES = 100;

export const DEFAULT_NEW_IMAGE_LAYOUT: ImageLayout = { orientation: "auto", pageSize: "a4", margin: "none" };

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|avif|gif|bmp)$/i;

/** El archivo es una imagen (por tipo MIME o, sin tipo, por extension). */
export function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("image/") || (file.type === "" && IMAGE_EXTENSION.test(file.name));
}

/**
 * Crea el PDF con `imagesToPdf` (el motor de «Imagen a PDF», carga diferida) y lo devuelve como `File` listo para
 * abrirse en PDF Pro. Las imagenes van en el orden dado y siempre en UN documento.
 */
export async function createPdfFromImages(
  files: readonly File[],
  layout: ImageLayout,
  fileName: string,
  onProgress?: ProgressCallback,
): Promise<File> {
  const { imagesToPdf } = await import("@/lib/pdf/imagesToPdf");
  // La calidad de imagen es la recordada en este dispositivo (la recomendada por defecto): las fotos grandes se reducen.
  const { readStoredImagePreset } = await import("@/lib/image/imageQualityPref");
  const result = await imagesToPdf([...files], { ...layout, merge: true, quality: readStoredImagePreset() }, onProgress);
  return new File([result.blob], fileName, { type: "application/pdf", lastModified: Date.now() });
}
