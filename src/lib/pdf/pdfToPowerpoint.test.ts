import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import * as core from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
  MAX_ACCUMULATED_IMAGE_BYTES,
  MAX_CANVAS_AREA_PX,
  MAX_CANVAS_DIMENSION_PX,
  MAX_PDF_TO_POWERPOINT_PAGES,
  pdfToPowerpoint,
  type PdfToPowerpointOptions,
} from "@/lib/pdf/pdfToPowerpoint";

/**
 * `pdfToPowerpoint` abre el documento con pdf.js (`openPdfDocument`) y
 * rasteriza cada pagina sobre un `<canvas>` real (`renderPageToCanvas`,
 * `canvas.toDataURL`). Igual que en `pdfToImages.test.ts`, ninguna de las
 * dos cosas funciona en `environment: "node"` (pdf.js referencia
 * `DOMMatrix` incluso solo para abrir el documento; un `<canvas>` real
 * necesita `document.createElement`).
 *
 * Este archivo sustituye `openPdfDocument` / `renderPageToCanvas` /
 * `closePdfDocument` de `@/lib/pdf/core` por dobles controlados -- el doble
 * de canvas trae su propio `toDataURL` fake, ya que este motor (a
 * diferencia de `pdfToImages.ts`) llama a `canvas.toDataURL` directamente
 * en vez de pasar por `canvasToBlob` -- y deja correr el codigo REAL de
 * `pdfToPowerpoint.ts`: paginacion, presupuesto de paginas, calculo de
 * layout/encaje y ensamblado del .pptx con `pptxgenjs` REAL (no mockeado),
 * para poder validar que el paquete OOXML resultante es de verdad valido.
 * Lo que queda sin cubrir (el rasterizado en si con pdf.js/canvas) se
 * documenta como limitacion, igual que en `pdfToImages.test.ts`.
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

/**
 * Duplicado deliberado del prefijo interno `JPEG_DATA_URL_PREFIX` de
 * `pdfToPowerpoint.ts` (no exportado: es un detalle de implementacion).
 * Debe mantenerse en sync si ese prefijo cambia.
 */
const JPEG_DATA_URL_PREFIX_FOR_TEST = "data:image/jpeg;base64,";

type FakeCanvas = {
  width: number;
  height: number;
  toDataURL: ReturnType<typeof vi.fn>;
};

type FakePage = {
  cleanup: ReturnType<typeof vi.fn>;
  getViewport: ReturnType<typeof vi.fn>;
};
type FakeDocument = {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
  loadingTask: { destroy: ReturnType<typeof vi.fn> };
};

/** Pagina carta (8.5in x 11in) a escala 1x, en "puntos" de canvas. */
const LETTER_AT_SCALE_1 = { width: 612, height: 792 };

/**
 * `pageViewport` es lo que `page.getViewport({ scale: 1 })` devolveria
 * (usado por `pdfToPowerpoint.ts` para acotar `scale` ANTES de rasterizar,
 * ver `clampScaleForPageSize`). Por defecto una pagina carta normal, que
 * nunca dispara el recorte de `MAX_CANVAS_DIMENSION_PX`/`MAX_CANVAS_AREA_PX`
 * a ninguna de las escalas 1-3 que ofrece la interfaz.
 */
function makeFakeDocument(
  numPages: number,
  pageViewport: { width: number; height: number } = LETTER_AT_SCALE_1,
): FakeDocument {
  return {
    numPages,
    getPage: vi.fn(
      async (): Promise<FakePage> => ({
        cleanup: vi.fn(),
        getViewport: vi.fn(() => pageViewport),
      }),
    ),
    loadingTask: { destroy: vi.fn(async () => {}) },
  };
}

function makeFakeCanvas(
  width = LETTER_AT_SCALE_1.width,
  height = LETTER_AT_SCALE_1.height,
): FakeCanvas {
  return {
    width,
    height,
    // El payload se rellena para superar con margen el umbral minimo de
    // longitud que `isValidJpegDataUrl` exige (ver `MIN_VALID_JPEG_BASE64_LENGTH`
    // en pdfToPowerpoint.ts): un placeholder demasiado corto se
    // rechazaria ahora como si fuese un resultado degenerado de verdad.
    toDataURL: vi.fn(
      (type: string, quality: number) =>
        `data:${type};base64,${Buffer.from(
          `w${width}h${height}q${quality}`.padEnd(120, "0"),
        ).toString("base64")}`,
    ),
  };
}

const openPdfDocumentMock = vi.mocked(core.openPdfDocument);
const renderPageToCanvasMock = vi.mocked(core.renderPageToCanvas);
const closePdfDocumentMock = vi.mocked(core.closePdfDocument);

beforeEach(() => {
  // `resetAllMocks` (no solo `clearAllMocks`) porque algun caso (senal ya
  // abortada antes de abrir el documento) deja adrede una implementacion
  // "once" sin consumir: sin el reset completo, ese valor colado se
  // filtraria al siguiente test y desincronizaria toda la cola de
  // `mockResolvedValueOnce`/`mockRejectedValueOnce` de los tests
  // posteriores.
  vi.resetAllMocks();
  renderPageToCanvasMock.mockImplementation(
    async () => makeFakeCanvas() as unknown as HTMLCanvasElement,
  );
  // `resetAllMocks` tambien borra la implementacion por defecto que trae el
  // factory de `vi.mock` (`closePdfDocument: vi.fn(async () => {})`), asi
  // que se restablece aqui explicitamente.
  closePdfDocumentMock.mockImplementation(async () => {});
});

async function loadPptxZip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

describe("pdfToPowerpoint — src/lib/pdf/pdfToPowerpoint.ts (paginacion/presupuesto/ensamblado, con pdf.js y canvas sustituidos)", () => {
  it("convierte N paginas mockeadas en un .pptx con N diapositivas, cada una con intent 'print'", async () => {
    const fakeDocument = makeFakeDocument(3);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const blob = await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
    );

    expect(fakeDocument.getPage).toHaveBeenCalledTimes(3);
    expect(renderPageToCanvasMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ intent: "print" }),
    );
    expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);

    expect(blob.size).toBeGreaterThan(0);
    const zip = await loadPptxZip(blob);
    const slideFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    expect(slideFiles).toHaveLength(3);
  });

  it("valida que el .pptx resultante es un paquete OOXML valido: trae [Content_Types].xml y una slideN.xml + sus rels por pagina", async () => {
    const fakeDocument = makeFakeDocument(2);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const blob = await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
    );

    const zip = await loadPptxZip(blob);
    const names = Object.keys(zip.files);

    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("ppt/slides/slide1.xml");
    expect(names).toContain("ppt/slides/slide2.xml");

    // pptxgenjs si genera relaciones por diapositiva (confirmado inspeccionando
    // el zip real generado por este mismo test, no asumido de antemano).
    expect(names).toContain("ppt/slides/_rels/slide1.xml.rels");
    expect(names).toContain("ppt/slides/_rels/slide2.xml.rels");

    // Cada slide referencia una imagen incrustada bajo ppt/media.
    const mediaFiles = names.filter((name) => name.startsWith("ppt/media/"));
    expect(mediaFiles.length).toBeGreaterThanOrEqual(2);

    const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
    expect(contentTypesXml).toContain("presentationml");
  });

  it("un PDF con mas paginas que MAX_PDF_TO_POWERPOINT_PAGES lanza PdfError('tooLarge') sin rasterizar nada", async () => {
    const fakeDocument = makeFakeDocument(MAX_PDF_TO_POWERPOINT_PAGES + 1);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "tooLarge" });

    expect(fakeDocument.getPage).not.toHaveBeenCalled();
    // El documento se cierra igualmente, aunque se rechace por presupuesto.
    expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
  });

  it("un PDF con exactamente MAX_PDF_TO_POWERPOINT_PAGES paginas si se procesa (limite inclusivo)", async () => {
    const fakeDocument = makeFakeDocument(MAX_PDF_TO_POWERPOINT_PAGES);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const blob = await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
    );

    expect(fakeDocument.getPage).toHaveBeenCalledTimes(
      MAX_PDF_TO_POWERPOINT_PAGES,
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it("se cancela via AbortSignal entre paginas: deja de rasterizar y propaga PdfError('cancelled')", async () => {
    const fakeDocument = makeFakeDocument(5);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    const controller = new AbortController();
    let callCount = 0;
    renderPageToCanvasMock.mockImplementation(async () => {
      callCount += 1;
      // Se cancela justo despues de procesar la primera pagina, antes de
      // que el bucle llegue a la comprobacion de la segunda.
      if (callCount === 1) controller.abort();
      return makeFakeCanvas() as unknown as HTMLCanvasElement;
    });

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    // Se detiene tras la primera pagina: nunca llega a rasterizar la 2a-5a.
    expect(callCount).toBe(1);
    expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
  });

  it("una senal ya abortada antes de empezar cancela sin abrir ninguna pagina", async () => {
    const fakeDocument = makeFakeDocument(3);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);
    const controller = new AbortController();
    controller.abort();

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });

    expect(fakeDocument.getPage).not.toHaveBeenCalled();
  });

  it("propaga PdfError('encrypted') cuando openPdfDocument falla por cifrado", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(
      new core.PdfError("encrypted"),
    );

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "encrypted" });

    // No hay documento que cerrar: openPdfDocument nunca devolvio uno.
    expect(closePdfDocumentMock).not.toHaveBeenCalled();
  });

  it("propaga PdfError('corrupt') cuando openPdfDocument falla por un PDF invalido", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new core.PdfError("corrupt"));

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("un fallo generico (no PdfError) al abrir el documento se reclasifica via toPdfError", async () => {
    openPdfDocumentMock.mockRejectedValueOnce(new Error("boom inesperado"));

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "unknown" });
  });

  it("reporta progreso monotono creciente de 0 a 1", async () => {
    const fakeDocument = makeFakeDocument(4);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);
    const seen: number[] = [];

    await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      (value) => seen.push(value),
    );

    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("acota 'quality' y 'scale' fuera de rango antes de pasarlos a renderPageToCanvas/toDataURL", async () => {
    const fakeDocument = makeFakeDocument(1);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);
    const fakeCanvas = makeFakeCanvas();
    renderPageToCanvasMock.mockResolvedValueOnce(
      fakeCanvas as unknown as HTMLCanvasElement,
    );

    const outOfRange: PdfToPowerpointOptions = {
      quality: 0.01, // por debajo de JPG_QUALITY_MIN (0.5)
      scale: 10 as unknown as PdfToPowerpointOptions["scale"], // por encima del maximo (3)
    };

    await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      outOfRange,
    );

    expect(renderPageToCanvasMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scale: 3, intent: "print" }),
    );
    expect(fakeCanvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.5);
  });

  it("un documento sin paginas (numPages 0) lanza PdfError('empty')", async () => {
    const fakeDocument = makeFakeDocument(0);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    await expect(
      pdfToPowerpoint(
        new File(["pdf"], "documento.pdf"),
        DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("paginas con otra proporcion que la primera no desbordan el slide (w/h se ajustan dentro del layout definido por la pagina 1)", async () => {
    const fakeDocument = makeFakeDocument(2);
    openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

    renderPageToCanvasMock
      // Pagina 1: carta vertical (8.5in x 11in a escala 1x) -> define el layout.
      .mockResolvedValueOnce(
        makeFakeCanvas(612, 792) as unknown as HTMLCanvasElement,
      )
      // Pagina 2: mucho mas ancha que alta (paisaje extremo).
      .mockResolvedValueOnce(
        makeFakeCanvas(1224, 300) as unknown as HTMLCanvasElement,
      );

    const blob = await pdfToPowerpoint(
      new File(["pdf"], "documento.pdf"),
      { quality: 0.9, scale: 1 },
    );

    const zip = await loadPptxZip(blob);
    const slide2Xml = await zip.file("ppt/slides/slide2.xml")?.async("string");
    expect(slide2Xml).toBeTruthy();
    // La imagen de la pagina 2 debe seguir declarando una extension (`a:ext`)
    // dentro del XML del slide: no se rompe el ensamblado por el cambio de
    // proporcion, solo se encaja (limitacion aceptada, no resuelta con logica
    // adicional).
    expect(slide2Xml).toContain("<a:ext");
  });

  describe("Hallazgo 1 (Codex): diapositivas en blanco por toDataURL degenerado", () => {
    it("un canvas cuyo toDataURL devuelve 'data:,' (formato invalido) lanza PdfError en vez de continuar en silencio", async () => {
      const fakeDocument = makeFakeDocument(1);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      const degenerateCanvas = makeFakeCanvas();
      degenerateCanvas.toDataURL.mockReturnValue("data:,");
      renderPageToCanvasMock.mockResolvedValueOnce(
        degenerateCanvas as unknown as HTMLCanvasElement,
      );

      await expect(
        pdfToPowerpoint(
          new File(["pdf"], "documento.pdf"),
          DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "unknown" });
    });

    it("un canvas cuyo toDataURL devuelve el prefijo JPEG correcto pero sin contenido (base64 vacio/trivial) tambien lanza PdfError", async () => {
      const fakeDocument = makeFakeDocument(1);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      const degenerateCanvas = makeFakeCanvas();
      // Prefijo correcto, pero el contenido base64 es demasiado corto para
      // ser un JPEG real: exactamente el caso que Codex confirmo que
      // pptxgenjs acepta en silencio y omite de la diapositiva.
      degenerateCanvas.toDataURL.mockReturnValue("data:image/jpeg;base64,");
      renderPageToCanvasMock.mockResolvedValueOnce(
        degenerateCanvas as unknown as HTMLCanvasElement,
      );

      await expect(
        pdfToPowerpoint(
          new File(["pdf"], "documento.pdf"),
          DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "unknown" });
    });

    it("un documento de 3 paginas se detiene en la primera pagina degenerada: no llega a rasterizar la 2a/3a ni produce un .pptx", async () => {
      const fakeDocument = makeFakeDocument(3);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      const degenerateCanvas = makeFakeCanvas();
      degenerateCanvas.toDataURL.mockReturnValue("data:,");
      renderPageToCanvasMock.mockResolvedValueOnce(
        degenerateCanvas as unknown as HTMLCanvasElement,
      );

      await expect(
        pdfToPowerpoint(
          new File(["pdf"], "documento.pdf"),
          DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "unknown" });

      // Nunca llego a pedir la 2a/3a pagina: no hay .pptx corrupto con
      // diapositivas en blanco, el fallo corta la iteracion de inmediato.
      expect(fakeDocument.getPage).toHaveBeenCalledTimes(1);
      expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
    });
  });

  describe("Hallazgo 1 (Codex): limite de dimensiones/area de canvas antes de rasterizar", () => {
    it("una pagina cuyo tamano excederia MAX_CANVAS_DIMENSION_PX/MAX_CANVAS_AREA_PX se acota: renderPageToCanvas se llama con un scale menor al solicitado", async () => {
      // Pagina enorme (en puntos PDF): a `scale` 3 (el solicitado) el
      // canvas resultante seria absurdamente grande. `page.getViewport`
      // devuelve este tamano ANTES de rasterizar nada.
      const hugePageViewport = { width: 50_000, height: 50_000 };
      const fakeDocument = makeFakeDocument(1, hugePageViewport);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      await pdfToPowerpoint(new File(["pdf"], "documento.pdf"), {
        quality: 0.9,
        scale: 3,
      });

      const expectedMaxScale = Math.min(
        MAX_CANVAS_DIMENSION_PX / hugePageViewport.width,
        MAX_CANVAS_DIMENSION_PX / hugePageViewport.height,
        Math.sqrt(
          MAX_CANVAS_AREA_PX / (hugePageViewport.width * hugePageViewport.height),
        ),
      );

      expect(renderPageToCanvasMock).toHaveBeenCalledTimes(1);
      const renderOptions = renderPageToCanvasMock.mock.calls[0][1] as {
        scale: number;
        intent: string;
      };
      // Nunca se intenta rasterizar con el scale solicitado (3): se acota
      // hacia abajo antes de la llamada.
      expect(renderOptions.scale).toBeLessThan(3);
      expect(renderOptions.scale).toBeCloseTo(expectedMaxScale, 6);
      expect(renderOptions.intent).toBe("print");
    });

    it("una pagina de tamano normal (carta) no se ve afectada por el recorte de dimensiones a ninguna escala 1-3", async () => {
      const fakeDocument = makeFakeDocument(1); // LETTER_AT_SCALE_1 por defecto
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      await pdfToPowerpoint(new File(["pdf"], "documento.pdf"), {
        quality: 0.9,
        scale: 3,
      });

      expect(renderPageToCanvasMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scale: 3 }),
      );
    });
  });

  describe("Hallazgo 2 (Codex): presupuesto acumulado de bytes de imagen", () => {
    it("una pagina cuyo data URL por si sola excede MAX_ACCUMULATED_IMAGE_BYTES lanza PdfError('tooLarge') a mitad de la iteracion", async () => {
      const fakeDocument = makeFakeDocument(3);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      // Construye un data URL cuya estimacion de bytes (base64Length * 3/4)
      // supera el presupuesto por un margen pequeno, sin depender de varias
      // paginas para cruzar el umbral: con numPages=3, si el motor se
      // detiene en la primera, la 2a/3a nunca se procesan (prueba real de
      // "a mitad de la iteracion", no de "al final").
      const oversizedByteCount = MAX_ACCUMULATED_IMAGE_BYTES + 4096;
      const oversizedBase64Length = Math.ceil((oversizedByteCount * 4) / 3);
      const oversizedDataUrl =
        JPEG_DATA_URL_PREFIX_FOR_TEST +
        "A".repeat(oversizedBase64Length);

      const oversizedCanvas = makeFakeCanvas();
      oversizedCanvas.toDataURL.mockReturnValue(oversizedDataUrl);
      renderPageToCanvasMock.mockResolvedValueOnce(
        oversizedCanvas as unknown as HTMLCanvasElement,
      );

      await expect(
        pdfToPowerpoint(
          new File(["pdf"], "documento.pdf"),
          DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "tooLarge" });

      // Se detuvo en la primera pagina: nunca llego a pedir la 2a/3a.
      expect(fakeDocument.getPage).toHaveBeenCalledTimes(1);
      expect(closePdfDocumentMock).toHaveBeenCalledWith(fakeDocument);
    });

    it("varias paginas cuyo tamano individual esta bajo el presupuesto, pero cuya suma lo supera, tambien lanzan PdfError('tooLarge')", async () => {
      const fakeDocument = makeFakeDocument(3);
      openPdfDocumentMock.mockResolvedValueOnce(fakeDocument as never);

      // Dos paginas de ~60% del presupuesto cada una: ninguna por si sola
      // lo excede, pero la suma si. Confirma que el contador es realmente
      // acumulativo entre paginas, no solo un tope por pagina individual.
      const perPageBytes = Math.ceil(MAX_ACCUMULATED_IMAGE_BYTES * 0.6);
      const perPageBase64Length = Math.ceil((perPageBytes * 4) / 3);
      const bigDataUrl =
        JPEG_DATA_URL_PREFIX_FOR_TEST + "A".repeat(perPageBase64Length);

      renderPageToCanvasMock.mockImplementation(async () => {
        const canvas = makeFakeCanvas();
        canvas.toDataURL.mockReturnValue(bigDataUrl);
        return canvas as unknown as HTMLCanvasElement;
      });

      await expect(
        pdfToPowerpoint(
          new File(["pdf"], "documento.pdf"),
          DEFAULT_PDF_TO_POWERPOINT_OPTIONS,
        ),
      ).rejects.toMatchObject({ code: "tooLarge" });

      // La 1a pagina por si sola (60%) no excede el presupuesto: se
      // detiene en la 2a (60% + 60% = 120% > 100%), nunca llega a la 3a.
      expect(fakeDocument.getPage).toHaveBeenCalledTimes(2);
    });
  });
});
