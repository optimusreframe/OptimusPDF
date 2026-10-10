/**
 * Lectura estructural de un PDF descargado con pdf-lib (lado Node): cajas,
 * rotacion, cifrado. Complementa a `pdf-inspection.ts` (pdfjs: texto,
 * operadores, tamano ya rotado).
 */
import { PDFDocument } from "@cantoo/pdf-lib";

export type Box = { x: number; y: number; width: number; height: number };

export type PageStructure = {
  mediaBox: Box;
  cropBox: Box;
  /** /Rotate de la pagina (0, 90, 180, 270). */
  rotation: number;
};

export async function readPages(bytes: Buffer): Promise<PageStructure[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => ({
    mediaBox: page.getMediaBox(),
    cropBox: page.getCropBox(),
    rotation: ((page.getRotation().angle % 360) + 360) % 360,
  }));
}

/** `true` si pdf-lib necesita contrasena para abrirlo (diccionario /Encrypt). */
export async function isEncrypted(bytes: Buffer): Promise<boolean> {
  try {
    await PDFDocument.load(bytes);
    return false;
  } catch {
    return true;
  }
}

/** Cabecera `%PDF-` al principio: comprobacion barata de que es un PDF. */
export function hasPdfHeader(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}
