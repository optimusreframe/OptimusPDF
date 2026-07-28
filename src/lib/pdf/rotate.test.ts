import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { normalizeRotation, rotatePdf, type RotatePlan } from "@/lib/pdf/rotate";

/**
 * Fixtures reales construidas con `@cantoo/pdf-lib` directamente en el
 * test (misma convencion que `unlock.test.ts` / `protect.test.ts`): sin
 * archivos externos, cada `it` arma su propio documento.
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

async function anglesOf(blob: Blob): Promise<number[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  return result.getPages().map((page) => page.getRotation().angle);
}

describe("normalizeRotation — src/lib/pdf/rotate.ts", () => {
  it("normaliza multiplos exactos de 90", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  it("envuelve 360 y multiplos mayores al rango 0..270", () => {
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(720)).toBe(0);
  });

  it("normaliza grados negativos al equivalente positivo", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-180)).toBe(180);
    expect(normalizeRotation(-360)).toBe(0);
  });

  it("valores no finitos (NaN, Infinity) devuelven 0", () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeRotation(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("rotatePdf — src/lib/pdf/rotate.ts", () => {
  it("aplica la rotacion base a todas las paginas", async () => {
    const file = await toFile(await documentWithPages(3));
    const blob = await rotatePdf(file, { base: 90 });
    expect(await anglesOf(blob)).toEqual([90, 90, 90]);
  });

  it("la rotacion es aditiva sobre la que ya trae la pagina", async () => {
    const document = await documentWithPages(1);
    document.getPage(0).setRotation(degrees(90));
    const file = await toFile(document);

    const blob = await rotatePdf(file, { base: 90 });
    // 90 (ya guardada) + 90 (aplicada) = 180
    expect(await anglesOf(blob)).toEqual([180]);
  });

  it("byPage sobreescribe la rotacion base solo en las paginas indicadas (1-based)", async () => {
    const file = await toFile(await documentWithPages(3));
    const plan: RotatePlan = { base: 90, byPage: { 2: 270 } };

    const blob = await rotatePdf(file, plan);
    expect(await anglesOf(blob)).toEqual([90, 270, 90]);
  });

  it("acepta grados negativos y los normaliza antes de aplicarlos", async () => {
    const file = await toFile(await documentWithPages(1));
    const blob = await rotatePdf(file, { base: -90 });
    expect(await anglesOf(blob)).toEqual([270]);
  });

  it("sin plan (objeto vacio) no cambia la rotacion de ninguna pagina", async () => {
    const file = await toFile(await documentWithPages(2));
    const blob = await rotatePdf(file, {});
    expect(await anglesOf(blob)).toEqual([0, 0]);
  });

  it("un documento sin paginas lanza PdfError('corrupt')", async () => {
    const file = await emptyFile();
    await expect(rotatePdf(file, { base: 90 })).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
