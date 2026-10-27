import { afterEach, describe, expect, it, vi } from "vitest";
import { buildThumbnail } from "@/lib/image/thumbnailCore";
import { makeSyntheticJpeg } from "@/lib/image/photoTestUtils";

const blobOf = (bytes: Uint8Array | Buffer): Blob => new Blob([new Uint8Array(bytes)]);

afterEach(() => vi.unstubAllGlobals());

describe("buildThumbnail: comprobacion + miniatura", () => {
  it("una foto con basura, un texto o un JPEG cortado se rechazan POR ESTRUCTURA, sin intentar decodificarlas", async () => {
    const decoder = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
    const jpeg = new Uint8Array(makeSyntheticJpeg({ width: 400, height: 300, seed: 5 }));
    expect((await buildThumbnail(blobOf(new TextEncoder().encode("texto ".repeat(100))))).problem).toBe("notImage");
    expect((await buildThumbnail(blobOf(jpeg.subarray(0, jpeg.length >> 1)))).problem).toBe("truncated");
    expect((await buildThumbnail(blobOf(new Uint8Array(0)))).problem).toBe("empty");
    expect(decoder).not.toHaveBeenCalled();
  });

  it("una foto buena se decodifica YA reducida (resizeWidth al lado largo) y sale sin problema", async () => {
    const jpeg = new Uint8Array(makeSyntheticJpeg({ width: 800, height: 600, seed: 6 }));
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("createImageBitmap", async (_source: Blob, options: Record<string, unknown>) => {
      seen.push(options);
      throw new Error("sin lienzo en Node");
    });
    const outcome = await buildThumbnail(blobOf(jpeg));
    expect(outcome).toEqual({ blob: null, problem: null, heic: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ imageOrientation: "from-image", resizeWidth: 360, resizeQuality: "medium" });
  });

  it("una foto vertical se pide ya con el ancho que da 360 px de lado largo (sin segundo reescalado)", async () => {
    const jpeg = new Uint8Array(makeSyntheticJpeg({ width: 600, height: 800, seed: 7 }));
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("createImageBitmap", async (_source: Blob, options: Record<string, unknown>) => {
      seen.push(options);
      throw new Error("x");
    });
    await buildThumbnail(blobOf(jpeg));
    expect(seen[0].resizeWidth).toBe(270);
  });

  it("una foto mas pequena que la miniatura no se amplia", async () => {
    const jpeg = new Uint8Array(makeSyntheticJpeg({ width: 200, height: 100, seed: 8 }));
    const seen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("createImageBitmap", async (_source: Blob, options: Record<string, unknown>) => {
      seen.push(options);
      throw new Error("x");
    });
    await buildThumbnail(blobOf(jpeg));
    expect(seen[0].resizeWidth).toBeUndefined();
  });

  it("reconoce HEIC por los bytes (ftyp heic) para poder decir que este navegador no lo abre", async () => {
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24], 0);
    heic.set(new TextEncoder().encode("ftypheic"), 4);
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("no soportado");
    });
    expect(await buildThumbnail(blobOf(heic))).toEqual({ blob: null, problem: null, heic: true });
  });

  it("cede el hilo entre pasos cuando se le pide (respaldo del hilo principal)", async () => {
    const pause = vi.fn(async () => {});
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("x");
    });
    await buildThumbnail(blobOf(new Uint8Array(makeSyntheticJpeg({ width: 100, height: 100, seed: 9 }))), 360, pause);
    expect(pause).toHaveBeenCalledTimes(2);
  });
});
