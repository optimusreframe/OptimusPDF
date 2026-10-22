import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { buildImagesCorpus, corpusTruth, type TruthDoc } from "./__fixtures__/images/corpus";
import { encodeMmr, jbig2SampleBitmap, jbig2Stream, jpxBytes, JPX_HEIGHT, JPX_WIDTH } from "./__fixtures__/images/codecs";
import { JPEG_CMYK, JPEG_GRAY, JPEG_RGB } from "./__fixtures__/images/jpegSamples";
import { readJpegHeader } from "./imagesJpeg";

/**
 * El corpus sintetico (U7.5): es reproducible, su verdad guardada (`truth.json`) coincide con la que genera el codigo, y
 * trae lo que el plan pide. Para regenerar la verdad tras cambiar el generador: `UPDATE_TRUTH=1 npx vitest run
 * --project engines src/lib/pdf/extractAssets/images.corpus.test.ts` (y revisar el diff de `truth.json`).
 */

const TRUTH_FILE = path.join(process.cwd(), "src/lib/pdf/extractAssets/__fixtures__/images/truth.json");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Cajas redondeadas a 9 decimales: `Math.sin`/`Math.cos` pueden diferir en el ultimo bit entre plataformas. */
const rounded = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "number" ? Math.round(item * 1e9) / 1e9 : item)));

describe("corpus sintetico de imagenes", () => {
  it("la verdad guardada en truth.json coincide con la que genera el codigo", async () => {
    const generated = rounded(corpusTruth(await buildImagesCorpus()));
    if (process.env.UPDATE_TRUTH === "1") fs.writeFileSync(TRUTH_FILE, `${JSON.stringify(generated, null, 2)}\n`);
    const saved = JSON.parse(fs.readFileSync(TRUTH_FILE, "utf8")) as Record<string, TruthDoc>;
    expect(saved).toEqual(generated);
  });

  it("es reproducible: construirlo dos veces da los MISMOS bytes en cada PDF", async () => {
    const first = await buildImagesCorpus();
    const second = await buildImagesCorpus();
    expect(second.map((entry) => [entry.name, sha(entry.bytes)])).toEqual(first.map((entry) => [entry.name, sha(entry.bytes)]));
  });

  it("cada PDF se abre, tiene las paginas de su verdad y las cajas estan dentro de la pagina", async () => {
    for (const entry of await buildImagesCorpus()) {
      const doc = await PDFDocument.load(entry.bytes, { updateMetadata: false });
      expect(doc.getPageCount(), entry.name).toBe(entry.truth.pageCount);
      const ids = new Set<string>();
      for (const image of entry.truth.images) {
        expect(ids.has(image.id), `${entry.name}: id repetido ${image.id}`).toBe(false);
        ids.add(image.id);
        expect(image.occurrences.length).toBeGreaterThan(0);
        for (const occurrence of image.occurrences) {
          expect(occurrence.pageIndex).toBeLessThan(entry.truth.pageCount);
          const { x, y, width, height } = occurrence.rect;
          expect(x, `${entry.name}/${image.id}`).toBeGreaterThanOrEqual(-1e-9);
          expect(y).toBeGreaterThanOrEqual(-1e-9);
          expect(x + width).toBeLessThanOrEqual(1 + 1e-9);
          expect(y + height).toBeLessThanOrEqual(1 + 1e-9);
          expect(width * height).toBeGreaterThan(0);
        }
      }
      expect(entry.truth.description.length).toBeGreaterThan(20);
    }
  });

  it("trae TODO lo que pide el plan para imagenes (U7.5)", async () => {
    const corpus = await buildImagesCorpus();
    const truth = corpusTruth(corpus);
    expect(truth["png-alpha"].images[0].hasAlpha).toBe(true);
    expect(truth["png-opaque"].images[0].hasAlpha).toBe(false);
    expect(truth.jpeg.images.some((image) => image.jpegOriginal)).toBe(true);
    expect(truth["logo-repeat"].pageCount).toBe(5);
    expect(truth["logo-repeat"].images).toHaveLength(1);
    expect(truth["logo-repeat"].images[0].occurrences).toHaveLength(5);
    expect(truth.inline.images.some((image) => image.source === "inline")).toBe(true);
    expect(truth["mask-1bit"].images[0].source).toBe("mask");
    expect(truth["form-nested"].images[0].occurrences).toHaveLength(2);
    expect(truth.smask.images.every((image) => image.hasAlpha)).toBe(true);
    expect(truth.scanned.scannedPages).toEqual([0]);
    expect(truth["mosaic-200"].images).toHaveLength(200);
    expect(truth.bomb.warnings).toContain("image-too-large");
    expect(truth.jpx.images).toHaveLength(1);
    expect(truth.jbig2.images).toHaveLength(1);
    expect(truth["decode-failed"].warnings).toEqual(["decode-failed"]);
  });

  it("la imagen anidada con giro y escala tiene una caja DISTINTA de la que daria ignorar las matrices", async () => {
    const nested = corpusTruth(await buildImagesCorpus())["form-nested"].images[0].occurrences[0].rect;
    const naive = { x: 150 / 612, y: 1 - (400 + 40) / 792, width: 60 / 612, height: 40 / 792 };
    expect(Math.abs(nested.width - naive.width)).toBeGreaterThan(0.05);
    expect(nested.width).toBeGreaterThan(nested.height * 0.5);
  });
});

describe("codecs sinteticos", () => {
  it("JPX: 1176 bytes de un JP2 de 32 x 20", () => {
    const bytes = jpxBytes();
    expect(bytes.length).toBe(1176);
    expect([...bytes.subarray(4, 8)]).toEqual([0x6a, 0x50, 0x20, 0x20]); // «jP  »
    expect([JPX_WIDTH, JPX_HEIGHT]).toEqual([32, 20]);
  });

  it("JBIG2: segmentos de pagina (48) y de region generica (38) con las medidas del dibujo", () => {
    const stream = jbig2Stream(jbig2SampleBitmap());
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    expect(stream[4]).toBe(48);
    // Cabecera de segmento: numero (4), tipo (1), referidos (1), pagina (1), longitud (4) = 11 bytes.
    expect(view.getUint32(7)).toBe(19); // longitud de los datos del segmento de pagina
    expect(view.getUint32(11)).toBe(16); // ancho
    expect(view.getUint32(15)).toBe(12); // alto
    const regionStart = 11 + 19;
    expect(stream[regionStart + 4]).toBe(38);
    expect(view.getUint32(regionStart + 11)).toBe(16); // ancho de la region
    expect(stream[regionStart + 11 + 17]).toBe(1); // banderas de region generica: MMR
  });

  it("MMR: una linea de otra del mismo dibujo cuesta 3 bits (V0 V0 V0) y una carrera mayor de 16 px no se admite", () => {
    const row = [...".....########....".padEnd(16, ".")].slice(0, 16).map((c) => c === "#");
    const one = encodeMmr([row.slice(0, 16)]);
    const many = encodeMmr(new Array(9).fill(row.slice(0, 16)));
    // 1 fila ocupa 3 bytes como maximo; 8 filas mas iguales anaden 24 bits = 3 bytes.
    expect(many.length - one.length).toBeLessThanOrEqual(4);
    expect(() => encodeMmr([new Array<boolean>(40).fill(true)])).toThrow(/16 px/);
  });

  it("JPEG de muestra: cabeceras validas con 3, 1 y 4 componentes", () => {
    expect(readJpegHeader(JPEG_RGB.bytes())).toEqual({ width: 64, height: 48, components: 3 });
    expect(readJpegHeader(JPEG_GRAY.bytes())).toEqual({ width: 48, height: 32, components: 1 });
    expect(readJpegHeader(JPEG_CMYK.bytes())).toEqual({ width: 32, height: 24, components: 4 });
  });
});
