/**
 * Archivos de prueba generados al vuelo (nada binario en el repositorio):
 * PDF con texto identificable por pagina, tamanos y rotaciones a medida, e
 * imagenes PNG/JPEG de ruido determinista. Corre en el lado Node del test.
 */
import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { createCanvas, ImageData } from "@napi-rs/canvas";

export type MakePdfOptions = {
  pages: number;
  /** Prefijo del texto de cada pagina: "<label>-<n>" (n base 1). */
  label?: string;
  /** Tamano de cada pagina en puntos (por defecto, 300 x 400). */
  size?: [number, number] | ((index: number) => [number, number]);
  /** Texto de cada pagina si no basta con «<label>-<n>» (solo WinAnsi: sin euro ni CJK). */
  text?: (index: number) => string;
  /** Rotacion /Rotate de cada pagina (multiplo de 90). */
  rotate?: (index: number) => number;
  /** Cifra el PDF (contrasena de usuario). */
  userPassword?: string;
};

/** Texto que lleva la pagina `n` (base 1) de un PDF creado con `makePdf({ label })`. */
export function pageLabel(label: string, n: number): string {
  return `${label}-${n}`;
}

export async function makePdf(options: MakePdfOptions): Promise<Buffer> {
  const label = options.label ?? "PAG";
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < options.pages; index += 1) {
    const size =
      typeof options.size === "function" ? options.size(index) : (options.size ?? [300, 400]);
    const page = document.addPage(size);
    const content = options.text ? options.text(index) : pageLabel(label, index + 1);
    // El texto largo se encoge para no salirse de la pagina (pdfjs no extrae lo que queda fuera).
    const fontSize = Math.max(6, Math.min(18, (size[0] - 48) / (content.length * 0.55)));
    page.drawText(content, { x: 24, y: size[1] / 2, size: fontSize, font });
    const rotation = options.rotate?.(index) ?? 0;
    if (rotation) page.setRotation(degrees(rotation));
  }
  if (options.userPassword) {
    document.encrypt({
      userPassword: options.userPassword,
      ownerPassword: `${options.userPassword}-owner`,
      permissions: {},
    });
  }
  return Buffer.from(await document.save());
}

export type PdfUpload = { name: string; mimeType: string; buffer: Buffer };

export function pdfUpload(name: string, buffer: Buffer): PdfUpload {
  return { name, mimeType: "application/pdf", buffer };
}

/** Imagen de ruido determinista (alta entropia: pesa de verdad al comprimirla). */
export function makeImage(
  kind: "png" | "jpeg",
  width: number,
  height: number,
  seed = 1,
  quality = 90,
): Buffer {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = (seed * 2654435761) >>> 0 || 1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 256;
  };
  for (let index = 0; index < data.length; index += 4) {
    data[index] = rand();
    data[index + 1] = rand();
    data[index + 2] = rand();
    data[index + 3] = 255;
  }
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return kind === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", quality);
}

export type ImageUpload = { name: string; mimeType: string; buffer: Buffer };

export function imageUpload(
  name: string,
  kind: "png" | "jpeg",
  width: number,
  height: number,
  seed = 1,
): ImageUpload {
  return {
    name,
    mimeType: kind === "png" ? "image/png" : "image/jpeg",
    buffer: makeImage(kind, width, height, seed),
  };
}
