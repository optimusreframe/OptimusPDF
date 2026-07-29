import { degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  loadPdf,
  originForCenter,
  savePdfToBlob,
  scaleProgress,
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

/* ------------------------------------------------------------------ *
 * Firma con varios firmantes
 * ------------------------------------------------------------------ */

export type SignatureFieldType = "signature" | "initials";

export const SIGNATURE_FIELD_TYPES: readonly SignatureFieldType[] = [
  "signature",
  "initials",
] as const;

export type Signer = {
  /** Identificador estable para React keys y para enlazar los campos. */
  id: string;
  name: string;
  /** Hexadecimal de `SIGNER_COLORS`. */
  color: string;
};

/** Hueco reservado en el documento para un firmante concreto. */
export type SignatureField = {
  id: string;
  signerId: string;
  pageIndex: number;
  type: SignatureFieldType;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

/**
 * Paleta fija con la que se distinguen los campos de cada firmante sobre
 * la vista previa. No son tokens del tema: son datos que viajan en el
 * estado y se pintan en linea, igual que `INK_COLORS`.
 */
export const SIGNER_COLORS = [
  "#0d4bff",
  "#0f9d68",
  "#e11d48",
  "#f59e0b",
  "#8b5cf6",
  "#0ea5e9",
] as const;

export function signerColorAt(index: number): string {
  const size = SIGNER_COLORS.length;
  return SIGNER_COLORS[((index % size) + size) % size];
}

export type SignPlacement = {
  /** PNG ya decodificado; el motor no toca `window`. */
  png: Uint8Array;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

export type SignMultiOptions = {
  placements: readonly SignPlacement[];
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

/**
 * Empotra una firma por cada colocacion recibida. La geometria es la
 * misma que comparten `editPdf.ts`, `crop.ts` y `watermark.ts`: aqui solo
 * se itera.
 */
export async function signPdfMulti(
  file: File,
  params: SignMultiOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const placements = params.placements;
    if (placements.length === 0) throw new PdfError("empty");

    const document = await loadPdf(file);
    onProgress?.(0.15);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    for (let position = 0; position < placements.length; position += 1) {
      const placement = placements[position];
      const index = Math.min(
        Math.max(0, placement.pageIndex),
        pages.length - 1,
      );
      const page = pages[index];
      const geometry = getPageGeometry(page);
      const image = await document.embedPng(placement.png);

      const rect = placement.rect;
      const maxWidth = Math.max(4, rect.width * geometry.viewWidth);
      const maxHeight = Math.max(4, rect.height * geometry.viewHeight);
      // El hueco reservado no tiene por que tener la proporcion del trazo
      // que acaba dentro: se encaja centrado en vez de deformarlo.
      const fit = Math.min(maxWidth / image.width, maxHeight / image.height);
      const width = image.width * fit;
      const height = image.height * fit;

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
      onProgress?.(
        scaleProgress((position + 1) / placements.length, 0.15, 0.85),
      );
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}

export async function signPdf(
  file: File,
  options: SignOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!options.signaturePng) throw new PdfError("empty");
  return signPdfMulti(
    file,
    {
      placements: [
        {
          png: dataUrlToBytes(options.signaturePng),
          pageIndex: options.placement.pageIndex,
          rect: options.placement.rect,
        },
      ],
    },
    onProgress,
  );
}
