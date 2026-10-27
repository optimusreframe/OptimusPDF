import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { BIG_WIDTH, BIG_HEIGHT, bigFlatePdf, bigJpegPdf, gradientPixel, type BigPdf } from "./__fixtures__/images/bigImages";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { decodePng } from "./images.testUtils";
import { BIG_ANALYSIS_PX, mentionsImages, prepareImages } from "./imagesPrep";
import { extractWith, renderWith, releaseRenderDocument, type ExtractEnv } from "./orchestrate";
import type { ExtractedAsset } from "./types";

/**
 * H11: una foto de mas de 12 MP NO se decodifica entera con pdf.js para buscar. Se sustituye por un punto en la copia con que se abre el
 * documento, y su miniatura sale de una version reducida (el JPEG original con `reduceJpeg`, el Flate por streaming). Aqui, con imagenes de
 * 12,3 MP de verdad: lo que se abre, lo que se ofrece (medidas REALES, miniatura, formatos) y los PNG a tamano completo bajo demanda.
 */

const MAX = 50_000_000;
let jpeg: BigPdf;
let flateRaw: BigPdf;
let flatePng: BigPdf;
let flateGray: BigPdf;

beforeAll(async () => {
  [jpeg, flateRaw, flatePng, flateGray] = await Promise.all([
    bigJpegPdf(),
    bigFlatePdf({ predictor: "none" }),
    bigFlatePdf({ predictor: "png" }),
    bigFlatePdf({ predictor: "png", comps: 1 }),
  ]);
}, 120_000);

/** El entorno de Node con registro de lo que se abre con pdf.js. */
function spyEnv(): { env: ExtractEnv; opened: Uint8Array[] } {
  const opened: Uint8Array[] = [];
  return { opened, env: { ...nodeExtractEnv, openDocument: async (bytes) => (opened.push(bytes), nodeExtractEnv.openDocument(bytes)) } };
}

async function imageWidthsIn(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const widths: number[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || !(object.dict instanceof PDFDict)) continue;
    if (object.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    widths.push((object.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber());
  }
  return widths;
}

describe("mentionsImages", () => {
  it("busca «/Image» en los bytes (el diccionario de un XObject va siempre en claro)", () => {
    expect(mentionsImages(new TextEncoder().encode("<< /Type /XObject /Subtype /Image /Width 4 >>"))).toBe(true);
    expect(mentionsImages(new TextEncoder().encode("<< /Type /Page /Contents 4 0 R >>"))).toBe(false);
    expect(mentionsImages(new Uint8Array(0))).toBe(false);
    expect(mentionsImages(new TextEncoder().encode("/Imag"))).toBe(false);
  });
});

describe("prepareImages", () => {
  it("un PDF sin imagenes no se abre con pdf-lib: se devuelve tal cual", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const bytes = await doc.save();
    const prep = await prepareImages(bytes, MAX);
    expect(prep.analysisBytes).toBe(bytes);
    expect(prep.big.size).toBe(0);
  });

  it("una foto JPEG de 12,3 MP se sustituye por un punto en la COPIA; el original no se toca", async () => {
    const prep = await prepareImages(jpeg.bytes, MAX);
    expect(prep.big.size).toBe(1);
    const [big] = [...prep.big.values()];
    expect([big.width, big.height]).toEqual([BIG_WIDTH, BIG_HEIGHT]);
    expect(big.width * big.height).toBeGreaterThan(BIG_ANALYSIS_PX);
    expect(big.jpeg?.length ?? 0).toBeGreaterThan(1000);
    expect(big.original?.key).toBe(big.key);
    expect(big.flate).toBeNull();
    expect(prep.analysisBytes).not.toBe(jpeg.bytes);
    expect(await imageWidthsIn(prep.analysisBytes)).toEqual([1]);
    expect(await imageWidthsIn(jpeg.bytes)).toEqual([BIG_WIDTH]);
    expect(prep.analysisBytes.length).toBeLessThan(jpeg.bytes.length);
    expect(prep.jpegIndex.has(big.key)).toBe(true);
  });

  it.each([
    ["Flate RGB sin predictor", () => flateRaw],
    ["Flate RGB con predictor PNG", () => flatePng],
    ["Flate gris con predictor PNG", () => flateGray],
  ])("%s de 12,3 MP: tambien se sustituye y se anota como reducible en streaming", async (_name, get) => {
    const prep = await prepareImages(get().bytes, MAX);
    expect(prep.big.size).toBe(1);
    const [big] = [...prep.big.values()];
    expect(big.jpeg).toBeNull();
    expect(big.flate).not.toBeNull();
    expect(big.flate!.png).toBe(get() !== flateRaw);
    expect(big.flate!.comps).toBe(get() === flateGray ? 1 : 3);
    expect(await imageWidthsIn(prep.analysisBytes)).toEqual([1]);
  });

  it("una imagen por debajo del umbral no se toca (aunque sea grande para una miniatura)", async () => {
    const small = await bigFlatePdf({ width: 2000, height: 1500 });
    const prep = await prepareImages(small.bytes, MAX);
    expect(prep.big.size).toBe(0);
    expect(prep.analysisBytes).toBe(small.bytes);
  });

  it("por encima del tope de 50 MP se sustituye tambien (no se decodifica nada) aunque no se pueda reducir", async () => {
    const prep = await prepareImages(flateRaw.bytes, 10_000_000);
    expect(prep.big.size).toBe(1);
    const noFlate = await prepareImages(jpeg.bytes, 10_000_000);
    expect(noFlate.big.size).toBe(1);
  });

  it("con /SMask o /Mask la transparencia solo la compone pdf.js: la foto NO se sustituye (se decodifica como siempre)", async () => {
    const doc = await PDFDocument.load(jpeg.bytes, { updateMetadata: false });
    const smask = doc.context.register(PDFRawStream.of(doc.context.obj({ Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceGray", BitsPerComponent: 8, Length: 4 }) as never, new Uint8Array([0, 80, 160, 255])));
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image") && (object.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber() === BIG_WIDTH) object.dict.set(PDFName.of("SMask"), smask);
    }
    const prep = await prepareImages(await doc.save({ useObjectStreams: false }), MAX);
    expect(prep.big.size).toBe(0);
    // ... salvo por encima del tope de 50 MP, donde nada se decodifica.
    const over = await prepareImages(await doc.save({ useObjectStreams: false }), 10_000_000);
    expect(over.big.size).toBe(1);
  });

  it("nunca lanza: un PDF roto o cifrado da el original", async () => {
    const garbage = new TextEncoder().encode("%PDF-1.4 /Subtype /Image garbage");
    const prep = await prepareImages(garbage, MAX);
    expect(prep.analysisBytes).toBe(garbage);
    expect(prep.big.size).toBe(0);
  });

  it("`keep`: la copia deja REAL solo esa imagen (para regenerar una foto sin decodificar las demas de la pagina)", async () => {
    const full = await prepareImages(jpeg.bytes, MAX);
    const [key] = [...full.big.keys()];
    const kept = await prepareImages(jpeg.bytes, MAX, { keep: key });
    expect(await imageWidthsIn(kept.analysisBytes)).toEqual([BIG_WIDTH]);
  });
});

function expectGradient(thumbPixels: { width: number; height: number; data: Uint8Array }, tolerance = 16): void {
  const at = (fx: number, fy: number): number[] => {
    const x = Math.min(thumbPixels.width - 1, Math.floor(fx * thumbPixels.width));
    const y = Math.min(thumbPixels.height - 1, Math.floor(fy * thumbPixels.height));
    return [...thumbPixels.data.subarray((y * thumbPixels.width + x) * 4, (y * thumbPixels.width + x) * 4 + 3)];
  };
  for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.5, 0.5]]) {
    const expected = gradientPixel(fx * BIG_WIDTH, fy * BIG_HEIGHT);
    const got = at(fx, fy);
    for (let c = 0; c < 2; c += 1) expect(Math.abs(got[c] - expected[c]), `${fx},${fy} canal ${c}`).toBeLessThanOrEqual(tolerance);
  }
}

describe("extractWith con fotos enormes", () => {
  it("JPEG: el documento se abre con la copia (un punto), el elemento sale con las medidas REALES, miniatura y JPG original", async () => {
    const { env, opened } = spyEnv();
    const result = await extractWith(env, jpeg.bytes);
    expect(opened).toHaveLength(1);
    expect(await imageWidthsIn(opened[0])).toEqual([1]);
    expect(result.warnings).toEqual([]);
    expect(result.assets).toHaveLength(1);
    const asset = result.assets[0];
    expect(asset.pixel).toEqual({ width: BIG_WIDTH, height: BIG_HEIGHT, hasAlpha: false });
    expect(asset.formats).toEqual(["png", "jpg-original"]);
    expect(asset.thumb).not.toBeNull();
    const thumb = decodePng(new Uint8Array(await asset.thumb!.arrayBuffer()));
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(256);
    expect(thumb.width / thumb.height).toBeCloseTo(BIG_WIDTH / BIG_HEIGHT, 1);
    // Rojo creciente a la derecha, verde creciente hacia abajo (JPEG: tolerancia).
    const left = thumb.data.subarray(0, 4);
    const right = thumb.data.subarray((thumb.width - 1) * 4, thumb.width * 4);
    expect(right[0]).toBeGreaterThan(left[0] + 100);
    expect(asset.bytesEstimate).toBeGreaterThan(1000);
  });

  it.each([
    ["Flate RGB sin predictor", () => flateRaw],
    ["Flate RGB con predictor PNG", () => flatePng],
  ])("%s: medidas reales y miniatura con el degradado (reducida en streaming)", async (_name, get) => {
    const { env, opened } = spyEnv();
    const result = await extractWith(env, get().bytes);
    expect(await imageWidthsIn(opened[0])).toEqual([1]);
    expect(result.assets).toHaveLength(1);
    const asset = result.assets[0];
    expect(asset.pixel).toEqual({ width: BIG_WIDTH, height: BIG_HEIGHT, hasAlpha: false });
    expect(asset.formats).toEqual(["png", "jpg"]);
    const thumb = decodePng(new Uint8Array(await asset.thumb!.arrayBuffer()));
    expectGradient(thumb, 6);
  });

  it("no pierde lo que hay en la pagina: la posicion de la imagen es la de la pintura original", async () => {
    const result = await extractWith(nodeExtractEnv, flatePng.bytes);
    const rect = result.assets[0].occurrences[0].rect;
    expect(rect.x).toBeCloseTo(50 / 612, 3);
    expect(rect.width).toBeCloseTo(300 / 612, 3);
    expect(rect.height).toBeCloseTo(200 / 792, 3);
  });

  it("una foto por encima del tope de 50 MP no se decodifica: aviso `image-too-large` y sin elemento (no es un JPEG descargable tal cual: nada que ofrecer)", async () => {
    const huge = await bigFlatePdf({ width: 7200, height: 7200, predictor: "png", comps: 1 });
    const { env, opened } = spyEnv();
    const result = await extractWith(env, huge.bytes);
    expect(await imageWidthsIn(opened[0])).toEqual([1]);
    expect(result.warnings.map((w) => w.code)).toContain("image-too-large");
    expect(result.assets).toEqual([]);
  }, 60_000);
});

describe("sin decodificador reducido", () => {
  it("si la version reducida no se puede decodificar, la foto se ofrece igual (medidas reales, sin miniatura)", async () => {
    for (const reduceJpeg of [async () => null, async () => { throw new Error("sin createImageBitmap"); }]) {
      const result = await extractWith({ ...nodeExtractEnv, reduceJpeg }, jpeg.bytes);
      expect(result.warnings).toEqual([]);
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].thumb).toBeNull();
      expect(result.assets[0].pixel).toEqual({ width: BIG_WIDTH, height: BIG_HEIGHT, hasAlpha: false });
      expect(result.assets[0].formats).toEqual(["png", "jpg-original"]);
      expect(result.assets[0].kind).toBe("image");
    }
  });
});

describe("browserJpegReducer", () => {
  it("pide al navegador el JPEG YA reducido (resizeWidth/resizeHeight, sin orientacion EXIF ni gestion de color) y lo lee con un canvas", async () => {
    const calls: Array<{ options: Record<string, unknown>; blobType: string }> = [];
    const closed: number[] = [];
    const g = globalThis as Record<string, unknown>;
    const before = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
    g.createImageBitmap = async (blob: Blob, options: Record<string, unknown>) => {
      calls.push({ options, blobType: blob.type });
      return { width: Number(options.resizeWidth), height: Number(options.resizeHeight), close: () => closed.push(1) };
    };
    g.OffscreenCanvas = class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: () => {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }) };
      }
    };
    try {
      const { browserJpegReducer } = await import("./imagesPixels");
      const reduced = await browserJpegReducer(new Uint8Array([0xff, 0xd8, 1, 2]), { width: 8000, height: 5000 }, 1024);
      expect(calls).toHaveLength(1);
      expect(calls[0].blobType).toBe("image/jpeg");
      expect(calls[0].options).toEqual({ resizeWidth: 1024, resizeHeight: 640, resizeQuality: "medium", imageOrientation: "none", colorSpaceConversion: "none" });
      expect([reduced?.width, reduced?.height]).toEqual([1024, 640]);
      expect(reduced?.data.length).toBe(1024 * 640 * 4);
      expect(closed).toHaveLength(1);
      // Una imagen pequena no se agranda.
      const small = await browserJpegReducer(new Uint8Array([0xff, 0xd8]), { width: 300, height: 200 }, 1024);
      expect([small?.width, small?.height]).toEqual([300, 200]);
    } finally {
      g.createImageBitmap = before.createImageBitmap;
      g.OffscreenCanvas = before.OffscreenCanvas;
    }
  });
  it("sin createImageBitmap (o si falla) devuelve null y no rompe", async () => {
    const { browserJpegReducer } = await import("./imagesPixels");
    expect(await browserJpegReducer(new Uint8Array([0xff, 0xd8]), { width: 5000, height: 4000 }, 1024)).toBeNull();
    const g = globalThis as Record<string, unknown>;
    const before = g.createImageBitmap;
    g.createImageBitmap = async () => {
      throw new Error("decode");
    };
    try {
      expect(await browserJpegReducer(new Uint8Array([0xff, 0xd8]), { width: 5000, height: 4000 }, 1024)).toBeNull();
    } finally {
      g.createImageBitmap = before;
    }
  });
});

describe("renderWith: los pixeles completos solo bajo demanda", () => {
  const pngOf = async (blob: Blob) => decodePng(new Uint8Array(await blob.arrayBuffer()));

  it.each([
    ["Flate RGB con predictor PNG (se envuelve el flujo: sin decodificar)", () => flatePng],
    ["Flate RGB sin predictor (en streaming)", () => flateRaw],
  ])("%s: el PNG sale a tamano completo y con los pixeles exactos", async (_name, get) => {
    const { env, opened } = spyEnv();
    const { assets } = await extractWith(env, get().bytes);
    const before = opened.length;
    const png = await renderWith(env, get().bytes, assets[0], "png");
    // Para el PNG de un Flate no se abre NINGUN documento con pdf.js.
    expect(opened.length).toBe(before);
    expect(png.type).toBe("image/png");
    const decoded = await pngOf(png);
    expect([decoded.width, decoded.height]).toEqual([BIG_WIDTH, BIG_HEIGHT]);
    for (const [x, y] of [[0, 0], [BIG_WIDTH - 1, BIG_HEIGHT - 1], [2000, 1500], [123, 2900]]) {
      expect([...decoded.data.subarray((y * BIG_WIDTH + x) * 4, (y * BIG_WIDTH + x) * 4 + 3)], `${x},${y}`).toEqual(gradientPixel(x, y));
    }
    await releaseRenderDocument();
  }, 60_000);

  it("JPEG: el PNG se regenera (en Node, sin createImageBitmap, abriendo una copia donde SOLO esa imagen es real) con las medidas completas", async () => {
    const { env, opened } = spyEnv();
    const { assets } = await extractWith(env, jpeg.bytes);
    const png = await renderWith(env, jpeg.bytes, assets[0], "png");
    // La ultima apertura es la copia con la imagen real (tiene el ancho completo), y la regeneracion es del tamano completo.
    expect(await imageWidthsIn(opened.at(-1)!)).toEqual([BIG_WIDTH]);
    const image = await loadImage(Buffer.from(await png.arrayBuffer()));
    expect([image.width, image.height]).toEqual([BIG_WIDTH, BIG_HEIGHT]);
    const canvas = createCanvas(BIG_WIDTH, BIG_HEIGHT);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const right = canvas.getContext("2d").getImageData(BIG_WIDTH - 2, 10, 1, 1).data;
    const left = canvas.getContext("2d").getImageData(1, 10, 1, 1).data;
    expect(right[0]).toBeGreaterThan(left[0] + 150);
    await releaseRenderDocument();
  }, 90_000);

  it("el JPG original se entrega tal cual (los mismos bytes del PDF, sin abrir pdf.js)", async () => {
    const { env, opened } = spyEnv();
    const { assets } = await extractWith(env, jpeg.bytes);
    const before = opened.length;
    const original = await renderWith(env, jpeg.bytes, assets[0], "jpg-original");
    expect(opened.length).toBe(before);
    expect(original.type).toBe("image/jpeg");
    const bytes = new Uint8Array(await original.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    const image = await loadImage(Buffer.from(bytes));
    expect(image.width).toBe(BIG_WIDTH);
  }, 60_000);

  it("una imagen pequena sigue yendo por el documento de siempre (sin tocar)", async () => {
    const small = await bigFlatePdf({ width: 400, height: 300, predictor: "png" });
    const { env } = spyEnv();
    const { assets } = await extractWith(env, small.bytes);
    expect(assets[0].pixel).toEqual({ width: 400, height: 300, hasAlpha: false });
    const png = await pngOf(await renderWith(env, small.bytes, assets[0], "png"));
    expect([...png.data.subarray(0, 3)]).toEqual(gradientPixel(0, 0, 400, 300));
    await releaseRenderDocument();
  });
});

describe("el elemento regenerado es el mismo que el buscado", () => {
  it("dos busquedas del mismo PDF dan el mismo id (huella de la version reducida)", async () => {
    const a = (await extractWith(nodeExtractEnv, flatePng.bytes)).assets.map((asset: ExtractedAsset) => asset.id);
    const b = (await extractWith(nodeExtractEnv, flatePng.bytes)).assets.map((asset: ExtractedAsset) => asset.id);
    expect(a).toEqual(b);
  });
});
