import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { buildPdfFromImages, imagesToPdf, type ImagesToPdfOptions } from "@/lib/pdf/imagesToPdf";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";

// jszip no admite `Blob` en Node: un ZIP de mentira que solo recuerda los nombres de las entradas.
vi.mock("@/lib/pdf/lazyZip", () => ({
  loadJSZip: async () =>
    class FakeZip {
      names: string[] = [];
      file(name: string): void {
        this.names.push(name);
      }
      async generateAsync(): Promise<Blob> {
        return new Blob([JSON.stringify(this.names)]);
      }
    },
}));

/**
 * Una foto mala NO aborta el PDF ni se cuela rota: se omite, se anota POR NOMBRE y con su motivo (`stats.skipped`) y las
 * demas siguen. Nunca sale un PDF con una imagen rota sin que quede constancia.
 */

const png = (name: string, width = 40, height = 30): File => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#c33";
  context.fillRect(0, 0, width, height);
  return new File([new Uint8Array(canvas.toBuffer("image/png"))], name, { type: "image/png" });
};
const jpeg = (name: string, seed = 1): File =>
  new File([new Uint8Array(makeSyntheticJpeg({ width: 320, height: 240, seed, quality: 85 }))], name, { type: "image/jpeg" });
const garbageJpg = (name: string): File => {
  const bytes = new Uint8Array(2048);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + 7) & 255;
  bytes[0] = 0x12;
  return new File([bytes], name, { type: "image/jpeg" });
};
const textPng = (name: string): File => new File([new TextEncoder().encode("esto es un texto, no una imagen ".repeat(30))], name, { type: "image/png" });
const truncatedJpeg = (name: string): File => {
  const full = new Uint8Array(makeSyntheticJpeg({ width: 400, height: 300, seed: 9, quality: 90 }));
  return new File([full.subarray(0, Math.floor(full.length * 0.6))], name, { type: "image/jpeg" });
};

const FIT: ImagesToPdfOptions = { merge: true, orientation: "auto", pageSize: "fit", margin: "none", photosPerPage: 1, quality: "original" };

async function pagesOf(blob: Blob): Promise<PDFDocument> {
  return PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
}

describe("imagesToPdf · fotos malas (M3)", () => {
  it("un .jpg con basura entre fotos buenas se omite y se nombra; las demas entran", async () => {
    const files = [png("foto-01.png"), garbageJpg("foto-02.jpg"), png("foto-03.png"), jpeg("foto-04.jpg")];
    const result = await imagesToPdf(files, FIT);
    expect((await pagesOf(result.blob)).getPageCount()).toBe(3);
    expect(result.stats.skipped).toEqual([{ position: 2, name: "foto-02.jpg", problem: "notImage" }]);
    expect(result.stats.photos).toBe(3);
    expect(result.stats.sourceBytes).toBe(files[0].size + files[2].size + files[3].size);
  });

  it("un .png que es texto se omite con su nombre", async () => {
    const result = await imagesToPdf([png("a.png"), textPng("notas.png")], FIT);
    expect((await pagesOf(result.blob)).getPageCount()).toBe(1);
    expect(result.stats.skipped).toEqual([{ position: 2, name: "notas.png", problem: "notImage" }]);
  });

  it("un JPEG truncado NO se incrusta roto, tampoco con «Original»: se omite como «incompleta»", async () => {
    for (const quality of ["original", "high", "balanced", "compact"] as const) {
      const result = await imagesToPdf([jpeg("buena.jpg", 2), truncatedJpeg("cortada.jpg")], { ...FIT, quality });
      expect((await pagesOf(result.blob)).getPageCount(), quality).toBe(1);
      expect(result.stats.skipped, quality).toEqual([{ position: 2, name: "cortada.jpg", problem: "truncated" }]);
    }
  });

  it("un archivo vacio entre fotos buenas se omite como «empty»", async () => {
    const result = await imagesToPdf([png("a.png"), new File([], "vacia.jpg", { type: "image/jpeg" }), png("c.png")], FIT);
    expect((await pagesOf(result.blob)).getPageCount()).toBe(2);
    expect(result.stats.skipped).toEqual([{ position: 2, name: "vacia.jpg", problem: "empty" }]);
  });

  it("con varias fotos por hoja, la foto mala se omite y la hoja se compone con las demas", async () => {
    const files = [png("f1.png"), png("f2.png"), garbageJpg("f3.jpg"), png("f4.png"), png("f5.png")];
    const result = await imagesToPdf(files, { ...FIT, pageSize: "a4", photosPerPage: 4 });
    const document = await pagesOf(result.blob);
    expect(document.getPageCount()).toBe(2);
    expect(result.stats.skipped).toEqual([{ position: 3, name: "f3.jpg", problem: "notImage" }]);
    expect(result.stats.photos).toBe(4);
  });

  it("una hoja entera de fotos malas no deja una pagina vacia", async () => {
    const files = [garbageJpg("m1.jpg"), garbageJpg("m2.jpg"), png("ok.png")];
    const result = await imagesToPdf(files, { ...FIT, pageSize: "a4", photosPerPage: 2 });
    expect((await pagesOf(result.blob)).getPageCount()).toBe(1);
    expect(result.stats.skipped.map((item) => item.name)).toEqual(["m1.jpg", "m2.jpg"]);
  });

  it("en ZIP (un PDF por foto) la foto mala se omite con su posicion real", async () => {
    const result = await imagesToPdf([png("a.png"), textPng("b.png"), png("c.png")], { ...FIT, merge: false });
    expect(result.kind).toBe("zip");
    expect(result.count).toBe(2);
    expect(JSON.parse(await result.blob.text())).toEqual(["a.pdf", "c.pdf"]);
    expect(result.stats.skipped).toEqual([{ position: 2, name: "b.png", problem: "notImage" }]);
  });

  it("si TODAS las fotos son inservibles no hay PDF: invalidType", async () => {
    await expect(imagesToPdf([garbageJpg("a.jpg"), textPng("b.png")], FIT)).rejects.toMatchObject({ code: "invalidType" });
    await expect(imagesToPdf([garbageJpg("a.jpg")], { ...FIT, merge: false })).rejects.toMatchObject({ code: "invalidType" });
  });

  it("las fotos buenas no producen avisos", async () => {
    const result = await imagesToPdf([png("a.png"), jpeg("b.jpg")], FIT);
    expect(result.stats.skipped).toEqual([]);
  });

  it("sin pedir omitir (Escanear a PDF, PDF Pro), una foto mala sigue abortando con invalidType", async () => {
    await expect(buildPdfFromImages([png("a.png"), garbageJpg("b.jpg")])).rejects.toMatchObject({ code: "invalidType" });
  });
});
