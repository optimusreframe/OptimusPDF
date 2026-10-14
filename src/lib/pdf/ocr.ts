import {
  StandardFonts,
  TextRenderingMode,
  degrees,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createOcrWorker } from "@/lib/pdf/ocrGuard";
import {
  PdfError,
  closePdfDocument,
  loadPdf,
  openPdfDocument,
  renderPageToCanvas,
  pdfBytesToBlob,
  savePdfToBytes,
  throwIfAborted,
  toPdfError,
  toWinAnsiSafe,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de OCR.
 *
 * Cada pagina se rasteriza con pdf.js (`intent: "print"`, obligatorio
 * para no depender de que la pestana pinte), se reconoce con
 * tesseract.js y el texto se superpone sobre la pagina ORIGINAL como
 * capa invisible (modo de render 3 del estandar PDF: los glifos se
 * posicionan pero no se pintan).
 *
 * Por eso la pagina no se rasteriza en la salida: el documento conserva
 * su calidad y gana una capa de texto seleccionable y buscable encima.
 *
 * tesseract.js se carga con `import()` dinamico y solo cuando el usuario
 * pulsa procesar: son varios megabytes de WebAssembly que nadie deberia
 * descargar por visitar la pagina.
 *
 * Limite honesto: el modelo de idioma se descarga de la CDN publica de
 * tesseract.js la primera vez (y queda en cache del navegador). El
 * documento nunca sale del dispositivo; lo que viaja es la peticion del
 * modelo, que no lleva ningun dato del archivo.
 */

export const OCR_LANGUAGES = ["spa", "eng", "fra", "por"] as const;
export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

export type OcrOptions = {
  language: OcrLanguage;
};

export const DEFAULT_OCR_OPTIONS: OcrOptions = { language: "spa" };

/** Resolucion de reconocimiento: 2x ~ 144 DPI, suficiente para texto impreso. */
const RECOGNITION_SCALE = 2;
const MAX_RASTER_SIDE = 4000;

/** Por debajo de esta confianza, tesseract suele devolver ruido. */
const MIN_WORD_CONFIDENCE = 30;

/** Proporcion de la altura de la caja que se usa como cuerpo de letra. */
const FONT_SIZE_RATIO = 0.8;

type ViewBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * Traduce un punto del render de pdf.js (origen arriba-izquierda, en
 * puntos PDF) al espacio de usuario del PDF (origen abajo-izquierda),
 * deshaciendo la rotacion que pdf.js aplica al viewport.
 *
 * Se deriva de la matriz que construye `PDFPageProxy.getViewport` para
 * cada valor de `/Rotate`.
 */
function renderedToUser(
  view: ViewBox,
  rotation: number,
  u: number,
  v: number,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: view.x0 + v, y: view.y0 + u };
    case 180:
      return { x: view.x1 - u, y: view.y0 + v };
    case 270:
      return { x: view.x1 - v, y: view.y1 - u };
    default:
      return { x: view.x0 + u, y: view.y1 - v };
  }
}

type RecognizedWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

/** Aplana la jerarquia bloque > parrafo > linea > palabra de tesseract. */
function collectWords(
  blocks: Array<{
    paragraphs: Array<{
      lines: Array<{ words: RecognizedWord[] }>;
    }>;
  }> | null,
): RecognizedWord[] {
  if (!blocks) return [];
  const words: RecognizedWord[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) words.push(word);
      }
    }
  }
  return words;
}

/**
 * Dibuja una palabra como texto invisible ajustado a su caja. Si la
 * fuente estandar no puede codificar algun caracter, se descarta esa
 * palabra en lugar de abortar el documento entero.
 */
function drawInvisibleWord(
  page: PDFPage,
  font: PDFFont,
  word: RecognizedWord,
  view: ViewBox,
  rotation: number,
  scale: number,
): void {
  const text = toWinAnsiSafe(word.text).trim();
  if (text.length === 0) return;

  const left = word.bbox.x0 / scale;
  const right = word.bbox.x1 / scale;
  const top = word.bbox.y0 / scale;
  const bottom = word.bbox.y1 / scale;

  const height = bottom - top;
  const width = right - left;
  if (height <= 0 || width <= 0) return;

  const size = Math.min(200, Math.max(1, height * FONT_SIZE_RATIO));
  const origin = renderedToUser(view, rotation, left, bottom);

  // Ajusta el ancho real de la palabra al de la caja detectada para que
  // la seleccion con el raton coincida con lo que se ve.
  let characterSpacing = 0;
  try {
    const natural = font.widthOfTextAtSize(text, size);
    characterSpacing = (width - natural) / text.length;
  } catch {
    return;
  }
  const spacingLimit = size * 0.5;
  characterSpacing = Math.min(
    spacingLimit,
    Math.max(-spacingLimit, characterSpacing),
  );

  try {
    page.drawText(text, {
      x: origin.x,
      y: origin.y,
      size,
      font,
      rotate: degrees(rotation),
      characterSpacing,
      renderMode: TextRenderingMode.Invisible,
    });
  } catch {
    // Caracter no codificable por la fuente estandar: se omite la palabra.
  }
}

export async function ocrPdf(
  file: File,
  options: OcrOptions = DEFAULT_OCR_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  return pdfBytesToBlob(await ocrPdfToBytes(file, options, onProgress, signal));
}

/**
 * Igual que `ocrPdf`, pero devuelve los BYTES del PDF resultante (sin pasar por un `Blob`): para quien sigue trabajando
 * con bytes (PDF Pro). Mismos bytes que el `Blob` de `ocrPdf`.
 */
export async function ocrPdfToBytes(
  file: File,
  options: OcrOptions = DEFAULT_OCR_OPTIONS,
  onProgress?: ProgressCallback,
  /**
   * Cancelacion real: el reconocimiento de una pagina cuesta segundos,
   * asi que se comprueba antes de empezar cada una en vez de dejar que
   * el trabajo siga consumiendo CPU despues de cancelar.
   */
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const language: OcrLanguage = OCR_LANGUAGES.includes(options.language)
    ? options.language
    : "spa";

  let viewer: PDFDocumentProxy | null = null;
  let worker: Awaited<
    ReturnType<typeof import("tesseract.js").createWorker>
  > | null = null;

  try {
    const document = await loadPdf(file);
    const total = document.getPageCount();
    if (total === 0) throw new PdfError("corrupt");

    viewer = await openPdfDocument(file);
    const font = await document.embedFont(StandardFonts.Helvetica);

    // Progreso real: cada pagina ocupa una franja y el reconocimiento
    // informa de su avance dentro de ella.
    let currentPage = 0;
    const report = (fraction: number) => {
      const value = (currentPage + Math.min(1, Math.max(0, fraction))) / total;
      onProgress?.(value * 0.95);
    };

    // Con guarda de inactividad (20 s) y error CLARO si no hay red a la CDN (antes: «Algo ha fallado»).
    worker = await createOcrWorker(
      language,
      (message) => {
        if (message.status === "recognizing text") {
          report(0.15 + message.progress * 0.8);
        }
      },
      signal,
    );

    const pages = document.getPages();

    for (let index = 0; index < total; index += 1) {
      throwIfAborted(signal);
      currentPage = index;
      report(0);

      const source = await viewer.getPage(index + 1);
      const base = source.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height, 1);
      const scale = Math.max(
        0.1,
        Math.min(RECOGNITION_SCALE, MAX_RASTER_SIDE / longest),
      );

      const canvas = await renderPageToCanvas(source, {
        scale,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });
      report(0.15);

      const result = await worker.recognize(
        canvas,
        {},
        { text: true, blocks: true },
      );
      canvas.width = 0;
      canvas.height = 0;

      const view = source.view;
      const box: ViewBox = {
        x0: view[0],
        y0: view[1],
        x1: view[2],
        y1: view[3],
      };
      const rotation = ((source.rotate % 360) + 360) % 360;
      source.cleanup();

      const target = pages[index];
      for (const word of collectWords(result.data.blocks)) {
        if (word.confidence < MIN_WORD_CONFIDENCE) continue;
        drawInvisibleWord(target, font, word, box, rotation, scale);
      }

      report(1);
    }

    const bytes = await savePdfToBytes(document);
    onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (worker) await worker.terminate();
    if (viewer) await closePdfDocument(viewer);
  }
}
