import { describe, expect, it } from "vitest";
import {
  BLACK_INK,
  BLUE_INK,
  InkError,
  MAX_EXTRACT_PIXELS,
  autoSpeckSize,
  estimateBackground,
  extractInk,
  fitDimensions,
  otsuThreshold,
  removeSpecks,
  resizeArea,
  trimToInk,
  type InkImage,
} from "./inkExtract";
import {
  SHADED_PAPER,
  WARM_PAPER,
  WHITE_PAPER,
  composePhoto,
  drawSignature,
  measure,
  throughJpeg,
  type Coverage,
  type Paper,
} from "./inkTestUtils";

/**
 * Motor de tinta (U6.1) sobre imagenes SINTETICAS: una firma con bucles dibujada con antialias, de la que se conoce la
 * cobertura verdadera de cada pixel (`Coverage`). Metrica de la unidad: >= 98 % de los pixeles de FONDO verdadero (sin
 * cobertura y a >= 2 px de un trazo) quedan con alfa 0, y >= 95 % de los pixeles de TINTA verdadera (cobertura >= 0,5)
 * quedan con alfa >= 128. Se mide con `crop: "none"` para comparar pixel a pixel.
 */

const DARK_BLUE = { r: 20, g: 40, b: 160 };
const NEAR_BLACK = { r: 10, g: 10, b: 40 };

interface Case {
  name: string;
  width: number;
  height: number;
  lineWidth: number;
  ink: { r: number; g: number; b: number };
  paper?: Paper;
  noise?: number;
  jpeg?: number;
}

const CASES: Case[] = [
  { name: "trazo negro sobre blanco", width: 800, height: 300, lineWidth: 4, ink: { r: 0, g: 0, b: 0 } },
  { name: "trazo azul sobre blanco", width: 800, height: 300, lineWidth: 4, ink: DARK_BLUE },
  { name: "trazo grueso (14 px)", width: 800, height: 300, lineWidth: 14, ink: NEAR_BLACK },
  { name: "papel con degradado y sombra + ruido", width: 800, height: 300, lineWidth: 4, ink: NEAR_BLACK, paper: SHADED_PAPER, noise: 2 },
  { name: "JPEG q35 con artefactos sobre papel con sombra", width: 800, height: 300, lineWidth: 4, ink: NEAR_BLACK, paper: SHADED_PAPER, noise: 3, jpeg: 35 },
  { name: "foto calida con vineta y JPEG q60", width: 800, height: 300, lineWidth: 3, ink: DARK_BLUE, paper: WARM_PAPER, noise: 3, jpeg: 60 },
  { name: "firma muy fina (1 px)", width: 800, height: 300, lineWidth: 1, ink: { r: 0, g: 0, b: 0 } },
  { name: "firma muy fina (1 px) en JPEG q50", width: 800, height: 300, lineWidth: 1, ink: { r: 0, g: 0, b: 0 }, jpeg: 50 },
  { name: "baja resolucion (120 x 50)", width: 120, height: 50, lineWidth: 2, ink: NEAR_BLACK, noise: 1 },
  { name: "baja resolucion (120 x 50) en JPEG q40", width: 120, height: 50, lineWidth: 2, ink: NEAR_BLACK, noise: 1, jpeg: 40 },
  { name: "imagen grande (2000 x 700) JPEG q70", width: 2000, height: 700, lineWidth: 6, ink: DARK_BLUE, paper: WARM_PAPER, noise: 3, jpeg: 70 },
];

async function build(testCase: Case): Promise<{ image: InkImage; truth: Coverage }> {
  const truth = drawSignature({ width: testCase.width, height: testCase.height, lineWidth: testCase.lineWidth });
  let image: InkImage = composePhoto(truth, { ink: testCase.ink, paper: testCase.paper, noise: testCase.noise });
  if (testCase.jpeg) image = await throughJpeg(image, testCase.jpeg);
  return { image, truth };
}

function alphaOf(image: InkImage, index: number): number {
  return image.data[index * 4 + 3];
}

describe("extractInk · precision sobre firmas sinteticas", () => {
  it.each(CASES)("$name: >= 98 % del fondo transparente y >= 95 % de la tinta conservada", async (testCase) => {
    const { image, truth } = await build(testCase);
    const result = extractInk(image, { crop: "none" });
    expect(result.image.width).toBe(truth.width);
    expect(result.image.height).toBe(truth.height);
    const metrics = measure(result.image, truth);
    expect(metrics.backgroundTransparent).toBeGreaterThanOrEqual(0.98);
    expect(metrics.inkKept).toBeGreaterThanOrEqual(0.95);
    expect(metrics.inkPixels).toBeGreaterThan(50);
  });

  it("el fondo es alfa 0 Y color 0 (nada de «halo» blanco ni de basura de color)", async () => {
    const { image } = await build(CASES[0]);
    const { image: out } = extractInk(image, { crop: "none" });
    for (let i = 0; i < out.width * out.height; i += 1) {
      if (out.data[i * 4 + 3] === 0) {
        expect(out.data[i * 4] + out.data[i * 4 + 1] + out.data[i * 4 + 2]).toBe(0);
      }
    }
  });

  it("alfa suave: los bordes conservan el antialias y, sobre blanco, la tinta se ve como en la foto", async () => {
    const { image } = await build(CASES[0]);
    const { image: out } = extractInk(image, { crop: "none" });
    let soft = 0;
    let opaque = 0;
    let error = 0;
    for (let i = 0; i < out.width * out.height; i += 1) {
      const a = out.data[i * 4 + 3];
      if (a > 20 && a < 235) soft += 1;
      if (a === 255) opaque += 1;
      // Compuesto sobre blanco frente a la foto original (canal rojo: tinta negra).
      const composite = (out.data[i * 4] * a + 255 * (255 - a)) / 255;
      error += Math.abs(composite - image.data[i * 4]);
    }
    expect(opaque).toBeGreaterThan(1000);
    expect(soft).toBeGreaterThan(opaque * 0.1);
    expect(error / (out.width * out.height)).toBeLessThan(2);
  });

  it("sin corregir la iluminacion, el papel con sombra deja de limpiarse (la correccion es la que lo arregla)", async () => {
    const { image, truth } = await build(CASES[3]);
    const corrected = measure(extractInk(image, { crop: "none", evenLighting: true }).image, truth);
    const raw = measure(extractInk(image, { crop: "none", evenLighting: false }).image, truth);
    expect(corrected.backgroundTransparent).toBeGreaterThanOrEqual(0.98);
    expect(raw.backgroundTransparent).toBeLessThan(0.9);
  });

  it("sombra de bordes DUROS (salto del 27 %, sin penumbra): tambien >= 97 % de fondo limpio", async () => {
    const hardShadow: Paper = (x, y, width, height) => {
      const diagonal = (x / width + y / height) / 2;
      const v = diagonal > 0.35 && diagonal < 0.55 ? 185 : 252;
      return [v, v, v];
    };
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4 });
    const image = composePhoto(truth, { ink: NEAR_BLACK, paper: hardShadow, noise: 2 });
    const metrics = measure(extractInk(image, { crop: "none" }).image, truth);
    expect(metrics.inkKept).toBeGreaterThanOrEqual(0.95);
    expect(metrics.backgroundTransparent).toBeGreaterThanOrEqual(0.97);
  });

  it("una firma que YA es un PNG transparente sale igual de transparente", () => {
    const truth = drawSignature({ width: 400, height: 150, lineWidth: 4 });
    const data = new Uint8ClampedArray(400 * 150 * 4);
    for (let i = 0; i < truth.cover.length; i += 1) {
      data[i * 4 + 3] = Math.round(truth.cover[i] * 255); // RGB 0 = tinta negra, alfa = cobertura
    }
    const metrics = measure(extractInk({ width: 400, height: 150, data }, { crop: "none" }).image, truth);
    expect(metrics.backgroundTransparent).toBe(1);
    expect(metrics.inkKept).toBeGreaterThanOrEqual(0.98);
  });
});

describe("extractInk · color de la tinta", () => {
  it("la tinta negra y la azul son los tonos del compositor de firmas (#0b0b0c y #12327d)", () => {
    const hex = (color: { r: number; g: number; b: number }) =>
      `#${[color.r, color.g, color.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    expect(hex(BLACK_INK)).toBe("#0b0b0c");
    expect(hex(BLUE_INK)).toBe("#12327d");
  });

  function opaqueColors(image: InkImage): Array<[number, number, number]> {
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < image.width * image.height; i += 1) {
      if (image.data[i * 4 + 3] === 255) colors.push([image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]]);
    }
    return colors;
  }

  it("«original» conserva el azul de la foto (mediana de los pixeles opacos cerca de su color)", async () => {
    const { image } = await build({ ...CASES[1], paper: WARM_PAPER, noise: 2 });
    const colors = opaqueColors(extractInk(image, { crop: "none" }).image);
    expect(colors.length).toBeGreaterThan(100);
    for (let channel = 0; channel < 3; channel += 1) {
      const sorted = colors.map((color) => color[channel]).sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      expect(Math.abs(median - [DARK_BLUE.r, DARK_BLUE.g, DARK_BLUE.b][channel])).toBeLessThanOrEqual(14);
    }
  });

  it("«original» sobre papel amarillento y con sombra no tine la tinta con el color del papel", async () => {
    const { image } = await build(CASES[3]);
    const colors = opaqueColors(extractInk(image, { crop: "none" }).image);
    const worst = Math.max(...colors.map((color) => Math.max(...color)));
    expect(colors.length).toBeGreaterThan(100);
    expect(worst).toBeLessThan(90);
  });

  it("«original» en una foto con sombra da el mismo azul a la luz que en la sombra (la ganancia corrige tambien el color)", () => {
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 5 });
    const photo = composePhoto(truth, { ink: DARK_BLUE, paper: SHADED_PAPER, illuminateInk: true });
    const { image } = extractInk(photo, { crop: "none" });
    const blueOf = (from: number, to: number) => {
      const values: number[] = [];
      for (let y = 0; y < image.height; y += 1) {
        for (let x = from; x < to; x += 1) {
          const i = y * image.width + x;
          if (image.data[i * 4 + 3] === 255) values.push(image.data[i * 4 + 2]);
        }
      }
      values.sort((a, b) => a - b);
      return { n: values.length, median: values[values.length >> 1] };
    };
    const light = blueOf(0, 250);
    const shade = blueOf(550, 800);
    expect(light.n).toBeGreaterThan(200);
    expect(shade.n).toBeGreaterThan(200);
    expect(Math.abs(light.median - 160)).toBeLessThanOrEqual(18);
    expect(Math.abs(shade.median - 160)).toBeLessThanOrEqual(18);
  });

  it("«original»: los bordes semitransparentes tambien llevan el color de la tinta, no el del papel", async () => {
    const { image } = await build(CASES[1]);
    const { image: out } = extractInk(image, { crop: "none" });
    const reds: number[] = [];
    const blues: number[] = [];
    for (let i = 0; i < out.width * out.height; i += 1) {
      const a = out.data[i * 4 + 3];
      if (a >= 100 && a <= 200) {
        reds.push(out.data[i * 4]);
        blues.push(out.data[i * 4 + 2]);
      }
    }
    expect(reds.length).toBeGreaterThan(300);
    reds.sort((a, b) => a - b);
    blues.sort((a, b) => a - b);
    // El azul de la foto es (20, 40, 160): al «desmezclar» el blanco de los bordes se recupera casi exacto.
    expect(Math.abs(reds[reds.length >> 1] - 20)).toBeLessThanOrEqual(8);
    expect(Math.abs(blues[blues.length >> 1] - 160)).toBeLessThanOrEqual(8);
  });

  it.each([
    ["black", BLACK_INK],
    ["blue", BLUE_INK],
    [{ r: 200, g: 10, b: 30 }, { r: 200, g: 10, b: 30 }],
  ] as const)("ink %j: todo pixel con tinta lleva ese color y el alfa no cambia", async (mode, expected) => {
    const { image } = await build(CASES[1]);
    const original = extractInk(image, { crop: "none" });
    const recolored = extractInk(image, { crop: "none", ink: mode });
    for (let i = 0; i < recolored.image.width * recolored.image.height; i += 1) {
      const a = alphaOf(recolored.image, i);
      expect(a).toBe(alphaOf(original.image, i));
      if (a > 0) {
        expect([recolored.image.data[i * 4], recolored.image.data[i * 4 + 1], recolored.image.data[i * 4 + 2]]).toEqual([
          expected.r,
          expected.g,
          expected.b,
        ]);
      }
    }
  });

  it("un color personalizado se redondea y se acota a 0-255; uno no numerico es un error", async () => {
    const { image } = await build(CASES[0]);
    const result = extractInk(image, { ink: { r: 300.4, g: -5, b: 12.6 } });
    const pixel = result.image.data.findIndex((_, index) => index % 4 === 3 && result.image.data[index] > 0);
    expect([result.image.data[pixel - 3], result.image.data[pixel - 2], result.image.data[pixel - 1]]).toEqual([255, 0, 13]);
    expect(() => extractInk(image, { ink: { r: Number.NaN, g: 0, b: 0 } })).toThrow(InkError);
  });
});

describe("extractInk · umbral y suavidad", () => {
  function fainter(): { image: InkImage; faintRows: number[] } {
    // Firma oscura + un subrayado de lapiz tenue (gris 150) de 4 px de alto debajo.
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4, underline: false });
    const image = composePhoto(truth, { ink: { r: 0, g: 0, b: 0 }, noise: 1 });
    const faintRows = [262, 263, 264, 265];
    for (const y of faintRows) for (let x = 100; x < 700; x += 1) for (let c = 0; c < 3; c += 1) image.data[(y * 800 + x) * 4 + c] = 150;
    return { image, faintRows };
  }

  function faintInk(result: ReturnType<typeof extractInk>, rows: number[]): number {
    let count = 0;
    for (const y of rows) for (let x = 100; x < 700; x += 1) if (alphaOf(result.image, y * 800 + x) > 0) count += 1;
    return count;
  }

  it("el umbral manual decide si el lapiz tenue cuenta como tinta (arriba la conserva, abajo la quita)", () => {
    const { image, faintRows } = fainter();
    const strict = extractInk(image, { crop: "none", threshold: 100, evenLighting: false });
    const loose = extractInk(image, { crop: "none", threshold: 200, evenLighting: false });
    expect(strict.threshold).toBe(100);
    expect(strict.auto).toBe(false);
    expect(faintInk(strict, faintRows)).toBe(0);
    expect(faintInk(loose, faintRows)).toBeGreaterThan(2000);
    expect(loose.inkPixels).toBeGreaterThan(strict.inkPixels);
  });

  it("el umbral automatico queda entre la tinta y el papel y se informa", async () => {
    const { image } = await build(CASES[0]);
    const result = extractInk(image, { crop: "none" });
    expect(result.auto).toBe(true);
    expect(result.threshold).toBeGreaterThanOrEqual(120);
    expect(result.threshold).toBeLessThanOrEqual(160);
  });

  it("un umbral manual se acota a 1-254 y uno no numerico es un error", async () => {
    const { image } = await build(CASES[0]);
    expect(extractInk(image, { threshold: 999 }).threshold).toBe(254);
    expect(extractInk(image, { threshold: 128.4 }).threshold).toBe(128);
    const blue = composePhoto(drawSignature({ width: 400, height: 150, lineWidth: 4 }), { ink: DARK_BLUE });
    expect(() => extractInk(blue, { threshold: 0 })).toThrow(/tinta/i);
    expect(() => extractInk(image, { threshold: Number.NaN })).toThrow(InkError);
  });

  it("softness: 0 da bordes duros (casi sin grises) y 1 un degradado largo", async () => {
    const { image } = await build(CASES[0]);
    const count = (softness: number) => {
      const { image: out } = extractInk(image, { crop: "none", softness });
      let soft = 0;
      for (let i = 0; i < out.width * out.height; i += 1) if (alphaOf(out, i) > 0 && alphaOf(out, i) < 255) soft += 1;
      return soft;
    };
    expect(count(0)).toBeLessThan(count(0.5));
    expect(count(0.5)).toBeLessThan(count(1));
    expect(extractInk(image, { softness: 7 }).inkPixels).toBe(extractInk(image, { softness: 1 }).inkPixels);
    expect(extractInk(image, { softness: -3 }).inkPixels).toBe(extractInk(image, { softness: 0 }).inkPixels);
  });
});

describe("extractInk · motas", () => {
  function withDust(): { image: InkImage; dust: Array<[number, number]> } {
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4 });
    const image = composePhoto(truth, { ink: { r: 0, g: 0, b: 0 } });
    const dust: Array<[number, number]> = [[30, 20], [770, 30], [400, 8], [60, 280], [740, 150]];
    for (const [x, y] of dust) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        for (let c = 0; c < 3; c += 1) image.data[((y + dy) * 800 + x + dx) * 4 + c] = 20;
      }
    }
    return { image, dust };
  }

  it("quita las motas pequenas y no toca la firma", () => {
    const { image, dust } = withDust();
    const clean = extractInk(image, { crop: "none" });
    expect(clean.removedSpecks).toBe(dust.length);
    for (const [x, y] of dust) expect(alphaOf(clean.image, y * 800 + x)).toBe(0);
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4 });
    expect(measure(clean.image, truth).inkKept).toBeGreaterThanOrEqual(0.95);
  });

  it("cleanSpecks: 0 las deja; un valor grande se las lleva y un tamano medio solo las que no llegan", () => {
    const { image, dust } = withDust();
    const kept = extractInk(image, { crop: "none", cleanSpecks: 0 });
    expect(kept.removedSpecks).toBe(0);
    for (const [x, y] of dust) expect(alphaOf(kept.image, y * 800 + x)).toBeGreaterThan(0);
    expect(extractInk(image, { crop: "none", cleanSpecks: 3 }).removedSpecks).toBe(0);
    expect(extractInk(image, { crop: "none", cleanSpecks: 40 }).removedSpecks).toBe(dust.length);
  });

  it("la motas fuera del trazo no ensanchan el recorte automatico", () => {
    const { image } = withDust();
    const cropped = extractInk(image);
    const bare = extractInk(composePhoto(drawSignature({ width: 800, height: 300, lineWidth: 4 }), { ink: { r: 0, g: 0, b: 0 } }));
    expect(cropped.inkBounds).toEqual(bare.inkBounds);
  });

  it("el tamano automatico crece con la imagen", () => {
    expect(autoSpeckSize(100, 50)).toBe(6);
    expect(autoSpeckSize(1600, 900)).toBe(26);
    expect(autoSpeckSize(4000, 3000)).toBe(160);
  });
});

describe("extractInk · recorte, margen y tamano", () => {
  it("recorte automatico: la caja es la de la tinta (+-1 px) y la salida suma el margen", async () => {
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4 });
    const image = composePhoto(truth, { ink: { r: 0, g: 0, b: 0 } });
    let minX = 800;
    let maxX = -1;
    let minY = 300;
    let maxY = -1;
    for (let i = 0; i < truth.cover.length; i += 1) {
      if (truth.cover[i] > 0) {
        minX = Math.min(minX, i % 800);
        maxX = Math.max(maxX, i % 800);
        minY = Math.min(minY, Math.floor(i / 800));
        maxY = Math.max(maxY, Math.floor(i / 800));
      }
    }
    const result = extractInk(image, { margin: 10 });
    const { inkBounds, outputRect } = result;
    expect(Math.abs(inkBounds.x - minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(inkBounds.y - minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(inkBounds.x + inkBounds.width - 1 - maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(inkBounds.y + inkBounds.height - 1 - maxY)).toBeLessThanOrEqual(1);
    expect(outputRect).toEqual({ x: inkBounds.x - 10, y: inkBounds.y - 10, width: inkBounds.width + 20, height: inkBounds.height + 20 });
    expect(result.image.width).toBe(outputRect.width);
    expect(result.image.height).toBe(outputRect.height);
    // La primera y la ultima fila/columna (margen) son transparentes; la caja de tinta toca el borde del contenido.
    for (let x = 0; x < result.image.width; x += 1) expect(alphaOf(result.image, x)).toBe(0);
    expect(measure(extractInk(image, { crop: "none" }).image, truth).inkKept).toBeGreaterThan(0.95);
  });

  it("margin: 0 recorta ajustado; «auto» deja al menos 2 px y como mucho 48", async () => {
    const truth = drawSignature({ width: 800, height: 300, lineWidth: 4 });
    const image = composePhoto(truth, { ink: { r: 0, g: 0, b: 0 } });
    const tight = extractInk(image, { margin: 0 });
    expect(tight.outputRect).toEqual(tight.inkBounds);
    const auto = extractInk(image);
    expect(auto.outputRect.x).toBeLessThanOrEqual(auto.inkBounds.x - 2);
    expect(auto.inkBounds.x - auto.outputRect.x).toBeLessThanOrEqual(48);
    const big = extractInk(composePhoto(drawSignature({ width: 2400, height: 800, lineWidth: 8 }), { ink: { r: 0, g: 0, b: 0 } }));
    expect(big.inkBounds.x - big.outputRect.x).toBe(48);
    expect(extractInk(image, { margin: -9 }).outputRect).toEqual(tight.outputRect);
  });

  it("margen automatico: una firma pequena (20 x 4 px) recibe igualmente 2 px por lado", () => {
    const width = 100;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 30; y < 34; y += 1) for (let x = 40; x < 60; x += 1) for (let c = 0; c < 3; c += 1) data[(y * width + x) * 4 + c] = 0;
    const result = extractInk({ width, height, data }, { cleanSpecks: 0 });
    expect(result.inkBounds).toEqual({ x: 40, y: 30, width: 20, height: 4 });
    expect(result.outputRect).toEqual({ x: 38, y: 28, width: 24, height: 8 });
  });

  it("el margen puede salirse de la imagen y esa zona queda transparente", () => {
    const width = 60;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 8; y < 12; y += 1) for (let x = 0; x < 30; x += 1) for (let c = 0; c < 3; c += 1) data[(y * width + x) * 4 + c] = 0;
    const result = extractInk({ width, height, data }, { margin: 6, cleanSpecks: 0 });
    expect(result.inkBounds.x).toBe(0);
    expect(result.outputRect.x).toBe(-6);
    expect(result.image.width).toBe(30 + 12);
    for (let y = 0; y < result.image.height; y += 1) {
      for (let x = 0; x < 6; x += 1) expect(alphaOf(result.image, y * result.image.width + x)).toBe(0);
    }
    expect(alphaOf(result.image, 6 * result.image.width + 6)).toBeGreaterThan(0);
  });

  it("crop «none»: toda la imagen; un rectangulo: solo esa region (la tinta de fuera se ignora)", () => {
    const width = 400;
    const height = 200;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const ink = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) for (let c = 0; c < 3; c += 1) data[(y * width + x) * 4 + c] = 0;
    };
    ink(50, 40, 100, 6);
    ink(300, 150, 60, 6);
    const image = { width, height, data };
    expect(extractInk(image, { crop: "none" }).image.width).toBe(width);
    const region = extractInk(image, { crop: { x: 20, y: 20, width: 200, height: 100 }, margin: 4 });
    expect(region.inkBounds).toEqual({ x: 50, y: 40, width: 100, height: 6 });
    expect(region.outputRect).toEqual({ x: 46, y: 36, width: 108, height: 14 });
    const exact = extractInk(image, { crop: { x: 20, y: 20, width: 200, height: 100, exact: true } });
    expect([exact.image.width, exact.image.height]).toEqual([200, 100]);
    expect(exact.inkBounds).toEqual({ x: 50, y: 40, width: 100, height: 6 });
    // La region solo con la segunda barra: no ve la primera.
    expect(extractInk(image, { crop: { x: 250, y: 100, width: 150, height: 100 }, margin: 0 }).inkBounds).toEqual({ x: 300, y: 150, width: 60, height: 6 });
    // Una region sin tinta es «no hay tinta»; una region fuera o con numeros raros, imagen no valida.
    expect(() => extractInk(image, { crop: { x: 200, y: 0, width: 80, height: 100 } })).toThrow(/tinta/i);
    expect(() => extractInk(image, { crop: { x: 900, y: 0, width: 80, height: 100 } })).toThrow(InkError);
    expect(() => extractInk(image, { crop: { x: Number.NaN, y: 0, width: 80, height: 100 } })).toThrow(InkError);
  });

  it("una region recortada se analiza SOLA: su fondo y su umbral no dependen del resto de la foto", () => {
    // Mitad izquierda: papel blanco con tinta negra. Mitad derecha: un bloque gris oscuro enorme que arruinaria el Otsu global.
    const width = 400;
    const height = 120;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (x >= 200) data[i] = data[i + 1] = data[i + 2] = 90;
        else if (y >= 50 && y < 56 && x >= 20 && x < 160) data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
    const region = extractInk({ width, height, data }, { crop: { x: 0, y: 0, width: 200, height: 120 }, margin: 0, cleanSpecks: 0 });
    expect(region.inkBounds).toEqual({ x: 20, y: 50, width: 140, height: 6 });
  });

  it("maxDimension reduce al tamano pedido conservando proporcion y tinta (area, alfa premultiplicado)", async () => {
    const { image } = await build({ ...CASES[1], width: 1600, height: 600 });
    const full = extractInk(image, { maxDimension: 8000 });
    expect(full.scale).toBe(1);
    const small = extractInk(image, { maxDimension: 500 });
    expect(Math.max(small.image.width, small.image.height)).toBe(500);
    expect(small.scale).toBeCloseTo(500 / full.image.width, 5);
    expect(Math.abs(small.image.width / small.image.height - full.image.width / full.image.height)).toBeLessThan(0.02);
    // El color azul sobrevive a la reduccion (no se oscurece mezclado con los pixeles invisibles).
    let sumB = 0;
    let sumR = 0;
    let n = 0;
    for (let i = 0; i < small.image.width * small.image.height; i += 1) {
      if (alphaOf(small.image, i) === 255) {
        sumR += small.image.data[i * 4];
        sumB += small.image.data[i * 4 + 2];
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(30);
    expect(sumB / n).toBeGreaterThan(110);
    expect(sumR / n).toBeLessThan(60);
  });

  it("por defecto la salida nunca pasa de 4096 px por lado", () => {
    const width = 5000;
    const height = 700;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 300; y < 340; y += 1) for (let x = 100; x < 4900; x += 1) for (let c = 0; c < 3; c += 1) data[(y * width + x) * 4 + c] = 0;
    const result = extractInk({ width, height, data }, { margin: 0 });
    expect(result.image.width).toBe(4096);
    expect(result.image.height).toBe(Math.round(40 * (4096 / 4800)));
    expect(result.scale).toBeCloseTo(4096 / 4800, 6);
  });

  it("fitDimensions y resizeArea: proporcion, minimo 1 px y promedio por area sin manchar el color", () => {
    expect(fitDimensions(100, 50, 4096)).toEqual({ width: 100, height: 50, scale: 1 });
    expect(fitDimensions(8192, 100, 4096)).toEqual({ width: 4096, height: 50, scale: 0.5 });
    expect(fitDimensions(10000, 1, 100)).toEqual({ width: 100, height: 1, scale: 0.01 });
    expect(fitDimensions(8192, 101, 4096)).toEqual({ width: 4096, height: 51, scale: 0.5 });
    // 4x4 con un solo pixel rojo opaco y el resto invisible (RGB 0): el 2x2 resultante sigue siendo ROJO (alfa 64).
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data.set([255, 0, 0, 255], (1 * 4 + 1) * 4);
    const out = resizeArea({ width: 4, height: 4, data }, 2, 2);
    expect(Array.from(out.data.slice(0, 4))).toEqual([255, 0, 0, 64]);
    expect(Array.from(out.data.slice(4, 8))).toEqual([0, 0, 0, 0]);
    // Ampliar tambien funciona (promedio de caja exacto).
    const up = resizeArea({ width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }, 3, 2);
    expect(Array.from(up.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
    expect(up.width * up.height).toBe(6);
  });
});

describe("extractInk · errores claros", () => {
  const solid = (value: number, width = 200, height = 80, alpha = 255): InkImage => {
    const data = new Uint8ClampedArray(width * height * 4).fill(value);
    for (let i = 3; i < data.length; i += 4) data[i] = alpha;
    return { width, height, data };
  };

  it("imagen totalmente blanca: «No se encontró tinta»", () => {
    for (const image of [solid(255), solid(250)]) {
      let thrown: unknown;
      try {
        extractInk(image);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InkError);
      expect((thrown as InkError).code).toBe("no-ink");
      expect((thrown as InkError).message).toContain("No se encontró tinta");
    }
  });

  it("blanca con ruido de JPEG, o transparente del todo: tambien «no hay tinta»", () => {
    const noisy = solid(252);
    for (let i = 0; i < noisy.data.length; i += 4) noisy.data[i] = noisy.data[i + 1] = noisy.data[i + 2] = 245 + ((i / 4) % 11);
    expect(() => extractInk(noisy)).toThrowError(expect.objectContaining({ code: "no-ink" }));
    expect(() => extractInk(solid(0, 100, 40, 0))).toThrowError(expect.objectContaining({ code: "no-ink" }));
  });

  it("gris liso sin contraste: no es tinta; negro liso y casi negro: demasiado oscura", () => {
    expect(() => extractInk(solid(128))).toThrowError(expect.objectContaining({ code: "no-ink" }));
    expect(() => extractInk(solid(0))).toThrowError(expect.objectContaining({ code: "too-dark" }));
    expect(() => extractInk(solid(20))).toThrowError(expect.objectContaining({ code: "too-dark" }));
    expect(() => extractInk(solid(20), { evenLighting: false })).toThrowError(expect.objectContaining({ code: "too-dark" }));
    expect(() => extractInk(solid(0))).toThrow(/oscura/);
  });

  it("una imagen con menos de 4 pixeles de tinta no es una firma", () => {
    const image = solid(255);
    for (const x of [10, 11, 12]) for (let c = 0; c < 3; c += 1) image.data[(40 * 200 + x) * 4 + c] = 0;
    expect(() => extractInk(image, { cleanSpecks: 0 })).toThrowError(expect.objectContaining({ code: "no-ink" }));
  });

  it("imagen enorme: se rechaza por el limite de pixeles SIN asignar memoria", () => {
    const huge = { width: 20_000, height: 20_000, data: new Uint8ClampedArray(4) };
    expect(huge.width * huge.height).toBeGreaterThan(MAX_EXTRACT_PIXELS);
    expect(() => extractInk(huge)).toThrowError(expect.objectContaining({ code: "too-many-pixels" }));
    expect(() => extractInk({ width: 7072, height: 7072, data: new Uint8ClampedArray(4) })).toThrowError(
      expect.objectContaining({ code: "too-many-pixels" }),
    );
  });

  it("entradas invalidas: dimensiones, datos cortos, region fuera", () => {
    const bad: InkImage[] = [
      { width: 0, height: 10, data: new Uint8ClampedArray(0) },
      { width: 10.5, height: 10, data: new Uint8ClampedArray(1000) },
      { width: 10, height: 10, data: new Uint8ClampedArray(399) },
      { width: -3, height: 10, data: new Uint8ClampedArray(1000) },
    ];
    for (const image of bad) expect(() => extractInk(image)).toThrowError(expect.objectContaining({ code: "invalid-image" }));
    expect(() => extractInk(null as unknown as InkImage)).toThrow(InkError);
    // Justo en el limite: 100 x 100 con datos justos funciona.
    expect(() => extractInk(solid(255, 100, 100))).toThrowError(expect.objectContaining({ code: "no-ink" }));
  });
});

describe("utilidades exportadas", () => {
  it("otsuThreshold: separa dos modos, usa el centro de una meseta y devuelve 128 sin datos", () => {
    const flat = new Array(256).fill(0);
    flat[40] = 100;
    flat[200] = 100;
    expect(otsuThreshold(flat)).toBe(119);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      histogram[i] = Math.round(500 * Math.exp(-((i - 60) ** 2) / 200) + 5000 * Math.exp(-((i - 220) ** 2) / 200));
    }
    const t = otsuThreshold(histogram);
    expect(t).toBeGreaterThan(90);
    expect(t).toBeLessThan(190);
    expect(otsuThreshold(new Array(256).fill(0))).toBe(128);
    const single = new Array(256).fill(0);
    single[77] = 1000;
    expect(otsuThreshold(single)).toBe(128);
    // Cuando hay dos picos en 0 y 255, el corte cae entre los dos.
    const extremes = new Array(256).fill(0);
    extremes[0] = 10;
    extremes[255] = 10;
    expect(otsuThreshold(extremes)).toBe(127);
  });

  it("estimateBackground: sigue un degradado e ignora un trazo oscuro encima", () => {
    const width = 400;
    const height = 120;
    const luma = new Uint8Array(width * height);
    const truth = (x: number) => 255 - Math.round((x / width) * 110);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) luma[y * width + x] = truth(x);
    for (let y = 50; y < 56; y += 1) for (let x = 40; x < 360; x += 1) luma[y * width + x] = 20;
    const background = estimateBackground(luma, width, height);
    expect(background.length).toBe(width * height);
    for (const [x, y] of [[10, 10], [200, 10], [390, 10], [100, 53], [200, 53], [300, 53], [200, 110]]) {
      expect(Math.abs(background[y * width + x] - truth(x))).toBeLessThanOrEqual(8);
    }
  });

  it("estimateBackground: sigue el degradado hasta los bordes (extrapola; no repite el valor de la celda)", () => {
    const width = 400;
    const height = 40;
    const truth = (x: number) => 255 - Math.round((x / 399) * 55);
    const luma = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) luma[y * width + x] = truth(x);
    const background = estimateBackground(luma, width, height, { cell: 80, percentile: 0.5 });
    for (const x of [0, 1, 2, 397, 398, 399, 100, 250]) expect(Math.abs(background[20 * width + x] - truth(x))).toBeLessThanOrEqual(3);
  });

  it("estimateBackground: una fila ENTERA de celdas cubiertas de tinta se repara con las vecinas", () => {
    const width = 400;
    const height = 120;
    const luma = new Uint8Array(width * height).fill(230);
    for (let y = 50; y < 60; y += 1) for (let x = 40; x < 360; x += 1) luma[y * width + x] = 20;
    const background = estimateBackground(luma, width, height, { cell: 10 });
    for (const x of [60, 200, 340]) expect(Math.abs(background[55 * width + x] - 230)).toBeLessThanOrEqual(6);
  });

  it("estimateBackground: una imagen de una sola celda (o de 1 px) no rompe", () => {
    const tiny = new Uint8Array(3 * 2).fill(200);
    expect(Array.from(estimateBackground(tiny, 3, 2))).toEqual([200, 200, 200, 200, 200, 200]);
    const dark = new Uint8Array(10).fill(3);
    expect(Math.min(...estimateBackground(dark, 10, 1))).toBeGreaterThanOrEqual(24);
  });

  it("removeSpecks: 8-conectividad, une ramas que se juntan y devuelve cuantos componentes quito", () => {
    const width = 20;
    const height = 12;
    const alpha = new Uint8Array(width * height);
    const set = (x: number, y: number, v = 255) => (alpha[y * width + x] = v);
    set(1, 1); // 1 px
    set(5, 1); // cadena DIAGONAL de 3 px (8-conectados)
    set(6, 2);
    set(7, 3);
    // V de 9 px (+ 1 debajo = 10): dos brazos de 5 que solo se juntan en el vertice (hay que unir etiquetas)
    for (let i = 0; i < 5; i += 1) {
      set(10 + i, 1 + i);
      set(18 - i, 1 + i);
    }
    set(14, 6);
    set(14, 9, 3); // alfa bajo pero >0 cuenta como tinta
    expect(removeSpecks(alpha, width, height, 4)).toBe(3);
    expect(alpha[1 * width + 1]).toBe(0);
    expect(alpha[2 * width + 6]).toBe(0);
    expect(alpha[9 * width + 14]).toBe(0);
    expect(alpha[1 * width + 10]).toBe(255);
    expect(alpha[1 * width + 18]).toBe(255);
    expect(alpha[6 * width + 14]).toBe(255);
    // No quita nada si todos son grandes o si el minimo es <= 1.
    expect(removeSpecks(alpha, width, height, 4)).toBe(0);
    expect(removeSpecks(alpha, width, height, 1)).toBe(0);
    expect(removeSpecks(alpha, width, height, 0)).toBe(0);
    // Con minSize justo igual al tamano del componente (10) NO se quita (< minSize).
    expect(removeSpecks(alpha, width, height, 10)).toBe(0);
    expect(removeSpecks(alpha, width, height, 11)).toBe(1);
    expect(alpha.every((value) => value === 0)).toBe(true);
  });

  it("removeSpecks: un componente de EXACTAMENTE minSize se queda aunque otro mas pequeno se vaya", () => {
    const width = 12;
    const height = 3;
    const alpha = new Uint8Array(width * height);
    for (const x of [1, 2, 3]) alpha[x] = 255; // 3 px: se va
    for (const x of [6, 7, 8, 9]) alpha[width + x] = 255; // 4 px: se queda
    expect(removeSpecks(alpha, width, height, 4)).toBe(1);
    expect(Array.from(alpha.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(alpha.slice(width + 6, width + 10))).toEqual([255, 255, 255, 255]);
  });

  it("removeSpecks: dos ramas con etiquetas distintas que se juntan por la diagonal NE cuentan como UN componente", () => {
    // x . x      fila 0: dos etiquetas
    // x x x      fila 1: el pixel central ve (0,0) y, por NE, (2,0): hay que unirlas
    const width = 5;
    const height = 3;
    const alpha = new Uint8Array(width * height);
    for (const [x, y] of [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]) alpha[y * width + x] = 255;
    expect(removeSpecks(alpha, width, height, 5)).toBe(0);
    expect(alpha.reduce((sum, value) => sum + (value ? 1 : 0), 0)).toBe(5);
    expect(removeSpecks(alpha, width, height, 6)).toBe(1);
  });

  it("trimToInk: caja ajustada, margen transparente, minAlpha y nada de tinta", () => {
    const width = 30;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    const put = (x: number, y: number, a: number) => data.set([9, 8, 7, a], (y * width + x) * 4);
    put(10, 5, 255);
    put(14, 8, 255);
    put(2, 18, 5); // alfa muy bajo, fuera de la caja
    const trimmed = trimToInk({ width, height, data }, 3, 10);
    expect(trimmed?.rect).toEqual({ x: 10, y: 5, width: 5, height: 4 });
    expect(trimmed?.padded).toEqual({ x: 7, y: 2, width: 11, height: 10 });
    expect(trimmed?.image.width).toBe(11);
    expect(Array.from(trimmed!.image.data.slice((3 * 11 + 3) * 4, (3 * 11 + 3) * 4 + 4))).toEqual([9, 8, 7, 255]);
    expect(trimToInk({ width, height, data }, 0, 1)?.rect).toEqual({ x: 2, y: 5, width: 13, height: 14 });
    expect(trimToInk({ width, height, data: new Uint8ClampedArray(width * height * 4) })).toBeNull();
    // `minAlpha` es inclusivo: un pixel con alfa == minAlpha cuenta.
    expect(trimToInk({ width, height, data }, 0, 5)?.rect).toEqual({ x: 2, y: 5, width: 13, height: 14 });
    expect(trimToInk({ width, height, data }, 0, 6)?.rect).toEqual({ x: 10, y: 5, width: 5, height: 4 });
    // Margen por encima del borde: la parte fuera es transparente.
    const edge = trimToInk({ width, height, data }, 20, 10);
    expect(edge?.image.width).toBe(5 + 40);
    expect(Array.from(edge!.image.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });
});

describe("determinismo", () => {
  it("misma entrada y mismas opciones: exactamente los mismos bytes (y no tocan la entrada)", async () => {
    const { image } = await build(CASES[4]);
    const before = new Uint8ClampedArray(image.data);
    const a = extractInk(image, { ink: "blue" });
    const b = extractInk(image, { ink: "blue" });
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
    expect(a).toEqual(b);
    expect(Buffer.from(image.data).equals(Buffer.from(before))).toBe(true);
  });

  it("papeles blanco, calido y sombreado dan salidas distintas pero cada una estable", () => {
    const truth = drawSignature({ width: 300, height: 120, lineWidth: 3 });
    for (const paper of [WHITE_PAPER, WARM_PAPER, SHADED_PAPER]) {
      const image = composePhoto(truth, { ink: NEAR_BLACK, paper, noise: 2, seed: 3 });
      const first = extractInk(image);
      const second = extractInk(image);
      expect(Buffer.from(first.image.data).equals(Buffer.from(second.image.data))).toBe(true);
    }
  });
});
