import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { DEFAULT_OCR_OPTIONS, OCR_LANGUAGES, ocrPdf } from "@/lib/pdf/ocr";

/**
 * `ocr.ts` combina dos dependencias que no funcionan bajo
 * `environment: "node"` de Vitest tal y como esta configurado el
 * proyecto:
 *
 *  1. `openPdfDocument` (pdf.js, via `core.ts`) — confirmado por
 *     experimentacion que revienta en Node (`DOMMatrix is not defined`,
 *     y despues de un shim, un fallo al resolver el worker estatico
 *     "/pdf.worker.min.mjs" como modulo de Node). Ver la nota identica
 *     en `core.test.ts` y `compare.test.ts`.
 *  2. `tesseract.js` (WASM, `import()` perezoso) — el propio enunciado de
 *     esta tarea ya anticipa que ejecutar reconocimiento OCR real en un
 *     run de Vitest en Node es impractico (lento, necesita el binario
 *     WASM y el modelo de idioma via red, o un entorno DOM).
 *
 * En `ocrPdf` (src/lib/pdf/ocr.ts:175-278), el orden de ejecucion es:
 *   loadPdf -> comprobar total de paginas (0 -> "corrupt") -> openPdfDocument -> ... -> tesseract
 * Es decir, `openPdfDocument` (pdf.js) se invoca ANTES de tocar
 * tesseract.js para cualquier documento con al menos 1 pagina. Eso deja
 * como unico camino ejecutable en este entorno los errores que ocurren
 * en o antes de `loadPdf` (documento vacio/corrupto/cifrado) — todo lo
 * que dependa de rasterizar una pagina o reconocer texto queda fuera de
 * alcance de esta suite (blocker documentado en el reporte de esta
 * tarea). El caso "PDF de 0 paginas" que tambien deberia fallar antes de
 * `openPdfDocument` no se pudo ejercitar en esta suite: se comprobo por
 * experimentacion que `@cantoo/pdf-lib` no permite serializar y volver a
 * cargar un documento con 0 paginas via la API publica (`PDFDocument
 * .create()` sin `addPage` da `getPageCount() === 0` en memoria, pero
 * tras `save()` + `load()` — el unico camino de `File` que acepta
 * `ocrPdf` — el documento reaparece con 1 pagina), asi que ese branch de
 * `ocrPdf` queda sin cobertura directa aqui.
 *
 * Lo que SI es genuinamente testable sin tocar pdf.js ni tesseract.js:
 * las constantes exportadas y las rutas de error mas tempranas de
 * `ocrPdf`.
 */

async function toFile(document: PDFDocument, name = "documento.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

describe("constantes — src/lib/pdf/ocr.ts", () => {
  it("OCR_LANGUAGES expone exactamente los 4 idiomas soportados", () => {
    expect(OCR_LANGUAGES).toEqual(["spa", "eng", "fra", "por"]);
  });

  it("DEFAULT_OCR_OPTIONS usa espanol por defecto", () => {
    expect(DEFAULT_OCR_OPTIONS).toEqual({ language: "spa" });
  });
});

describe("ocrPdf — rutas de error previas a pdf.js/tesseract.js (src/lib/pdf/ocr.ts)", () => {
  it("archivo vacio (0 bytes) -> PdfError('corrupt') (falla en loadPdf, antes de abrir con pdf.js)", async () => {
    const empty = new File([], "vacio.pdf", { type: "application/pdf" });
    await expect(ocrPdf(empty)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("PDF cifrado sin contrasena -> PdfError('encrypted') (falla en loadPdf, antes de abrir con pdf.js)", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    document.encrypt({ userPassword: "clave1234", ownerPassword: "clave1234" });
    const file = await toFile(document, "cifrado.pdf");

    await expect(ocrPdf(file)).rejects.toMatchObject({ code: "encrypted" });
  });
});
