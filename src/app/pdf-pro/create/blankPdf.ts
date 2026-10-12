import { PDFDocument } from "@cantoo/pdf-lib";
import { PdfError } from "@/lib/pdf/core";
import { BLANK_PAGE_SIZES } from "@/lib/pdf/pageAssembly";

/** Nuevo documento en blanco (Wave 7 · U8): A4 o Carta, vertical u horizontal, de 1 a `MAX_BLANK_PAGES` paginas. */

export const MAX_BLANK_PAGES = 200;

export type BlankDocumentOptions = {
  size: "a4" | "letter";
  orientation: "portrait" | "landscape";
  pages: number;
};

export const DEFAULT_BLANK_OPTIONS: BlankDocumentOptions = { size: "a4", orientation: "portrait", pages: 1 };

/** Cuantas paginas valen: entero entre 1 y `MAX_BLANK_PAGES` (cualquier otra cosa se ajusta al limite). */
export function clampBlankPages(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_BLANK_PAGES, Math.max(1, Math.round(value)));
}

export async function createBlankPdf(options: BlankDocumentOptions): Promise<Uint8Array> {
  const pages = clampBlankPages(options.pages);
  const base = BLANK_PAGE_SIZES[options.size === "letter" ? "letter" : "a4"];
  const width = options.orientation === "landscape" ? base.height : base.width;
  const height = options.orientation === "landscape" ? base.width : base.height;
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage([width, height]);
  const bytes = await document.save();
  if (bytes.byteLength === 0) throw new PdfError("unknown");
  return bytes;
}
