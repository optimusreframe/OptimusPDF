import { effectiveFontKey, cssFontStack } from "@/lib/pdf/editFonts";
import type { CatalogFontKey } from "@/lib/pdf/editTypes";

/*
 * Metricas verticales para que la VISTA PREVIA coincida con lo que dibuja
 * `applyTextEdits`. El exportador (pdf-lib) pone la primera linea base a
 * `(lh*size - (asc+desc)*size)/2 + asc*size` bajo el borde superior de la caja,
 * con el ascenso y descenso de la fuente del PDF (AFM en las estandar, tablas
 * `hhea` en Liberation). El navegador reparte el interlineado igual, pero con
 * el ascenso y descenso de la fuente CSS que use el sistema; la diferencia
 * (medida con `measureText`) se resta en pantalla.
 */

export type VerticalMetrics = { ascent: number; descent: number };

/** Ascenso y descenso (em) con los que pdf-lib dibuja cada fuente del catalogo. */
export const PDF_FONT_METRICS: Readonly<Record<CatalogFontKey, VerticalMetrics>> = {
  helvetica: { ascent: 0.718, descent: 0.207 },
  times: { ascent: 0.683, descent: 0.217 },
  courier: { ascent: 0.629, descent: 0.157 },
  "liberation-sans": { ascent: 1854 / 2048, descent: 434 / 2048 },
  // hhea de Liberation 2.1.5 (unitsPerEm 2048); la Sans coincide con la 1.x.
  "liberation-serif": { ascent: 1825 / 2048, descent: 443 / 2048 },
  "liberation-mono": { ascent: 1705 / 2048, descent: 615 / 2048 },
};

/** Distancia (em) del borde superior de la caja a la primera linea base, como el exportador. */
export function exportBaselineFromTop(
  fontKey: CatalogFontKey,
  lineHeight: number,
): number {
  const { ascent, descent } = PDF_FONT_METRICS[effectiveFontKey(fontKey)];
  return (lineHeight - (ascent + descent)) / 2 + ascent;
}

let probe: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, VerticalMetrics | null>();

function context(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe;
  probe = null;
  if (typeof document === "undefined") return null;
  // jsdom no implementa canvas y avisa por consola: ahi no hay nada que medir.
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return null;
  try {
    probe = document.createElement("canvas").getContext("2d");
  } catch {
    probe = null;
  }
  return probe;
}

/** Ascenso y descenso (em) de la fuente CSS efectiva, o `null` si no se pueden medir. */
export function cssFontMetrics(
  fontKey: CatalogFontKey,
  bold: boolean,
  italic: boolean,
): VerticalMetrics | null {
  const key = `${fontKey}|${bold ? 1 : 0}${italic ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const ctx = context();
  let result: VerticalMetrics | null = null;
  if (ctx) {
    const font = cssFontStack(effectiveFontKey(fontKey), bold, italic);
    const size = 100;
    ctx.font = `${font.fontStyle} ${font.fontWeight} ${size}px ${font.fontFamily}`;
    const measured = ctx.measureText("Hg");
    if (
      Number.isFinite(measured.fontBoundingBoxAscent) &&
      Number.isFinite(measured.fontBoundingBoxDescent) &&
      measured.fontBoundingBoxAscent > 0
    ) {
      result = {
        ascent: measured.fontBoundingBoxAscent / size,
        descent: measured.fontBoundingBoxDescent / size,
      };
    }
  }
  cache.set(key, result);
  return result;
}

/**
 * Cuantos px (a la escala dada) hay que subir el texto en pantalla para que su
 * primera linea base caiga donde la dibujara el exportador. Positivo = el
 * navegador lo pondria mas abajo. 0 si no hay medida.
 */
export function previewBaselineShift(
  css: { fontKey: CatalogFontKey; bold: boolean; italic: boolean; fontSize: number; lineHeight: number },
  scale: number,
): number {
  const metrics = cssFontMetrics(css.fontKey, css.bold, css.italic);
  if (!metrics) return 0;
  const cssBaseline =
    (css.lineHeight - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
  const pdfBaseline = exportBaselineFromTop(css.fontKey, css.lineHeight);
  return (cssBaseline - pdfBaseline) * css.fontSize * scale;
}

export function __resetPreviewMetricsForTests(): void {
  probe = undefined;
  cache.clear();
}
