import { degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  loadPdf,
  originForCenter,
  savePdfToBlob,
  toPdfError,
  viewPointToUser,
  type NormalizedRect,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de firma: empotra la firma (siempre un PNG generado en el
 * navegador a partir del trazo, del texto o de la imagen que sube el
 * usuario) en la posicion elegida sobre la vista previa.
 *
 * IMPORTANTE: esto NO es una firma electronica cualificada. Es una firma
 * visual (una imagen colocada sobre la pagina), que es lo que se puede
 * hacer con honestidad sin certificados ni servidor.
 */

export type SignaturePlacement = {
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

export type SignOptions = {
  /** PNG en data URL producido por el compositor de firma. */
  signaturePng: string;
  placement: SignaturePlacement;
};

/** Convierte un data URL base64 en bytes, sin pasar por la red. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.startsWith("data:")) {
    throw new PdfError("invalidType");
  }
  const binary = window.atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function signPdf(
  file: File,
  options: SignOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    if (!options.signaturePng) throw new PdfError("empty");

    const document = await loadPdf(file);
    onProgress?.(0.25);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const index = Math.min(
      Math.max(0, options.placement.pageIndex),
      pages.length - 1,
    );
    const page = pages[index];
    const geometry = getPageGeometry(page);

    const image = await document.embedPng(dataUrlToBytes(options.signaturePng));
    onProgress?.(0.6);

    const rect = options.placement.rect;
    const width = Math.max(4, rect.width * geometry.viewWidth);
    const height = Math.max(4, rect.height * geometry.viewHeight);

    // El DOM mide desde arriba; el espacio de vista, desde abajo.
    const vx = (rect.x + rect.width / 2) * geometry.viewWidth;
    const vy =
      geometry.viewHeight - (rect.y + rect.height / 2) * geometry.viewHeight;

    const center = viewPointToUser(geometry, vx, vy);
    // Se compensa el `/Rotate` para que la firma se vea recta en pantalla.
    const angle = geometry.rotation;
    const origin = originForCenter(
      center.x,
      center.y,
      width,
      height,
      0,
      angle,
    );

    page.drawImage(image, {
      x: origin.x,
      y: origin.y,
      width,
      height,
      rotate: degrees(angle),
    });
    onProgress?.(0.85);

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
