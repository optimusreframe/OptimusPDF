/*
 * Verdad de terreno ESTRUCTURAL de un contrato firmado, obtenida comparandolo con su version en blanco
 * (herramienta de desarrollo; solo posiciones y conteos, jamas texto ni imagenes de clientes).
 *
 *  - Las IMAGENES que el firmado tiene de mas (la firma o las iniciales estampadas) respecto al blanco, pagina a pagina
 *    (el firmado lleva UNA pagina extra al final —hoja de certificado antigua—: se ignora).
 *  - Los TEXTOS que el firmado tiene de mas (datos rellenados): solo su caja.
 *
 * Clasificacion por tamano (fracciones de pagina): iniciales si el ancho es <= 0,095; firma si es >= 0,125; entre
 * ambos `either` (podria ser cualquiera de las dos).
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  readPageGraphics,
  readPageTexts,
  viewGeometryOf,
  type CollectContext,
  type ImageBox,
} from "@/lib/pdf/autoMapCollect";
import type { OpsTable } from "@/lib/pdf/autoMapTypes";
import { underscoreSegments } from "@/lib/pdf/detectSlots";

export type NormRect = { x: number; y: number; width: number; height: number };
export type GtKind = "initials" | "signature" | "either";

export type GtImage = {
  pageIndex: number;
  rect: NormRect;
  kind: GtKind;
  /** La base de la imagen cae sobre una raya horizontal fina del blanco (ancla geometrica). */
  anchoredToLine: boolean;
  /** Largo (fraccion de pagina) de esa raya, o 0 si no esta anclada. */
  anchorWidth: number;
};
export type GtText = { pageIndex: number; rect: NormRect };

export type GroundTruth = {
  /** Paginas del blanco (el firmado puede traer una mas). */
  pages: number;
  signedPages: number;
  images: GtImage[];
  texts: GtText[];
};

export const GT_INITIALS_MAX_WIDTH = 0.095;
export const GT_SIGNATURE_MIN_WIDTH = 0.125;
/** Una imagen coincide con una de las del blanco si posicion y tamano difieren menos que esto (fraccion de pagina). */
const SAME_IMAGE_TOLERANCE = 0.004;
const SAME_TEXT_TOLERANCE = 0.003;

const context: CollectContext = { yieldEveryMs: 1e9, now: () => 0 };

type PageSnapshot = {
  images: NormRect[];
  texts: Array<NormRect>;
  lines: Array<{ x0: number; x1: number; y: number }>;
};

async function snapshot(pdf: PDFDocumentProxy, ops: OpsTable): Promise<PageSnapshot[]> {
  const out: PageSnapshot[] = [];
  for (let index = 0; index < pdf.numPages; index += 1) {
    const page = await pdf.getPage(index + 1);
    const geometry = viewGeometryOf(page);
    const texts = await readPageTexts(page, geometry);
    const graphics = await readPageGraphics(page, geometry, ops, context);
    const W = geometry.viewWidth;
    const H = geometry.viewHeight;
    const rectOf = (img: ImageBox): NormRect => ({ x: img.x0 / W, y: 1 - img.y1 / H, width: (img.x1 - img.x0) / W, height: (img.y1 - img.y0) / H });
    out.push({
      images: graphics.images.map(rectOf),
      texts: texts.map((t) => ({ x: t.left / W, y: 1 - (t.baseline + 0.85 * t.height) / H, width: (t.right - t.left) / W, height: (1.07 * t.height) / H })),
      // Rayas vectoriales y rayas dibujadas con guiones bajos de texto.
      lines: [...graphics.segments, ...underscoreSegments(texts)].map((s) => ({ x0: s.x0 / W, x1: s.x1 / W, y: 1 - s.y / H })),
    });
    page.cleanup();
  }
  return out;
}

function sameRect(a: NormRect, b: NormRect, tolerance: number): boolean {
  return (
    Math.abs(a.x - b.x) < tolerance &&
    Math.abs(a.y - b.y) < tolerance &&
    Math.abs(a.width - b.width) < tolerance &&
    Math.abs(a.height - b.height) < tolerance
  );
}

/** Una firma pequena sobre una raya larga (>= 0,16 de pagina) es una firma, no unas iniciales. */
export const GT_SIGNATURE_LINE_MIN_WIDTH = 0.16;

export function classifyGtImage(rect: NormRect, anchorWidth = 0): GtKind {
  if (anchorWidth >= GT_SIGNATURE_LINE_MIN_WIDTH) return rect.width >= GT_INITIALS_MAX_WIDTH ? "signature" : "either";
  if (rect.width <= GT_INITIALS_MAX_WIDTH) return "initials";
  if (rect.width >= GT_SIGNATURE_MIN_WIDTH) return "signature";
  return "either";
}

/** Compara un firmado con su blanco y devuelve las imagenes y textos anadidos (solo posiciones). */
export async function extractGroundTruth(blank: PDFDocumentProxy, signed: PDFDocumentProxy, ops: OpsTable): Promise<GroundTruth> {
  const [blankPages, signedPages] = await Promise.all([snapshot(blank, ops), snapshot(signed, ops)]);
  const images: GtImage[] = [];
  const texts: GtText[] = [];
  blankPages.forEach((base, pageIndex) => {
    const sign = signedPages[pageIndex];
    if (!sign) return;
    for (const rect of sign.images) {
      if (base.images.some((other) => sameRect(rect, other, SAME_IMAGE_TOLERANCE))) continue;
      const bottom = rect.y + rect.height;
      const hosts = base.lines.filter(
        (line) => Math.abs(line.y - bottom) <= 0.035 && Math.min(line.x1, rect.x + rect.width) - Math.max(line.x0, rect.x) > 0.3 * rect.width,
      );
      const anchorWidth = hosts.length > 0 ? Math.max(...hosts.map((line) => line.x1 - line.x0)) : 0;
      images.push({ pageIndex, rect, kind: classifyGtImage(rect, anchorWidth), anchoredToLine: hosts.length > 0, anchorWidth });
    }
    for (const rect of sign.texts) {
      if (base.texts.some((other) => sameRect(rect, other, SAME_TEXT_TOLERANCE))) continue;
      texts.push({ pageIndex, rect });
    }
  });
  return { pages: blankPages.length, signedPages: signedPages.length, images, texts };
}
