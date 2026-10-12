import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { cropPdf, cropTargets, type CropOptions } from "@/lib/pdf/crop";

/** Recorte por rango (U5): `scope: "range"` y su seleccion de paginas; los demas ambitos no cambian. */

async function pdf(pages: number): Promise<File> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) document.addPage([300, 400]);
  const bytes = await document.save();
  return new File([bytes as unknown as BlobPart], "a.pdf", { type: "application/pdf" });
}

const RECT = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
const opts = (patch: Partial<CropOptions>): CropOptions => ({ rect: RECT, scope: "all", pageIndex: 0, ...patch });

async function widths(blob: Blob): Promise<number[]> {
  const document = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
  return document.getPages().map((page) => page.getCropBox().width);
}

describe("cropTargets", () => {
  it("`all` son todas, `current` la indicada (acotada)", () => {
    expect(cropTargets(opts({}), 3)).toEqual([0, 1, 2]);
    expect(cropTargets(opts({ scope: "current", pageIndex: 1 }), 3)).toEqual([1]);
    expect(cropTargets(opts({ scope: "current", pageIndex: 99 }), 3)).toEqual([2]);
    expect(cropTargets(opts({ scope: "current", pageIndex: -4 }), 3)).toEqual([0]);
  });

  it("`range` incluye los extremos y acepta 0 en «hasta» como el final", () => {
    expect(cropTargets(opts({ scope: "range", fromPage: 2, toPage: 3 }), 5)).toEqual([1, 2]);
    expect(cropTargets(opts({ scope: "range", fromPage: 2, toPage: 0 }), 5)).toEqual([1, 2, 3, 4]);
    expect(cropTargets(opts({ scope: "range", fromPage: 4 }), 5)).toEqual([3, 4]);
  });

  it("`range` se acota: desde > total y hasta < desde dejan una sola pagina valida", () => {
    expect(cropTargets(opts({ scope: "range", fromPage: 9, toPage: 12 }), 3)).toEqual([2]);
    expect(cropTargets(opts({ scope: "range", fromPage: 3, toPage: 1 }), 3)).toEqual([2]);
    expect(cropTargets(opts({ scope: "range", fromPage: 0, toPage: 50 }), 3)).toEqual([0, 1, 2]);
  });
});

describe("cropPdf con scope range", () => {
  it("recorta solo las paginas del rango", async () => {
    const blob = await cropPdf(await pdf(4), opts({ scope: "range", fromPage: 2, toPage: 3 }));
    expect(await widths(blob)).toEqual([300, 150, 150, 300]);
  });

  it("sin `fromPage/toPage` recorta todas (rango abierto)", async () => {
    const blob = await cropPdf(await pdf(3), opts({ scope: "range" }));
    expect(await widths(blob)).toEqual([150, 150, 150]);
  });

  it("`all` y `current` siguen igual que antes", async () => {
    expect(await widths(await cropPdf(await pdf(3), opts({ scope: "all" })))).toEqual([150, 150, 150]);
    expect(await widths(await cropPdf(await pdf(3), opts({ scope: "current", pageIndex: 2 })))).toEqual([300, 300, 150]);
  });

  it("los campos de rango se ignoran fuera de `range`", async () => {
    const blob = await cropPdf(await pdf(3), opts({ scope: "all", fromPage: 3, toPage: 3 }));
    expect(await widths(blob)).toEqual([150, 150, 150]);
  });
});
