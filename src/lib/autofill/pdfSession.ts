/**
 * Lectura de un PDF para el autorrelleno: cajas de texto con posicion (capa de texto de pdf.js, con `/Rotate` aplicado), cuanto
 * texto legible hay (para decidir si la pagina necesita OCR) y rasterizado de una pagina (solo cuando el OCR hace falta).
 *
 * `wrapPdfJs` recibe un documento ya abierto —en el navegador, el de `openPdfDocument`; en las pruebas, el del build «legacy» de
 * pdfjs-dist— y no importa pdf.js: asi el mismo codigo corre en los dos entornos.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextBox } from "@/lib/autofill/layout";
import { MAX_BOXES_PER_PAGE } from "@/lib/autofill/layout";
import { countLegibleChars, imageCoverage, type CoverageOps } from "@/lib/pdf/pageTextKind";
import type { Rgba } from "@/lib/scan/pixels";

export type PdfPageText = {
  boxes: TextBox[];
  width: number;
  height: number;
  /** Caracteres no blancos de la capa de texto (todos, tambien los girados que no se usan como cajas). */
  chars: number;
  legible: number;
  illegible: number;
  /** Fraccion de la pagina cubierta por imagenes (perezoso: lee la lista de operadores). */
  imageCoverage: () => Promise<number>;
};

export interface PdfSession {
  numPages: number;
  readPage(index: number): Promise<PdfPageText>;
  /** Pagina a pixeles para el OCR, o `null` si no se puede. `side` = lado mayor deseado en px (por defecto, el de lectura completa). */
  rasterize(index: number, side?: number): Promise<Rgba | null>;
  /** Libera lo que pdf.js guarda de la pagina (memoria acotada en documentos largos). */
  release(index: number): Promise<void>;
  close(): Promise<void>;
}

export type WrapOptions = {
  ops: CoverageOps;
  rasterize?: (page: PDFPageProxy, side?: number) => Promise<Rgba | null>;
  close?: () => Promise<void>;
};

type TextItemLike = { str: string; transform: number[]; width: number; height: number };

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === "object" && item !== null && typeof (item as { str?: unknown }).str === "string" && Array.isArray((item as { transform?: unknown }).transform);
}

export function wrapPdfJs(pdf: PDFDocumentProxy, options: WrapOptions): PdfSession {
  return {
    numPages: pdf.numPages,
    async readPage(index) {
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const [a, b, c, d, e, f] = viewport.transform as unknown as number[];
      const map = (x: number, y: number): { x: number; y: number } => ({ x: a * x + c * y + e, y: b * x + d * y + f });
      const content = await page.getTextContent();
      const boxes: TextBox[] = [];
      let text = "";
      for (const item of content.items) {
        if (!isTextItem(item) || item.str.length === 0) continue;
        text += item.str;
        if (boxes.length >= MAX_BOXES_PER_PAGE) continue;
        const [t0, t1, t2, t3, tx, ty] = item.transform;
        const length = Math.hypot(t0, t1) || 1;
        const start = map(tx, ty);
        const end = map(tx + (item.width * t0) / length, ty + (item.width * t1) / length);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        // Texto girado o vertical en la VISTA no sirve para leer lineas.
        if (!(dx >= 0) || Math.abs(dy) > 0.2 * Math.max(Math.abs(dx), 0.01)) continue;
        const height = item.height || Math.hypot(t2, t3) || 10;
        boxes.push({ text: item.str, x0: start.x, x1: end.x, y0: start.y - 0.8 * height, y1: start.y + 0.2 * height });
      }
      const { legible, illegible } = countLegibleChars(text);
      const chars = text.replace(/\s/g, "").length;
      const result: PdfPageText = {
        boxes,
        width: viewport.width,
        height: viewport.height,
        chars,
        legible,
        illegible,
        imageCoverage: async () => {
          const list = await page.getOperatorList();
          return imageCoverage(list.fnArray, list.argsArray, options.ops, viewport.width * viewport.height);
        },
      };
      return result;
    },
    async release(index) {
      try {
        (await pdf.getPage(index + 1)).cleanup();
      } catch {
        // La pagina ya no esta: nada que liberar.
      }
    },
    async rasterize(index, side) {
      if (!options.rasterize) return null;
      const page = await pdf.getPage(index + 1);
      try {
        return await options.rasterize(page, side);
      } finally {
        page.cleanup();
      }
    },
    async close() {
      if (options.close) await options.close();
      else await pdf.loadingTask.destroy();
    },
  };
}
