/**
 * Utilidades SOLO PARA PRUEBAS de `textBlocks*.test.ts`: generan PDFs
 * sinteticos con `@cantoo/pdf-lib` / `pdfkit` y los abren con el build
 * `legacy` de pdf.js, que SI funciona en Node (el principal exige
 * `DOMMatrix`). Mismo enfoque que `detectFields.test.ts`. Ninguna
 * dependencia nueva, y la aplicacion no importa este archivo.
 */
import path from "node:path";
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from "@cantoo/pdf-lib";
import type { TextBlock, UserBox } from "@/lib/pdf/editTypes";
import type { TextOps } from "@/lib/pdf/textBlocks";

export const STANDARD_FONT_DIR = path.join(
  process.cwd(),
  "node_modules/pdfjs-dist/standard_fonts/",
);

/** Metricas (fraccion del tamano) que pdf.js usa para las fuentes estandar. */
export const METRICS: Record<string, { ascent: number; descent: number }> = {
  [StandardFonts.Helvetica]: { ascent: 0.718, descent: -0.207 },
  [StandardFonts.HelveticaBold]: { ascent: 0.718, descent: -0.207 },
  [StandardFonts.TimesRoman]: { ascent: 0.683, descent: -0.217 },
  [StandardFonts.TimesRomanBold]: { ascent: 0.683, descent: -0.217 },
  [StandardFonts.Courier]: { ascent: 0.629, descent: -0.157 },
};

export type OpenedPdf = {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  doc: any;
  OPS: TextOps;
  page: (pageNumber: number) => Promise<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  close: () => Promise<void>;
};

/** Abre bytes de PDF con pdf.js legacy (analisis sin canvas). */
export async function openWithPdfjs(bytes: Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: STANDARD_FONT_DIR,
    verbosity: 0,
  });
  const doc = await task.promise;
  return {
    doc,
    OPS: pdfjs.OPS as unknown as TextOps,
    page: (n: number) => doc.getPage(n),
    close: async () => {
      await task.destroy();
    },
  };
}

export function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export type DrawSpec = {
  text: string;
  x: number;
  y: number;
  size: number;
  /** "#rrggbb" */
  color?: string;
  font?: StandardFonts;
  rotate?: number;
};

export type Expected = {
  text: string;
  /** Caja envolvente esperada (espacio de usuario). */
  box: UserBox;
  size: number;
  color: string;
  rotation: number;
};

export async function newDoc() {
  const doc = await PDFDocument.create();
  const fonts = new Map<StandardFonts, PDFFont>();
  const font = async (name: StandardFonts) => {
    let f = fonts.get(name);
    if (!f) {
      f = await doc.embedFont(name);
      fonts.set(name, f);
    }
    return f;
  };
  return { doc, font };
}

/** Caja envolvente esperada de un texto dibujado con `drawText`. */
export function expectedBox(
  spec: DrawSpec,
  widthOfText: number,
): UserBox {
  const metrics = METRICS[spec.font ?? StandardFonts.Helvetica];
  const angle = ((spec.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const bottom = metrics.descent * spec.size;
  const top = metrics.ascent * spec.size;
  const corners = [
    [0, bottom],
    [widthOfText, bottom],
    [0, top],
    [widthOfText, top],
  ].map(([u, v]) => ({
    x: spec.x + u * cos - v * sin,
    y: spec.y + u * sin + v * cos,
  }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Dibuja una linea y devuelve lo que se espera encontrar. */
export async function drawLine(
  page: PDFPage,
  fontFor: (name: StandardFonts) => Promise<PDFFont>,
  spec: DrawSpec,
): Promise<Expected> {
  const fontName = spec.font ?? StandardFonts.Helvetica;
  const font = await fontFor(fontName);
  const color = spec.color ?? "#000000";
  page.drawText(spec.text, {
    x: spec.x,
    y: spec.y,
    size: spec.size,
    font,
    color: hexToRgb(color),
    rotate: spec.rotate ? degrees(spec.rotate) : undefined,
  });
  // Ancho SIN kerning (pdf-lib no lo aplica al dibujar): suma por caracter.
  const width = [...spec.text].reduce(
    (sum, ch) => sum + font.widthOfTextAtSize(ch, spec.size),
    0,
  );
  return {
    text: spec.text,
    box: expectedBox(spec, width),
    size: spec.size,
    color,
    rotation: (((spec.rotate ?? 0) % 360) + 360) % 360,
  };
}

/**
 * Pagina con contenido en bruto: `content` es el flujo de la pagina y
 * `fonts` los recursos (`/F1` -> fuente).
 */
export function setRawContent(
  doc: PDFDocument,
  page: PDFPage,
  content: string,
  fonts: Record<string, PDFFont>,
) {
  const stream = doc.context.flateStream(content);
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  const map: Record<string, PDFRef> = {};
  for (const [name, font] of Object.entries(fonts)) map[name] = font.ref;
  page.node.Resources()?.set(PDFName.of("Font"), doc.context.obj(map));
}

/** Coincidencia de un bloque esperado con los detectados (texto normalizado). */
export function findBlock(
  blocks: readonly TextBlock[],
  text: string,
): TextBlock | undefined {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return blocks.find((b) => norm(b.text) === norm(text));
}

export type Check = {
  /** Cubre toda la tinta esperada (metricas AFM) con 1 pt de tolerancia. */
  covers: boolean;
  /** No se pasa de la tinta en mas de 0.4 x tamano + 1 pt por lado. */
  tight: boolean;
  size: boolean;
  color: boolean;
  rotation: boolean;
};

/**
 * Compara un bloque detectado con lo esperado. La caja esperada usa las
 * metricas AFM de la fuente (tinta real); pdf.js puede dar otro
 * ascenso/descenso (el de la fuente sustituta), asi que la caja detectada
 * debe CUBRIR la tinta y no pasarse mas de 0.4 em por cada lado. Los
 * extremos a lo largo de la linea base son exactos (ver `alongBaselineError`).
 */
export function checkBlock(block: TextBlock, expected: Expected): Check {
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const angleDelta = Math.abs(
    ((block.rotation - expected.rotation + 540) % 360) - 180,
  );
  const b = block.box;
  const e = expected.box;
  const slack = 1;
  const grow = 0.4 * expected.size + 1;
  return {
    covers:
      b.x <= e.x + slack &&
      b.y <= e.y + slack &&
      b.x + b.width >= e.x + e.width - slack &&
      b.y + b.height >= e.y + e.height - slack,
    tight:
      b.x >= e.x - grow &&
      b.y >= e.y - grow &&
      b.x + b.width <= e.x + e.width + grow &&
      b.y + b.height <= e.y + e.height + grow,
    size: near(block.fontSize, expected.size, 0.5),
    color: block.color.toLowerCase() === expected.color.toLowerCase(),
    rotation: angleDelta <= 0.5,
  };
}
