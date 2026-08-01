import { PDFDocument, degrees, type PDFPage } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de organizacion de paginas: orden, rotacion, eliminacion e
 * insercion de paginas en blanco en una sola pasada. Modulo puro (sin
 * React).
 *
 * El plan es la lista final de paginas en el orden deseado; lo que no
 * aparece en la lista queda fuera del documento resultante. Duplicar una
 * pagina en la lista la duplica en la salida.
 *
 * Un plan vacio se interpreta como "documento intacto": es la salida
 * conservadora si la interfaz aun no ha terminado de construir el plan.
 */

export type OrganizePage =
  /** Una pagina del documento original, en su posicion final del plan. */
  | { kind: "existing"; page: number; rotation: number }
  /** Una pagina nueva y vacia, sin origen en el documento. */
  | { kind: "blank" };

/**
 * Tamano visual de una pagina copiada, respetando su rotacion EFECTIVA
 * final (original + delta del plan) -- `getSize()` de @cantoo/pdf-lib
 * devuelve el MediaBox crudo, que NO refleja `/Rotate`: una pagina
 * apaisada con /Rotate 90 devuelve {width,height} como si fuera vertical.
 * Verificado contra el codigo real de la libreria.
 */
function visualSize(page: PDFPage, extraRotation: number): [number, number] {
  const { width, height } = page.getSize();
  const angle = (((page.getRotation().angle + extraRotation) % 360) + 360) % 360;
  return angle === 90 || angle === 270 ? [height, width] : [width, height];
}

/**
 * Tamano que debe tener una pagina en blanco en la posicion `index` del
 * plan. Regla de herencia (decision de producto): la entrada `existing`
 * ANTERIOR mas cercana en el PLAN (no en el documento original); si no
 * hay, la `existing` SIGUIENTE mas cercana en el plan; si el plan es
 * todo-blancos, el tamano de la pagina 1 del documento ORIGINAL (sin
 * rotacion extra, ya que no hay entrada de plan asociada).
 */
function blankSizeFor(
  plan: OrganizePage[],
  index: number,
  source: PDFDocument,
): [number, number] {
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = plan[i];
    if (entry.kind === "existing") {
      return visualSize(source.getPage(entry.page - 1), entry.rotation);
    }
  }
  for (let i = index + 1; i < plan.length; i += 1) {
    const entry = plan[i];
    if (entry.kind === "existing") {
      return visualSize(source.getPage(entry.page - 1), entry.rotation);
    }
  }
  // El guard `pageCount < 1` ya garantiza que la pagina 1 existe.
  return visualSize(source.getPage(0), 0);
}

export async function organizePdf(
  file: File,
  pages: OrganizePage[],
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const source = await loadPdf(file);
    onProgress?.(0.2);

    const pageCount = source.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");

    // Las entradas `blank` siempre pasan; las `existing` solo si su
    // numero de pagina cae dentro del documento original.
    const plan: OrganizePage[] =
      pages.length === 0
        ? source
            .getPageIndices()
            .map((index) => ({
              kind: "existing" as const,
              page: index + 1,
              rotation: 0,
            }))
        : pages.filter((item) =>
            // Simetrico a proposito (positivo en ambas ramas, nada de "lo
            // que no sea blank se trata como existing"): un `kind`
            // desconocido -- ej. una entrada con la forma vieja
            // `{page, rotation}` sin `kind`, de un caller no tipado --
            // se descarta aqui en vez de colarse al bucle principal y
            // materializarse como blanco en silencio.
            item.kind === "existing"
              ? Number.isInteger(item.page) &&
                item.page >= 1 &&
                item.page <= pageCount
              : item.kind === "blank",
          );
    // Un PDF de 0 paginas se guarda sin error (verificado): este guard es
    // lo unico que lo impide, preservado exactamente como en el motor
    // original.
    if (plan.length === 0) throw new PdfError("empty");

    const existingEntries = plan.filter(
      (item): item is Extract<OrganizePage, { kind: "existing" }> =>
        item.kind === "existing",
    );

    const output = await PDFDocument.create();
    // Una sola llamada a copyPages: copiar pagina a pagina multiplica el
    // coste en documentos con recursos compartidos. Las paginas `blank`
    // no tienen origen en el documento, asi que nunca pasan por aqui.
    const copied = await output.copyPages(
      source,
      existingEntries.map((item) => item.page - 1),
    );

    let cursor = 0;
    for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index];
      if (item.kind === "existing") {
        const page = copied[cursor];
        cursor += 1;
        const rotation = item.rotation;
        if (rotation % 360 !== 0) {
          const current = page.getRotation().angle;
          page.setRotation(degrees(((current + rotation) % 360 + 360) % 360));
        }
        output.addPage(page);
      } else {
        // `addPage` necesita una tupla [width, height], nunca un objeto
        // {width, height}: un objeto lanza un TypeError real de la
        // libreria que aqui se dejaria escapar (no se relanza como
        // PdfError generico) para no ocultar un bug de firma.
        output.addPage(blankSizeFor(plan, index, source));
      }
      onProgress?.(0.2 + ((index + 1) / plan.length) * 0.7);
    }
    // Invariante barata: si el cursor no consumio todo `copied`, algo
    // esta mal (desincronizacion entre `existingEntries` y el recorrido
    // del plan).
    if (cursor !== copied.length) throw new PdfError("unknown");

    const blob = await savePdfToBlob(output);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
