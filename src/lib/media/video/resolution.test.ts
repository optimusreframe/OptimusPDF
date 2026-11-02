import { describe, expect, it } from "vitest";
import { availableResolutions, fitResolution, toEven } from "@/lib/media/video/resolution";

describe("fitResolution", () => {
  it("720p sobre 1920x1080 da 1280x720 (el lado corto manda)", () => {
    expect(fitResolution(1920, 1080, "720p")).toEqual({ width: 1280, height: 720, scaled: true });
  });

  it("un video vertical de movil (1080x1920) a 720p sale 720x1280, no 405x720", () => {
    expect(fitResolution(1080, 1920, "720p")).toEqual({ width: 720, height: 1280, scaled: true });
  });

  it("nunca amplia: pedir 1080p sobre 1280x720 deja el original", () => {
    expect(fitResolution(1280, 720, "1080p")).toEqual({ width: 1280, height: 720, scaled: false });
    expect(fitResolution(1280, 720, "720p")).toEqual({ width: 1280, height: 720, scaled: false });
  });

  it("«original» no toca nada, ni siquiera medidas impares", () => {
    expect(fitResolution(1081, 721, "original")).toEqual({ width: 1081, height: 721, scaled: false });
  });

  it("conserva la proporcion y da lados pares (4:3, 21:9, cuadrado)", () => {
    for (const [w, h] of [[1440, 1080], [2560, 1080], [1080, 1080], [1366, 768], [3840, 2160]] as const) {
      const out = fitResolution(w, h, "480p");
      expect(out.width % 2).toBe(0);
      expect(out.height % 2).toBe(0);
      expect(Math.min(out.width, out.height)).toBe(480);
      expect(Math.abs(out.width / out.height - w / h)).toBeLessThan(0.01);
    }
  });

  it("medidas imposibles (0) no producen NaN", () => {
    expect(fitResolution(0, 0, "720p")).toEqual({ width: 0, height: 0, scaled: false });
  });
});

describe("availableResolutions", () => {
  it("ofrece «Original» y solo las que reducen de verdad", () => {
    expect(availableResolutions(1920, 1080)).toEqual(["original", "720p", "480p", "360p"]);
    expect(availableResolutions(1280, 720)).toEqual(["original", "480p", "360p"]);
    expect(availableResolutions(640, 360)).toEqual(["original"]);
  });

  it("un video vertical se mide por su lado corto", () => {
    expect(availableResolutions(2160, 3840)).toEqual(["original", "1080p", "720p", "480p", "360p"]);
  });
});

describe("toEven", () => {
  it("redondea al par mas cercano con minimo 2", () => {
    expect(toEven(7)).toBe(8);
    expect(toEven(6.4)).toBe(6);
    expect(toEven(0.2)).toBe(2);
  });
});
