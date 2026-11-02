import path from "node:path";
import { build } from "vite";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import type { Page } from "@playwright/test";

/**
 * Banco de pruebas del motor «HTML a PDF» en un Chromium REAL: empaqueta el motor con Vite (en memoria, una vez por proceso),
 * lo mete en una pagina de la app y convierte paginas SINTETICAS. Despues analiza el PDF en el lado Node: tamaño de cada hoja,
 * y los pixeles de la imagen de cada pagina (se extrae el JPEG empotrado y se decodifica con `@napi-rs/canvas`).
 */

export type LayoutReport = {
  pages: number;
  blankPagesSkipped: number;
  forcedBreaks: number;
  layoutWidthPx: number;
  documentHeightPx: number;
  scale: number;
};

export type ConvertOptions = { pageSize?: "a4" | "letter"; orientation?: "portrait" | "landscape"; margin?: "none" | "small" | "large" };

async function bundleEngine(): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      rollupOptions: { output: { inlineDynamicImports: true } },
      lib: {
        entry: path.resolve(process.cwd(), "e2e/helpers/html-pdf-lab-entry.ts"),
        name: "HtmlPdfLabBundle",
        formats: ["iife"],
        fileName: () => "html-pdf-lab.js",
      },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el motor de HTML a PDF");
  return chunk.code;
}

let cached: Promise<string> | null = null;
export function engineBundle(): Promise<string> {
  cached ??= bundleEngine();
  return cached;
}

/** Abre una pagina de la app (mismas cabeceras CSP) y deja el motor en `window.HtmlPdfLab`. */
export async function installLab(page: Page): Promise<void> {
  await page.goto("/html-to-pdf");
  await page.addScriptTag({ content: await engineBundle() });
  await page.waitForFunction(() => "HtmlPdfLab" in window);
}

export async function convertHtml(page: Page, html: string, options: ConvertOptions = {}): Promise<{ pdf: Buffer; report: LayoutReport }> {
  const result = await page.evaluate(
    async ([source, opts]) => {
      const lab = (window as unknown as { HtmlPdfLab: { convert: (html: string, options: unknown) => Promise<{ base64: string; report: unknown }> } }).HtmlPdfLab;
      return lab.convert(source as string, opts);
    },
    [html, options] as const,
  );
  return { pdf: Buffer.from(result.base64, "base64"), report: result.report as LayoutReport };
}

export type PageImage = { width: number; height: number; rgba: Uint8ClampedArray };
export type PageAnalysis = {
  /** Tamaño de la hoja, en puntos. */
  widthPt: number;
  heightPt: number;
  /** La imagen que ESTA hoja dibuja (jsPDF reparte todas en un solo diccionario: se sigue el `Do` del contenido de la hoja). */
  image: PageImage | null;
  /** Donde la dibuja: esquina inferior izquierda y tamaño, en puntos. */
  placement: { x: number; y: number; width: number; height: number } | null;
};

/** Texto del contenido de una hoja (descomprimido). */
function contentOf(doc: PDFDocument, page: ReturnType<PDFDocument["getPages"]>[number]): string {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = doc.context.lookup(contents.get(index));
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  }
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")).join("\n");
}

/** Hojas del PDF y, de cada una, la imagen (JPEG) que dibuja, ya decodificada. */
export async function analyzePdf(pdf: Buffer | Uint8Array): Promise<PageAnalysis[]> {
  const doc = await PDFDocument.load(new Uint8Array(pdf), { updateMetadata: false });
  const out: PageAnalysis[] = [];
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    let image: PageImage | null = null;
    let placement: PageAnalysis["placement"] = null;
    const content = contentOf(doc, page);
    const draw = /([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+cm\s*\/(\w+)\s+Do/.exec(content);
    const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    if (draw && xobjects) {
      const ref = xobjects.get(PDFName.of(draw[7]));
      const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (stream instanceof PDFRawStream && stream.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) {
        const decoded = await loadImage(Buffer.from(stream.contents));
        const canvas = createCanvas(decoded.width, decoded.height);
        const context = canvas.getContext("2d");
        context.drawImage(decoded, 0, 0);
        image = { width: decoded.width, height: decoded.height, rgba: context.getImageData(0, 0, decoded.width, decoded.height).data };
        placement = { x: Number(draw[5]), y: Number(draw[6]), width: Number(draw[1]), height: Number(draw[4]) };
      }
    }
    out.push({ widthPt: width, heightPt: height, image, placement });
  }
  return out;
}

/** Cuantos pixeles de la fila `row` son tinta clara (algun canal por debajo de `threshold`). */
export function inkInRow(image: PageImage, row: number, threshold = 160): number {
  let count = 0;
  const offset = row * image.width * 4;
  for (let column = 0; column < image.width; column += 1) {
    const index = offset + column * 4;
    if (Math.min(image.rgba[index], image.rgba[index + 1], image.rgba[index + 2]) < threshold) count += 1;
  }
  return count;
}

/** Hay tinta en alguna parte de la imagen. */
export function hasInk(image: PageImage, threshold = 160): boolean {
  for (let index = 0; index < image.rgba.length; index += 4) {
    if (Math.min(image.rgba[index], image.rgba[index + 1], image.rgba[index + 2]) < threshold) return true;
  }
  return false;
}

/** Hay algun pixel cuyo color esta a menos de `tolerance` de `color` dentro de la region (fracciones 0-1 de la imagen). */
export function hasColor(image: PageImage, color: [number, number, number], region: { x0?: number; x1?: number; y0?: number; y1?: number } = {}, tolerance = 40): boolean {
  const x0 = Math.floor((region.x0 ?? 0) * image.width);
  const x1 = Math.ceil((region.x1 ?? 1) * image.width);
  const y0 = Math.floor((region.y0 ?? 0) * image.height);
  const y1 = Math.ceil((region.y1 ?? 1) * image.height);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * 4;
      if (
        Math.abs(image.rgba[index] - color[0]) <= tolerance &&
        Math.abs(image.rgba[index + 1] - color[1]) <= tolerance &&
        Math.abs(image.rgba[index + 2] - color[2]) <= tolerance
      ) {
        return true;
      }
    }
  }
  return false;
}
