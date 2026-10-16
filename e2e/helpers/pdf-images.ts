/**
 * Imagenes empotradas en un PDF firmado y su comparacion con el trazo capturado (Firma agil · F1 · U1.3).
 *
 * `embeddedImages` lee los XObject de imagen del PDF (el motor de firma usa `embedPng`: RGB + mascara de transparencia
 * `SMask`) y los decodifica; `pngPixels` decodifica el PNG del trazo tal como lo guarda la aplicacion (`data:` URL). Un
 * trazo y una imagen empotrada son EL MISMO si su mascara de transparencia (la forma del trazo) coincide pixel a pixel:
 * dos firmas distintas dibujadas con semillas distintas tienen formas distintas.
 */
import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";

export type PixelImage = { width: number; height: number; alpha: Uint8Array };

function dataUrlBytes(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new Error("no es una data URL");
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

/** La forma (canal alfa) de un PNG, tal como lo decodifica el navegador de Node (`@napi-rs/canvas`). */
export async function pngPixels(dataUrl: string): Promise<PixelImage> {
  const image = await loadImage(dataUrlBytes(dataUrl));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, image.width, image.height).data;
  const alpha = new Uint8Array(image.width * image.height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = rgba[index * 4 + 3];
  return { width: image.width, height: image.height, alpha };
}

/** Todas las imagenes con transparencia que el PDF trae empotradas (una por firma colocada o reutilizada). */
export async function embeddedImages(bytes: Buffer | Uint8Array): Promise<PixelImage[]> {
  const pdf = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
  const out: PixelImage[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    const mask = dict.get(PDFName.of("SMask"));
    if (!(mask instanceof PDFRef)) continue;
    const maskStream = pdf.context.lookup(mask);
    if (!(maskStream instanceof PDFRawStream)) continue;
    const width = Number(dict.get(PDFName.of("Width"))?.toString());
    const height = Number(dict.get(PDFName.of("Height"))?.toString());
    const alpha = decodePDFRawStream(maskStream).decode();
    out.push({ width, height, alpha: new Uint8Array(alpha) });
  }
  return out;
}

export const shapeHash = (image: PixelImage): string =>
  createHash("sha256").update(`${image.width}x${image.height}:`).update(image.alpha).digest("hex");

/** Mismo ancho, mismo alto y la misma mascara de transparencia. */
export function sameShape(a: PixelImage, b: PixelImage): boolean {
  return shapeHash(a) === shapeHash(b);
}
