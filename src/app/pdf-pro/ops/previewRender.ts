import { closePdfDocument, openPdfDocument, renderPageToDataUrl } from "@/lib/pdf/core";

/**
 * Dibuja la primera pagina de unos bytes como imagen (para la vista previa del resultado). Esta aparte
 * para poder sustituirla en las pruebas de componentes (pdf.js necesita un navegador de verdad).
 * Devuelve `null` si no se pudo dibujar: la vista previa es una ayuda, nunca bloquea «Aplicar».
 */
export async function renderPreviewDataUrl(bytes: Uint8Array, maxWidth = 360): Promise<string | null> {
  let document: Awaited<ReturnType<typeof openPdfDocument>> | null = null;
  try {
    document = await openPdfDocument(bytes);
    const page = await document.getPage(1);
    const url = await renderPageToDataUrl(page, { maxWidth });
    page.cleanup();
    return url;
  } catch {
    return null;
  } finally {
    if (document) await closePdfDocument(document);
  }
}
