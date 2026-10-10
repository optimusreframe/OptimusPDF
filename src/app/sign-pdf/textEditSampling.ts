import {
  lineStripsToUserBoxes,
  sampleCanvasBackground,
  userBoxToPx,
  type PageMetrics,
} from "@/app/edit-pdf/editCanvasMath";
import type { SurfaceSample } from "@/app/edit-pdf/EditSurface";
import type { UserBox } from "@/lib/pdf/editTypes";

/*
 * Muestreo del fondo bajo un texto original (W6-A): la edicion de texto cubre el
 * original con el color de la pagina que lo rodea. Editar PDF lo lee del canvas
 * de su superficie; la vista de Firmar es una imagen (`<img>`, ver
 * `usePageImage`), asi que aqui se lee de ESA imagen: solo la ventana pequena
 * que hace falta, dibujada en un canvas temporal. La misma decision que Editar
 * PDF (`sampleCanvasBackground`, en px por punto), a cualquier resolucion.
 */

/** Fuente de pixeles sobre una imagen ya cargada, o `null` si no se puede leer (sin canvas, sin cargar). */
export function imagePixelSource(
  image: HTMLImageElement | null,
): { getImageData: (x: number, y: number, width: number, height: number) => ImageData } | null {
  if (!image || !image.complete || image.naturalWidth === 0 || typeof document === "undefined") {
    return null;
  }
  return {
    getImageData(x, y, width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("no-2d-context");
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    },
  };
}

/** Holgura (pt) que se deja entre la cobertura y un borde fino. */
const LINE_CLEARANCE_PT = 0.5;

export function sampleBackgroundFromImage(
  image: HTMLImageElement | null,
  metrics: PageMetrics | null,
  box: UserBox,
  quad?: ReadonlyArray<{ x: number; y: number }>,
  ignore?: readonly UserBox[],
  inner?: UserBox,
): SurfaceSample | null {
  const source = imagePixelSource(image);
  if (!image || !source || !metrics) return null;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const rect = userBoxToPx(metrics, box);
  // Px de imagen por px CSS: la imagen cubre la hoja entera, a la resolucion con que se dibujo.
  const k = width / metrics.cssWidth;
  // Px de imagen por punto PDF: independiente del zoom y de la resolucion.
  const pxPerPt = width / Math.max(1, metrics.geometry.viewWidth);
  const toImage = (b: UserBox) => {
    const r = userBoxToPx(metrics, b);
    return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
  };
  const sample = sampleCanvasBackground(
    source,
    { width, height },
    { x: rect.left * k, y: rect.top * k, width: rect.width * k, height: rect.height * k },
    quad?.map((point) => {
      const p = userBoxToPx(metrics, { x: point.x, y: point.y, width: 0, height: 0 });
      return { x: p.left * k, y: p.top * k };
    }),
    ignore?.map(toImage),
    { pxPerPt, inner: inner ? toImage(inner) : undefined },
  );
  if (!sample) return null;
  if (!sample.lines || sample.lines.length === 0) return sample;
  const clip = lineStripsToUserBoxes(metrics, sample.lines, k, pxPerPt, LINE_CLEARANCE_PT);
  return { ...sample, clip };
}
