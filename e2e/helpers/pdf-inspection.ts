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

async function loadDocument(bytes: Buffer, password?: string) {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(bytes);
  const loadingTask = pdfjsLib.getDocument({
    data,
    ...(password === undefined ? {} : { password }),
    // Sin esto pdfjs avisa por stderr en cada PDF con fuentes estandar.
    standardFontDataUrl: `${path.resolve(process.cwd(), "node_modules/pdfjs-dist/standard_fonts")}${path.sep}`,
  });
  return loadingTask.promise;
}

export async function getPageCount(bytes: Buffer, password?: string): Promise<number> {
  const pdf = await loadDocument(bytes, password);
  const count = pdf.numPages;
  await pdf.loadingTask.destroy();
  return count;
}

/** Texto seleccionable de una pagina (base 1). Vacio si la pagina se rasterizo. */
export async function getPageText(
  bytes: Buffer,
  pageNumber: number,
  password?: string,
): Promise<string> {
  const pdf = await loadDocument(bytes, password);
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

/**
 * `true` si pdfjs pide contrasena para abrir el documento (PasswordException),
 * sea por no darla o por darla mal.
 */
export async function requiresPassword(bytes: Buffer, password?: string): Promise<boolean> {
  try {
    const pdf = await loadDocument(bytes, password);
    await pdf.loadingTask.destroy();
    return false;
  } catch (error) {
    if ((error as { name?: string }).name === "PasswordException") return true;
    throw error;
  }
}

/** Banderas de permiso del PDF cifrado (`null` si no esta cifrado o permite todo). */
export async function getPermissions(bytes: Buffer, password?: string): Promise<number[] | null> {
  const pdf = await loadDocument(bytes, password);
  try {
    const flags: number[] | null = await pdf.getPermissions();
    return flags;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Constantes de `PermissionFlag` de pdfjs (ISO 32000-1, tabla 22). */
export const PERMISSION = {
  PRINT: 0x04,
  MODIFY_CONTENTS: 0x08,
  COPY: 0x10,
  MODIFY_ANNOTATIONS: 0x20,
  FILL_INTERACTIVE_FORMS: 0x100,
  ASSEMBLE: 0x400,
} as const;

export type TextItem = {
  str: string;
  /** Inicio de la linea base, en puntos del espacio del PDF (origen abajo a la izquierda, sin rotar la pagina). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Matriz de texto [a, b, c, d, e, f]: b/a dan el giro del texto. */
  transform: number[];
};

/** Fragmentos de texto de una pagina (base 1) con su posicion; ignora los vacios. */
export async function getTextItems(bytes: Buffer, pageNumber: number, password?: string): Promise<TextItem[]> {
  const pdf = await loadDocument(bytes, password);
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (content.items as any[])
      .filter((item) => typeof item.str === "string" && item.str.trim() !== "")
      .map((item) => ({
        str: item.str as string,
        x: item.transform[4] as number,
        y: item.transform[5] as number,
        width: item.width as number,
        height: item.height as number,
        transform: item.transform as number[],
      }));
  } finally {
    await pdf.loadingTask.destroy();
  }
}
