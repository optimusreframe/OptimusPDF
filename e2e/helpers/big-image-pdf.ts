/**
 * PDF SINTETICO con fotos ENORMES (Flate RGB sin perdida, 40 MP cada una) para las pruebas de memoria de «Extraer elementos» (H11): la
 * foto son franjas lisas, el archivo pesa unos cientos de KB y pdf.js necesitaria ~280 MB para decodificar cada una. Solo Node.
 */
import zlib from "node:zlib";
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { pdfUpload, type PdfUpload } from "./test-files";

export async function bigImagesPdf(count: number, width: number, height: number): Promise<PdfUpload> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const context = doc.context;
  const page = doc.addPage([612, 792]);
  // Cada fila es distinta por imagen (la huella de dos fotos iguales las fundiria en una).
  for (let i = 0; i < count; i += 1) {
    const deflate = zlib.createDeflate({ level: 1 });
    const chunks: Buffer[] = [];
    deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      deflate.on("end", resolve);
      deflate.on("error", reject);
    });
    // Franjas verticales (la misma fila en toda la imagen, como una foto muy lisa): el archivo pesa unos cientos de KB.
    const row = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x += 1) {
      row[x * 3] = ((x >> 6) * 3 + i * 40) & 255;
      row[x * 3 + 1] = (60 + i * 30) & 255;
      row[x * 3 + 2] = (90 + i * 50) & 255;
    }
    for (let y = 0; y < height; y += 1) {
      if (!deflate.write(row)) await new Promise<void>((resolve) => deflate.once("drain", resolve));
    }
    deflate.end();
    await done;
    const data = Buffer.concat(chunks);
    const ref = context.register(
      context.stream(data, { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "FlateDecode" }),
    );
    page.node.setXObject(PDFName.of(`Im${i}`), ref);
    page.node.addContentStream(context.register(context.flateStream(new TextEncoder().encode(`q 160 0 0 100 ${40 + i * 180} 600 cm /Im${i} Do Q\n`))));
  }
  return pdfUpload(`fotos-${count}x${Math.round((width * height) / 1e6)}mp.pdf`, Buffer.from(await doc.save({ useObjectStreams: false })));
}
