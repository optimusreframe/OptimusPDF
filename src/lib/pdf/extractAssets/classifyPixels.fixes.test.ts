import { describe, expect, it } from "vitest";
import { analyzePixels } from "./classifyPixels";
import { isInkLike, judgeStampImage, stampShape } from "./classifyRules";
import { BLACK_PEN, BLUE_PEN, blank, fillRect, mulberry32, type Raster, type Rgb } from "./__fixtures__/classify/rasters";

/** Rasgos nuevos de los pixeles (correcciones H1, H2, H7): barras distintas, cuatro lados del marco y papel con sombra. */

/** Barras verticales casi de toda la altura: `[x, ancho]` de cada una. */
function bars(width: number, height: number, columns: ReadonlyArray<readonly [number, number]>, color: Rgb = BLACK_PEN): Raster {
  const raster = blank(width, height);
  for (const [x, w] of columns) fillRect(raster, x, 2, w, height - 4, color);
  return raster;
}

describe("fullSpanRuns · cuantas barras distintas hay", () => {
  it("una «I» (un palo) es UNA barra aunque ocupe el 14 % del ancho", () => {
    const f = analyzePixels(bars(100, 60, [[40, 14]]));
    expect(f.fullSpanRuns).toBe(1);
    expect(f.fullSpanShare).toBeGreaterThan(0.9);
  });
  it("una «T» con su palo y una «M» (tres palos) cuentan sus palos", () => {
    const raster = blank(120, 60);
    fillRect(raster, 10, 2, 8, 56, BLACK_PEN);
    fillRect(raster, 40, 2, 8, 56, BLACK_PEN);
    fillRect(raster, 70, 2, 8, 56, BLACK_PEN);
    fillRect(raster, 10, 28, 68, 6, BLACK_PEN);
    const f = analyzePixels(raster);
    expect(f.fullSpanRuns).toBe(3);
    expect(f.fullSpanShare).toBeLessThan(0.5);
  });
  it("un codigo de barras (12 barras) tiene 12 y una cuadricula fina tambien se detecta", () => {
    const columns: Array<[number, number]> = [];
    for (let i = 0; i < 12; i += 1) columns.push([6 + i * 10, 3 + (i % 3)]);
    const f = analyzePixels(bars(140, 50, columns));
    expect(f.fullSpanRuns).toBe(12);
    expect(f.fullSpanShare).toBeGreaterThan(0.2);
  });
  it("las filas cuentan igual (una raya horizontal gruesa)", () => {
    const raster = blank(100, 40);
    fillRect(raster, 2, 5, 96, 4, BLACK_PEN);
    fillRect(raster, 2, 20, 96, 4, BLACK_PEN);
    fillRect(raster, 2, 33, 96, 4, BLACK_PEN);
    const f = analyzePixels(raster);
    expect(f.fullSpanRuns).toBe(3);
  });
  it("una imagen vacia: 0", () => {
    expect(analyzePixels(blank(20, 20)).fullSpanRuns).toBe(0);
  });
});

describe("frameSides · los cuatro lados de la caja de la tinta", () => {
  it("un marco rectangular (borde de 3 px) cubre los cuatro lados", () => {
    const raster = blank(120, 40);
    fillRect(raster, 0, 0, 120, 3, BLUE_PEN);
    fillRect(raster, 0, 37, 120, 3, BLUE_PEN);
    fillRect(raster, 0, 0, 3, 40, BLUE_PEN);
    fillRect(raster, 117, 0, 3, 40, BLUE_PEN);
    const f = analyzePixels(raster);
    expect(f.frameSides).toBeGreaterThanOrEqual(0.99);
    expect(f.frameShare).toBeGreaterThan(0.6);
    expect(stampShape(f)).toBe("frame");
    expect(judgeStampImage({ features: f, geometry: { aspect: 3, heightFrac: 0.05, areaFrac: 0.016, widthFrac: 0.26, widthPt: 160, heightPt: 53, repeatPages: 1, band: null, firstPageTop: false, pages: 1 }, signatureLabel: null, initialsLabel: null, analyzedPages: 1, scannedPage: false })?.kind).toBe("stamp");
  });
  it("unas iniciales azules gruesas que tocan los bordes de su caja (una «P» y una «Q» recortadas al ras) NO tienen los cuatro lados", () => {
    const raster = blank(100, 64);
    // «P»: palo vertical + panza arriba. «Q»: aro con cola. Hay huecos en el borde superior e inferior entre las dos letras.
    fillRect(raster, 0, 0, 8, 64, BLUE_PEN);
    fillRect(raster, 0, 0, 30, 8, BLUE_PEN);
    fillRect(raster, 22, 0, 8, 30, BLUE_PEN);
    fillRect(raster, 0, 26, 30, 8, BLUE_PEN);
    fillRect(raster, 50, 8, 8, 44, BLUE_PEN);
    fillRect(raster, 92, 8, 8, 44, BLUE_PEN);
    fillRect(raster, 58, 0, 34, 8, BLUE_PEN);
    fillRect(raster, 58, 52, 34, 8, BLUE_PEN);
    const f = analyzePixels(raster);
    expect(f.frameShare).toBeGreaterThan(0.45);
    expect(f.frameSides).toBeLessThan(0.85);
    expect(stampShape(f)).not.toBe("frame");
  });
  it("sin tinta: 0", () => {
    expect(analyzePixels(blank(30, 30)).frameSides).toBe(0);
  });
});

describe("localPaper · papel con sombra o gris, no un cuadro de color liso", () => {
  /** Una firma azul fina sobre papel con un degradado de sombra de una esquina a la otra, con ruido de JPEG. */
  function shadowedSignature(options: { bg: number; shadow: number; noise: number; seed: number }): Raster {
    const width = 160;
    const height = 50;
    const raster = blank(width, height, [options.bg, options.bg, options.bg - 3, 255]);
    const rand = mulberry32(options.seed);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        const lighting = 1 - options.shadow * (1 - x / width) * (1 - (y / height) * 0.5);
        const n = (rand() - 0.5) * 2 * options.noise;
        for (let c = 0; c < 3; c += 1) raster.data[o + c] = Math.max(0, Math.min(255, raster.data[o + c] * lighting + n));
      }
    }
    for (let x = 12; x < 148; x += 1) {
      const y = 22 + Math.round(8 * Math.sin(x / 7));
      fillRect(raster, x, y, 2, 3, BLUE_PEN);
      fillRect(raster, x, y - 9 + ((x * 5) % 12), 1, 2, BLUE_PEN);
    }
    return raster;
  }

  it("una foto con una sombra fuerte (el 45 %) NO es un fondo claro en conjunto, pero si papel respecto a su entorno: tinta limpia", () => {
    const f = analyzePixels(shadowedSignature({ bg: 240, shadow: 0.45, noise: 8, seed: 1 }));
    expect(f.lightBackground).toBe(false);
    expect(f.localPaper).toBe(true);
    expect(f.inkFraction).toBeGreaterThan(0.02);
    expect(f.inkFraction).toBeLessThan(0.2);
    expect(f.blueShare + f.darkShare).toBeGreaterThan(0.7);
    expect(isInkLike(f, true)).toBe(true);
    // Sin etiqueta cerca (modo estricto) sigue sin valer: el papel con sombra solo se acepta con una etiqueta.
    expect(isInkLike(f)).toBe(false);
  });
  it("un papel gris oscuro uniforme (foto oscura, luminancia ~150 con ruido fuerte) tambien", () => {
    const f = analyzePixels(shadowedSignature({ bg: 150, shadow: 0.2, noise: 22, seed: 2 }));
    expect(f.lightBackground).toBe(false);
    expect(f.localPaper).toBe(true);
    expect(f.inkFraction).toBeLessThan(0.25);
  });
  it("un papel blanco bien iluminado ya es un fondo claro y NO usa el fondo local", () => {
    const f = analyzePixels(shadowedSignature({ bg: 250, shadow: 0, noise: 3, seed: 3 }));
    expect(f.lightBackground).toBe(true);
    expect(f.localPaper).toBe(false);
  });
  it("un cuadro de color saturado liso (una insignia de 24 x 24) NO es papel: sin esto salia como «sello»", () => {
    const tile = blank(24, 24, [60, 190, 90, 255]);
    fillRect(tile, 0, 10, 14, 4, [250, 250, 250]);
    const f = analyzePixels(tile);
    expect(f.lightBackground).toBe(false);
    expect(f.localPaper).toBe(false);
    expect(stampShape(f)).toBeNull();
  });
  it("una foto de muchos colores no es papel", () => {
    const raster = blank(80, 60);
    const rand = mulberry32(7);
    for (let i = 0; i < 80 * 60; i += 1) raster.data.set([Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255], i * 4);
    const f = analyzePixels(raster);
    expect(f.localPaper).toBe(false);
  });
  it("con fondo transparente el fondo local no interviene", () => {
    const raster = blank(60, 30);
    fillRect(raster, 5, 10, 50, 3, BLUE_PEN);
    const f = analyzePixels(raster);
    expect(f.localPaper).toBe(false);
    expect(f.lightBackground).toBe(true);
  });
});
