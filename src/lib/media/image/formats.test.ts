import { describe, expect, it } from "vitest";
import {
  BASELINE_SUPPORT,
  OUTPUT_FORMATS,
  OUTPUT_FORMAT_INFO,
  isOutputFormat,
  needsBackground,
  qualityToUnit,
  resolveFormat,
  splitFormats,
  type OutputSupport,
} from "@/lib/media/image/formats";

describe("formatos de salida", () => {
  it("cada formato tiene su tipo MIME y su extension, y solo JPG y BMP piden color de fondo", () => {
    expect(OUTPUT_FORMATS.map((format) => OUTPUT_FORMAT_INFO[format].extension)).toEqual(["jpg", "png", "webp", "avif", "bmp"]);
    expect(OUTPUT_FORMATS.map((format) => OUTPUT_FORMAT_INFO[format].mime)).toEqual(["image/jpeg", "image/png", "image/webp", "image/avif", "image/bmp"]);
    expect(OUTPUT_FORMATS.filter(needsBackground)).toEqual(["jpeg", "bmp"]);
    expect(OUTPUT_FORMATS.filter((format) => OUTPUT_FORMAT_INFO[format].lossy)).toEqual(["jpeg", "webp", "avif"]);
  });

  it("isOutputFormat solo da por buenos los formatos conocidos", () => {
    expect(isOutputFormat("webp")).toBe(true);
    expect(isOutputFormat("gif")).toBe(false);
    expect(isOutputFormat(undefined)).toBe(false);
  });

  it("la base segura ofrece JPG, PNG y BMP y deja fuera WebP y AVIF hasta probarlos", () => {
    expect(splitFormats(BASELINE_SUPPORT)).toEqual({ available: ["jpeg", "png", "bmp"], unavailable: ["webp", "avif"] });
  });

  it("un navegador que crea WebP lo ofrece; el que no crea AVIF lo deja en los no disponibles, en orden estable", () => {
    const support: OutputSupport = { ...BASELINE_SUPPORT, webp: true };
    expect(splitFormats(support)).toEqual({ available: ["jpeg", "png", "webp", "bmp"], unavailable: ["avif"] });
  });

  it("resolveFormat conserva lo pedido si se puede y, si no, cae al primero disponible", () => {
    expect(resolveFormat("png", BASELINE_SUPPORT)).toBe("png");
    expect(resolveFormat("avif", BASELINE_SUPPORT)).toBe("jpeg");
    expect(resolveFormat("webp", { jpeg: false, png: true, webp: false, avif: false, bmp: true })).toBe("png");
  });

  it("la calidad 1-100 pasa a 0-1 y un valor absurdo no rompe la codificacion", () => {
    expect(qualityToUnit(90)).toBeCloseTo(0.9);
    expect(qualityToUnit(100)).toBe(1);
    expect(qualityToUnit(0)).toBe(0.01);
    expect(qualityToUnit(250)).toBe(1);
    expect(qualityToUnit(Number.NaN)).toBe(0.9);
  });
});
