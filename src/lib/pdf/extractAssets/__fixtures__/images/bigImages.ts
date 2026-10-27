/**
 * PDF SINTETICOS con una foto ENORME (mas de 12 MP: el umbral de `imagesPrep.ts`) para probar que el motor no la decodifica entera:
 * un JPEG, y un RGB / gris de 8 bits con `/FlateDecode` sin predictor o con predictor PNG. Los pixeles son un degradado conocido
 * (`gradientPixel`) para comparar colores, nunca bytes.
 */

import zlib from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

/** Mas de 12 000 000 px (`BIG_ANALYSIS_PX`): 4100 x 3000 = 12,3 MP. */
export const BIG_WIDTH = 4100;
export const BIG_HEIGHT = 3000;

/** Color del degradado en (x, y): rojo crece hacia la derecha, verde hacia abajo y el azul es constante. */
export function gradientPixel(x: number, y: number, width = BIG_WIDTH, height = BIG_HEIGHT): [number, number, number] {
  return [Math.floor((255 * x) / width), Math.floor((255 * y) / height), 90];
}

export type BigFlateOptions = { width?: number; height?: number; comps?: 1 | 3; predictor?: "none" | "png" };

/** Filas RGB/gris sin comprimir (y, con `png`, cada una con su byte de filtro «Sub»). */
export function flateRows(options: Required<BigFlateOptions>): Uint8Array {
  const { width, height, comps, predictor } = options;
  const rowBytes = width * comps;
  const stride = rowBytes + (predictor === "png" ? 1 : 0);
  const out = new Uint8Array(stride * height);
  const row = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = gradientPixel(x, y, width, height);
      if (comps === 3) {
        row[x * 3] = r;
        row[x * 3 + 1] = g;
        row[x * 3 + 2] = b;
      } else row[x] = Math.round((r + g) / 2);
    }
    if (predictor === "png") {
      out[y * stride] = 1;
      for (let i = 0; i < rowBytes; i += 1) out[y * stride + 1 + i] = (row[i] - (i >= comps ? row[i - comps] : 0)) & 0xff;
    } else out.set(row, y * stride);
  }
  return out;
}

export type BigPdf = { bytes: Uint8Array; width: number; height: number };

/** PDF de una pagina con una imagen Flate de `width x height` dibujada en 300 x 200 pt. */
export async function bigFlatePdf(options: BigFlateOptions = {}): Promise<BigPdf> {
  const full = { width: options.width ?? BIG_WIDTH, height: options.height ?? BIG_HEIGHT, comps: options.comps ?? 3, predictor: options.predictor ?? "none" } as Required<BigFlateOptions>;
  const deflated = zlib.deflateSync(flateRows(full), { level: 1 });
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: full.width,
    Height: full.height,
    ColorSpace: full.comps === 3 ? "DeviceRGB" : "DeviceGray",
    BitsPerComponent: 8,
    Filter: "FlateDecode",
    Length: deflated.length,
    ...(full.predictor === "png" ? { DecodeParms: { Predictor: 15, Colors: full.comps, BitsPerComponent: 8, Columns: full.width } } : {}),
  });
  const ref = doc.context.register(PDFRawStream.of(dict as never, deflated));
  page.node.setXObject(PDFName.of("Im0"), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(300, 0, 0, 200, 50, 500), drawObject("Im0"), popGraphicsState());
  return { bytes: await doc.save({ useObjectStreams: false }), width: full.width, height: full.height };
}

/** PDF de una pagina con un JPEG de `width x height` (el degradado) dibujado en 300 x 200 pt. */
export async function bigJpegPdf(width = BIG_WIDTH, height = BIG_HEIGHT): Promise<BigPdf> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgb(0,0,90)");
  gradient.addColorStop(1, "rgb(255,0,90)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const vertical = ctx.createLinearGradient(0, 0, 0, height);
  vertical.addColorStop(0, "rgba(0,0,0,0)");
  vertical.addColorStop(1, "rgba(0,255,0,1)");
  ctx.fillStyle = vertical;
  ctx.fillRect(0, 0, width, height);
  const jpeg = new Uint8Array(canvas.toBuffer("image/jpeg", 85));
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedJpg(jpeg), { x: 50, y: 500, width: 300, height: 200 });
  return { bytes: await doc.save({ useObjectStreams: false }), width, height };
}
