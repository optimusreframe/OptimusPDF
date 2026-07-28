/**
 * Renderiza una pagina de un PDF ya descargado a pixeles REALES en Node
 * (pdfjs-dist "legacy" + @napi-rs/canvas, el mismo backend de canvas que
 * pdfjs-dist ya trae como dependencia opcional) para poder muestrear
 * color exacto en zonas conocidas. Esto es lo que prueba que una zona
 * censurada ya no muestra el contenido original -- no basta con que el
 * texto no sea seleccionable, hay que ver que el pixel tampoco lo es.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function getPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const workerPath = pathToFileURL(
        path.resolve(
          process.cwd(),
          "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
        ),
      ).href;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

export type Rgba = { r: number; g: number; b: number; a: number };

export type RenderedPage = {
  width: number;
  height: number;
  /** Color de un pixel, en coordenadas de imagen (0,0 = esquina superior izquierda). */
  pixelAt: (x: number, y: number) => Rgba;
  /**
   * Color promedio de un rectangulo. Mas robusto que un solo pixel frente
   * a artefactos de compresion JPEG en los bordes de una zona censurada.
   */
  averageColor: (x: number, y: number, width: number, height: number) => Rgba;
};

export async function renderPageToPixels(
  bytes: Buffer,
  pageNumber: number,
  scale = 2,
): Promise<RenderedPage> {
  const pdfjsLib = await getPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    // @napi-rs/canvas implementa el mismo CanvasRenderingContext2D que
    // pdf.js espera del navegador real; se castea porque sus tipos no
    // coinciden byte a byte con el DOM lib de TypeScript.
    const context = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    await page.render({ canvasContext: context, viewport }).promise;

    const pixelAt = (x: number, y: number): Rgba => {
      const data = context.getImageData(x, y, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    };

    const averageColor = (
      x: number,
      y: number,
      width: number,
      height: number,
    ): Rgba => {
      const data = context.getImageData(x, y, width, height).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const count = width * height;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        a += data[i + 3];
      }
      return {
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count),
        a: Math.round(a / count),
      };
    };

    return { width: viewport.width, height: viewport.height, pixelAt, averageColor };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Distancia euclidiana simple entre 2 colores RGB (ignora alpha). */
export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.sqrt(
    (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2,
  );
}
