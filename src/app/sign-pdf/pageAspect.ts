import { closePdfDocument, openPdfDocument } from "@/lib/pdf/core";

/*
 * Lectura puntual de la geometria de UNA pagina de un PDF con pdf.js. La
 * usan el lienzo (la firma de "Solo yo" que esta en una pagina que no se ve)
 * y "Aplicar a todos los documentos" (cada documento tiene paginas de tamano
 * y proporcion propios). Abre el documento, lee y lo cierra: nunca deja uno
 * abierto, asi que llamarla en serie no acumula memoria.
 */

export type PageInfo = {
  /** Paginas del documento. */
  count: number;
  /** Pagina leida (0-based), ya acotada a `[0, count - 1]`. */
  pageIndex: number;
  /** ancho / alto de esa pagina tal y como se ve (con su rotacion). */
  aspect: number;
};

/**
 * Cuenta de paginas y proporcion de la pagina pedida (acotada si se pasa del
 * final), o `null` si no se puede leer.
 */
export async function pageInfoOf(file: File, index: number): Promise<PageInfo | null> {
  try {
    const document = await openPdfDocument(file);
    try {
      const count = Math.max(1, document.numPages);
      const pageIndex = Math.min(Math.max(0, index), count - 1);
      const page = await document.getPage(pageIndex + 1);
      const viewport = page.getViewport?.({ scale: 1 });
      page.cleanup();
      if (!viewport || !(viewport.height > 0)) return null;
      return { count, pageIndex, aspect: viewport.width / viewport.height };
    } finally {
      void closePdfDocument(document);
    }
  } catch {
    return null;
  }
}

/**
 * Proporcion ancho/alto de una pagina concreta del PDF (la que se ve en
 * pantalla, con su rotacion), o `null` si no se puede leer. Solo hace falta
 * para las paginas que NO estan en pantalla.
 */
export async function pageAspectOf(file: File, index: number): Promise<number | null> {
  try {
    const document = await openPdfDocument(file);
    try {
      const page = await document.getPage(index + 1);
      const viewport = page.getViewport?.({ scale: 1 });
      page.cleanup();
      return viewport && viewport.height > 0 ? viewport.width / viewport.height : null;
    } finally {
      void closePdfDocument(document);
    }
  } catch {
    return null;
  }
}
