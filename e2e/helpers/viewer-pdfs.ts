import { randomBytes } from "node:crypto";
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from "@cantoo/pdf-lib";

/**
 * PDF de prueba para el visor continuo de PDF Pro (Wave 7 · U3): muchas paginas, de tamanos distintos, con
 * giro y CropBox, y uno pesado (~40 MB de ruido incompresible) para medir la apertura.
 */

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [595, 842],
  [842, 595],
  [612, 792],
  [420, 595],
  [1190, 1684],
  [300, 300],
  [595, 842],
  [200, 800],
];

export type ViewerPdfOptions = {
  mixed?: boolean;
  rotate?: boolean;
  crop?: boolean;
  /** KB de ruido incompresible por pagina (para pesar mucho). */
  noiseKb?: number;
};

export async function makeViewerPdf(pages: number, options: ViewerPdfOptions = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const [w, h] = options.mixed ? SIZES[i % SIZES.length] : [595, 842];
    const page = doc.addPage([w, h]);
    page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 2 });
    page.drawText(`PAGINA ${i + 1}`, { x: 40, y: h - 90, size: Math.min(48, w / 8), font, color: rgb(0, 0, 0.6) });
    if (options.rotate && i % 3 === 1) page.setRotation(degrees(90));
    if (options.rotate && i % 5 === 2) page.setRotation(degrees(180));
    if (options.crop && i % 4 === 3) page.setCropBox(30, 30, w - 80, h - 120);
    if (options.noiseKb) {
      const data = randomBytes(options.noiseKb * 1024);
      const side = Math.floor(Math.sqrt(data.length));
      const stream = doc.context.stream(data.subarray(0, side * side), {
        Type: "XObject",
        Subtype: "Image",
        Width: side,
        Height: side,
        ColorSpace: "DeviceGray",
        BitsPerComponent: 8,
      });
      const ref = doc.context.register(stream);
      page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Im0: ref }));
      const content = doc.context.register(doc.context.stream(`q 200 0 0 200 ${w - 260} 40 cm /Im0 Do Q`));
      const existing = page.node.get(PDFName.of("Contents"));
      page.node.set(PDFName.of("Contents"), doc.context.obj(existing ? [existing, content] : [content]));
    }
  }
  return Buffer.from(await doc.save());
}
