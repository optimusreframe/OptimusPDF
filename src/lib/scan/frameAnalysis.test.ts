import { describe, expect, it } from "vitest";
import {
  BRIGHTNESS_TOO_DARK_THRESHOLD,
  MOTION_STABLE_THRESHOLD,
  SHARPNESS_OK_THRESHOLD,
  analyzeFrame,
  analyzeSample,
  getCaptureHint,
  sampleFrame,
  type FrameSample,
} from "@/lib/scan/frameAnalysis";

/**
 * `analyzeSample` y `getCaptureHint` son aritmetica pura sobre un buffer
 * RGBA, asi que se prueban de punta a punta en el entorno "node" del
 * proyecto (ver vitest.config.ts) construyendo los pixeles a mano.
 *
 * `sampleFrame`/`analyzeFrame`, en cambio, necesitan Canvas 2D: en Node no
 * hay `document`, y la propia funcion lo detecta y se retira sin lanzar.
 * Ese camino de degradacion si se ejercita aqui; el escalado real del
 * fotograma solo se puede comprobar en navegador (e2e).
 */
function makeSample(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
): FrameSample {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      const gray = value(x, y);
      data[pixel] = gray;
      data[pixel + 1] = gray;
      data[pixel + 2] = gray;
      data[pixel + 3] = 255;
    }
  }
  return { data, width, height };
}

const flat = (gray: number) => makeSample(24, 18, () => gray);
const checkerboard = makeSample(24, 18, (x, y) => ((x + y) % 2 === 0 ? 255 : 0));

describe("frameAnalysis — src/lib/scan/frameAnalysis.ts", () => {
  it("una imagen plana muy oscura da brillo bajo y el consejo 'too_dark'", () => {
    const metrics = analyzeSample(flat(12));

    expect(metrics.brightness).toBeCloseTo(12, 0);
    expect(metrics.brightness).toBeLessThan(BRIGHTNESS_TOO_DARK_THRESHOLD);
    expect(getCaptureHint(metrics)).toBe("too_dark");
  });

  it("un patron de alto contraste da nitidez por encima del umbral", () => {
    const metrics = analyzeSample(checkerboard);

    expect(metrics.sharpness).toBeGreaterThan(SHARPNESS_OK_THRESHOLD);
    expect(metrics.brightness).toBeCloseTo(127.5, 0);
  });

  it("una imagen plana bien iluminada no tiene detalle: nitidez ~0", () => {
    const metrics = analyzeSample(flat(200));

    expect(metrics.sharpness).toBeCloseTo(0, 5);
    expect(getCaptureHint(metrics)).toBe("hold_steady");
  });

  it("dos fotogramas identicos dan motionDelta 0", () => {
    const metrics = analyzeSample(checkerboard, checkerboard);

    expect(metrics.motionDelta).toBe(0);
  });

  it("dos fotogramas muy distintos dan motionDelta alto", () => {
    const metrics = analyzeSample(flat(255), flat(0));

    expect(metrics.motionDelta).toBeCloseTo(255, 0);
    expect(metrics.motionDelta).toBeGreaterThan(MOTION_STABLE_THRESHOLD);
  });

  it("sin fotograma anterior no hay movimiento medible: motionDelta 0", () => {
    expect(analyzeSample(checkerboard).motionDelta).toBe(0);
  });

  it("un fotograma anterior de otro tamano se ignora en vez de dar un falso movimiento", () => {
    const other = makeSample(12, 9, () => 0);

    expect(analyzeSample(flat(255), other).motionDelta).toBe(0);
  });

  it("un fotograma nitido, iluminado y quieto da el consejo 'ok'", () => {
    expect(getCaptureHint(analyzeSample(checkerboard, checkerboard))).toBe("ok");
  });

  it("un fotograma nitido pero en movimiento da 'hold_steady'", () => {
    const moved = makeSample(24, 18, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    const metrics = analyzeSample(checkerboard, moved);

    expect(metrics.sharpness).toBeGreaterThan(SHARPNESS_OK_THRESHOLD);
    expect(getCaptureHint(metrics)).toBe("hold_steady");
  });

  it("la falta de luz manda sobre el movimiento: oscuro y movido sigue siendo 'too_dark'", () => {
    const metrics = analyzeSample(flat(5), flat(40));

    expect(metrics.motionDelta).toBeGreaterThan(MOTION_STABLE_THRESHOLD);
    expect(getCaptureHint(metrics)).toBe("too_dark");
  });

  it("un fotograma demasiado pequeno para el laplaciano no se inventa metricas", () => {
    const metrics = analyzeSample(makeSample(2, 2, () => 128));

    expect(getCaptureHint(metrics)).toBe("unknown");
  });

  it("metricas no finitas dan el consejo 'unknown'", () => {
    expect(
      getCaptureHint({ sharpness: Number.NaN, brightness: 120, motionDelta: 0 }),
    ).toBe("unknown");
  });

  it("sampleFrame sin Canvas 2D (entorno Node) devuelve null en vez de lanzar", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe(
      "undefined",
    );

    const fakeSource = {} as CanvasImageSource;
    expect(sampleFrame(fakeSource, 1920, 1080)).toBeNull();
  });

  it("sampleFrame con una fuente sin dimensiones devuelve null", () => {
    expect(sampleFrame({} as CanvasImageSource, 0, 0)).toBeNull();
  });

  it("analyzeFrame sin Canvas 2D devuelve metricas 'unknown' en vez de lanzar", () => {
    const fakeCanvas = { width: 640, height: 480 } as HTMLCanvasElement;

    expect(getCaptureHint(analyzeFrame(fakeCanvas))).toBe("unknown");
  });
});
