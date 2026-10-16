import { PDFDocument } from "@cantoo/pdf-lib";
import { createCanvas, ImageData, loadImage } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_IMAGE_DIMENSION,
  isValidVaultImage,
  pngIhdrCrcValid,
  readPngSize,
} from "@/app/sign-pdf/signVault";
import { renderPages } from "@/lib/pdf/editRenderTestUtils";
import {
  InkError,
  MAX_OUTPUT_DIMENSION,
  MAX_PNG_BYTES,
  encodeInkPng,
  encodePng,
  encodePngBytes,
  extractInk,
  pngCrc32,
  type InkImage,
} from "./inkExtract";
import { NEAR_BLACK_FOR_TESTS, composePhoto, drawSignature, throughJpeg, WARM_PAPER } from "./inkTestUtils";

/**
 * Salida del motor: el PNG tiene que ser valido para el baul (`isValidVaultImage`, `pngIhdrCrcValid`), caber en sus
 * topes (4096 px, 600 KB), decodificarse a los MISMOS pixeles y poder estamparse en un PDF sin recuadro blanco.
 */

afterEach(() => vi.unstubAllGlobals());

function vaultImage(png: Uint8Array) {
  const size = readPngSize(png);
  expect(size).not.toBeNull();
  return { png, width: size!.width, height: size!.height, ratio: size!.width / size!.height };
}

async function decode(png: Uint8Array): Promise<InkImage> {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data: pixels.data };
}

function noise(width: number, height: number, mode: "rgb" | "alpha"): InkImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 12345;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24;
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = mode === "rgb" ? next() : 10;
    data[i * 4 + 1] = mode === "rgb" ? next() : 20;
    data[i * 4 + 2] = mode === "rgb" ? next() : 30;
    data[i * 4 + 3] = mode === "rgb" ? 255 : next();
  }
  return { width, height, data };
}

describe("los topes del baul se mantienen sincronizados", () => {
  it("MAX_PNG_BYTES y MAX_OUTPUT_DIMENSION son los de signVault.ts", () => {
    expect(MAX_PNG_BYTES).toBe(MAX_VAULT_IMAGE_BYTES);
    expect(MAX_PNG_BYTES).toBe(600 * 1024);
    expect(MAX_OUTPUT_DIMENSION).toBe(MAX_VAULT_IMAGE_DIMENSION);
    expect(MAX_OUTPUT_DIMENSION).toBe(4096);
  });
});

describe("encodePngBytes / encodePng", () => {
  it("el CRC propio coincide con el de PNG (valor conocido de «IEND»)", () => {
    expect(pngCrc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("PNG valido para el baul y decodifica a los mismos pixeles (alfa exacto, color donde hay tinta)", async () => {
    const truth = drawSignature({ width: 500, height: 180, lineWidth: 4 });
    const photo = composePhoto(truth, { ink: { r: 20, g: 40, b: 160 }, paper: WARM_PAPER, noise: 2 });
    const result = extractInk(photo);
    const blob = await encodePng(result);
    expect(blob.type).toBe("image/png");
    const png = new Uint8Array(await blob.arrayBuffer());
    expect(png.length).toBeLessThanOrEqual(MAX_VAULT_IMAGE_BYTES);
    expect(pngIhdrCrcValid(png)).toBe(true);
    expect(isValidVaultImage(vaultImage(png))).toBe(true);
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const back = await decode(png);
    expect([back.width, back.height]).toEqual([result.image.width, result.image.height]);
    let colorError = 0;
    let colored = 0;
    for (let i = 0; i < back.width * back.height; i += 1) {
      expect(back.data[i * 4 + 3]).toBe(result.image.data[i * 4 + 3]);
      if (result.image.data[i * 4 + 3] === 255) {
        colorError += Math.abs(back.data[i * 4 + 2] - result.image.data[i * 4 + 2]);
        colored += 1;
      }
    }
    expect(colored).toBeGreaterThan(100);
    expect(colorError).toBe(0);
  });

  it("una imagen suave (degradados que favorecen cada filtro de fila) se decodifica EXACTA", async () => {
    const width = 160;
    const height = 90;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = (x * 255) / width;
        data[i + 1] = (y * 255) / height + (x % 7);
        data[i + 2] = 128 + 100 * Math.sin((x + y) / 9);
        data[i + 3] = 255;
      }
    }
    // Filas con bandas verticales y horizontales para que gane cada filtro en alguna fila.
    for (let x = 0; x < width; x += 1) data[(10 * width + x) * 4] = x % 2 ? 250 : 5;
    for (let y = 40; y < 60; y += 1) for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 1] = 77;
    const png = await encodePngBytes({ width, height, data });
    const back = await decode(png);
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
  });

  it("es determinista: mismos pixeles, mismos bytes", async () => {
    const image = extractInk(composePhoto(drawSignature({ width: 300, height: 120, lineWidth: 3 }), { ink: NEAR_BLACK_FOR_TESTS })).image;
    const a = await encodePngBytes(image);
    const b = await encodePngBytes(image);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("un PNG corrupto en el IHDR no pasa el validador (la prueba del validador es real)", async () => {
    const image = extractInk(composePhoto(drawSignature({ width: 300, height: 120, lineWidth: 3 }), { ink: NEAR_BLACK_FOR_TESTS })).image;
    const png = await encodePngBytes(image);
    const broken = png.slice();
    broken[20] ^= 0x01;
    expect(pngIhdrCrcValid(png)).toBe(true);
    expect(pngIhdrCrcValid(broken)).toBe(false);
  });

  it("una imagen de 1 x 1 y una de 4096 x 1 se codifican", async () => {
    for (const [w, h] of [[1, 1], [4096, 1], [1, 300]]) {
      const data = new Uint8ClampedArray(w * h * 4);
      data.set([5, 6, 7, 255], 0);
      const png = await encodePngBytes({ width: w, height: h, data });
      expect(readPngSize(png)).toEqual({ width: w, height: h });
      expect(Array.from((await decode(png)).data.slice(0, 4))).toEqual([5, 6, 7, 255]);
    }
  });

  it("el PNG se estampa en un PDF y SIN recuadro blanco: el fondo del PDF se ve a traves de la firma", async () => {
    const truth = drawSignature({ width: 600, height: 220, lineWidth: 5 });
    const photo = composePhoto(truth, { ink: { r: 10, g: 10, b: 40 }, paper: WARM_PAPER, noise: 2 });
    const blob = await encodePng(extractInk(photo, { ink: "black" }));
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 140]);
    page.drawRectangle({ x: 0, y: 0, width: 300, height: 140, color: (await import("@cantoo/pdf-lib")).rgb(0.85, 0.9, 1) });
    const embedded = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
    page.drawImage(embedded, { x: 20, y: 20, width: 260, height: 100 });
    const [raster] = await renderPages(await doc.save(), 2);
    const at = (x: number, y: number) => {
      const i = (y * raster.width + x) * 4;
      return [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
    };
    // Esquina interior del recuadro de la imagen, que en la foto era papel blanco: tiene que seguir siendo el azul claro del PDF.
    const [r, g, b] = at(2 * 20 + 6, 2 * 20 + 6);
    expect(Math.abs(r - 217)).toBeLessThanOrEqual(3);
    expect(Math.abs(g - 230)).toBeLessThanOrEqual(3);
    expect(Math.abs(b - 255)).toBeLessThanOrEqual(3);
    // Y alguna zona oscura (la firma) si hay.
    let dark = 0;
    for (let i = 0; i < raster.width * raster.height; i += 1) if (raster.data[i * 4] < 60) dark += 1;
    expect(dark).toBeGreaterThan(300);
  });
});

describe("encodeInkPng · escalera de tamano", () => {
  it("una firma normal cabe sin perdida", async () => {
    const image = extractInk(composePhoto(drawSignature({ width: 900, height: 300, lineWidth: 4 }), { ink: NEAR_BLACK_FOR_TESTS, noise: 2 })).image;
    const encoded = await encodeInkPng(image);
    expect(encoded.quantization).toBe("lossless");
    expect(encoded.scale).toBe(1);
    expect(encoded.bytes.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
  });

  it("si el color con ruido no cabe, cuantiza a 5 bits (560 x 400) y, si no, a 3 (800 x 400) antes de tocar el tamano", async () => {
    const middling = noise(560, 400, "rgb");
    expect((await encodePngBytes(middling)).length).toBeGreaterThan(MAX_PNG_BYTES);
    const five = await encodeInkPng(middling);
    expect(five.quantization).toBe("rgb5");
    expect(five.bytes.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
    expect((await decode(five.bytes)).data[0] & 0x07).toBe(0);
    const image = noise(800, 400, "rgb");
    const encoded = await encodeInkPng(image);
    expect((await encodePngBytes(image)).length).toBeGreaterThan(MAX_PNG_BYTES);
    expect(encoded.quantization).toBe("rgb3");
    expect([encoded.width, encoded.height]).toEqual([800, 400]);
    expect(encoded.bytes.length).toBeLessThanOrEqual(MAX_PNG_BYTES);
    expect(pngIhdrCrcValid(encoded.bytes)).toBe(true);
    const back = await decode(encoded.bytes);
    expect(back.data[0] & 0x1f).toBe(0); // 3 bits: los 5 bajos a cero
  });

  it("cuantizar o aplanar el color NUNCA toca el alfa (es el antialias de los bordes)", async () => {
    const width = 500;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    let state = 99;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24;
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = next();
      data[i * 4 + 1] = next();
      data[i * 4 + 2] = next();
      data[i * 4 + 3] = 1 + (next() % 254);
    }
    const encoded = await encodeInkPng({ width, height, data });
    expect(encoded.quantization).not.toBe("lossless");
    const back = await decode(encoded.bytes);
    let different = 0;
    for (let i = 0; i < width * height; i += 1) if (back.data[i * 4 + 3] !== data[i * 4 + 3]) different += 1;
    expect(different).toBe(0);
  });

  it("con un tope de bytes bajo, aplana el color y, si ni asi, reduce el tamano (alfa aleatorio = incompresible)", async () => {
    const image = noise(500, 300, "alpha");
    const flat = await encodeInkPng(image, { maxBytes: 600 * 1024 });
    expect(flat.quantization).toBe("lossless");
    const encoded = await encodeInkPng(image, { maxBytes: 40_000 });
    expect(encoded.scale).toBeLessThan(1);
    expect(encoded.width).toBeLessThan(500);
    expect(encoded.bytes.length).toBeLessThanOrEqual(40_000);
    expect(readPngSize(encoded.bytes)).toEqual({ width: encoded.width, height: encoded.height });
    expect(encoded.width / encoded.height).toBeCloseTo(500 / 300, 1);
    await expect(encodeInkPng(image, { maxBytes: 20 })).rejects.toMatchObject({ code: "encode-failed" });
  });

  it("nunca produce mas de 4096 px por lado, aunque se le pase una imagen mas grande", async () => {
    const data = new Uint8ClampedArray(6000 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data[i + 3] = (i / 4) % 7 === 0 ? 255 : 0;
    const encoded = await encodeInkPng({ width: 6000, height: 40, data });
    expect(encoded.width).toBe(4096);
    expect(encoded.height).toBe(Math.round(40 * (4096 / 6000)));
    expect(isValidVaultImage(vaultImage(encoded.bytes))).toBe(true);
    const custom = await encodeInkPng({ width: 6000, height: 40, data }, { maxDimension: 1000 });
    expect(custom.width).toBe(1000);
  });
});

describe("sin CompressionStream", () => {
  it("cae al PNG del canvas (con la limitacion de tamano) y respeta el tope de dimension", async () => {
    class FakeCanvas {
      private readonly canvas;
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        this.canvas = createCanvas(width, height);
      }
      getContext() {
        const context = this.canvas.getContext("2d");
        return { putImageData: (data: unknown) => context.putImageData(data as never, 0, 0) };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(this.canvas.toBuffer("image/png"))], { type: "image/png" });
      }
    }
    vi.stubGlobal("CompressionStream", undefined);
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    vi.stubGlobal("ImageData", ImageData);
    const data = new Uint8ClampedArray(5000 * 10 * 4);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const encoded = await encodeInkPng({ width: 5000, height: 10, data });
    expect(encoded.width).toBe(4096);
    expect(pngIhdrCrcValid(encoded.bytes)).toBe(true);
    await expect(encodePngBytes({ width: 2, height: 2, data: new Uint8ClampedArray(16) })).rejects.toBeInstanceOf(InkError);
  });
});

describe("integracion JPEG real -> PNG del baul", () => {
  it("JPEG q35 sobre papel calido: PNG valido, <= 600 KB y <= 4096", async () => {
    const truth = drawSignature({ width: 1200, height: 400, lineWidth: 5 });
    const jpeg = await throughJpeg(composePhoto(truth, { ink: { r: 20, g: 40, b: 160 }, paper: WARM_PAPER, noise: 3 }), 35);
    const png = new Uint8Array(await (await encodePng(extractInk(jpeg))).arrayBuffer());
    expect(png.length).toBeLessThanOrEqual(MAX_VAULT_IMAGE_BYTES);
    expect(isValidVaultImage(vaultImage(png))).toBe(true);
    expect(pngIhdrCrcValid(png)).toBe(true);
  });
});
