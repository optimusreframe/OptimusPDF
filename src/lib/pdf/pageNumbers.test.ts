import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import {
  DEFAULT_PAGE_NUMBERS_OPTIONS,
  addPageNumbers,
  formatPageLabel,
  type PageNumbersOptions,
} from "@/lib/pdf/pageNumbers";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` directamente en el
 * test (misma convencion que `unlock.test.ts` / `protect.test.ts`).
 */
async function documentWithPages(count: number): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    document.addPage([300, 300]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "source.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/**
 * `PDFDocument.save()` anade una pagina en blanco por defecto si el
 * documento no tiene ninguna (`addDefaultPage`), asi que un documento
 * realmente sin paginas solo se puede producir desactivando esa opcion.
 */
async function emptyFile(name = "empty.pdf"): Promise<File> {
  const document = await PDFDocument.create();
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/**
 * Una pagina en blanco recien creada no tiene entradas en `/Resources
 * /Font`. Si `addPageNumbers` dibujo texto en ella, pdf-lib registra ahi
 * la fuente incrustada: es una forma de comprobar (sin decodificar el
 * flujo de contenido, que puede llegar comprimido) que el motor SI
 * escribio algo en esa pagina en concreto.
 */
function hasFontResource(page: ReturnType<PDFDocument["getPage"]>): boolean {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  return (fonts?.keys().length ?? 0) > 0;
}

async function fontFlagsOf(blob: Blob): Promise<boolean[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  return result.getPages().map((page) => hasFontResource(page));
}

describe("formatPageLabel — src/lib/pdf/pageNumbers.ts", () => {
  it("sustituye {n} y {p} por el numero actual y el total", () => {
    expect(formatPageLabel("{n} de {p}", 3, 10)).toBe("3 de 10");
  });

  it("respeta el texto que no forma parte de los marcadores", () => {
    expect(formatPageLabel("Pagina {n}", 1, 1)).toBe("Pagina 1");
  });

  it("una plantilla vacia (o solo espacios) cae de vuelta al marcador {n}", () => {
    expect(formatPageLabel("   ", 5, 5)).toBe("5");
  });
});

describe("addPageNumbers — src/lib/pdf/pageNumbers.ts", () => {
  it("numera todas las paginas por defecto (fromPage=1, toPage=0 -> hasta el final)", async () => {
    const file = await toFile(await documentWithPages(3));
    const blob = await addPageNumbers(file, DEFAULT_PAGE_NUMBERS_OPTIONS);

    expect(await fontFlagsOf(blob)).toEqual([true, true, true]);
  });

  it("respeta el rango fromPage/toPage: las paginas fuera de rango no se tocan", async () => {
    const file = await toFile(await documentWithPages(5));
    const options: PageNumbersOptions = {
      ...DEFAULT_PAGE_NUMBERS_OPTIONS,
      fromPage: 2,
      toPage: 4,
    };

    const blob = await addPageNumbers(file, options);
    expect(await fontFlagsOf(blob)).toEqual([false, true, true, true, false]);
  });

  it("mode 'facing' no lanza y numera el rango completo (alterna el ancla en paginas pares)", async () => {
    const file = await toFile(await documentWithPages(4));
    const options: PageNumbersOptions = {
      ...DEFAULT_PAGE_NUMBERS_OPTIONS,
      mode: "facing",
      anchor: "bottom-left",
    };

    const blob = await addPageNumbers(file, options);
    expect(await fontFlagsOf(blob)).toEqual([true, true, true, true]);
  });

  it("firstNumber distinto de 1 tambien numera el rango completo sin lanzar", async () => {
    // El total {p} que calcula addPageNumbers es firstNumber + count - 1
    // (el ultimo numero asignado, no el total de paginas del documento):
    // aqui solo se comprueba que ese calculo no rompe el rango de paginas
    // tocadas cuando firstNumber empieza en un valor alto.
    const file = await toFile(await documentWithPages(3));
    const options: PageNumbersOptions = {
      ...DEFAULT_PAGE_NUMBERS_OPTIONS,
      firstNumber: 42,
    };

    const blob = await addPageNumbers(file, options);
    expect(await fontFlagsOf(blob)).toEqual([true, true, true]);
  });

  it("un documento sin paginas lanza PdfError('corrupt')", async () => {
    const file = await emptyFile();

    await expect(addPageNumbers(file, DEFAULT_PAGE_NUMBERS_OPTIONS)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
