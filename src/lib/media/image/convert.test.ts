import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { readImageHeader } from "@/lib/image/prepareForPdf";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";
import {
  ImageConvertError,
  convertImages,
  errorCodeForFailures,
  packConvertedImages,
  precheckImage,
  type ConvertOptions,
  type ImageBackend,
  type RenderJob,
} from "@/lib/media/image/convert";
import { DESKTOP_LIMITS, IOS_LIMITS, type ConvertLimits } from "@/lib/media/image/sizing";
import { PdfError } from "@/lib/pdf/core";

/**
 * Motor del convertidor con un backend de mentira: comprueba QUE se decide (que se omite, a que tamano se pide, como se
 * llaman las salidas, que sale en el ZIP) sin lienzo de navegador. La decodificacion/codificacion real se prueba en el E2E.
 */

function pngFile(name: string, width: number, height: number): File {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#336699";
  context.fillRect(0, 0, width, height);
  return new File([new Uint8Array(canvas.toBuffer("image/png"))], name, { type: "image/png" });
}

function jpegFile(name: string, width: number, height: number): File {
  return new File([new Uint8Array(makeSyntheticJpeg({ width, height, seed: 5, quality: 85 }))], name, { type: "image/jpeg" });
}

/** Backend que lee las dimensiones de la cabecera y entrega `bytesPerPixel` bytes por pixel de salida. */
function fakeBackend(options: { bytesPerPixel?: number; fail?: Record<string, ImageConvertError | Error> } = {}) {
  const calls: Array<{ name: string; job: RenderJob }> = [];
  const backend: ImageBackend = {
    async render(file, job) {
      const name = (file as File).name;
      calls.push({ name, job });
      const failure = options.fail?.[name];
      if (failure) throw failure;
      const header = readImageHeader(new Uint8Array(await file.arrayBuffer()));
      const sourceWidth = header.displayWidth ?? 10;
      const sourceHeight = header.displayHeight ?? 10;
      const size = job.planSize({ width: sourceWidth, height: sourceHeight });
      const bytes = Math.max(1, Math.round(size.width * size.height * (options.bytesPerPixel ?? 0.1)));
      return { blob: new Blob([new Uint8Array(bytes)], { type: "image/x-fake" }), sourceWidth, sourceHeight, width: size.width, height: size.height, capped: size.capped };
    },
  };
  return { backend, calls };
}

const BASE: ConvertOptions = { format: "jpeg", quality: 80, resize: { mode: "original" }, background: "#ffffff", suffix: "convertida" };

describe("convertImages", () => {
  it("convierte cada imagen, pone el nombre con sufijo y suma los pesos", async () => {
    const { backend } = fakeBackend({ bytesPerPixel: 0.5 });
    const files = [pngFile("uno.png", 40, 30), jpegFile("dos.jpg", 64, 48)];
    const outcome = await convertImages(files, BASE, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.failures).toEqual([]);
    expect(outcome.items.map((item) => item.outputName)).toEqual(["uno-convertida.jpg", "dos-convertida.jpg"]);
    expect(outcome.items.map((item) => [item.width, item.height])).toEqual([[40, 30], [64, 48]]);
    expect(outcome.items.every((item) => !item.resized && !item.capped)).toBe(true);
    expect(outcome.sourceBytes).toBe(files[0].size + files[1].size);
    expect(outcome.outputBytes).toBe(outcome.items[0].blob.size + outcome.items[1].blob.size);
  });

  it("pide al backend el formato, la calidad 0-1 y el fondo SOLO si el formato no guarda transparencia", async () => {
    const { backend, calls } = fakeBackend();
    const file = pngFile("a.png", 20, 20);
    await convertImages([file], { ...BASE, format: "jpeg", quality: 70, background: "#ff0000" }, { backend, limits: DESKTOP_LIMITS });
    await convertImages([file], { ...BASE, format: "png" }, { backend, limits: DESKTOP_LIMITS });
    await convertImages([file], { ...BASE, format: "bmp", background: "#00ff00" }, { backend, limits: DESKTOP_LIMITS });
    expect(calls.map((call) => [call.job.format, call.job.quality, call.job.flatten])).toEqual([
      ["jpeg", 0.7, "#ff0000"],
      ["png", 0.8, null],
      ["bmp", 0.8, "#00ff00"],
    ]);
  });

  it("el tamano de salida respeta el ancho maximo sin ampliar", async () => {
    const { backend } = fakeBackend();
    const files = [pngFile("grande.png", 400, 200), pngFile("pequena.png", 100, 50)];
    const outcome = await convertImages(files, { ...BASE, resize: { mode: "maxWidth", maxWidth: 200 } }, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.items.map((item) => [item.width, item.height, item.resized])).toEqual([[200, 100, true], [100, 50, false]]);
  });

  it("avisa (`capped`) cuando el limite del dispositivo reduce mas de lo pedido", async () => {
    const tiny: ConvertLimits = { ...DESKTOP_LIMITS, maxCanvasPixels: 1000, maxCanvasSide: 100 };
    const { backend } = fakeBackend();
    const outcome = await convertImages([pngFile("a.png", 100, 100)], BASE, { backend, limits: tiny });
    expect(outcome.items[0].capped).toBe(true);
    expect(outcome.items[0].width * outcome.items[0].height).toBeLessThanOrEqual(1000);
  });

  it("una imagen mala no detiene a las demas y queda nombrada con su motivo y su posicion", async () => {
    const { backend, calls } = fakeBackend();
    const files = [
      pngFile("buena.png", 30, 30),
      new File([new Uint8Array(0)], "vacia.png", { type: "image/png" }),
      new File([new TextEncoder().encode("esto es texto")], "texto.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array(jpegFile("x.jpg", 80, 60).size)], "ceros.jpg", { type: "image/jpeg" }),
      jpegFile("otra.jpg", 50, 50),
    ];
    const outcome = await convertImages(files, BASE, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.items.map((item) => item.sourceName)).toEqual(["buena.png", "otra.jpg"]);
    expect(outcome.failures).toEqual([
      { sourceName: "vacia.png", index: 1, problem: "empty" },
      { sourceName: "texto.jpg", index: 2, problem: "notImage" },
      { sourceName: "ceros.jpg", index: 3, problem: "notImage" },
    ]);
    // Lo que se descarta antes de decodificar ni siquiera llega al backend.
    expect(calls.map((call) => call.name)).toEqual(["buena.png", "otra.jpg"]);
  });

  it("un JPEG cortado a medias se rechaza como incompleto (los navegadores lo abririan con la parte de abajo gris)", async () => {
    const full = makeSyntheticJpeg({ width: 200, height: 150, seed: 2, quality: 90 });
    const cut = new File([new Uint8Array(full).slice(0, Math.floor(full.length * 0.6))], "cortada.jpg", { type: "image/jpeg" });
    const { backend } = fakeBackend();
    const outcome = await convertImages([cut], BASE, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.items).toEqual([]);
    expect(outcome.failures).toEqual([{ sourceName: "cortada.jpg", index: 0, problem: "truncated" }]);
  });

  it("limites: peso, pixeles de entrada y memoria de la tanda", async () => {
    const { backend, calls } = fakeBackend({ bytesPerPixel: 1 });
    const files = [pngFile("a.png", 60, 60), pngFile("b.png", 60, 60), pngFile("c.png", 60, 60)];
    const heavy: ConvertLimits = { ...DESKTOP_LIMITS, maxFileBytes: files[0].size - 1 };
    expect((await convertImages(files, BASE, { backend, limits: heavy })).failures.map((failure) => failure.problem)).toEqual(["tooBig", "tooBig", "tooBig"]);
    const wide: ConvertLimits = { ...DESKTOP_LIMITS, maxInputPixels: 3000 };
    expect((await convertImages(files, BASE, { backend, limits: wide })).failures.map((failure) => failure.problem)).toEqual(["tooManyPixels", "tooManyPixels", "tooManyPixels"]);
    expect(calls).toHaveLength(0);
    // La primera salida (3600 B) llena el presupuesto de 1000 B: las siguientes se quedan fuera con su motivo.
    const small: ConvertLimits = { ...DESKTOP_LIMITS, maxBatchOutputBytes: 1000 };
    const outcome = await convertImages(files, BASE, { backend, limits: small });
    expect(outcome.items.map((item) => item.sourceName)).toEqual(["a.png"]);
    expect(outcome.failures.map((failure) => [failure.sourceName, failure.problem])).toEqual([["b.png", "batchFull"], ["c.png", "batchFull"]]);
  });

  it("los limites de iPhone/iPad son mas estrictos que los de escritorio", async () => {
    const { backend } = fakeBackend();
    const file = pngFile("a.png", 30, 30);
    const outcome = await convertImages([file], BASE, { backend, limits: { ...IOS_LIMITS, maxInputPixels: 100 } });
    expect(outcome.failures[0].problem).toBe("tooManyPixels");
  });

  it("los errores del backend se traducen: ilegible, HEIC que el navegador no abre, no pudo codificar, error raro", async () => {
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63])], "iphone.heic", { type: "image/heic" });
    const { backend } = fakeBackend({
      fail: {
        "iphone.heic": new ImageConvertError("unreadable"),
        "rota.png": new ImageConvertError("unreadable"),
        "no-codifica.png": new ImageConvertError("encodeFailed"),
        "rara.png": new Error("boom"),
      },
    });
    const files = [heic, pngFile("rota.png", 10, 10), pngFile("no-codifica.png", 10, 10), pngFile("rara.png", 10, 10)];
    const outcome = await convertImages(files, BASE, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.failures.map((failure) => [failure.sourceName, failure.problem])).toEqual([
      ["iphone.heic", "heic"],
      ["rota.png", "unreadable"],
      ["no-codifica.png", "encodeFailed"],
      ["rara.png", "unreadable"],
    ]);
  });

  it("dos entradas con el mismo nombre base no se pisan en la salida", async () => {
    const { backend } = fakeBackend();
    const files = [pngFile("foto.png", 20, 20), jpegFile("foto.jpg", 20, 20), pngFile("FOTO.png", 20, 20)];
    const outcome = await convertImages(files, BASE, { backend, limits: DESKTOP_LIMITS });
    expect(outcome.items.map((item) => item.outputName)).toEqual(["foto-convertida.jpg", "foto-convertida (2).jpg", "FOTO-convertida (3).jpg"]);
  });

  it("informa del progreso por archivo y cede el hilo entre archivos", async () => {
    const { backend } = fakeBackend();
    const progress: number[] = [];
    const starts: Array<[number, number]> = [];
    const yielded = vi.fn(async () => {});
    await convertImages([pngFile("a.png", 10, 10), pngFile("b.png", 10, 10)], BASE, {
      backend,
      limits: DESKTOP_LIMITS,
      onProgress: (value) => progress.push(value),
      onFileStart: (n, total) => starts.push([n, total]),
      yieldToMain: yielded,
    });
    expect(progress).toEqual([0.5, 1]);
    expect(starts).toEqual([[1, 2], [2, 2]]);
    expect(yielded).toHaveBeenCalledTimes(2);
  });

  it("cancelar corta la tanda con el codigo de cancelacion y no convierte el resto", async () => {
    const controller = new AbortController();
    const { backend, calls } = fakeBackend();
    const promise = convertImages([pngFile("a.png", 10, 10), pngFile("b.png", 10, 10)], BASE, {
      backend,
      limits: DESKTOP_LIMITS,
      signal: controller.signal,
      onFileStart: (n) => {
        if (n === 2) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(calls.map((call) => call.name)).toEqual(["a.png"]);
  });

  it("una cancelacion que llega desde el backend tambien se convierte en cancelacion, no en un fallo de la imagen", async () => {
    const { backend } = fakeBackend({ fail: { "a.png": new PdfError("cancelled") } });
    await expect(convertImages([pngFile("a.png", 10, 10)], BASE, { backend, limits: DESKTOP_LIMITS })).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("precheckImage", () => {
  it("acepta una imagen entera y rechaza lo que no se puede intentar", async () => {
    expect(await precheckImage(pngFile("a.png", 20, 20), DESKTOP_LIMITS)).toBeNull();
    expect(await precheckImage(new Blob([]), DESKTOP_LIMITS)).toBe("empty");
    expect(await precheckImage(new Blob(["hola"]), DESKTOP_LIMITS)).toBe("notImage");
  });
});

describe("packConvertedImages", () => {
  it("una sola imagen sale como archivo directo", async () => {
    const { backend } = fakeBackend();
    const { items } = await convertImages([pngFile("sola.png", 20, 20)], BASE, { backend, limits: DESKTOP_LIMITS });
    const packed = await packConvertedImages(items, "imagenes-convertidas", "jpeg");
    expect(packed.kind).toBe("file");
    expect(packed.filename).toBe("sola-convertida.jpg");
    expect(packed.blob).toBe(items[0].blob);
  });

  it("varias salen en un ZIP con un archivo por imagen y sus nombres", async () => {
    const { backend } = fakeBackend({ bytesPerPixel: 1 });
    const { items } = await convertImages([pngFile("a.png", 12, 10), pngFile("a.jpg", 8, 8), jpegFile("b.jpg", 20, 20)], BASE, { backend, limits: DESKTOP_LIMITS });
    const packed = await packConvertedImages(items, "imagenes-convertidas", "jpeg");
    expect(packed.kind).toBe("zip");
    expect(packed.filename).toBe("imagenes-convertidas.zip");
    const zip = await JSZip.loadAsync(await packed.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["a-convertida (2).jpg", "a-convertida.jpg", "b-convertida.jpg"]);
    expect((await zip.files["a-convertida.jpg"].async("uint8array")).length).toBe(120);
    expect((await zip.files["b-convertida.jpg"].async("uint8array")).length).toBe(400);
  });

  it("sin imagenes convertidas no hay nada que empaquetar", async () => {
    await expect(packConvertedImages([], "x", "png")).rejects.toMatchObject({ code: "empty" });
  });
});

describe("errorCodeForFailures", () => {
  const failure = (problem: Parameters<typeof errorCodeForFailures>[0][number]["problem"]) => ({ sourceName: "x", index: 0, problem });
  it("elige el codigo general mas cercano al motivo", () => {
    expect(errorCodeForFailures([failure("notImage"), failure("notImage")])).toBe("invalidType");
    expect(errorCodeForFailures([failure("heic")])).toBe("invalidType");
    expect(errorCodeForFailures([failure("truncated"), failure("corrupt"), failure("empty")])).toBe("corrupt");
    expect(errorCodeForFailures([failure("tooBig"), failure("unreadable")])).toBe("unknown");
  });
});
