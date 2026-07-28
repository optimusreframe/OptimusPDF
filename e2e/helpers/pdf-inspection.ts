/**
 * Inspeccion estructural de un PDF ya descargado, corriendo en el lado
 * Node del test (no en el navegador). Usa el build "legacy" de
 * pdfjs-dist, que es el unico pensado para Node: el build normal falla
 * con `DOMMatrix is not defined` fuera de un navegador real (confirmado
 * durante la fase 4 al intentar usarlo en Vitest). getTextContent() y
 * getOperatorList() no necesitan canvas -- solo el renderizado a pixeles
 * lo necesita, y eso se resuelve aparte en pdf-render-inspection.ts
 * usando el visor de PDF real de Chromium.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export type PageOperatorCounts = {
  /** Operaciones de pintado de texto (showText y variantes). */
  textPaintOps: number;
  /** Operaciones de pintado de imagen (XObject de imagen). */
  imagePaintOps: number;
  totalOps: number;
};

async function loadDocument(bytes: Buffer) {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(bytes);
  const loadingTask = pdfjsLib.getDocument({ data });
  return loadingTask.promise;
}

export async function getPageCount(bytes: Buffer): Promise<number> {
  const pdf = await loadDocument(bytes);
  const count = pdf.numPages;
  await pdf.loadingTask.destroy();
  return count;
}

/** Texto seleccionable de una pagina (base 1). Vacio si la pagina se rasterizo. */
export async function getPageText(bytes: Buffer, pageNumber: number): Promise<string> {
  const pdf = await loadDocument(bytes);
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return content.items.map((item: any) => item.str ?? "").join(" ");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Dimensiones de una pagina en puntos, con la rotacion ya aplicada. */
export async function getPageSize(
  bytes: Buffer,
  pageNumber: number,
): Promise<{ width: number; height: number }> {
  const pdf = await loadDocument(bytes);
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const TEXT_SHOW_OP_NAMES = new Set([
  "showText",
  "showSpacedText",
  "nextLineShowText",
  "nextLineSetSpacingShowText",
]);
const IMAGE_PAINT_OP_NAMES = new Set([
  "paintImageXObject",
  "paintInlineImageXObject",
  "paintImageMaskXObject",
]);

/**
 * Cuenta operaciones de pintado de texto vs. imagen en una pagina. Una
 * pagina censurada por `redactPdf` se reemplaza entera por una unica
 * imagen JPEG: no debe quedar NINGUNA operacion de texto, solo pintado de
 * imagen.
 */
export async function getPageOperatorCounts(
  bytes: Buffer,
  pageNumber: number,
): Promise<PageOperatorCounts> {
  const pdfjsLib = await getPdfjs();
  const pdf = await loadDocument(bytes);
  try {
    const page = await pdf.getPage(pageNumber);
    const ops = await page.getOperatorList();
    let textPaintOps = 0;
    let imagePaintOps = 0;
    for (const fn of ops.fnArray as number[]) {
      const name = pdfjsLib.OPS
        ? Object.keys(pdfjsLib.OPS).find((key) => pdfjsLib.OPS[key] === fn)
        : undefined;
      if (name && TEXT_SHOW_OP_NAMES.has(name)) textPaintOps += 1;
      if (name && IMAGE_PAINT_OP_NAMES.has(name)) imagePaintOps += 1;
    }
    return { textPaintOps, imagePaintOps, totalOps: ops.fnArray.length };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
