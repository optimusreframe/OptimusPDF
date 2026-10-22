/**
 * Piezas comunes de los E2E del motor REAL de «Extraer elementos» (F7 · U7.3): PDF del corpus del clasificador y PDF de escala
 * generados en Node con pdf-lib (NUNCA los PDF reales del usuario), apertura de la herramienta SIN gancho (motor de produccion) y
 * comparacion de la FORMA de una firma por su canal alfa (pixeles, no bytes: la compresion cambia entre maquinas). Headless siempre.
 */
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, type Page } from "@playwright/test";
import { pdfInput, setLanguage, type Lang } from "./extract-ui-flow";
import { pdfUpload, type PdfUpload } from "./test-files";
import type { PixelImage } from "./pdf-images";

export type CorpusName = "optimus-1signer" | "optimus-2signers" | "pasted-scans" | "docusign-like" | "logo-header-footer" | "scanned-page" | "vector-signatures" | "vector-decoys";

/** Un PDF del corpus del clasificador (se genera en Node con pdf-lib y `signPdfMulti`). */
export async function corpusUpload(name: CorpusName, fileName = `${name}.pdf`): Promise<PdfUpload> {
  const generate = await import("../../src/lib/pdf/extractAssets/__fixtures__/classify/generate");
  const fixtures: Record<CorpusName, () => Promise<{ bytes: Uint8Array }>> = {
    "optimus-1signer": generate.makeOptimusOneSigner,
    "optimus-2signers": generate.makeOptimusTwoSigners,
    "pasted-scans": generate.makePastedScans,
    "docusign-like": generate.makeDocuSignLike,
    "logo-header-footer": generate.makeLogoHeaderFooter,
    "scanned-page": generate.makeScannedPage,
    "vector-signatures": generate.makeVectorSignatures,
    "vector-decoys": generate.makeVectorDecoys,
  };
  return pdfUpload(fileName, Buffer.from((await fixtures[name]()).bytes));
}

/** `pages` paginas con `images` imagenes DISTINTAS de `side` x `height` px (RGB sin perdida): el documento de escala de las pruebas de rendimiento. */
export async function scalePdf(pages: number, images: number, side: number, height = side): Promise<PdfUpload> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const context = doc.context;
  const pageObjects = Array.from({ length: pages }, () => doc.addPage([612, 792]));
  for (let i = 0; i < images; i += 1) {
    const data = new Uint8Array(side * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const o = (y * side + x) * 3;
        data[o] = ((x >> 4) * 5 + i * 31) & 255;
        data[o + 1] = ((y >> 4) * 7 + i * 17) & 255;
        data[o + 2] = (((x + y) >> 5) + i * 53) & 255;
      }
    }
    const ref = context.register(context.flateStream(data, { Type: "XObject", Subtype: "Image", Width: side, Height: height, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    const page = pageObjects[i % pages];
    page.node.setXObject(PDFName.of(`Im${i}`), ref);
    const content = `q 120 0 0 120 ${40 + (i % 4) * 130} ${600 - Math.floor(i / pages) * 130} cm /Im${i} Do Q\n`;
    page.node.addContentStream(context.register(context.flateStream(new TextEncoder().encode(content))));
  }
  return pdfUpload(`escala-${pages}p-${images}i.pdf`, Buffer.from(await doc.save({ useObjectStreams: false })));
}

export const RUN_LABEL: Record<Lang, string> = { es: "Buscar elementos", en: "Find elements" };

/** Abre la herramienta con el motor REAL (sin gancho) y sube el PDF; NO pulsa «Buscar elementos». */
export async function openRealEngine(page: Page, upload: PdfUpload, lang: Lang = "es"): Promise<void> {
  await setLanguage(page, lang);
  await page.goto("/extract-assets");
  await pdfInput(page).setInputFiles(upload);
}

/** Pulsa «Buscar elementos» y espera el resultado. */
export async function runSearch(page: Page, lang: Lang = "es", timeout = 90_000): Promise<void> {
  await page.getByRole("button", { name: RUN_LABEL[lang] }).click();
  await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout });
}

export type Grid = number[];

/** Cobertura (0..1) de la tinta de un canal alfa, recortada a su caja y remuestreada a `cols x rows` casillas. */
export function alphaGrid(alpha: ArrayLike<number>, width: number, height: number, cols = 48, rows = 16): Grid {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x] > 40) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) return new Array(cols * rows).fill(0);
  const boxW = x1 - x0 + 1;
  const boxH = y1 - y0 + 1;
  const grid = new Array<number>(cols * rows).fill(0);
  const counts = new Array<number>(cols * rows).fill(0);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const gx = Math.min(cols - 1, Math.floor(((x - x0) / boxW) * cols));
      const gy = Math.min(rows - 1, Math.floor(((y - y0) / boxH) * rows));
      grid[gy * cols + gx] += alpha[y * width + x] > 40 ? 1 : 0;
      counts[gy * cols + gx] += 1;
    }
  }
  return grid.map((value, i) => (counts[i] > 0 ? value / counts[i] : 0));
}

/** Parecido (IoU de casillas con tinta > 0,25) entre dos rejillas de cobertura. */
export function gridIou(a: Grid, b: Grid): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    const inA = a[i] > 0.25;
    const inB = b[i] > 0.25;
    if (inA && inB) inter += 1;
    if (inA || inB) union += 1;
  }
  return union > 0 ? inter / union : 0;
}

/** Rejilla de la forma de un PNG (Buffer) segun su alfa. */
export async function pngGrid(bytes: Buffer | Uint8Array): Promise<Grid> {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, image.width, image.height).data;
  const alpha = new Uint8Array(image.width * image.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];
  return alphaGrid(alpha, image.width, image.height);
}

export function pixelGrid(image: PixelImage): Grid {
  return alphaGrid(image.alpha, image.width, image.height);
}

/** La rejilla de la firma/iniciales de una entrada del baul (IndexedDB real), leida en el navegador. */
export async function vaultGrid(page: Page, signerName: string, kind: "signature" | "initials", cols = 48, rows = 16): Promise<Grid> {
  const raw = await page.evaluate(
    async ({ name, which }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-signature-vault");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const request = db.transaction("signatures").objectStore("signatures").getAll();
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const record = records.find((item) => item.signerName === name);
      const image = record?.[which] as { png: Uint8Array } | null | undefined;
      if (!image) return null;
      const bitmap = await createImageBitmap(new Blob([image.png as BlobPart], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const alpha: number[] = [];
      for (let i = 3; i < data.length; i += 4) alpha.push(data[i]);
      return { width: canvas.width, height: canvas.height, alpha };
    },
    { name: signerName, which: kind },
  );
  if (!raw) throw new Error(`el baul no tiene ${kind} de ${signerName}`);
  return alphaGrid(raw.alpha, raw.width, raw.height, cols, rows);
}
