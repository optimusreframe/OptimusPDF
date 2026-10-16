/**
 * Donde estan colocadas las imagenes (firmas e iniciales) de un PDF firmado, como fraccion de la pagina con el origen
 * ARRIBA-izquierda (igual que `SignatureField.rect`). Se lee del contenido con la matriz de transformacion que lleva el
 * cuadrado unidad de cada imagen a la pagina (pdf.js "legacy" en Node). Solo paginas sin giro.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PdfjsModule = any;
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function getPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async () => {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    return lib;
  })();
  return pdfjsPromise;
}

export type Placement = { page: number; x: number; y: number; width: number; height: number };

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

export async function imagePlacements(bytes: Buffer | Uint8Array): Promise<Placement[]> {
  const lib = await getPdfjs();
  const task = lib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: `${path.resolve(process.cwd(), "node_modules/pdfjs-dist/standard_fonts")}${path.sep}` });
  const pdf = await task.promise;
  const out: Placement[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const [x0, y0, x1, y1] = page.view as number[];
      const width = x1 - x0;
      const height = y1 - y0;
      const ops = await page.getOperatorList();
      const names = new Map<number, string>(Object.entries(lib.OPS as Record<string, number>).map(([key, value]) => [value, key]));
      const stack: Matrix[] = [];
      let ctm: Matrix = IDENTITY;
      ops.fnArray.forEach((fn: number, index: number) => {
        const name = names.get(fn);
        const args = ops.argsArray[index];
        if (name === "save") stack.push(ctm);
        else if (name === "restore") ctm = stack.pop() ?? IDENTITY;
        else if (name === "transform") ctm = mul(ctm, args as Matrix);
        else if (name === "paintImageXObject" || name === "paintInlineImageXObject" || name === "paintImageMaskXObject") {
          const w = Math.abs(ctm[0]);
          const h = Math.abs(ctm[3]);
          out.push({ page: pageNumber - 1, x: (ctm[4] - x0) / width, y: 1 - (ctm[5] + h - y0) / height, width: w / width, height: h / height });
        }
      });
    }
  } finally {
    await task.destroy();
  }
  return out;
}
