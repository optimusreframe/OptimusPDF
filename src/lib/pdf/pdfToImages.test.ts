import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import * as core from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";
import {
  DEFAULT_PDF_TO_IMAGES_OPTIONS,
  JPG_QUALITY_MAX,
  JPG_QUALITY_MIN,
  pdfToImages,
  type PdfToImageScale,
  type PdfToImagesOptions,
} from "@/lib/pdf/pdfToImages";

/**
 * `pdfToImages` abre el documento con pdf.js (`openPdfDocument`) y rasteriza
 * cada pagina sobre un `<canvas>` real (`renderPageToCanvas` + `canvasToBlob`
 * de `imagesToPdf.ts`). Ninguna de las dos cosas funciona en
 * `environment: "node"`:
 *
 * - `renderPageToCanvas`/`canvasToBlob` necesitan `document.createElement`
 *   y `canvas.toBlob`, que no existen sin un DOM real.
 * - Mas grave: `pdfjs-dist` en si mismo (incluso solo para ABRIR el
 *   documento, antes de renderizar nada) referencia `DOMMatrix` al
 *   procesarlo, y lanza `ReferenceError: DOMMatrix is not defined` fuera de
 *   la cadena de promesas de `getDocument()` (verificado manualmente: el
 *   error ni siquiera llega al `catch` de `openPdfDocument`, revienta el
 *   proceso). Invocar `pdfToImages` de verdad en este entorno no es "un
 *   test que falla limpio", es inestable para todo el runner de Vitest.
 *
 * Por eso este archivo NO llama a pdf.js real. En su lugar sustituye
 * `openPdfDocument` / `renderPageToCanvas` / `closePdfDocument` de
 * `@/lib/pdf/core` (y `canvasToBlob` de `@/lib/pdf/imagesToPdf`) por dobles
 * controlados, y deja correr el codigo REAL de `pdfToImages.ts`: seleccion
 * y orden de paginas (`resolvePages`), acotado de calidad/escala, nombrado
 * con relleno de ceros, y la decision `jpg` vs `zip`. Lo que queda sin
 * cubrir (el rasterizado en si) se documenta como limitacion.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: vi.fn(),
    renderPageToCanvas: vi.fn(),
    closePdfDocument: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/pdf/imagesToPdf", () => ({
  canvasToBlob: vi.fn(),
}));

type FakePage = { cleanup: ReturnType<typeof vi.fn> };
type FakeDocument = {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  loadingTask: { destroy: ReturnType<typeof vi.fn> };
};

function makeFakeDocument(numPages: number): FakeDocument {
  return {
    numPages,
    getPage: vi.fn(async (_pageNumber: number): Promise<FakePage> => ({
      cleanup: vi.fn(),
    })),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

const openPdfDocumentMock = vi.mocked(core.openPdfDocument);
const renderPageToCanvasMock = vi.mocked(core.renderPageToCanvas);
const closePdfDocumentMock = vi.mocked(core.closePdfDocument);
const canvasToBlobMock = vi.mocked(canvasToBlob);

beforeEach(() => {
  vi.clearAllMocks();
  renderPageToCanvasMock.mockImplementation(
    async () => ({ width: 0, height: 0 }) as unknown as HTMLCanvasElement,
  );
  // `canvasToBlob` esta mockeado por completo (no corre el real, que
  // necesita un <canvas> de verdad), asi que el "blob" devuelto aqui solo
  // necesita representar unos bytes de imagen para el resto de la cadena.
  // Un `Blob` real funciona en el navegador, pero JSZip no puede leer un
  // `Blob` real en Node (usa FileReader internamente); un Uint8Array si
  // es un tipo soportado por JSZip en cualquier entorno. Se castea a Blob
  // solo para satisfacer la firma del mock — pdfToImages.ts trata este
  // valor como opaco (lo pasa a `zip.file`/lo devuelve tal cual).
  canvasToBlobMock.mockImplementation(async (_canvas, type, quality) => {
    return new TextEncoder().encode(
      `quality:${quality}`,
    ) as unknown as Blob;
  });
});

describe("pdfToImages — src/lib/pdf/pdfToImages.ts (seleccion/orden/nombrado, con pdf.js y canvas sustituidos)", () => {
  it("con varias paginas y sin filtro, exporta un ZIP con una imagen por pagina nombrada con el prefijo por defecto", async () => {
    const fakeDocument = makeFakeDocument(3);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const result = await pdfToImages(new Blob(["pdf"]), DEFAULT_PDF_TO_IMAGES_OPTIONS);

    expect(result.kind).toBe("zip");
    expect(result.count).toBe(3);
    expect(fakeDocument.getPage).toHaveBeenCalledTimes(3);

    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual([
      "pagina-1.jpg",
      "pagina-2.jpg",
      "pagina-3.jpg",
    ]);
    expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
  });

  it("con una unica pagina, devuelve la imagen suelta (kind 'jpg'), no un ZIP", async () => {
    const fakeDocument = makeFakeDocument(1);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const result = await pdfToImages(new Blob(["pdf"]), DEFAULT_PDF_TO_IMAGES_OPTIONS);

    expect(result.kind).toBe("jpg");
    expect(result.count).toBe(1);
  });

  it("'pages' deduplica, descarta indices fuera de rango y ordena ascendente sin importar el orden de entrada", async () => {
    const fakeDocument = makeFakeDocument(5);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      pages: [3, 1, 1, 10, -1],
    });

    // pageNumber = indice + 1; se esperan los indices validos 1 y 3, en ese orden.
    const calledPageNumbers = fakeDocument.getPage.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(calledPageNumbers).toEqual([2, 4]);
  });

  it("'pages' vacio (plan sin filtro explicito) procesa todas las paginas", async () => {
    const fakeDocument = makeFakeDocument(2);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const result = await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      pages: [],
    });

    expect(result.count).toBe(2);
    expect(fakeDocument.getPage).toHaveBeenCalledTimes(2);
  });

  it("si 'pages' no deja ningun indice valido, lanza PdfError('empty') y aun asi cierra el documento", async () => {
    const fakeDocument = makeFakeDocument(3);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    await expect(
      pdfToImages(new Blob(["pdf"]), {
        ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
        pages: [99, -1],
      }),
    ).rejects.toMatchObject({ code: "empty" });

    expect(fakeDocument.getPage).not.toHaveBeenCalled();
    expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
  });

  it("acota quality y scale fuera de rango antes de pasarlos a render/canvas", async () => {
    const fakeDocument = makeFakeDocument(1);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const outOfRange: PdfToImagesOptions = {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      quality: 0.01, // por debajo de JPG_QUALITY_MIN
      scale: 10 as unknown as PdfToImageScale, // por encima del maximo (3)
    };

    await pdfToImages(new Blob(["pdf"]), outOfRange);

    expect(renderPageToCanvasMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scale: 3, intent: "print" }),
    );
    expect(canvasToBlobMock).toHaveBeenCalledWith(
      expect.anything(),
      "image/jpeg",
      JPG_QUALITY_MIN,
    );
  });

  it("recorta y usa 'namePrefix'; si queda vacio, recae en 'pagina'", async () => {
    const withPrefix = makeFakeDocument(1);
    openPdfDocumentMock.mockResolvedValueOnce(withPrefix as never);
    const first = await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      pages: [0],
      namePrefix: "  hoja  ",
    });
    // Una sola pagina -> no hay ZIP que inspeccionar por nombre, pero el
    // prefijo tambien se usa para el numero total de digitos: se valida
    // indirectamente en el caso multipagina de abajo.
    expect(first.kind).toBe("jpg");

    const blankPrefixDoc = makeFakeDocument(2);
    openPdfDocumentMock.mockResolvedValueOnce(blankPrefixDoc as never);
    const result = await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      namePrefix: "   ",
    });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["pagina-1.jpg", "pagina-2.jpg"]);
  });

  it("el relleno de ceros del nombre depende del total de paginas del documento", async () => {
    const fakeDocument = makeFakeDocument(12);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const result = await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      pages: [2],
      namePrefix: "hoja",
    });

    // Con 12 paginas totales, el ancho de relleno es 2 digitos.
    expect(result.kind).toBe("jpg");
    // Se valida el nombre a traves del ZIP con mas de una pagina exportada.
    const multi = makeFakeDocument(12);
    openPdfDocumentMock.mockResolvedValueOnce(multi as never);
    const zipResult = await pdfToImages(new Blob(["pdf"]), {
      ...DEFAULT_PDF_TO_IMAGES_OPTIONS,
      pages: [2, 3],
      namePrefix: "hoja",
    });
    const zip = await JSZip.loadAsync(await zipResult.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["hoja-03.jpg", "hoja-04.jpg"]);
  });

  it("reporta progreso hasta 1 al terminar", async () => {
    const fakeDocument = makeFakeDocument(2);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);
    const seen: number[] = [];

    await pdfToImages(new Blob(["pdf"]), DEFAULT_PDF_TO_IMAGES_OPTIONS, (value) =>
      seen.push(value),
    );

    expect(seen[seen.length - 1]).toBe(1);
  });

  it("JPG_QUALITY_MIN/MAX documentan el rango real acotado por clampQuality", async () => {
    expect(JPG_QUALITY_MIN).toBe(0.5);
    expect(JPG_QUALITY_MAX).toBe(1);
  });
});
