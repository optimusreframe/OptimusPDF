import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectFields, detectRasterFields, isSuggestionOnly } from "@/lib/pdf/detectFields";
import { renderPageToCanvas } from "@/lib/pdf/core";
import { makeFormPdf, makeImageOnlyPdf } from "@/lib/pdf/testing/signSyntheticPdfs";

/**
 * La heuristica RASTER (paginas escaneadas) NO corre por defecto (W6-A): toma por hueco
 * cualquier raya oscura de una foto. Solo corre con la accion explicita
 * (`detectRasterFields`, el boton «Buscar huecos en paginas escaneadas»). Con un espia
 * sobre el render se comprueba que `detectFields` jamas lo toca.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return {
    ...actual,
    getPdfJs: async () => ({ OPS: pdfjs.OPS }),
    openPdfDocument: async (file: File) => {
      const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
      return task.promise;
    },
    closePdfDocument: async (doc: { loadingTask: { destroy: () => Promise<void> } }) => {
      await doc.loadingTask.destroy();
    },
    // Una pagina "escaneada" pintada de blanco con una raya oscura: lo que la heuristica raster tomaria por hueco.
    renderPageToCanvas: vi.fn(async () => {
      const width = 400;
      const height = 600;
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let x = 40; x < 360; x += 1) for (let y = 300; y < 303; y += 1) data.set([0, 0, 0, 255], (y * width + x) * 4);
      return {
        width,
        height,
        getContext: () => ({ getImageData: () => ({ data, width, height }) }),
      } as unknown as HTMLCanvasElement;
    }),
  };
});

const file = (bytes: Uint8Array, name = "doc.pdf") => new File([bytes as BlobPart], name, { type: "application/pdf" });

beforeEach(() => vi.mocked(renderPageToCanvas).mockClear());

describe("heuristica raster apagada por defecto", () => {
  it("`detectFields` sobre una pagina solo-imagen NO renderiza nada ni sugiere nada", async () => {
    const result = await detectFields(file(await makeImageOnlyPdf()));
    expect(result).toEqual([]);
    expect(renderPageToCanvas).not.toHaveBeenCalled();
  });

  it("tampoco con un documento de texto: la ruta raster no se toca", async () => {
    const { bytes } = await makeFormPdf();
    const result = await detectFields(file(bytes));
    expect(result.length).toBeGreaterThan(0);
    expect(renderPageToCanvas).not.toHaveBeenCalled();
  });

  it("solo la accion explicita la ejecuta, y solo sobre la pagina pedida", async () => {
    const found = await detectRasterFields(file(await makeImageOnlyPdf()), [0]);
    expect(renderPageToCanvas).toHaveBeenCalledTimes(1);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((field) => field.source === "heuristic-raster" && field.confidence === "low")).toBe(true);
    // Una sugerencia sin tocar: sin valor no cuenta como campo.
    expect(found.every((field) => isSuggestionOnly(field, ""))).toBe(true);
  });

  it("sin paginas pedidas busca solo en las que NO tienen texto", async () => {
    const { bytes } = await makeFormPdf();
    const found = await detectRasterFields(file(bytes));
    expect(found).toEqual([]);
    expect(renderPageToCanvas).not.toHaveBeenCalled();
  });

  it("pide como mucho el tope por pagina de huecos", async () => {
    const found = await detectRasterFields(file(await makeImageOnlyPdf()), [0]);
    expect(found.length).toBeLessThanOrEqual(20);
  });
});
