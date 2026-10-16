import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import {
  InkError,
  MAX_DECODE_PIXELS,
  MAX_INPUT_FILE_BYTES,
  MAX_WORK_PIXELS,
  VECTOR_LONG_SIDE,
  decodeImageFile,
  extractInk,
  planRasterSize,
  readImageSize,
  sniffImageFormat,
  type Rasterizer,
} from "./inkExtract";
import { composePhoto, drawSignature, nodeRasterizer, toJpegFile, toPngFile } from "./inkTestUtils";

/**
 * `decodeImageFile`: formato por los primeros bytes, tamano leido de la CABECERA (sin decodificar), topes y errores con
 * codigo estable. El rasterizado real del navegador se prueba en `e2e/specs/ink-extract.spec.ts`; aqui se usa el de Node.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="150" viewBox="0 0 400 150"><path d="M20 100 C 80 20, 140 20, 200 90 S 320 130, 380 40" stroke="#000" stroke-width="5" fill="none" stroke-linecap="round"/></svg>`;

function bytesOf(file: Blob): Promise<Uint8Array> {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const photo = () => composePhoto(drawSignature({ width: 300, height: 120, lineWidth: 3 }), { ink: { r: 0, g: 0, b: 0 } });

describe("sniffImageFormat", () => {
  it("reconoce cada formato por sus bytes, no por el nombre ni el tipo", async () => {
    const png = await bytesOf(toPngFile(photo(), "a.txt"));
    const jpeg = await bytesOf(toJpegFile(photo(), 60, "a.png"));
    expect(sniffImageFormat(png)).toBe("png");
    expect(sniffImageFormat(jpeg)).toBe("jpeg");
    const webpCanvas = createCanvas(40, 20);
    webpCanvas.getContext("2d").fillRect(0, 0, 10, 10);
    expect(sniffImageFormat(new Uint8Array(webpCanvas.toBuffer("image/webp", 80)))).toBe("webp");
    expect(sniffImageFormat(new TextEncoder().encode(SVG))).toBe("svg");
    expect(sniffImageFormat(new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- hola -->\n<!DOCTYPE svg PUBLIC "x" "y">\n${SVG}`))).toBe("svg");
    expect(sniffImageFormat(new TextEncoder().encode(`﻿  ${SVG}`))).toBe("svg");
    const heic = new Uint8Array(24);
    heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(sniffImageFormat(heic)).toBe("heic");
  });

  it("rechaza lo que no es imagen o no esta admitido (PDF, HTML, texto, GIF, AVIF, vacio)", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(sniffImageFormat(text("%PDF-1.7\n"))).toBeNull();
    expect(sniffImageFormat(text("<html><body><svg></svg></body></html>"))).toBeNull();
    expect(sniffImageFormat(text("hola mundo"))).toBeNull();
    expect(sniffImageFormat(text("GIF89a......"))).toBeNull();
    const avif = new Uint8Array(24);
    avif.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    expect(sniffImageFormat(avif)).toBeNull();
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("readImageSize (solo la cabecera)", () => {
  it("PNG y JPEG reales", async () => {
    expect(readImageSize(await bytesOf(toPngFile(photo())), "png")).toEqual({ width: 300, height: 120 });
    expect(readImageSize(await bytesOf(toJpegFile(photo())), "jpeg")).toEqual({ width: 300, height: 120 });
  });

  it("WEBP lossy (real), lossless y extendido (cabeceras escritas a mano)", () => {
    const canvas = createCanvas(40, 20);
    canvas.getContext("2d").fillRect(0, 0, 10, 10);
    const lossy = new Uint8Array(canvas.toBuffer("image/webp", 80));
    expect(readImageSize(lossy, "webp")).toEqual({ width: 40, height: 20 });
    const lossless = new Uint8Array(32);
    lossless.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0, 0, 0, 0, 0x2f]);
    const bits = ((300 - 1) | ((120 - 1) << 14)) >>> 0;
    new DataView(lossless.buffer).setUint32(21, bits, true);
    expect(readImageSize(lossless, "webp")).toEqual({ width: 300, height: 120 });
    const extended = new Uint8Array(32);
    extended.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    extended.set([0x2b, 0x01, 0x00], 24); // 300 - 1
    extended.set([0x77, 0x00, 0x00], 27); // 120 - 1
    expect(readImageSize(extended, "webp")).toEqual({ width: 300, height: 120 });
  });

  it("SVG: width/height con unidades, solo viewBox, porcentajes y sin caja", () => {
    const size = (svg: string) => readImageSize(new TextEncoder().encode(svg), "svg");
    expect(size(SVG)).toEqual({ width: 400, height: 150 });
    expect(size(`<svg xmlns="x" width="12pt" height='6.5px'></svg>`)).toEqual({ width: 12, height: 6.5 });
    expect(size(`<svg xmlns="x" viewBox="0 0 80 40"></svg>`)).toEqual({ width: 80, height: 40 });
    expect(size(`<svg xmlns="x" width="200" viewBox="0, 0, 80, 40"></svg>`)).toEqual({ width: 200, height: 100 });
    expect(size(`<svg xmlns="x" height="40" viewBox="0 0 80 40"></svg>`)).toEqual({ width: 80, height: 40 });
    expect(size(`<svg xmlns="x" width="100%" height="100%"></svg>`)).toBeNull();
    expect(size(`<svg xmlns="x"></svg>`)).toBeNull();
    expect(size(`<svg xmlns="x" viewBox="0 0 0 0"></svg>`)).toBeNull();
  });

  it("HEIC: la mayor caja ispe", () => {
    const bytes = new Uint8Array(200);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const view = new DataView(bytes.buffer);
    const box = (at: number, width: number, height: number) => {
      bytes.set([0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0], at);
      view.setUint32(at + 12, width);
      view.setUint32(at + 16, height);
    };
    box(40, 160, 120); // miniatura
    box(100, 4032, 3024);
    expect(readImageSize(bytes, "heic")).toEqual({ width: 4032, height: 3024 });
    expect(readImageSize(new Uint8Array(40), "heic")).toBeNull();
  });
});

describe("planRasterSize", () => {
  it("un SVG se pide a 2000 px por el lado mayor; un raster pequeno, a su tamano", () => {
    expect(planRasterSize(400, 150, "svg")).toEqual({ width: VECTOR_LONG_SIDE, height: 750, downscaled: false });
    expect(planRasterSize(5000, 100, "svg")).toEqual({ width: 2000, height: 40, downscaled: false });
    expect(planRasterSize(300, 120, "png")).toEqual({ width: 300, height: 120, downscaled: false });
  });

  it("una foto de 48 MP se decodifica reducida a <= 16 MP conservando la proporcion", () => {
    const plan = planRasterSize(8064, 6048, "jpeg");
    expect(plan.downscaled).toBe(true);
    expect(plan.width * plan.height).toBeLessThanOrEqual(MAX_WORK_PIXELS * 1.001);
    expect(plan.width * plan.height).toBeGreaterThan(MAX_WORK_PIXELS * 0.99);
    expect(Math.abs(plan.width / plan.height - 8064 / 6048)).toBeLessThan(0.001);
    expect(planRasterSize(4000, 4000, "png").downscaled).toBe(false); // justo 16 MP
    expect(planRasterSize(4001, 4000, "png").downscaled).toBe(true);
  });
});

describe("decodeImageFile", () => {
  const options = { rasterizer: nodeRasterizer };

  it("PNG, JPG, WEBP y SVG se leen a pixeles RGBA", async () => {
    const png = await decodeImageFile(toPngFile(photo()), options);
    expect([png.format, png.width, png.height, png.originalWidth, png.originalHeight, png.downscaled]).toEqual(["png", 300, 120, 300, 120, false]);
    expect(png.data.length).toBe(300 * 120 * 4);
    const jpeg = await decodeImageFile(toJpegFile(photo()), options);
    expect([jpeg.format, jpeg.width, jpeg.height]).toEqual(["jpeg", 300, 120]);
    const canvas = createCanvas(64, 32);
    canvas.getContext("2d").fillRect(8, 8, 20, 4);
    const webp = await decodeImageFile(new File([new Uint8Array(canvas.toBuffer("image/webp", 90))], "x.webp"), options);
    expect([webp.format, webp.width, webp.height]).toEqual(["webp", 64, 32]);
    const svg = await decodeImageFile(new File([SVG], "firma.svg", { type: "image/svg+xml" }), options);
    expect([svg.format, svg.width, svg.height, svg.originalWidth, svg.originalHeight]).toEqual(["svg", 2000, 750, 400, 150]);
    expect(svg.downscaled).toBe(false);
  });

  it("SVG simple con un trazo: sale tinta (sin fondo) y la caja corresponde al trazo ampliado", async () => {
    const svg = await decodeImageFile(new File([SVG], "firma.svg"), options);
    // El SVG es transparente fuera del trazo: se compone sobre blanco y el motor encuentra el trazo.
    const result = extractInk(svg, { margin: 0 });
    expect(result.inkPixels).toBeGreaterThan(2000);
    // El trazo va de x=20 a x=380 (con su grosor), en una caja de 400 x 150 pintada a x5.
    expect(result.inkBounds.x).toBeGreaterThanOrEqual(80);
    expect(result.inkBounds.x).toBeLessThanOrEqual(110);
    expect(result.inkBounds.x + result.inkBounds.width).toBeGreaterThan(1850);
    expect(result.inkBounds.x + result.inkBounds.width).toBeLessThanOrEqual(1925);
  });

  it("el formato manda el contenido, no el nombre: un PNG llamado .txt se lee; un HTML llamado .png, no", async () => {
    const disguised = new File([await toPngFile(photo()).arrayBuffer()], "firma.txt", { type: "text/plain" });
    expect((await decodeImageFile(disguised, options)).format).toBe("png");
    const html = new File(["<html><body>hola</body></html>"], "firma.png", { type: "image/png" });
    await expect(decodeImageFile(html, options)).rejects.toMatchObject({ code: "unsupported-format" });
    await expect(decodeImageFile(new File(["%PDF-1.4"], "x.png"), options)).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it("archivo vacio y archivo de mas de 10 MB: error claro y NO se lee ni se decodifica", async () => {
    const rasterizer: Rasterizer = vi.fn();
    await expect(decodeImageFile(new Blob([]), { rasterizer })).rejects.toMatchObject({ code: "empty-file" });
    expect(MAX_INPUT_FILE_BYTES).toBe(10 * 1024 * 1024);
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]);
    await expect(decodeImageFile(big, { rasterizer })).rejects.toMatchObject({ code: "file-too-large" });
    expect(rasterizer).not.toHaveBeenCalled();
    // Justo 10 MB todavia se acepta (falla despues por no ser imagen, no por tamano).
    await expect(decodeImageFile(new Blob([new Uint8Array(10 * 1024 * 1024)]), { rasterizer })).rejects.toMatchObject({
      code: "unsupported-format",
    });
    await expect(decodeImageFile(null as unknown as Blob, { rasterizer })).rejects.toBeInstanceOf(InkError);
  });

  it("imagen enorme segun su CABECERA (30 000 x 30 000): se rechaza SIN decodificar", async () => {
    const rasterizer: Rasterizer = vi.fn();
    const bomb = new Blob([pngHeader(30_000, 30_000)]);
    expect(bomb.size).toBeLessThan(100);
    await expect(decodeImageFile(bomb, { rasterizer })).rejects.toMatchObject({ code: "too-many-pixels" });
    expect(rasterizer).not.toHaveBeenCalled();
    // 10 000 x 10 000 = justo 100 MP: aun se decodifica (reducido); 10 001 x 10 000 no.
    expect(10_000 * 10_000).toBe(MAX_DECODE_PIXELS);
    const ok: Rasterizer = vi.fn(async () => ({ image: { width: 2, height: 2, data: new Uint8ClampedArray(16) }, originalWidth: 10_000, originalHeight: 10_000 }));
    await expect(decodeImageFile(new Blob([pngHeader(10_000, 10_000)]), { rasterizer: ok })).resolves.toMatchObject({ downscaled: true });
    await expect(decodeImageFile(new Blob([pngHeader(10_001, 10_000)]), { rasterizer: ok })).rejects.toMatchObject({ code: "too-many-pixels" });
  });

  it("cabecera con dimension 0, o un rasterizador que devuelve basura: decode-failed", async () => {
    await expect(decodeImageFile(new Blob([pngHeader(0, 50)]), options)).rejects.toMatchObject({ code: "decode-failed" });
    const broken: Rasterizer = async () => ({ image: { width: 10, height: 10, data: new Uint8ClampedArray(3) }, originalWidth: 10, originalHeight: 10 });
    await expect(decodeImageFile(await toPngFile(photo()), { rasterizer: broken })).rejects.toMatchObject({ code: "decode-failed" });
  });

  it("sin APIs de navegador (Node): un PNG corrupto da decode-failed y un HEIC dice que no se puede abrir aqui", async () => {
    const corrupt = new Blob([pngHeader(40, 40), new Uint8Array(200)]);
    await expect(decodeImageFile(corrupt)).rejects.toMatchObject({ code: "decode-failed" });
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const error = await decodeImageFile(new Blob([heic])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InkError);
    expect((error as InkError).code).toBe("unsupported-format");
    expect((error as InkError).message).toMatch(/HEIC/);
  });
});
