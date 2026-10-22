import { describe, expect, it } from "vitest";
import { analyzePixels, rgbToHsv } from "./classifyPixels";
import {
  BLACK_PEN,
  BLUE_PEN,
  blank,
  fillRect,
  initialsRaster,
  inkSignatureRaster,
  logoRaster,
  photoRaster,
  stampRaster,
  emptyRingRaster,
  mulberry32,
} from "./__fixtures__/classify/rasters";

/** Rasgos de los pixeles de una miniatura: fondo, tinta, tono, colores, solidez, aro, marco y barras. */

describe("rgbToHsv", () => {
  it("tono, saturacion y valor de colores conocidos", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 255 });
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(Math.round(rgbToHsv(255, 0, 128).h)).toBe(330);
  });
});

describe("analyzePixels", () => {
  it("una firma azul transparente: fondo claro, tinta azul, un color, trazo fino", () => {
    const f = analyzePixels(inkSignatureRaster({ seed: 1, ink: BLUE_PEN }));
    expect(f.lightBackground).toBe(true);
    expect(f.hasAlpha).toBe(true);
    expect(f.transparent).toBeGreaterThan(0.8);
    expect(f.blueShare).toBeGreaterThan(0.95);
    expect(f.darkShare).toBeLessThan(0.1 + 1);
    expect(f.colorBins).toBeLessThanOrEqual(2);
    expect(f.solidity).toBeLessThan(0.5);
    expect(f.inkFraction).toBeGreaterThan(0.03);
    expect(f.inkFraction).toBeLessThan(0.3);
    expect(f.dominantHue).toBeGreaterThan(200);
    expect(f.dominantHue).toBeLessThan(250);
    expect(f.dominantHueShare).toBeGreaterThan(0.95);
    expect(f.fullSpanShare).toBeLessThan(0.1);
    expect(f.meanAlpha).toBeGreaterThan(0.7);
  });

  it("tinta negra: tinta oscura y sin tono dominante", () => {
    const f = analyzePixels(inkSignatureRaster({ seed: 2, ink: BLACK_PEN }));
    expect(f.darkShare).toBeGreaterThan(0.95);
    expect(f.blueShare).toBe(0);
    expect(f.dominantHue).toBe(-1);
    expect(f.chromaticShare).toBe(0);
    expect(f.inkLuma).toBeLessThan(40);
  });

  it("un escaneo opaco con papel casi blanco y ruido sigue teniendo fondo claro y tinta oscura", () => {
    const f = analyzePixels(inkSignatureRaster({ seed: 3, ink: BLACK_PEN, background: "paper", noise: 28, paper: 240 }));
    expect(f.hasAlpha).toBe(false);
    expect(f.transparent).toBe(0);
    expect(f.lightBackground).toBe(true);
    expect(f.darkShare).toBeGreaterThan(0.8);
    expect(f.inkFraction).toBeGreaterThan(0.03);
    expect(f.inkFraction).toBeLessThan(0.3);
  });

  it("un fondo gris oscuro NO es un fondo claro (foto o diagrama)", () => {
    const f = analyzePixels(blank(40, 40, [90, 90, 96, 255]));
    expect(f.lightBackground).toBe(false);
  });

  it("un papel con ruido demasiado fuerte deja de ser un fondo uniforme", () => {
    const raster = blank(60, 60, [240, 240, 238, 255]);
    const rand = mulberry32(3);
    for (let i = 0; i < 60 * 60; i += 1) {
      const value = 100 + Math.floor(rand() * 150); // luminancias repartidas entre 100 y 250: ningun tono manda
      raster.data[i * 4] = raster.data[i * 4 + 1] = raster.data[i * 4 + 2] = value;
    }
    expect(analyzePixels(raster).lightBackground).toBe(false);
  });

  it("un logo de colores planos: relleno solido, varios colores y color cromatico", () => {
    const f = analyzePixels(logoRaster({ seed: 1 }));
    expect(f.solidity).toBeGreaterThan(0.7);
    expect(f.colorBins).toBeGreaterThanOrEqual(3);
    expect(f.chromaticShare).toBeGreaterThan(0.5);
    expect(f.inkFraction).toBeGreaterThan(0.3);
  });

  it("una foto tiene miles de cubetas de color y es opaca", () => {
    const f = analyzePixels(photoRaster({ seed: 1, width: 128, height: 96 }));
    expect(f.colorBins).toBeGreaterThan(150);
    expect(f.transparent).toBe(0);
    expect(f.hasAlpha).toBe(false);
    expect(f.meanAlpha).toBe(1);
  });

  it("un sello circular rojo: aro (tinta en el borde de la elipse, centro casi vacio), saturado y de un solo tono", () => {
    const f = analyzePixels(stampRaster({ size: 160 }));
    expect(f.ringShare).toBeGreaterThan(0.55);
    expect(f.centerShare).toBeLessThan(0.45);
    expect(f.dominantHueShare).toBeGreaterThan(0.95);
    expect(f.inkSaturation).toBeGreaterThan(0.7);
    expect(f.dominantHue === 355 || (f.dominantHue > 340 && f.dominantHue <= 360) || f.dominantHue < 10).toBe(true);
  });

  it("un circulo vacio de trazo fino tambien es un aro", () => {
    const f = analyzePixels(emptyRingRaster(96));
    expect(f.ringShare).toBeGreaterThan(0.8);
    expect(f.centerShare).toBeLessThan(0.1);
  });

  it("un marco rectangular: tinta pegada al borde de su caja", () => {
    const raster = blank(100, 50);
    fillRect(raster, 0, 0, 100, 4, [20, 60, 190]);
    fillRect(raster, 0, 46, 100, 4, [20, 60, 190]);
    fillRect(raster, 0, 0, 4, 50, [20, 60, 190]);
    fillRect(raster, 96, 0, 4, 50, [20, 60, 190]);
    const f = analyzePixels(raster);
    expect(f.frameShare).toBeGreaterThan(0.9);
  });

  it("barras (codigo de barras): columnas casi enteras de tinta", () => {
    const raster = blank(100, 40, [255, 255, 255, 255]);
    for (let x = 2; x < 98; x += 4) fillRect(raster, x, 2, 2, 36, [0, 0, 0]);
    const f = analyzePixels(raster);
    expect(f.fullSpanShare).toBeGreaterThan(0.4);
    const sign = analyzePixels(inkSignatureRaster({ seed: 5 }));
    expect(sign.fullSpanShare).toBeLessThan(0.12);
  });

  it("una imagen sin pixeles visibles o con datos de menos devuelve rasgos vacios, sin lanzar", () => {
    const empty = analyzePixels(blank(10, 10));
    expect(empty.transparent).toBe(1);
    expect(empty.inkFraction).toBe(0);
    expect(empty.colorBins).toBe(0);
    expect(analyzePixels({ width: 0, height: 0, data: new Uint8ClampedArray(0) }).inkFraction).toBe(0);
    expect(analyzePixels({ width: 10, height: 10, data: new Uint8ClampedArray(8) }).inkFraction).toBe(0);
  });

  it("las iniciales de rotulador grueso tienen mas relleno que las de trazo fino", () => {
    const thin = analyzePixels(initialsRaster({ seed: 7, ink: BLACK_PEN }));
    const thick = analyzePixels(initialsRaster({ seed: 7, size: 120, ink: BLACK_PEN, thickness: 6 }));
    expect(thick.solidity).toBeGreaterThan(thin.solidity);
    expect(thick.solidity).toBeGreaterThan(0.6);
    expect(thin.solidity).toBeLessThan(0.55);
  });

  it("caja de la tinta normalizada y alfa medio", () => {
    const raster = blank(100, 100);
    fillRect(raster, 20, 30, 40, 20, [0, 0, 0], 128);
    const f = analyzePixels(raster);
    expect(f.inkBox.x).toBeCloseTo(0.2, 2);
    expect(f.inkBox.y).toBeCloseTo(0.3, 2);
    expect(f.inkBox.width).toBeCloseTo(0.4, 2);
    expect(f.inkBox.height).toBeCloseTo(0.2, 2);
    expect(f.meanAlpha).toBeCloseTo(0.5, 1);
  });

  it("el tono dominante cruza el cero (rojo entre 350 y 10 grados)", () => {
    const raster = blank(60, 30);
    fillRect(raster, 10, 10, 20, 10, [200, 0, 20]); // ~ 354 grados
    fillRect(raster, 30, 10, 20, 10, [200, 20, 0]); // ~ 6 grados
    const f = analyzePixels(raster);
    expect(f.dominantHueShare).toBeGreaterThan(0.99);
    expect(f.dominantHue > 345 || f.dominantHue < 15).toBe(true);
  });
});
