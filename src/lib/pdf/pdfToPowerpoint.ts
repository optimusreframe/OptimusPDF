import PptxGenJS from "pptxgenjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  scaleProgress,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  JPG_QUALITY_DEFAULT,
  JPG_QUALITY_MAX,
  JPG_QUALITY_MIN,
  type PdfToImageScale,
} from "@/lib/pdf/pdfToImages";

/**
 * Motor "PDF -> PowerPoint".
 *
 * Cada pagina del PDF se convierte en UNA diapositiva con UNA IMAGEN de esa
 * pagina completa: no son diapositivas editables. La UI debe dejarlo
 * explicito.
 *
 * Reutiliza las mismas primitivas de bajo nivel que `pdfToImages.ts`
 * (`openPdfDocument` + `document.getPage` + `renderPageToCanvas` +
 * `closePdfDocument`, todas de `@/lib/pdf/core`) para abrir el documento
 * UNA vez y rasterizar pagina a pagina, en vez de invocar la funcion
 * publica `pdfToImages()` en un loop (que reabriria/reparsearia el PDF
 * completo N veces). No hizo falta promover ningun helper nuevo en
 * `pdfToImages.ts`: esas primitivas ya son publicas en `core.ts` y
 * `pdfToImages.ts` en si mismo no es mas que otro consumidor de ellas.
 *
 * El render offscreen usa SIEMPRE `intent: "print"` (ver comentario en
 * `pdfToImages.ts`): con `"display"` pdf.js encadena los pasos con
 * `requestAnimationFrame` y el proceso se congela en pestanas en segundo
 * plano.
 */

export type PdfToPowerpointOptions = {
  /** Calidad JPEG 0.5..1 (mismo rango que `pdfToImages`). */
  quality: number;
  /** Escala de render: 1x ~ 72 DPI, 2x ~ 144 DPI, 3x ~ 216 DPI. */
  scale: PdfToImageScale;
};

export const DEFAULT_PDF_TO_POWERPOINT_OPTIONS: PdfToPowerpointOptions = {
  quality: JPG_QUALITY_DEFAULT,
  scale: 2,
};

/**
 * Tope de paginas totales del PDF de entrada. Ni `pdfToImages.ts` ni
 * `core.ts` definen hoy un limite de paginas reutilizable (se busco antes
 * de crear este). 300 paginas a escala 3x en JPG genera un .pptx de un
 * tamano ya considerable pero manejable en memoria de un navegador
 * corriente; por encima de eso, con `scale`/`quality` ya acotando el peso
 * de cada imagen individual (igual que hace `pdfToImages.ts`), lo que
 * queda sin tope es el numero de imagenes acumuladas en el paquete final,
 * y esta cifra corta esa acumulacion sin bytes acumulados por separado.
 */
export const MAX_PDF_TO_POWERPOINT_PAGES = 300;

/**
 * Tope duro de pixeles por LADO de canvas que este motor esta dispuesto a
 * rasterizar. Codex reprodujo el problema que motiva este limite: cuando
 * un canvas excede el tamano maximo que un navegador soporta (varia por
 * navegador/motor, pero todos rondan desde algunos miles hasta unas pocas
 * decenas de miles de pixeles por lado), `canvas.toDataURL("image/jpeg",
 * ...)` puede devolver un data URL vacio/degenerado ("data:,") EN VEZ de
 * lanzar una excepcion -- y `pptxgenjs` lo acepta en silencio: solo omite
 * la imagen de esa diapositiva, que queda en blanco sin que nadie se
 * entere hasta abrir el archivo. 8000px deja margen conservador bajo los
 * limites conocidos mas bajos (Chromium, Firefox y Safari soportan varios
 * miles de px por lado sin problema); una pagina real, incluso a formato
 * poster (A0) con `scale` 3 (216 DPI), no se acerca a esta cifra.
 */
export const MAX_CANVAS_DIMENSION_PX = 8000;

/**
 * Tope duro de AREA total (ancho x alto) en pixeles del canvas. Complementa
 * `MAX_CANVAS_DIMENSION_PX`: dos lados individualmente por debajo del tope
 * por lado pueden seguir multiplicando a un area que agota la memoria del
 * navegador (un canvas RGBA sin comprimir pesa 4 bytes/pixel). 64.000.000px
 * (~8000x8000) cubre paginas grandes reales con margen, sin depender solo
 * de que ningun lado individual toque su maximo.
 */
export const MAX_CANVAS_AREA_PX = 64_000_000;

/** Prefijo exacto que debe encabezar un data URL JPEG valido. */
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

/**
 * Longitud minima razonable (en caracteres base64, tras el prefijo) para
 * aceptar un data URL como un JPEG "real". Un JPEG valido de cualquier
 * contenido, por trivial que sea, trae cabeceras y tablas de cuantizacion
 * que nunca lo dejan en un puñado de caracteres: cualquier cosa por debajo
 * de este umbral es, con confianza razonable, un resultado degenerado
 * (canvas vacio, contexto perdido, limite del navegador alcanzado) y no
 * una imagen real.
 */
const MIN_VALID_JPEG_BASE64_LENGTH = 100;

/**
 * Tope de bytes JPEG acumulados (estimados a partir de la longitud del
 * data URL en base64 de cada pagina -- proporcional al tamano real del
 * JPEG, ~4/3 mas grande) que este motor esta dispuesto a retener en
 * memoria mientras arma el .pptx en curso. `pptx.write()` empaqueta todo
 * en una unica llamada al final: hasta ahora solo se limitaba el NUMERO de
 * paginas (`MAX_PDF_TO_POWERPOINT_PAGES`), pero nada acotaba el peso
 * acumulado de las imagenes ya retenidas en memoria antes de llegar ahi.
 * 300 MB en bytes JPEG reales es generoso para cualquier presentacion real
 * hasta el tope de paginas a `scale`/`quality` maximos, pero corta el caso
 * patologico (muchas paginas densas a resolucion alta) antes de que se
 * acumule un volumen de memoria excesivo.
 */
export const MAX_ACCUMULATED_IMAGE_BYTES = 300 * 1024 * 1024;

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return JPG_QUALITY_DEFAULT;
  return Math.min(JPG_QUALITY_MAX, Math.max(JPG_QUALITY_MIN, value));
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.min(3, Math.max(1, Math.round(value)));
}

/**
 * Acota `requestedScale` hacia abajo si, aplicado al tamano en puntos PDF
 * de esta pagina concreta, el canvas resultante excederia
 * `MAX_CANVAS_DIMENSION_PX` (por lado) o `MAX_CANVAS_AREA_PX` (area total).
 * Se llama ANTES de pedir el canvas real: `pageWidthPt`/`pageHeightPt` se
 * obtienen de `page.getViewport({ scale: 1 })`, que es sincrono y NO
 * rasteriza nada.
 */
function clampScaleForPageSize(
  requestedScale: number,
  pageWidthPt: number,
  pageHeightPt: number,
): number {
  if (!(pageWidthPt > 0) || !(pageHeightPt > 0)) return requestedScale;
  const maxByDimension = Math.min(
    MAX_CANVAS_DIMENSION_PX / pageWidthPt,
    MAX_CANVAS_DIMENSION_PX / pageHeightPt,
  );
  const maxByArea = Math.sqrt(
    MAX_CANVAS_AREA_PX / (pageWidthPt * pageHeightPt),
  );
  return Math.min(requestedScale, maxByDimension, maxByArea);
}

/**
 * Confirma que `dataUrl` es un JPEG base64 genuino y no un resultado
 * vacio/degenerado ("data:," u otra cosa) que `canvas.toDataURL()` puede
 * devolver sin lanzar excepcion cuando el canvas excede lo que el
 * navegador soporta.
 */
function isValidJpegDataUrl(dataUrl: string): boolean {
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) return false;
  return (
    dataUrl.length - JPEG_DATA_URL_PREFIX.length >= MIN_VALID_JPEG_BASE64_LENGTH
  );
}

/**
 * Convierte un PDF en una presentacion PPTX: una diapositiva por pagina,
 * cada una con la imagen rasterizada de esa pagina completa. Todas las
 * paginas se exportan (a diferencia de `pdfToImages`, no hay seleccion
 * parcial).
 */
export async function pdfToPowerpoint(
  file: File,
  options: PdfToPowerpointOptions = DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  const quality = clampQuality(options.quality);
  const scale = clampScale(options.scale);

  let document: PDFDocumentProxy | null = null;
  try {
    throwIfAborted(signal);
    document = await openPdfDocument(file);
    const totalPages = document.numPages;
    if (totalPages <= 0) throw new PdfError("empty");
    if (totalPages > MAX_PDF_TO_POWERPOINT_PAGES) throw new PdfError("tooLarge");

    const pptx = new PptxGenJS();
    // Dimensiones del layout de la presentacion, tomadas de la proporcion
    // de la PRIMERA pagina (puntos PDF -> pulgadas: pulgadas = puntos/72).
    let slideWidthIn = 0;
    let slideHeightIn = 0;
    // Presupuesto de bytes JPEG acumulados (estimados desde cada data URL):
    // ver comentario de `MAX_ACCUMULATED_IMAGE_BYTES`.
    let accumulatedImageBytes = 0;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      throwIfAborted(signal);

      const page = await document.getPage(pageNumber);

      // Tamano en puntos PDF de esta pagina a escala 1 (sincrono, no
      // rasteriza nada): sirve para acotar `scale` ANTES de pedirle a
      // `renderPageToCanvas` que reserve el <canvas> real.
      const basePageViewport = page.getViewport({ scale: 1 });
      const effectiveScale = clampScaleForPageSize(
        scale,
        basePageViewport.width,
        basePageViewport.height,
      );

      const canvas = await renderPageToCanvas(page, {
        scale: effectiveScale,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });

      // `renderPageToCanvas` escala la pagina por `effectiveScale`: dividir
      // por ese mismo factor recupera el tamano en puntos PDF de esta
      // pagina concreta (puede diferir de `scale` si esta pagina se acoto
      // por `MAX_CANVAS_DIMENSION_PX`/`MAX_CANVAS_AREA_PX`).
      const pageWidthIn = canvas.width / effectiveScale / 72;
      const pageHeightIn = canvas.height / effectiveScale / 72;

      if (pageNumber === 1) {
        slideWidthIn = pageWidthIn;
        slideHeightIn = pageHeightIn;
        pptx.defineLayout({
          name: "PDF_PAGE",
          width: slideWidthIn,
          height: slideHeightIn,
        });
        pptx.layout = "PDF_PAGE";
      }

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      // Libera la memoria del canvas antes de pasar a la siguiente pagina.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      if (!isValidJpegDataUrl(dataUrl)) {
        // Codex reprodujo esto: cuando un canvas excede el tamano maximo
        // que un navegador soporta, `toDataURL()` puede devolver un data
        // URL vacio/degenerado ("data:,") EN VEZ de lanzar una excepcion.
        // `pptxgenjs` tampoco lanza: solo omite la imagen de esa
        // diapositiva en su consola interna, y el .pptx final se genera
        // igual con esa diapositiva en blanco, sin que nadie se entere
        // hasta abrirlo. Se prefiere fallar aqui con honestidad.
        throw new PdfError(
          "unknown",
          `No se pudo rasterizar la pagina ${pageNumber}: canvas.toDataURL devolvio un resultado vacio o invalido`,
        );
      }

      // Estimacion de bytes JPEG reales a partir de la longitud base64
      // (proporcional al tamano real: cada 4 caracteres base64 codifican 3
      // bytes). Se comprueba a mitad de la iteracion -- no hace falta
      // esperar a terminar todas las paginas para saber que el presupuesto
      // ya se agoto.
      const base64Length = dataUrl.length - JPEG_DATA_URL_PREFIX.length;
      accumulatedImageBytes += Math.floor((base64Length * 3) / 4);
      if (accumulatedImageBytes > MAX_ACCUMULATED_IMAGE_BYTES) {
        throw new PdfError("tooLarge");
      }

      // Si esta pagina tiene otra proporcion que la primera, se ajusta
      // (contain) para que la imagen no desborde ni se recorte: limitacion
      // conocida y aceptada, no se intenta redefinir el layout por pagina.
      const fit = Math.min(
        slideWidthIn / pageWidthIn,
        slideHeightIn / pageHeightIn,
      );
      const w = pageWidthIn * fit;
      const h = pageHeightIn * fit;
      const x = (slideWidthIn - w) / 2;
      const y = (slideHeightIn - h) / 2;

      const slide = pptx.addSlide();
      slide.addImage({ data: dataUrl, x, y, w, h });

      // Se reserva el ultimo tramo del progreso para el empaquetado final.
      onProgress?.(scaleProgress(pageNumber / totalPages, 0, 0.95));
    }

    // Mejor esfuerzo: `pptx.write()` empaqueta el ZIP final en una sola
    // llamada no cancelable a medio camino, igual que `pdfMake.createPdf()
    // .getBlob()` en `wordToPdf.ts`. Se comprueba la senal justo antes,
    // pero una cancelacion durante el empaquetado en si no se puede cortar.
    throwIfAborted(signal);
    const output = await pptx.write({ outputType: "blob" });
    onProgress?.(1);
    return output as Blob;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (document) await closePdfDocument(document);
  }
}
