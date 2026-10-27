import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_KINDS,
  CALIBRATION_MEAN_TOLERANCE,
  CALIBRATION_REFERENCE,
  CALIBRATION_REFERENCES,
  CALIBRATION_SIZE,
  CALIBRATION_TOLERANCE,
  MIN_CALIBRATED_QUALITY,
  calibrationPixels,
  calibrationSize,
  geometricMeanRatio,
  pickCalibratedQuality,
  referenceBytesFor,
} from "@/lib/image/jpegCalibration";

/** Calibracion del codificador JPEG: un codificador que pesa mas que Chromium con la misma calidad se corrige a la baja. */

/** Un codificador de juguete: pesa `scale` veces lo de referencia a cada calidad (crece con la calidad). */
const encoderWeighing = (scale: number) => async (quality: number) => referenceBytesFor(quality) * scale;

describe("referenceBytesFor", () => {
  it("devuelve el punto medido y interpola entre dos puntos", () => {
    for (const [quality, bytes] of CALIBRATION_REFERENCE) expect(referenceBytesFor(quality)).toBe(bytes);
    const [q0, b0] = CALIBRATION_REFERENCE[3];
    const [q1, b1] = CALIBRATION_REFERENCE[4];
    expect(referenceBytesFor((q0 + q1) / 2)).toBeCloseTo((b0 + b1) / 2, 6);
  });

  it("fuera de rango se queda en el extremo y es creciente con la calidad", () => {
    expect(referenceBytesFor(0.1)).toBe(CALIBRATION_REFERENCE[0][1]);
    expect(referenceBytesFor(1)).toBe(CALIBRATION_REFERENCE[CALIBRATION_REFERENCE.length - 1][1]);
    let previous = 0;
    for (let q = 0.5; q <= 0.95; q += 0.01) {
      const bytes = referenceBytesFor(q);
      expect(bytes).toBeGreaterThanOrEqual(previous);
      previous = bytes;
    }
  });

  it("sin tabla no hay referencia (no se corrige nada)", () => {
    expect(referenceBytesFor(0.87, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("pickCalibratedQuality", () => {
  it("un codificador como el de referencia (o hasta un 12 % mas pesado) conserva la calidad pedida", async () => {
    for (const scale of [1, 1.05, CALIBRATION_TOLERANCE]) {
      expect(await pickCalibratedQuality(0.87, referenceBytesFor(0.87), encoderWeighing(scale))).toBe(0.87);
    }
  });

  it("un codificador que pesa 2 veces mas baja la calidad hasta igualar el peso de referencia, sin pasarse del limite", async () => {
    const measure = encoderWeighing(2);
    const quality = await pickCalibratedQuality(0.87, referenceBytesFor(0.87), measure);
    expect(quality).toBeLessThan(0.87);
    expect(quality).toBeGreaterThanOrEqual(MIN_CALIBRATED_QUALITY);
    expect(await measure(quality)).toBeLessThanOrEqual(referenceBytesFor(0.87) * CALIBRATION_TOLERANCE);
    // Y es la mas alta que cumple (un poco mas arriba ya se pasaria del limite).
    expect(await measure(quality + 0.02)).toBeGreaterThan(referenceBytesFor(0.87) * CALIBRATION_TOLERANCE * 0.97);
  });

  it("si ni la calidad minima cabe, devuelve la minima; nunca baja de ella", async () => {
    expect(await pickCalibratedQuality(0.9, 1000, async () => 1e9)).toBe(MIN_CALIBRATED_QUALITY);
    // Y esa minima son 0,5: por debajo un JPEG se ve mal.
    expect(MIN_CALIBRATED_QUALITY).toBe(0.5);
  });

  it("sin referencia finita no toca la calidad y no mide nada", async () => {
    let calls = 0;
    const quality = await pickCalibratedQuality(0.8, Number.POSITIVE_INFINITY, async () => {
      calls += 1;
      return 1;
    });
    expect(quality).toBe(0.8);
    expect(calls).toBe(0);
  });

  it("mide un numero acotado de veces (no recorre todas las calidades)", async () => {
    let calls = 0;
    await pickCalibratedQuality(0.92, referenceBytesFor(0.92), async (q) => {
      calls += 1;
      return referenceBytesFor(q) * 2;
    });
    expect(calls).toBeLessThanOrEqual(9);
  });
});

describe("calibrationPixels", () => {
  it("es determinista, opaca y de tamano fijo", () => {
    const a = calibrationPixels();
    const b = calibrationPixels();
    expect(a.length).toBe(CALIBRATION_SIZE * CALIBRATION_SIZE * 4);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    for (let index = 3; index < a.length; index += 4) expect(a[index]).toBe(255);
  });

  it("codificada a JPEG pesa lo que pesa una foto (varios KB) y crece con la calidad", () => {
    const canvas = createCanvas(CALIBRATION_SIZE, CALIBRATION_SIZE);
    const context = canvas.getContext("2d");
    const image = context.createImageData(CALIBRATION_SIZE, CALIBRATION_SIZE);
    image.data.set(calibrationPixels());
    context.putImageData(image, 0, 0);
    const sizes = [60, 80, 92].map((quality) => canvas.toBuffer("image/jpeg", quality).length);
    expect(sizes[0]).toBeGreaterThan(5_000);
    expect(sizes[0]).toBeLessThan(sizes[1]);
    expect(sizes[1]).toBeLessThan(sizes[2]);
  });
});

describe("tres imagenes de prueba con contenido distinto (media geometrica)", () => {
  it("cada imagen es determinista, opaca y de su tamano; las tres son distintas entre si", () => {
    const seen = new Set<string>();
    for (const kind of CALIBRATION_KINDS) {
      const a = calibrationPixels(kind);
      const b = calibrationPixels(kind);
      expect(a.length).toBe(calibrationSize(kind) ** 2 * 4);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), kind).toBe(0);
      for (let index = 3; index < a.length; index += 4) expect(a[index]).toBe(255);
      seen.add(Buffer.from(a).subarray(0, 4096).toString("base64"));
    }
    expect(seen.size).toBe(3);
  });

  it("la lisa pesa mucho menos que la de textura (cubren los dos extremos del contenido de una foto)", () => {
    const weigh = (kind: (typeof CALIBRATION_KINDS)[number]): number => {
      const size = calibrationSize(kind);
      const canvas = createCanvas(size, size);
      const context = canvas.getContext("2d");
      const image = context.createImageData(size, size);
      image.data.set(calibrationPixels(kind));
      context.putImageData(image, 0, 0);
      return canvas.toBuffer("image/jpeg", 87).length;
    };
    expect(weigh("smooth")).toBeLessThan(weigh("mixed") * 0.6);
    expect(weigh("texture")).toBeGreaterThan(weigh("mixed") * 0.9);
  });

  it("las tablas de referencia de las tres imagenes crecen con la calidad", () => {
    for (const kind of CALIBRATION_KINDS) {
      const table = CALIBRATION_REFERENCES[kind];
      expect(table.length).toBe(CALIBRATION_REFERENCE.length);
      for (let index = 1; index < table.length; index += 1) {
        expect(table[index][0]).toBeGreaterThan(table[index - 1][0]);
        expect(table[index][1], kind).toBeGreaterThan(table[index - 1][1]);
      }
    }
  });

  it("geometricMeanRatio: 1 si pesan lo de la referencia, el factor comun si pesan todas k veces, e Infinity sin datos", () => {
    const reference = Object.fromEntries(CALIBRATION_KINDS.map((kind) => [kind, referenceBytesFor(0.87, CALIBRATION_REFERENCES[kind])])) as Record<(typeof CALIBRATION_KINDS)[number], number>;
    expect(geometricMeanRatio(0.87, reference)).toBeCloseTo(1, 9);
    const doubled = Object.fromEntries(CALIBRATION_KINDS.map((kind) => [kind, reference[kind] * 2])) as typeof reference;
    expect(geometricMeanRatio(0.87, doubled)).toBeCloseTo(2, 9);
    // La media es geometrica: x0,5 en una y x2 en otra se compensan.
    const mixed = { ...reference, mixed: reference.mixed * 2, smooth: reference.smooth / 2 };
    expect(geometricMeanRatio(0.87, mixed)).toBeCloseTo(1, 9);
    expect(geometricMeanRatio(0.87, { ...reference, smooth: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("un codificador que pesa 2x en las tres baja la calidad hasta igualar la media; con el resultado entre 1 y la tolerancia", async () => {
    const measure = async (quality: number): Promise<number> =>
      geometricMeanRatio(
        0.87,
        Object.fromEntries(CALIBRATION_KINDS.map((kind) => [kind, referenceBytesFor(quality, CALIBRATION_REFERENCES[kind]) * 2])) as Record<(typeof CALIBRATION_KINDS)[number], number>,
      );
    const quality = await pickCalibratedQuality(0.87, 1, measure, CALIBRATION_MEAN_TOLERANCE);
    expect(quality).toBeLessThan(0.87);
    expect(await measure(quality)).toBeLessThanOrEqual(CALIBRATION_MEAN_TOLERANCE);
    expect(CALIBRATION_MEAN_TOLERANCE).toBeLessThan(CALIBRATION_TOLERANCE);
  });
});
