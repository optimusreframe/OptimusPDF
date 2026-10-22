import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setPrepareBackendOverride } from "@/lib/image/prepareBrowser";
import { createNodeBackend, makeSyntheticJpeg, withExifOrientation, type NodeBackendStats } from "@/lib/image/photoTestUtils";
import { MIN_SAVING } from "@/lib/image/prepareForPdf";
import { estimatePdfSize, probeImageFiles } from "@/lib/image/estimatePdfSize";
import {
  MARGINS,
  imagesToPdf,
  pageSizeInPoints,
  type ImagesToPdfOptions,
} from "@/lib/pdf/imagesToPdf";
import { layoutPhotoGrid, pixelsNeededForRect, type PhotosPerPage } from "@/lib/pdf/photoGrid";

/**
 * `imagesToPdf` con calidad de imagen y varias fotos por hoja, con el backend de Node (`@napi-rs/canvas`): lo que llega
 * al PDF (pixeles de cada imagen, bytes, posiciones) y el tamano frente a las fotos originales.
 */

const stats = (): NodeBackendStats => ({ decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 });
let backendStats = stats();
beforeEach(() => {
  backendStats = stats();
  setPrepareBackendOverride(createNodeBackend(backendStats));
});
afterEach(() => setPrepareBackendOverride(null));

const jpegFile = (name: string, options: Parameters<typeof makeSyntheticJpeg>[0], orientation?: 6 | 8 | 3): File => {
  const bytes = makeSyntheticJpeg(options);
  const data = orientation ? withExifOrientation(bytes, orientation) : bytes;
  return new File([new Uint8Array(data)], name, { type: "image/jpeg" });
};

const BASE: ImagesToPdfOptions = { merge: true, orientation: "auto", pageSize: "a4", margin: "none" };

type PageImage = { width: number; height: number; bytes: Uint8Array; filter: string };

/** Imagenes (XObject) de una pagina, en orden de aparicion, con sus pixeles y su flujo comprimido. */
function pageImages(document: PDFDocument, pageIndex: number): PageImage[] {
  const page = document.getPage(pageIndex);
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  const out: PageImage[] = [];
  if (!xobjects) return out;
  // @ts-expect-error entries() existe en PDFDict
  for (const [, ref] of xobjects.entries()) {
    const stream = document.context.lookup(ref as PDFRef);
    if (!(stream instanceof PDFRawStream)) continue;
    const filter = String(stream.dict.get(PDFName.of("Filter")));
    out.push({
      width: Number(stream.dict.get(PDFName.of("Width"))),
      height: Number(stream.dict.get(PDFName.of("Height"))),
      bytes: stream.contents,
      filter,
    });
  }
  return out;
}

type Placement = { x: number; y: number; width: number; height: number };

/** Posiciones `cm` + `Do` de la pagina (solo imagenes sin giro, que son las que dibuja `drawImage`). */
function pagePlacements(document: PDFDocument, pageIndex: number): Placement[] {
  const contents = document.getPage(pageIndex).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((item) => document.context.lookup(item)) : [contents];
  let text = "";
  for (const stream of streams) {
    if (stream instanceof PDFRawStream) text += Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
  }
  const out: Placement[] = [];
  // Cada imagen: `q` + varias matrices `cm` (traslacion, escala...) + `/Nombre Do` + `Q`. Se multiplican todas.
  for (const block of text.split(/^q$/m).slice(1)) {
    if (!/\/\S+ Do/.test(block)) continue;
    let matrix = [1, 0, 0, 1, 0, 0];
    for (const line of block.split("\n")) {
      const numbers = /^(-?[\d.e+-]+) (-?[\d.e+-]+) (-?[\d.e+-]+) (-?[\d.e+-]+) (-?[\d.e+-]+) (-?[\d.e+-]+) cm$/.exec(line.trim());
      if (!numbers) continue;
      const [a, b, c, d, e, f] = numbers.slice(1).map(Number);
      const [m0, m1, m2, m3, m4, m5] = matrix;
      // matriz nueva = [a b c d e f] x matriz anterior (la ultima `cm` se aplica primero al punto).
      matrix = [a * m0 + b * m2, a * m1 + b * m3, c * m0 + d * m2, c * m1 + d * m3, e * m0 + f * m2 + m4, e * m1 + f * m3 + m5];
    }
    out.push({ width: matrix[0], height: matrix[3], x: matrix[4], y: matrix[5] });
  }
  return out;
}

async function load(blob: Blob): Promise<PDFDocument> {
  return PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { updateMetadata: false });
}

describe("imagesToPdf con calidad de imagen", () => {
  it("«Equilibrada» (por defecto) reduce las fotos y el PDF pesa mucho menos que las fotos originales", async () => {
    const files = [1, 2, 3].map((seed) => jpegFile(`f${seed}.jpg`, { width: 4000, height: 3000, seed, quality: 92 }));
    const original = files.reduce((sum, file) => sum + file.size, 0);
    const result = await imagesToPdf(files, BASE);
    const document = await load(result.blob);
    expect(document.getPageCount()).toBe(3);
    for (let page = 0; page < 3; page += 1) {
      const [image] = pageImages(document, page);
      expect(Math.max(image.width, image.height)).toBe(3000);
    }
    expect(result.blob.size).toBeLessThan(original * (1 - MIN_SAVING));
    expect(result.stats).toMatchObject({ photos: 3, changed: 3, sourceBytes: original });
    expect(backendStats.maxLive).toBe(1);
    expect(backendStats.live).toBe(0);
  }, 60_000);

  it("«Original» incrusta EXACTAMENTE los bytes de cada JPEG (y su orientacion EXIF sigue funcionando)", async () => {
    const files = [
      jpegFile("a.jpg", { width: 4000, height: 3000, seed: 1, quality: 92 }),
      jpegFile("b.jpg", { width: 3000, height: 2000, seed: 2, quality: 92 }, 6),
    ];
    const result = await imagesToPdf(files, { ...BASE, quality: "original" });
    expect(result.stats.changed).toBe(0);
    expect(backendStats.decodes).toBe(0);
    const document = await load(result.blob);
    for (let page = 0; page < 2; page += 1) {
      const [image] = pageImages(document, page);
      expect(image.filter).toContain("DCTDecode");
      const source = new Uint8Array(await files[page].arrayBuffer());
      expect(image.bytes.length).toBe(source.length);
      expect(Buffer.compare(Buffer.from(image.bytes), Buffer.from(source))).toBe(0);
    }
    // La foto con EXIF 6 (3000x2000 guardada) va en una pagina vertical.
    expect(document.getPage(1).getWidth()).toBeLessThan(document.getPage(1).getHeight());
  }, 60_000);

  it("la orientacion mezclada (1, 6, 8, 3) sale con las paginas y proporciones correctas con cualquier preset", async () => {
    for (const quality of ["original", "balanced", "compact"] as const) {
      const files = [
        jpegFile("o1.jpg", { width: 4000, height: 3000, seed: 1, quality: 92 }),
        jpegFile("o6.jpg", { width: 4000, height: 3000, seed: 2, quality: 92 }, 6),
        jpegFile("o8.jpg", { width: 4000, height: 3000, seed: 3, quality: 92 }, 8),
        jpegFile("o3.jpg", { width: 4000, height: 3000, seed: 4, quality: 92 }, 3),
      ];
      const result = await imagesToPdf(files, { ...BASE, quality, pageSize: "fit" });
      const document = await load(result.blob);
      const ratios = [4 / 3, 3 / 4, 3 / 4, 4 / 3];
      ratios.forEach((ratio, page) => {
        expect(document.getPage(page).getWidth() / document.getPage(page).getHeight(), `${quality} pagina ${page}`).toBeCloseTo(ratio, 2);
      });
    }
  }, 120_000);

  it("«Compacta» pesa menos que «Equilibrada» y esta que «Alta»", async () => {
    const files = [4, 5].map((seed) => jpegFile(`f${seed}.jpg`, { width: 4000, height: 3000, seed, quality: 92 }));
    const sizes: number[] = [];
    for (const quality of ["high", "balanced", "compact"] as const) sizes.push((await imagesToPdf(files, { ...BASE, quality })).blob.size);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
    expect(sizes[1]).toBeGreaterThan(sizes[2]);
  }, 120_000);

  it("avisa antes de preparar cada foto (1..N de N), en orden, y se puede cancelar a mitad", async () => {
    const files = [1, 2, 3, 4].map((seed) => jpegFile(`f${seed}.jpg`, { width: 4000, height: 3000, seed, quality: 92 }));
    const seen: Array<[number, number]> = [];
    await imagesToPdf(files, BASE, undefined, { onPhotoStart: (position, total) => seen.push([position, total]) });
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);

    const controller = new AbortController();
    const started: number[] = [];
    await expect(
      imagesToPdf(files, BASE, undefined, {
        signal: controller.signal,
        onPhotoStart: (position) => {
          started.push(position);
          if (position === 2) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(started).toEqual([1, 2]);
    expect(backendStats.live).toBe(0);
  }, 60_000);

  it("un archivo que no es imagen falla con `invalidType`", async () => {
    const junk = new File([new Uint8Array(400).fill(5)], "x.jpg", { type: "image/jpeg" });
    await expect(imagesToPdf([junk], BASE)).rejects.toMatchObject({ code: "invalidType" });
  });
});

describe("imagesToPdf con varias fotos por hoja", () => {
  const photos = (count: number): File[] =>
    Array.from({ length: count }, (_, index) =>
      jpegFile(`p${index}.jpg`, index % 3 === 0 ? { width: 3200, height: 2400, seed: index + 1, quality: 90 } : index % 3 === 1 ? { width: 2400, height: 3200, seed: index + 1, quality: 90 } : { width: 4800, height: 1600, seed: index + 1, quality: 90 }),
    );

  for (const perPage of [2, 4, 6, 8, 10] as const) {
    it(`${perPage} por hoja con 13 fotos mezcladas: ${Math.ceil(13 / perPage)} hojas y cada foto exactamente donde dice el composicion`, async () => {
      const files = photos(13);
      const options: ImagesToPdfOptions = { ...BASE, photosPerPage: perPage, margin: "small", quality: "balanced" };
      const result = await imagesToPdf(files, options);
      const document = await load(result.blob);
      expect(document.getPageCount()).toBe(Math.ceil(13 / perPage));
      // Las proporciones reales de las fotos (las de los pixeles incrustados) componen la misma hoja que el modulo puro.
      const embedded = [] as { width: number; height: number }[];
      for (let page = 0; page < document.getPageCount(); page += 1) {
        const images = pageImages(document, page);
        for (const image of images) embedded.push({ width: image.width, height: image.height });
      }
      expect(embedded).toHaveLength(13);
      const expected = layoutPhotoGrid(embedded, {
        perPage: perPage as PhotosPerPage,
        pageSize: pageSizeInPoints("a4"),
        orientation: "auto",
        margin: MARGINS.small,
      });
      for (let page = 0; page < expected.length; page += 1) {
        expect(document.getPage(page).getWidth()).toBeCloseTo(expected[page].pageWidth, 2);
        expect(document.getPage(page).getHeight()).toBeCloseTo(expected[page].pageHeight, 2);
        const placements = pagePlacements(document, page);
        expect(placements).toHaveLength(expected[page].photos.length);
        expected[page].photos.forEach((placed, k) => {
          expect(placements[k].x).toBeCloseTo(placed.rect.x, 2);
          expect(placements[k].y).toBeCloseTo(placed.rect.y, 2);
          expect(placements[k].width).toBeCloseTo(placed.rect.width, 2);
          expect(placements[k].height).toBeCloseTo(placed.rect.height, 2);
        });
      }
    }, 120_000);
  }

  it("cada foto solo lleva los pixeles que su celda necesita (a 250 ppp en «Equilibrada»), nunca mas que el tope del preset", async () => {
    const files = photos(10);
    const result = await imagesToPdf(files, { ...BASE, photosPerPage: 10, quality: "balanced" });
    const document = await load(result.blob);
    const sheet = layoutPhotoGrid(
      pageImages(document, 0).map((image) => ({ width: image.width, height: image.height })),
      { perPage: 10, pageSize: pageSizeInPoints("a4"), orientation: "auto", margin: 0 },
    )[0];
    pageImages(document, 0).forEach((image, k) => {
      const needed = pixelsNeededForRect(sheet.photos[k].rect, 250);
      // El lado largo es lo que pidio la celda (con el minimo de 640 px) y jamas pasa de 3000.
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(Math.max(640, needed) + 2);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(3000);
    });
  }, 120_000);

  it("con «Original» no se toca ningun byte de ninguna foto, tambien con varias por hoja", async () => {
    const files = photos(5);
    const result = await imagesToPdf(files, { ...BASE, photosPerPage: 4, quality: "original" });
    expect(backendStats.decodes).toBe(0);
    const document = await load(result.blob);
    const embedded: Uint8Array[] = [];
    for (let page = 0; page < document.getPageCount(); page += 1) for (const image of pageImages(document, page)) embedded.push(image.bytes);
    expect(embedded).toHaveLength(5);
    for (let index = 0; index < 5; index += 1) {
      expect(Buffer.compare(Buffer.from(embedded[index]), Buffer.from(await files[index].arrayBuffer()))).toBe(0);
    }
  }, 60_000);

  it("el PDF con 4 por hoja pesa claramente menos que con 1 por hoja (misma calidad)", async () => {
    const files = photos(8);
    const one = (await imagesToPdf(files, { ...BASE, photosPerPage: 1, quality: "balanced" })).blob.size;
    const four = (await imagesToPdf(files, { ...BASE, photosPerPage: 4, quality: "balanced" })).blob.size;
    expect(four).toBeLessThan(one * 0.8);
  }, 120_000);

  it("«Ajustar» con varias fotos usa A4, y horizontal gira la hoja", async () => {
    const files = photos(4);
    const fit = await load((await imagesToPdf(files, { ...BASE, pageSize: "fit", photosPerPage: 4 })).blob);
    expect(fit.getPage(0).getWidth()).toBeCloseTo(595.28, 1);
    const land = await load((await imagesToPdf(files, { ...BASE, orientation: "landscape", photosPerPage: 4 })).blob);
    expect(land.getPage(0).getWidth()).toBeCloseTo(841.89, 1);
  }, 60_000);

  it("el orden `order` decide que foto va en cada celda", async () => {
    const files = photos(4);
    const result = await imagesToPdf(files, { ...BASE, photosPerPage: 4, order: [3, 2, 1, 0], quality: "balanced" });
    const document = await load(result.blob);
    const dims = pageImages(document, 0).map((image) => image.width / image.height);
    // Las fotos 3 y 0 son horizontales (4:3), la 1 vertical (3:4) y la 2 panoramica (3:1): el orden se invierte.
    expect(dims[0]).toBeCloseTo(4 / 3, 1);
    expect(dims[1]).toBeGreaterThan(2.5);
    expect(dims[2]).toBeLessThan(1);
    expect(dims[3]).toBeCloseTo(4 / 3, 1);
  }, 60_000);
});

describe("estimacion antes de generar frente al PDF real", () => {
  it("39 fotos de 24 MP: la estimacion con «Equilibrada» y con 4 por hoja esta en el orden de magnitud del PDF real", async () => {
    // 6 fotos distintas repetidas para no generar 39 (el tamano medio es lo que cuenta).
    const base = [1, 2, 3].map((seed) => jpegFile(`b${seed}.jpg`, { width: 4000, height: 3000, seed, quality: 92 }));
    const files = Array.from({ length: 12 }, (_, index) => base[index % 3]);
    const probes = await probeImageFiles(files);
    for (const perPage of [1, 4] as const) {
      const estimate = estimatePdfSize(probes, "balanced", { perPage, pageSize: pageSizeInPoints("a4"), orientation: "auto", margin: 0 });
      const real = (await imagesToPdf(files, { ...BASE, photosPerPage: perPage, quality: "balanced" })).blob.size;
      expect(estimate.sourceBytes).toBe(files.reduce((sum, file) => sum + file.size, 0));
      expect(estimate.optimizedBytes / real, `${perPage} por hoja`).toBeGreaterThan(0.4);
      expect(estimate.optimizedBytes / real, `${perPage} por hoja`).toBeLessThan(2.5);
      expect(estimate.optimizedBytes).toBeLessThan(estimate.unoptimizedBytes);
    }
  }, 180_000);

  it("«Original» estima el peso de los archivos (mas las hojas) y varias por hoja reduce la estimacion de las demas calidades", async () => {
    const files = [1, 2].map((seed) => jpegFile(`o${seed}.jpg`, { width: 4000, height: 3000, seed, quality: 92 }));
    const probes = await probeImageFiles(files);
    const grid = (perPage: PhotosPerPage) => ({ perPage, pageSize: pageSizeInPoints("a4"), orientation: "auto" as const, margin: 0 });
    const original = estimatePdfSize(probes, "original", grid(4));
    expect(original.optimizedBytes).toBeGreaterThanOrEqual(original.sourceBytes);
    expect(original.optimizedBytes).toBeLessThan(original.sourceBytes * 1.01);
    expect(estimatePdfSize(probes, "balanced", grid(4)).optimizedBytes).toBeLessThan(estimatePdfSize(probes, "balanced", grid(1)).optimizedBytes);
  });
});
