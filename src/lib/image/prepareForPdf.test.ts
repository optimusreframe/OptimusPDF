import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  CANVAS_SAFE_MAX_PIXELS,
  CANVAS_SAFE_MAX_SIDE,
  CELL_QUALITY_MAX,
  DEFAULT_IMAGE_PRESET,
  IMAGE_PRESETS,
  IMAGE_PRESET_IDS,
  ImagePrepareError,
  MIN_FIT_SIDE,
  MIN_SAVING,
  chooseOutcome,
  estimatePreparedBytes,
  fitWithin,
  isImagePresetId,
  planDownscaleSteps,
  planNativeDecodeWidth,
  planPreparation,
  prepareImage,
  readImageHeader,
  scanRaster,
  withFitMaxSide,
  type ImageHeader,
  type Raster,
  type TranscodePlan,
  type TranscodeResult,
} from "@/lib/image/prepareForPdf";
import {
  createNodeRunner,
  decodeToPixels,
  drawSyntheticPhoto,
  makeSyntheticJpeg,
  withExifOrientation,
  type NodeBackendStats,
} from "@/lib/image/photoTestUtils";

/**
 * Politica de preparacion de fotos para el PDF: cabeceras, plan, reglas (nunca ampliar, solo si ahorra >= 15 %, EXIF,
 * alfa, grafico frente a foto), limites de lienzo de iOS, cancelacion y calidad medida (PSNR / SSIM) con fotos sinteticas.
 */

const blobOf = (bytes: Uint8Array | Buffer): Blob => new Blob([new Uint8Array(bytes)]);
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/* ------------------------------ constructores de cabeceras ------------------------------ */

function pngHeader(width: number, height: number, colorType: number, withTrns = false): Uint8Array {
  const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): void => {
    bytes.push((data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255);
    for (const ch of type) bytes.push(ch.charCodeAt(0));
    bytes.push(...data, 0, 0, 0, 0);
  };
  chunk("IHDR", [(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, (height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, colorType, 0, 0, 0]);
  if (withTrns) chunk("tRNS", [0]);
  chunk("IDAT", [0, 0]);
  return new Uint8Array(bytes);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}

function heif(brand: string, width: number, height: number, quarterTurns = 0): Uint8Array {
  const bytes: number[] = [0, 0, 0, 24];
  for (const ch of "ftyp") bytes.push(ch.charCodeAt(0));
  for (const ch of brand) bytes.push(ch.charCodeAt(0));
  bytes.push(0, 0, 0, 0, ...Array(8).fill(0));
  const be = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  // ispe: tamano, "ispe", version/flags, ancho, alto
  bytes.push(0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0, ...be(width), ...be(height));
  if (quarterTurns) bytes.push(0, 0, 0, 9, 0x69, 0x72, 0x6f, 0x74, quarterTurns);
  bytes.push(...Array(32).fill(0));
  return new Uint8Array(bytes);
}

describe("presets", () => {
  it("cuatro presets, recomendado = equilibrada; topes de lado 4096 / 3000 / 2200 y calidades 0,92 / 0,87 / 0,80", () => {
    expect([...IMAGE_PRESET_IDS]).toEqual(["original", "high", "balanced", "compact"]);
    expect(DEFAULT_IMAGE_PRESET).toBe("balanced");
    expect(IMAGE_PRESETS.original.maxSide).toBeNull();
    expect(IMAGE_PRESETS.high).toMatchObject({ maxSide: 4096, quality: 0.92 });
    expect(IMAGE_PRESETS.balanced).toMatchObject({ maxSide: 3000, quality: 0.87 });
    expect(IMAGE_PRESETS.compact).toMatchObject({ maxSide: 2200, quality: 0.8 });
    expect(MIN_SAVING).toBe(0.15);
  });

  it("isImagePresetId solo admite los cuatro", () => {
    for (const id of IMAGE_PRESET_IDS) expect(isImagePresetId(id)).toBe(true);
    for (const bad of ["Original", "low", "", null, undefined, 3, {}]) expect(isImagePresetId(bad)).toBe(false);
  });

  it("withFitMaxSide: solo baja el tope, respeta el minimo y no toca `original`", () => {
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 1200).maxSide).toBe(1200);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 9000).maxSide).toBe(3000);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 100).maxSide).toBe(MIN_FIT_SIDE);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, undefined)).toBe(IMAGE_PRESETS.balanced);
    expect(withFitMaxSide(IMAGE_PRESETS.original, 500)).toBe(IMAGE_PRESETS.original);
  });

  it("withFitMaxSide: una foto reducida a su celda sube la calidad JPEG (sin pasar de 0,95); sin reducir no cambia nada", () => {
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 1200).quality).toBeCloseTo(0.94, 9);
    expect(withFitMaxSide(IMAGE_PRESETS.high, 1200).quality).toBe(CELL_QUALITY_MAX);
    expect(withFitMaxSide(IMAGE_PRESETS.compact, 1200).quality).toBeCloseTo(0.87, 9);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 3000)).toBe(IMAGE_PRESETS.balanced);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 9000).quality).toBe(0.87);
    expect(withFitMaxSide(IMAGE_PRESETS.balanced, 1200).sizeRatio).toBeGreaterThan(IMAGE_PRESETS.balanced.sizeRatio);
  });
});

describe("fitWithin (nunca amplia)", () => {
  it("no toca lo que ya cabe y reduce lo grande conservando la proporcion", () => {
    expect(fitWithin(2000, 1000, 3000)).toEqual({ width: 2000, height: 1000, scale: 1 });
    const big = fitWithin(8064, 6048, 3000);
    expect(big.width).toBe(3000);
    expect(big.height).toBe(2250);
    expect(big.scale).toBeCloseTo(3000 / 8064, 9);
  });

  it("una imagen pequena NO se amplia hasta el tope (800x600 con tope 3000 sigue en 800x600)", () => {
    expect(fitWithin(800, 600, 3000)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitWithin(3000, 100, 3000).scale).toBe(1);
  });

  it("jamas devuelve mas pixeles de los de entrada, para cualquier tamano", () => {
    for (const [w, h] of [[1, 1], [10, 5000], [640, 480], [3000, 3000], [4096, 4096], [12000, 2000], [8064, 6048], [20000, 20000]]) {
      for (const side of [null, 4096, 3000, 2200]) {
        const out = fitWithin(w, h, side);
        expect(out.width).toBeLessThanOrEqual(w);
        expect(out.height).toBeLessThanOrEqual(h);
        expect(out.width * out.height).toBeLessThanOrEqual(CANVAS_SAFE_MAX_PIXELS + 2 * Math.max(out.width, out.height));
        if (side) expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(side);
      }
    }
  });

  it("tope de area aunque no haya tope de lado", () => {
    const out = fitWithin(10000, 10000, null);
    expect(out.width * out.height).toBeLessThanOrEqual(CANVAS_SAFE_MAX_PIXELS * 1.001);
  });
});

describe("planDownscaleSteps: limites de lienzo de iOS/Safari (16,7 Mpx y 4096 px de lado)", () => {
  const cases: Array<[number, number, number, number]> = [
    [8064, 6048, 3000, 2250],
    [8064, 6048, 4096, 3072],
    [12000, 3000, 2200, 550],
    [10000, 10000, 2200, 2200],
    [4000, 3000, 3000, 2250],
    [4032, 3024, 640, 480],
  ];
  for (const [sw, sh, tw, th] of cases) {
    it(`${sw}x${sh} -> ${tw}x${th}: ningun lienzo pasa de 4096 px ni de 16 Mpx, cada paso reduce como mucho a la mitad y acaba en el objetivo`, () => {
      const steps = planDownscaleSteps(sw, sh, tw, th);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[steps.length - 1]).toEqual({ width: tw, height: th });
      let previous = { width: sw, height: sh };
      steps.forEach((step, index) => {
        expect(step.width).toBeLessThanOrEqual(CANVAS_SAFE_MAX_SIDE);
        expect(step.height).toBeLessThanOrEqual(CANVAS_SAFE_MAX_SIDE);
        expect(step.width * step.height).toBeLessThanOrEqual(CANVAS_SAFE_MAX_PIXELS);
        expect(step.width).toBeLessThanOrEqual(previous.width);
        expect(step.height).toBeLessThanOrEqual(previous.height);
        // Salvo el primero (que baja al tope de lienzo), cada paso es >= la mitad del anterior.
        if (index > 0) {
          expect(step.width).toBeGreaterThanOrEqual(Math.floor(previous.width / 2));
          expect(step.height).toBeGreaterThanOrEqual(Math.floor(previous.height / 2));
        }
        previous = step;
      });
    });
  }

  it("una imagen que ya es del tamano pedido da un solo paso", () => {
    expect(planDownscaleSteps(3000, 2000, 3000, 2000)).toEqual([{ width: 3000, height: 2000 }]);
  });
});

describe("planDownscaleSteps: pasos de mitad EXACTA (sin aliasing en WebKit)", () => {
  it("48 Mpx -> 3000: primero la mitad exacta (4032x3024) y despues el ajuste fino", () => {
    expect(planDownscaleSteps(8064, 6048, 3000, 2250)).toEqual([
      { width: 4032, height: 3024 },
      { width: 3000, height: 2250 },
    ]);
  });

  it("un origen de menos del doble del objetivo se reduce en un solo paso fino", () => {
    expect(planDownscaleSteps(5000, 3750, 3000, 2250)).toEqual([{ width: 3000, height: 2250 }]);
    expect(planDownscaleSteps(6000, 4500, 3000, 2250)).toEqual([{ width: 3000, height: 2250 }]);
  });

  it("de 24000 px a 1500: el primer lienzo respeta el tope de 4096 px y los siguientes reducen a la mitad (nunca a menos)", () => {
    const steps = planDownscaleSteps(24000, 3000, 1500, 188);
    let previous = 24000;
    steps.forEach((step, index) => {
      if (index > 0) expect(step.width).toBeGreaterThanOrEqual(Math.ceil(previous / 2) - 1);
      previous = step.width;
    });
    expect(steps[steps.length - 1]).toEqual({ width: 1500, height: 188 });
    expect(steps[0].width).toBeLessThanOrEqual(CANVAS_SAFE_MAX_SIDE);
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  it("jamas devuelve un paso mayor que el anterior ni que el origen, ni ciclos infinitos con objetivos raros", () => {
    for (const [sw, sh, tw, th] of [
      [100, 100, 100, 100],
      [100, 50, 99, 49],
      [3, 3, 1, 1],
      [16000, 100, 640, 4],
    ] as Array<[number, number, number, number]>) {
      const steps = planDownscaleSteps(sw, sh, tw, th);
      expect(steps.length).toBeLessThanOrEqual(33);
      expect(steps[steps.length - 1]).toEqual({ width: tw, height: th });
      let previous = { width: sw, height: sh };
      for (const step of steps) {
        expect(step.width).toBeLessThanOrEqual(previous.width);
        expect(step.height).toBeLessThanOrEqual(previous.height);
        previous = step;
      }
    }
  });
});

describe("planNativeDecodeWidth: hasta donde decodifica el reductor nativo cuando NO filtra (WebKit)", () => {
  it("prefiere un multiplo EXACTO del objetivo (objetivo x 2^k) entre el 72 % y el 95 % del origen: el resto son mitades exactas", () => {
    expect(planNativeDecodeWidth(8064, 3000)).toBe(6000); // 0,744x; luego 6000 -> 3000 es una mitad exacta
    expect(planNativeDecodeWidth(7000, 3000)).toBe(6000);
    expect(planNativeDecodeWidth(8064, 1500)).toBe(6000); // 1500 x 4
    expect(planNativeDecodeWidth(5712, 2200)).toBe(4400); // 0,77x
  });

  it("si el origen ya es (casi) un multiplo exacto del objetivo se decodifica entero y se baja por pasos de mitad", () => {
    expect(planNativeDecodeWidth(12000, 3000)).toBeNull();
    expect(planNativeDecodeWidth(6000, 3000)).toBeNull();
    expect(planNativeDecodeWidth(6100, 3000)).toBeNull();
  });

  it("sin multiplo exacto cerca, decodifica al 75 % del origen (nunca menos del doble del objetivo)", () => {
    expect(planNativeDecodeWidth(8064, 2200)).toBe(6048); // 4400 seria 0,55x (aliasing) y 8800 pasa del origen
    expect(planNativeDecodeWidth(20000, 3000)).toBe(15000); // 12000 seria 0,6x
    expect(planNativeDecodeWidth(11000, 3000)).toBe(8250);
    expect(planNativeDecodeWidth(8064, 4096)).toBeNull(); // 8192 pasa del origen: decodificar entera y bajar a 4096
  });

  it("la reduccion nativa jamas baja del 72 % del origen ni del doble del objetivo", () => {
    for (const source of [4001, 5000, 6001, 7000, 8064, 9500, 12000, 16000, 24000, 50000]) {
      for (const target of [1000, 1500, 2200, 3000, 4096]) {
        const width = planNativeDecodeWidth(source, target);
        if (width === null) continue;
        expect(width).toBeLessThan(source);
        expect(width).toBeGreaterThanOrEqual(target * 2);
        expect(width / source).toBeGreaterThanOrEqual(0.72 - 1e-9);
      }
    }
  });

  it("un origen que ya cabe (o es menos del doble) no se reduce al decodificar", () => {
    expect(planNativeDecodeWidth(3000, 3000)).toBeNull();
    expect(planNativeDecodeWidth(2000, 3000)).toBeNull();
    expect(planNativeDecodeWidth(4000, 3000)).toBeNull();
    expect(planNativeDecodeWidth(5999, 3000)).toBeNull();
    expect(planNativeDecodeWidth(4000, 0)).toBeNull();
  });
});

describe("readImageHeader", () => {
  it("JPEG: dimensiones, orientacion EXIF y dimensiones vistas (giradas con 5..8)", () => {
    const jpeg = makeSyntheticJpeg({ width: 400, height: 200, quality: 80, texture: 5, grain: 1 });
    const plain = readImageHeader(new Uint8Array(jpeg));
    expect(plain).toMatchObject({ kind: "jpeg", width: 400, height: 200, orientation: 1, displayWidth: 400, displayHeight: 200, mayHaveAlpha: false });
    const rotated = readImageHeader(new Uint8Array(withExifOrientation(jpeg, 6)));
    expect(rotated).toMatchObject({ kind: "jpeg", width: 400, height: 200, orientation: 6, displayWidth: 200, displayHeight: 400 });
    const mirrored = readImageHeader(new Uint8Array(withExifOrientation(jpeg, 2)));
    expect(mirrored).toMatchObject({ orientation: 2, displayWidth: 400, displayHeight: 200 });
    // 5..8 giran 90 grados (ancho y alto vistos se intercambian); 1..4 no.
    for (const orientation of [1, 2, 3, 4] as const) {
      expect(readImageHeader(new Uint8Array(withExifOrientation(jpeg, orientation)))).toMatchObject({ displayWidth: 400, displayHeight: 200 });
    }
    for (const orientation of [5, 6, 7, 8] as const) {
      expect(readImageHeader(new Uint8Array(withExifOrientation(jpeg, orientation)))).toMatchObject({ displayWidth: 200, displayHeight: 400 });
    }
  });

  it("PNG: tipo de color con alfa (4 y 6), tRNS y sin alfa", () => {
    expect(readImageHeader(pngHeader(10, 20, 2))).toMatchObject({ kind: "png", width: 10, height: 20, mayHaveAlpha: false });
    expect(readImageHeader(pngHeader(10, 20, 6)).mayHaveAlpha).toBe(true);
    expect(readImageHeader(pngHeader(10, 20, 4)).mayHaveAlpha).toBe(true);
    expect(readImageHeader(pngHeader(10, 20, 3, true)).mayHaveAlpha).toBe(true);
    expect(readImageHeader(pngHeader(10, 20, 3, false)).mayHaveAlpha).toBe(false);
  });

  it("WebP, HEIC y AVIF: dimensiones y formato; `irot` impar intercambia ancho y alto vistos", () => {
    expect(readImageHeader(webpVp8x(4000, 3000))).toMatchObject({ kind: "webp", width: 4000, height: 3000, mayHaveAlpha: true });
    expect(readImageHeader(heif("heic", 4032, 3024))).toMatchObject({ kind: "heic", width: 4032, height: 3024, displayWidth: 4032 });
    expect(readImageHeader(heif("heic", 4032, 3024, 1))).toMatchObject({ displayWidth: 3024, displayHeight: 4032 });
    expect(readImageHeader(heif("heic", 4032, 3024, 2))).toMatchObject({ displayWidth: 4032 });
    expect(readImageHeader(heif("avif", 800, 600))).toMatchObject({ kind: "avif", width: 800, height: 600 });
  });

  it("GIF y BMP se reconocen; basura, vacio y truncados no lanzan", () => {
    expect(readImageHeader(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0, 0, 0]))).toMatchObject({ kind: "gif", width: 10, height: 20 });
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d], 0);
    bmp.set([5, 0, 0, 0], 18);
    bmp.set([6, 0, 0, 0], 22);
    expect(readImageHeader(bmp)).toMatchObject({ kind: "bmp", width: 5, height: 6 });
    for (const garbage of [new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array([0xff, 0xd8, 0xff]), new Uint8Array(100).fill(7), pngHeader(5, 5, 2).slice(0, 12)]) {
      expect(() => readImageHeader(garbage)).not.toThrow();
    }
    expect(readImageHeader(new Uint8Array(100).fill(7)).kind).toBe("unknown");
  });

  it("dimensiones imposibles (0) se tratan como ilegibles", () => {
    expect(readImageHeader(pngHeader(0, 20, 2)).width).toBeNull();
  });
});

function header(overrides: Partial<ImageHeader>): ImageHeader {
  return { kind: "jpeg", width: 4000, height: 3000, displayWidth: 4000, displayHeight: 3000, orientation: 1, mayHaveAlpha: false, ...overrides };
}

describe("planPreparation (la politica)", () => {
  it("`original` conserva JPEG y PNG sin tocarlos, tengan el tamano que tengan", () => {
    expect(planPreparation(header({ width: 8064, height: 6048, displayWidth: 8064, displayHeight: 6048 }), 9_000_000, IMAGE_PRESETS.original)).toEqual({ action: "keep", reason: "original-preset" });
    expect(planPreparation(header({ kind: "png", mayHaveAlpha: true }), 30_000_000, IMAGE_PRESETS.original)).toEqual({ action: "keep", reason: "original-preset" });
  });

  it("`original` con WebP/HEIC convierte (no hay otra forma) y solo se acota por los limites de lienzo de iOS", () => {
    const plan = planPreparation(header({ kind: "webp", width: 9000, height: 6000, displayWidth: 9000, displayHeight: 6000 }), 5_000_000, IMAGE_PRESETS.original);
    expect(plan).toMatchObject({ action: "transcode", mustConvert: true, maxSide: CANVAS_SAFE_MAX_SIDE, maxPixels: CANVAS_SAFE_MAX_PIXELS });
  });

  it("un JPEG que ya cabe y pesa pocos bytes por pixel pasa intacto", () => {
    const plan = planPreparation(header({ width: 2000, height: 1500, displayWidth: 2000, displayHeight: 1500 }), 3_000_000 * 0.08, IMAGE_PRESETS.balanced);
    expect(plan).toEqual({ action: "keep", reason: "already-small" });
  });

  it("un JPEG que ya cabe pero pesa mucho por pixel se prueba a reencodar", () => {
    const plan = planPreparation(header({ width: 2576, height: 1932, displayWidth: 2576, displayHeight: 1932 }), 3_100_000, IMAGE_PRESETS.balanced);
    expect(plan).toMatchObject({ action: "transcode", output: "jpeg", mustConvert: false, maxSide: 3000, quality: 0.87 });
  });

  it("un JPEG que excede el tope se reduce aunque pese poco", () => {
    const plan = planPreparation(header({}), 1_000_000, IMAGE_PRESETS.balanced);
    expect(plan.action).toBe("transcode");
  });

  it("la orientacion no cambia la decision: una foto 6000x4000 con EXIF 6 tambien excede 3000", () => {
    const plan = planPreparation(header({ width: 6000, height: 4000, displayWidth: 4000, displayHeight: 6000, orientation: 6 }), 500_000, IMAGE_PRESETS.balanced);
    expect(plan).toMatchObject({ action: "transcode", hint: { width: 4000, height: 6000 }, orientation: 6 });
  });

  it("JPEG de dimensiones ilegibles se conserva", () => {
    expect(planPreparation(header({ width: null, height: null, displayWidth: null, displayHeight: null }), 5_000_000, IMAGE_PRESETS.balanced)).toEqual({ action: "keep", reason: "unreadable" });
  });

  it("PNG pequeno o grafico que ya cabe se conserva; PNG grande se analiza", () => {
    const png = (overrides: Partial<ImageHeader> = {}) => header({ kind: "png", mayHaveAlpha: true, width: 1200, height: 800, displayWidth: 1200, displayHeight: 800, ...overrides });
    expect(planPreparation(png(), 100_000, IMAGE_PRESETS.balanced)).toEqual({ action: "keep", reason: "small-png" });
    expect(planPreparation(png(), 600_000, IMAGE_PRESETS.balanced)).toEqual({ action: "keep", reason: "graphic-png" });
    const photo = planPreparation(png(), 3_000_000, IMAGE_PRESETS.balanced);
    expect(photo).toMatchObject({ action: "transcode", output: "auto", mustConvert: false, checkAlpha: true });
    const huge = planPreparation(png({ width: 6000, height: 4000, displayWidth: 6000, displayHeight: 4000 }), 100_000, IMAGE_PRESETS.balanced);
    expect(huge.action).toBe("transcode");
  });

  it("WebP, HEIC, AVIF, GIF y lo desconocido siempre se convierten", () => {
    for (const kind of ["webp", "heic", "avif", "gif", "bmp", "unknown"] as const) {
      expect(planPreparation(header({ kind, width: 100, height: 100, displayWidth: 100, displayHeight: 100 }), 5_000, IMAGE_PRESETS.balanced)).toMatchObject({ action: "transcode", mustConvert: true, output: "auto" });
    }
  });
});

describe("chooseOutcome (solo si ahorra >= 15 %)", () => {
  const plan = planPreparation(header({}), 4_000_000, IMAGE_PRESETS.balanced) as TranscodePlan;
  const result = (bytes: number, format: "jpeg" | "png" = "jpeg"): TranscodeResult => ({ format, bytes: new Uint8Array(bytes), width: 10, height: 10, scanned: null });

  it("justo el 85 % se acepta; un byte mas, no", () => {
    expect(chooseOutcome(plan, "jpeg", 1000, result(850)).use).toBe("transcoded");
    expect(chooseOutcome(plan, "jpeg", 1000, result(851)).use).toBe("original");
    expect(chooseOutcome(plan, "jpeg", 1000, result(2000))).toEqual({ use: "original", reason: "not-smaller" });
  });

  it("sin resultado se conserva el original", () => {
    expect(chooseOutcome(plan, "jpeg", 1000, null)).toEqual({ use: "original", reason: "unavailable" });
  });

  it("PNG que sigue siendo PNG solo se sustituye si se redujo de verdad", () => {
    const pngPlan = planPreparation(header({ kind: "png", mayHaveAlpha: true, width: 6000, height: 4000, displayWidth: 6000, displayHeight: 4000 }), 8_000_000, IMAGE_PRESETS.balanced) as TranscodePlan;
    expect(chooseOutcome(pngPlan, "png", 1000, result(500, "png"))).toEqual({ use: "transcoded", reason: "resized-png" });
    expect(chooseOutcome(pngPlan, "png", 1000, result(900, "png"))).toEqual({ use: "original", reason: "not-smaller" });
    expect(chooseOutcome(pngPlan, "png", 1000, result(500, "jpeg"))).toEqual({ use: "transcoded", reason: "recompressed" });
  });

  it("lo que hay que convertir se usa siempre", () => {
    const convert = planPreparation(header({ kind: "webp" }), 4_000_000, IMAGE_PRESETS.balanced) as TranscodePlan;
    expect(chooseOutcome(convert, "webp", 1000, result(5000))).toEqual({ use: "transcoded", reason: "converted" });
  });
});

/* ------------------------------ escaneo de pixeles ------------------------------ */

function rasterFrom(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number], reads?: number[]): Raster {
  return {
    width,
    height,
    rows(from, to) {
      reads?.push(to - from);
      const data = new Uint8ClampedArray((to - from) * width * 4);
      for (let y = from; y < to; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const [r, g, b, a] = fill(x, y);
          const at = ((y - from) * width + x) * 4;
          data[at] = r;
          data[at + 1] = g;
          data[at + 2] = b;
          data[at + 3] = a;
        }
      }
      return data;
    },
    async encode() {
      return new Uint8Array(1);
    },
    release() {},
  };
}

describe("scanRaster (foto o grafico, alfa real o trivial)", () => {
  it("una captura de pantalla con pocos colores es un grafico", () => {
    const raster = rasterFrom(600, 400, (x, y) => (((x >> 5) + (y >> 5)) % 2 === 0 ? [240, 240, 240, 255] : [30, 90, 200, 255]));
    const scan = scanRaster(raster, false);
    expect(scan.graphic).toBe(true);
    expect(scan.distinctColors).toBeLessThan(10);
  });

  it("una foto (muchos colores) no es un grafico", () => {
    const hash = (x: number, y: number, k: number): number => {
      let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k, 2147483647);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return (h ^ (h >>> 16)) & 255;
    };
    const raster = rasterFrom(600, 400, (x, y) => [hash(x, y, 1), hash(x, y, 2), hash(x, y, 3), 255]);
    expect(scanRaster(raster, false).graphic).toBe(false);
  });

  it("transparencia REAL (un recorte, una sombra) frente a transparencia trivial (un pixel suelto)", () => {
    const cutout = rasterFrom(200, 200, (x, y) => ((x - 100) ** 2 + (y - 100) ** 2 < 80 ** 2 ? [200, 30, 30, 255] : [0, 0, 0, 0]));
    expect(scanRaster(cutout, true)).toMatchObject({ realAlpha: true, anyAlpha: true });
    const trivial = rasterFrom(200, 200, (x, y) => [100, 120, 140, x === 3 && y === 4 ? 0 : 255]);
    expect(scanRaster(trivial, true)).toMatchObject({ realAlpha: false, anyAlpha: true });
    const opaque = rasterFrom(200, 200, () => [1, 2, 3, 255]);
    expect(scanRaster(opaque, true)).toMatchObject({ realAlpha: false, anyAlpha: false });
  });

  it("sin `checkAlpha` no mira el alfa", () => {
    const cutout = rasterFrom(100, 100, () => [0, 0, 0, 0]);
    expect(scanRaster(cutout, false).realAlpha).toBe(false);
  });

  it("lee por bandas (memoria acotada), no la imagen entera de golpe", () => {
    const reads: number[] = [];
    scanRaster(rasterFrom(300, 1000, () => [10, 10, 10, 255], reads), true);
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(256);
  });
});

/* ------------------------------ preparacion con pixeles ------------------------------ */

describe("prepareImage con un backend de Node", () => {
  it("un JPEG grande se reduce al tope del preset, sin ampliar, y sale mas ligero", async () => {
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, seed: 7, quality: 92 });
    for (const [preset, side] of [["balanced", 3000], ["compact", 2200]] as const) {
      const out = await prepareImage(blobOf(jpeg), preset, createNodeRunner());
      expect(out.changed).toBe(true);
      expect(out.format).toBe("jpeg");
      expect(out.width).toBe(side);
      expect(out.height).toBe(Math.round((3000 * side) / 4000));
      expect(out.bytes.length).toBeLessThan(jpeg.length * (1 - MIN_SAVING));
      expect(out.orientation).toBe(1);
    }
  });

  it("nunca amplia: un JPEG pequeno y pesado conserva sus dimensiones (o se queda intacto)", async () => {
    const jpeg = makeSyntheticJpeg({ width: 1000, height: 700, seed: 2, quality: 99, grain: 8 });
    for (const preset of ["high", "balanced", "compact"] as const) {
      const out = await prepareImage(blobOf(jpeg), preset, createNodeRunner());
      expect(out.width as number).toBeLessThanOrEqual(1000);
      expect(out.height as number).toBeLessThanOrEqual(700);
    }
  });

  it("un JPEG ligero que ya cabe pasa con los MISMOS bytes y sin decodificarlo", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const jpeg = makeSyntheticJpeg({ width: 1600, height: 1200, seed: 1, quality: 60, grain: 0.5, texture: 4 });
    const out = await prepareImage(blobOf(jpeg), "balanced", createNodeRunner(stats));
    expect(out.changed).toBe(false);
    expect(out.reason).toBe("already-small");
    expect(same(out.bytes, new Uint8Array(jpeg))).toBe(true);
    expect(stats.decodes).toBe(0);
  });

  it("si reencodar no ahorra el 15 %, se conserva el JPEG original (mismos bytes)", async () => {
    // Una foto ya muy comprimida y ruidosa: pesa por pixel mas que el umbral y al reencodar a 0,87 no baja el 15 %.
    const jpeg = makeSyntheticJpeg({ width: 1400, height: 1000, seed: 5, quality: 62, grain: 14, texture: 45 });
    const out = await prepareImage(blobOf(jpeg), "balanced", createNodeRunner());
    if (out.changed) {
      expect(out.bytes.length).toBeLessThanOrEqual(jpeg.length * (1 - MIN_SAVING));
    } else {
      expect(same(out.bytes, new Uint8Array(jpeg))).toBe(true);
      expect(["not-smaller", "already-small"]).toContain(out.reason);
    }
  });

  it("`original`: JPEG y PNG salen con exactamente los mismos bytes y la misma orientacion", async () => {
    const jpeg = withExifOrientation(makeSyntheticJpeg({ width: 3000, height: 2000, seed: 9, quality: 95 }), 6);
    const outJpeg = await prepareImage(blobOf(jpeg), "original", createNodeRunner());
    expect(outJpeg).toMatchObject({ format: "jpeg", changed: false, orientation: 6, reason: "original-preset" });
    expect(same(outJpeg.bytes, new Uint8Array(jpeg))).toBe(true);
    const png = new Uint8Array(drawSyntheticPhoto({ width: 1500, height: 1000, seed: 4 }).toBuffer("image/png"));
    const outPng = await prepareImage(blobOf(png), "original", createNodeRunner());
    expect(outPng).toMatchObject({ format: "png", changed: false });
    expect(same(outPng.bytes, png)).toBe(true);
  });

  it("la orientacion EXIF se hornea: la foto reducida sale derecha (6 = el lado rojo guardado a la izquierda queda ARRIBA)", async () => {
    const canvas = createCanvas(3200, 1600);
    const context = canvas.getContext("2d");
    context.drawImage(drawSyntheticPhoto({ width: 3200, height: 1600, seed: 12 }), 0, 0);
    context.globalAlpha = 0.9;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 1600, 1600);
    context.fillStyle = "#0000ff";
    context.fillRect(1600, 0, 1600, 1600);
    context.globalAlpha = 1;
    const jpeg = withExifOrientation(canvas.toBuffer("image/jpeg", 95), 6);
    const out = await prepareImage(blobOf(jpeg), "balanced", createNodeRunner());
    expect(out.changed).toBe(true);
    expect(out.orientation).toBe(1);
    expect(out.width).toBe(1500);
    expect(out.height).toBe(3000);
    const pixels = await decodeToPixels(out.bytes);
    expect(pixels.width).toBe(1500);
    expect(pixels.height).toBe(3000);
    const at = (x: number, y: number) => [pixels.data[(y * pixels.width + x) * 4], pixels.data[(y * pixels.width + x) * 4 + 1], pixels.data[(y * pixels.width + x) * 4 + 2]];
    expect(at(750, 300)[0]).toBeGreaterThan(at(750, 300)[2] + 60); // arriba: rojo
    expect(at(750, 2700)[2]).toBeGreaterThan(at(750, 2700)[0] + 60); // abajo: azul
  });

  it("`bakeOrientation`: un JPEG pequeno con EXIF 6 se reencoda derecho aunque la politica lo conserve (y sin el, se conserva)", async () => {
    const jpeg = withExifOrientation(makeSyntheticJpeg({ width: 800, height: 400, seed: 3, quality: 60, grain: 0.5, texture: 4 }), 6);
    const kept = await prepareImage(blobOf(jpeg), "balanced", createNodeRunner());
    expect(kept).toMatchObject({ changed: false, orientation: 6 });
    for (const preset of ["original", "balanced"] as const) {
      const baked = await prepareImage(blobOf(jpeg), preset, createNodeRunner(), { bakeOrientation: true });
      expect(baked).toMatchObject({ changed: true, format: "jpeg", orientation: 1, width: 400, height: 800 });
    }
    // Una foto sin orientacion no se toca aunque se pida hornearla.
    const upright = makeSyntheticJpeg({ width: 800, height: 400, seed: 3, quality: 60, grain: 0.5, texture: 4 });
    expect(await prepareImage(blobOf(upright), "balanced", createNodeRunner(), { bakeOrientation: true })).toMatchObject({ changed: false });
  });

  it("un PNG fotografico con transparencia TRIVIAL (una franja diminuta) se aplana sobre BLANCO al pasar a JPEG, no sobre negro", async () => {
    const canvas = createCanvas(2400, 1600);
    const context = canvas.getContext("2d");
    context.drawImage(drawSyntheticPhoto({ width: 2400, height: 1600, seed: 14 }), 0, 0);
    // Franja de 0,05 % de la imagen totalmente transparente: transparencia trivial (< 0,1 %).
    context.clearRect(0, 0, 2, 600);
    const png = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await prepareImage(blobOf(png), "high", createNodeRunner());
    expect(out.format).toBe("jpeg");
    const pixels = await decodeToPixels(out.bytes);
    // Pixeles de la franja (columna 0, fila 300): casi blancos, no negros.
    const at = (300 * pixels.width) * 4;
    expect(pixels.data[at]).toBeGreaterThan(200);
    expect(pixels.data[at + 1]).toBeGreaterThan(200);
    expect(pixels.data[at + 2]).toBeGreaterThan(200);
  });

  it("PNG fotografico sin transparencia (aunque lleve canal alfa opaco) pasa a JPEG y pesa menos", async () => {
    const png = new Uint8Array(drawSyntheticPhoto({ width: 2400, height: 1600, seed: 11 }).toBuffer("image/png"));
    const out = await prepareImage(blobOf(png), "balanced", createNodeRunner());
    expect(out.changed).toBe(true);
    expect(out.format).toBe("jpeg");
    expect(out.bytes.length).toBeLessThan(png.length * (1 - MIN_SAVING));
  });

  it("PNG con transparencia real conserva el alfa (sigue siendo PNG y la esquina sigue transparente)", async () => {
    const canvas = createCanvas(3400, 2200);
    const context = canvas.getContext("2d");
    const photo = drawSyntheticPhoto({ width: 1500, height: 1500, seed: 3 });
    context.drawImage(photo, 1000, 300);
    const png = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await prepareImage(blobOf(png), "balanced", createNodeRunner());
    expect(out.format).toBe("png");
    const pixels = await decodeToPixels(out.bytes);
    expect(pixels.data[3]).toBe(0); // esquina superior izquierda: transparente
  });

  it("captura de pantalla (pocos colores) se conserva como PNG, no se vuelve JPEG con manchas", async () => {
    const canvas = createCanvas(1800, 1200);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 1800, 1200);
    context.fillStyle = "#1a73e8";
    for (let row = 0; row < 40; row += 1) context.fillRect(60, 40 + row * 28, 200 + ((row * 37) % 900), 14);
    const png = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await prepareImage(blobOf(png), "balanced", createNodeRunner());
    expect(out.format).toBe("png");
    expect(same(out.bytes, png)).toBe(true);
  });

  it("un PNG grafico mas grande que el tope se reduce y sigue siendo PNG (o se conserva si no ahorra)", async () => {
    const canvas = createCanvas(4200, 3000);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 4200, 3000);
    context.fillStyle = "#222";
    for (let row = 0; row < 90; row += 1) context.fillRect(100, 60 + row * 30, 300 + ((row * 97) % 3000), 14);
    const png = new Uint8Array(canvas.toBuffer("image/png"));
    const out = await prepareImage(blobOf(png), "balanced", createNodeRunner());
    expect(out.format).toBe("png");
    if (out.changed) expect(Math.max(out.width as number, out.height as number)).toBeLessThanOrEqual(3000);
  });

  it("WebP de foto se convierte a JPEG (hay que convertir si o si)", async () => {
    const webp = new Uint8Array(drawSyntheticPhoto({ width: 2000, height: 1500, seed: 8 }).toBuffer("image/webp", 90));
    const out = await prepareImage(blobOf(webp), "balanced", createNodeRunner());
    expect(out.changed).toBe(true);
    expect(out.format).toBe("jpeg");
    expect(out.reason).toBe("converted");
  });

  it("con `original`, un WebP se convierte y respeta los topes de lienzo de iOS", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const webp = new Uint8Array(drawSyntheticPhoto({ width: 5000, height: 3500, seed: 8 }).toBuffer("image/webp", 80));
    const out = await prepareImage(blobOf(webp), "original", createNodeRunner(stats));
    expect(out.changed).toBe(true);
    expect(stats.maxSide).toBeLessThanOrEqual(CANVAS_SAFE_MAX_SIDE);
    expect(stats.maxPixels).toBeLessThanOrEqual(CANVAS_SAFE_MAX_PIXELS);
  });

  it("el tope por celda (`fitMaxSide`) baja los pixeles de la foto y `original` lo ignora", async () => {
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, seed: 6, quality: 92 });
    const small = await prepareImage(blobOf(jpeg), "balanced", createNodeRunner(), { fitMaxSide: 1000 });
    expect(Math.max(small.width as number, small.height as number)).toBe(1000);
    const original = await prepareImage(blobOf(jpeg), "original", createNodeRunner(), { fitMaxSide: 1000 });
    expect(same(original.bytes, new Uint8Array(jpeg))).toBe(true);
    const never = await prepareImage(blobOf(jpeg), "compact", createNodeRunner(), { fitMaxSide: 9000 });
    expect(Math.max(never.width as number, never.height as number)).toBe(2200);
  });

  it("basura y vacio fallan con `undecodable`; sin backend un JPEG/PNG se conserva y un WebP falla", async () => {
    await expect(prepareImage(blobOf(new Uint8Array(0)), "balanced", createNodeRunner())).rejects.toMatchObject({ code: "undecodable" });
    await expect(prepareImage(blobOf(new Uint8Array(500).fill(9)), "balanced", createNodeRunner())).rejects.toMatchObject({ code: "undecodable" });
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    const kept = await prepareImage(blobOf(jpeg), "balanced", null);
    expect(kept).toMatchObject({ changed: false, reason: "unavailable" });
    expect(same(kept.bytes, new Uint8Array(jpeg))).toBe(true);
    const webp = new Uint8Array(drawSyntheticPhoto({ width: 300, height: 200 }).toBuffer("image/webp", 80));
    await expect(prepareImage(blobOf(webp), "balanced", null)).rejects.toBeInstanceOf(ImagePrepareError);
  });

  it("si el backend no puede decodificar un JPEG, se conserva el original", async () => {
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    const out = await prepareImage(blobOf(jpeg), "balanced", async () => null);
    expect(out).toMatchObject({ changed: false, reason: "unavailable" });
  });

  it("un fallo inesperado del backend no pierde la foto: se conserva el original", async () => {
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    const out = await prepareImage(blobOf(jpeg), "balanced", async () => {
      throw new Error("boom");
    });
    expect(out).toMatchObject({ changed: false, reason: "unavailable" });
  });
});

describe("cancelacion y memoria", () => {
  it("una senal ya abortada rechaza con `cancelled` sin hacer nada", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const controller = new AbortController();
    controller.abort();
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    await expect(prepareImage(blobOf(jpeg), "balanced", createNodeRunner(stats), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(stats.decodes).toBe(0);
  });

  it("cancelar a mitad (tras decodificar) rechaza con `cancelled` y libera el lienzo", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const controller = new AbortController();
    const inner = createNodeRunner(stats);
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    const runner = async (source: Blob, plan: TranscodePlan, signal?: AbortSignal) => {
      // El usuario cancela justo despues de que el motor decodifique: el encode no debe llegar a ocurrir.
      queueMicrotask(() => undefined);
      setTimeout(() => controller.abort(), 0);
      return inner(source, plan, signal);
    };
    await expect(prepareImage(blobOf(jpeg), "balanced", runner, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(stats.live).toBe(0);
  });

  it("el raster se libera tambien si la codificacion falla", async () => {
    const stats: NodeBackendStats = { decodes: 0, live: 0, maxLive: 0, maxSide: 0, maxPixels: 0, encodes: 0 };
    const jpeg = makeSyntheticJpeg({ width: 4000, height: 3000, quality: 92 });
    const failing = async (source: Blob, plan: TranscodePlan) => {
      const { transcodeImage } = await import("@/lib/image/prepareForPdf");
      const { createNodeBackend } = await import("@/lib/image/photoTestUtils");
      const backend = createNodeBackend(stats);
      const wrapped = {
        async decode(blob: Blob, request: Parameters<typeof backend.decode>[1]) {
          const raster = await backend.decode(blob, request);
          if (!raster) return raster;
          return {
            width: raster.width,
            height: raster.height,
            rows: raster.rows.bind(raster),
            encode: async () => {
              throw new Error("encode failed");
            },
            release: raster.release.bind(raster),
          };
        },
      };
      return transcodeImage(source, plan, wrapped);
    };
    const out = await prepareImage(blobOf(jpeg), "balanced", failing);
    expect(out.changed).toBe(false);
    expect(stats.live).toBe(0);
  });
});

describe("estimatePreparedBytes", () => {
  it("un JPEG de 48 MP (8,6 MB) se estima en ~1 MB con «Equilibrada» y es siempre <= al original", () => {
    const h = header({ width: 8064, height: 6048, displayWidth: 8064, displayHeight: 6048 });
    const balanced = estimatePreparedBytes(h, 8_600_000, IMAGE_PRESETS.balanced);
    expect(balanced.optimized).toBeGreaterThan(500_000);
    expect(balanced.optimized).toBeLessThan(2_500_000);
    expect(balanced.unoptimized).toBe(8_600_000);
    for (const id of IMAGE_PRESET_IDS) expect(estimatePreparedBytes(h, 8_600_000, IMAGE_PRESETS[id]).optimized).toBeLessThanOrEqual(8_600_000);
    expect(estimatePreparedBytes(h, 8_600_000, IMAGE_PRESETS.original).optimized).toBe(8_600_000);
  });

  it("una foto ligera pero enorme (se reduce por tamano) nunca se estima mas pesada que su archivo", () => {
    const h = header({ width: 8000, height: 6000, displayWidth: 8000, displayHeight: 6000 });
    for (const id of ["high", "balanced", "compact"] as const) {
      expect(estimatePreparedBytes(h, 200_000, IMAGE_PRESETS[id]).optimized).toBeLessThanOrEqual(200_000);
    }
  });

  it("las estimaciones respetan el orden de los presets", () => {
    const h = header({ width: 4032, height: 3024, displayWidth: 4032, displayHeight: 3024 });
    const [high, balanced, compact] = (["high", "balanced", "compact"] as const).map((id) => estimatePreparedBytes(h, 4_000_000, IMAGE_PRESETS[id]).optimized);
    expect(high).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(compact);
  });

  it("una cabecera ilegible o desconocida estima el peso del archivo", () => {
    expect(estimatePreparedBytes(null, 1234, IMAGE_PRESETS.balanced).optimized).toBe(1234);
    expect(estimatePreparedBytes(header({ kind: "unknown", width: null, height: null, displayWidth: null, displayHeight: null }), 777, IMAGE_PRESETS.balanced).optimized).toBe(777);
  });

  it("un WebP/HEIC sin optimizar se estima como PNG (mucho mas pesado)", () => {
    const h = header({ kind: "heic", width: 4032, height: 3024, displayWidth: 4032, displayHeight: 3024 });
    const e = estimatePreparedBytes(h, 2_500_000, IMAGE_PRESETS.balanced);
    expect(e.unoptimized).toBeGreaterThan(20_000_000);
    expect(e.optimized).toBeLessThan(e.unoptimized / 5);
  });

});
