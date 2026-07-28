import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import {
  DEFAULT_CROP_RECT,
  cropPdf,
  type CropOptions,
} from "@/lib/pdf/crop";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` directamente en el
 * test (misma convencion que `unlock.test.ts` / `protect.test.ts`).
 */
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

async function cropBoxesOf(
  blob: Blob,
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  return result.getPages().map((page) => page.getCropBox());
}

/**
 * El calculo de 0.06/0.88 en punto flotante deja restos de decima de
 * micropunto (p.ej. 17.999999999999982 en vez de 18): se compara con
 * tolerancia en vez de exactitud bit a bit.
 */
function expectBoxClose(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

describe("cropPdf — src/lib/pdf/crop.ts", () => {
  it("recorta con el rectangulo por defecto en todas las paginas (pagina sin rotar)", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    document.addPage([300, 300]);
    const file = await toFile(document);

    const options: CropOptions = { rect: DEFAULT_CROP_RECT, scope: "all", pageIndex: 0 };
    const blob = await cropPdf(file, options);
    const boxes = await cropBoxesOf(blob);

    // DEFAULT_CROP_RECT = {x:0.06, y:0.06, width:0.88, height:0.88} sobre una
    // pagina cuadrada de 300x300 sin rotar: el mapeo vista->usuario es la
    // identidad, asi que el CropBox resultante es una traduccion directa.
    expect(boxes).toHaveLength(2);
    expectBoxClose(boxes[0], { x: 18, y: 18, width: 264, height: 264 });
    expectBoxClose(boxes[1], { x: 18, y: 18, width: 264, height: 264 });
  });

  it("scope 'current' solo recorta la pagina indicada; las demas quedan intactas", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    document.addPage([300, 300]);
    document.addPage([300, 300]);
    const file = await toFile(document);

    const options: CropOptions = {
      rect: DEFAULT_CROP_RECT,
      scope: "current",
      pageIndex: 1,
    };
    const blob = await cropPdf(file, options);
    const boxes = await cropBoxesOf(blob);

    expectBoxClose(boxes[0], { x: 0, y: 0, width: 300, height: 300 });
    expectBoxClose(boxes[1], { x: 18, y: 18, width: 264, height: 264 });
    expectBoxClose(boxes[2], { x: 0, y: 0, width: 300, height: 300 });
  });

  it("respeta el /Rotate de la pagina al traducir el rectangulo de vista a espacio de usuario", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([400, 200]);
    page.setRotation(degrees(90));
    const file = await toFile(document);

    // Mitad izquierda de la vista (tal y como la ve la persona usuaria tras
    // aplicar la rotacion), altura completa.
    const options: CropOptions = {
      rect: { x: 0, y: 0, width: 0.5, height: 1 },
      scope: "all",
      pageIndex: 0,
    };
    const blob = await cropPdf(file, options);
    const boxes = await cropBoxesOf(blob);

    // Calculado a mano deshaciendo /Rotate=90 sobre una caja de 400x200:
    // el CropBox en espacio de usuario resultante es (0,0,400,100).
    expect(boxes).toHaveLength(1);
    expectBoxClose(boxes[0], { x: 0, y: 0, width: 400, height: 100 });
  });

  it("un recorte que dejaria un lado por debajo del minimo lanza PdfError('empty')", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 300]);
    const file = await toFile(document);

    // width/height se sanean a un minimo de 0.02 (6pt sobre 300pt), por
    // debajo de los MIN_SIDE_POINTS = 8 que exige el motor.
    const options: CropOptions = {
      rect: { x: 0, y: 0, width: 0.001, height: 0.001 },
      scope: "all",
      pageIndex: 0,
    };

    await expect(cropPdf(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("un documento sin paginas lanza PdfError('corrupt')", async () => {
    const file = await emptyFile();
    const options: CropOptions = { rect: DEFAULT_CROP_RECT, scope: "all", pageIndex: 0 };

    await expect(cropPdf(file, options)).rejects.toMatchObject({ code: "corrupt" });
  });
});
