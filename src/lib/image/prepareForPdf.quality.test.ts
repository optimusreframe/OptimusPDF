import { describe, expect, it } from "vitest";
import {
  CANVAS_SAFE_MAX_PIXELS,
  CANVAS_SAFE_MAX_SIDE,
  IMAGE_PRESETS,
  estimatePreparedBytes,
  prepareImage,
  readImageHeader,
} from "@/lib/image/prepareForPdf";
import {
  createNodeRunner,
  decodeToPixels,
  makeSyntheticJpeg,
  psnr,
  reducePixels,
  ssim,
  type NodeBackendStats,
} from "@/lib/image/photoTestUtils";

/**
 * Pruebas PESADAS de la preparacion de fotos (fotos sinteticas de 12, 24 y 48 MP): calidad medida (PSNR / SSIM), pesos,
 * estimacion frente al peso real y 40 fotos grandes en secuencia con los topes de lienzo de iOS. Las de la politica (rapidas)
 * estan en `prepareForPdf.test.ts`.
 */

const blobOf = (bytes: Uint8Array | Buffer): Blob => new Blob([new Uint8Array(bytes)]);

/* ------------------------------ calidad medida ------------------------------ */

describe("calidad y peso medidos con fotos sinteticas (12, 24 y 48 MP)", () => {
  const sizes: Array<[string, number, number]> = [
    ["12 MP", 4000, 3000],
    ["24 MP", 5712, 4284],
    ["48 MP", 8064, 6048],
  ];
  for (const [label, width, height] of sizes) {
    it(`${label}: «Alta» y «Equilibrada» dan PSNR >= 38 dB y SSIM >= 0,97 frente a la original reducida al mismo tamano, y pesan <= 3 MB / <= 1,5 MB`, async () => {
      const jpeg = makeSyntheticJpeg({ width, height, seed: width, quality: 92 });
      const full = await decodeToPixels(jpeg);
      const report: string[] = [`${label}: original ${(jpeg.length / 1e6).toFixed(2)} MB`];
      for (const [preset, maxBytes] of [["high", 3_000_000], ["balanced", 1_500_000]] as const) {
        const out = await prepareImage(blobOf(jpeg), preset, createNodeRunner());
        expect(out.bytes.length).toBeLessThanOrEqual(maxBytes);
        // Un JPEG de 12 MP ligero cabe en el tope de «Alta» (4096 px) y pasa intacto: no hay nada que medir.
        if (!out.changed) {
          expect(["already-small", "not-smaller"]).toContain(out.reason);
          expect(preset === "high" && width <= 4096).toBe(true);
          report.push(`  ${preset}: intacta (${(out.bytes.length / 1e6).toFixed(2)} MB, ya cabe y pesa poco)`);
          continue;
        }
        const pixels = await decodeToPixels(out.bytes);
        const reference = reducePixels(full, pixels.width, pixels.height);
        const dB = psnr(pixels, reference);
        const structural = ssim(pixels, reference);
        report.push(`  ${preset}: ${(out.bytes.length / 1e6).toFixed(2)} MB ${out.width}x${out.height} PSNR ${dB.toFixed(2)} dB SSIM ${structural.toFixed(4)}`);
        expect(dB, `${label} ${preset} PSNR`).toBeGreaterThanOrEqual(38);
        expect(structural, `${label} ${preset} SSIM`).toBeGreaterThanOrEqual(0.97);
      }
      console.log(report.join("\n"));
    }, 120_000);
  }

  it("foto de estres de alta frecuencia (grano 9): se reporta el peso real; sigue por debajo de los topes y no baja de 35 dB", async () => {
    const jpeg = makeSyntheticJpeg({ width: 8064, height: 6048, seed: 99, quality: 92, grain: 9, texture: 35 });
    const full = await decodeToPixels(jpeg);
    const lines: string[] = [`estres 48 MP: original ${(jpeg.length / 1e6).toFixed(2)} MB`];
    for (const [preset, maxBytes] of [["high", 3_500_000], ["balanced", 1_500_000]] as const) {
      const out = await prepareImage(blobOf(jpeg), preset, createNodeRunner());
      const pixels = await decodeToPixels(out.bytes);
      const reference = reducePixels(full, pixels.width, pixels.height);
      const dB = psnr(pixels, reference);
      lines.push(`  ${preset}: ${(out.bytes.length / 1e6).toFixed(2)} MB PSNR ${dB.toFixed(2)} SSIM ${ssim(pixels, reference).toFixed(4)}`);
      expect(out.bytes.length).toBeLessThanOrEqual(maxBytes);
      expect(dB).toBeGreaterThanOrEqual(35);
    }
    console.log(lines.join("\n"));
  }, 120_000);

  it("el orden de peso es coherente: original > alta > equilibrada > compacta", async () => {
    const jpeg = makeSyntheticJpeg({ width: 5712, height: 4284, seed: 21, quality: 92 });
    const weights: number[] = [jpeg.length];
    for (const preset of ["high", "balanced", "compact"] as const) {
      weights.push((await prepareImage(blobOf(jpeg), preset, createNodeRunner())).bytes.length);
    }
    for (let index = 1; index < weights.length; index += 1) expect(weights[index]).toBeLessThan(weights[index - 1]);
  }, 60_000);
});


describe("estimacion y memoria con fotos grandes", () => {
  it("estimacion frente al peso real (fotos sinteticas): dentro de un factor 2,5", async () => {
    for (const [width, height, seed] of [[4000, 3000, 31], [5712, 4284, 32], [8064, 6048, 33]] as const) {
      const jpeg = makeSyntheticJpeg({ width, height, seed, quality: 92 });
      const h = readImageHeader(new Uint8Array(jpeg));
      for (const preset of ["high", "balanced", "compact"] as const) {
        const estimate = estimatePreparedBytes(h, jpeg.length, IMAGE_PRESETS[preset]).optimized;
        const actual = (await prepareImage(blobOf(jpeg), preset, createNodeRunner())).bytes.length;
        expect(estimate / actual, `${width}x${height} ${preset}`).toBeGreaterThan(1 / 2.5);
        expect(estimate / actual, `${width}x${height} ${preset}`).toBeLessThan(2.5);
      }
    }
  }, 120_000);

  it("40 fotos grandes en secuencia: nunca hay mas de un lienzo vivo y ninguno supera los topes de iOS", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const runner = createNodeRunner(stats);
    const jpeg = makeSyntheticJpeg({ width: 6000, height: 4500, seed: 1, quality: 90 });
    for (let index = 0; index < 40; index += 1) {
      const out = await prepareImage(blobOf(jpeg), index % 2 === 0 ? "balanced" : "high", runner);
      expect(out.changed).toBe(true);
    }
    expect(stats.decodes).toBe(40);
    expect(stats.maxLive).toBe(1);
    expect(stats.live).toBe(0);
    expect(stats.maxSide).toBeLessThanOrEqual(CANVAS_SAFE_MAX_SIDE);
    expect(stats.maxPixels).toBeLessThanOrEqual(CANVAS_SAFE_MAX_PIXELS);
  }, 120_000);
});
