import { describe, expect, it } from "vitest";
import {
  AUTO_CAPTURE_STABLE_MS,
  LIVE_SAMPLE_WIDTH,
  analyzeLiveFrame,
  createFrameTracker,
  minCoverageFor,
  pickHint,
  readFrame,
  resetFrameTracker,
  type FrameReading,
} from "@/lib/scan/liveFrame";
import type { Rgba } from "@/lib/scan/pixels";
import type { QuadCorners } from "@/lib/scan/perspective";
import { detectLiveQuad, convexHull, circumscribedQuad } from "@/lib/scan/liveDetect";

/** Fotograma sintetico de 320 x 240: escritorio oscuro con una hoja clara con lineas de texto. */
function frame(options: { paper?: [number, number, number]; box?: [number, number, number, number]; text?: boolean; noise?: number; shift?: number; blur?: boolean; glare?: boolean } = {}): Rgba {
  const width = 320;
  const height = 240;
  const [x0, y0, x1, y1] = (options.box ?? [70, 30, 250, 210]).map((v, i) => v + (i % 2 === 0 ? (options.shift ?? 0) : 0)) as [number, number, number, number];
  const paper = options.paper ?? [235, 232, 225];
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      let v: [number, number, number] = inside ? paper : [50, 52, 58];
      if (inside && options.text !== false) {
        const row = (y - y0) % 14;
        if (row >= 5 && row < 8 && x > x0 + 12 && x < x1 - 12 && (x - x0) % 9 < 6) v = [28, 28, 32];
      }
      if (options.blur && inside) {
        const t = ((y - y0) % 14) / 14;
        v = [paper[0] - 40 * Math.sin(t * Math.PI), paper[1] - 40 * Math.sin(t * Math.PI), paper[2] - 40 * Math.sin(t * Math.PI)];
      }
      if (options.glare && inside && (x - 160) ** 2 + (y - 120) ** 2 < 55 ** 2) v = [255, 255, 255];
      const n = (rand() - 0.5) * (options.noise ?? 0);
      data.set([v[0] + n, v[1] + n, v[2] + n, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

describe("detectLiveQuad — src/lib/scan/liveDetect.ts", () => {
  it("encuentra una hoja clara sobre fondo oscuro con esquinas normalizadas", () => {
    const found = detectLiveQuad(frame());
    expect(found).not.toBeNull();
    const { quad } = found as NonNullable<typeof found>;
    expect(quad.topLeft.x).toBeCloseTo(70 / 320, 1);
    expect(quad.topLeft.y).toBeCloseTo(30 / 240, 1);
    expect(quad.bottomRight.x).toBeCloseTo(250 / 320, 1);
    expect(quad.bottomRight.y).toBeCloseTo(210 / 240, 1);
    expect((found as NonNullable<typeof found>).confidence).toBeGreaterThan(0.8);
  });

  it("un fotograma liso o con la hoja diminuta no da cuadrilatero", () => {
    expect(detectLiveQuad({ data: new Uint8ClampedArray(320 * 240 * 4).fill(128), width: 320, height: 240 })).toBeNull();
    expect(detectLiveQuad(frame({ box: [150, 110, 170, 130] }))).toBeNull();
  });

  it("casco convexo y cuadrilatero circunscrito de un rectangulo con ruido en los lados", () => {
    const points = [];
    for (let x = 0; x <= 20; x += 1) points.push({ x, y: 0 + (x % 3 === 0 ? 0.2 : 0) }, { x, y: 10 });
    for (let y = 0; y <= 10; y += 1) points.push({ x: 0, y }, { x: 20, y });
    const hull = convexHull(points);
    expect(hull.length).toBeGreaterThanOrEqual(4);
    const quad = circumscribedQuad(hull);
    expect(quad).not.toBeNull();
    expect((quad as NonNullable<typeof quad>).length).toBe(4);
  });
});

describe("readFrame — veredicto sin estado", () => {
  it("una hoja nitida y luminosa: documento, cobertura razonable, sin brillo ni oscuridad", () => {
    const reading = readFrame(frame());
    expect(reading.quad).not.toBeNull();
    expect(reading.coverage).toBeGreaterThan(0.4);
    expect(reading.blurry).toBe(false);
    expect(reading.glare).toBe(false);
    expect(reading.dark).toBe(false);
    expect(reading.cutOff).toBe(false);
  });

  it("papel quemado = brillo; papel oscuro = oscuro; hoja sin texto nitido (borrosa) = borrosa", () => {
    expect(readFrame(frame({ glare: true })).glare).toBe(true);
    expect(readFrame(frame({ paper: [75, 72, 68] })).dark).toBe(true);
    expect(readFrame(frame({ blur: true })).blurry).toBe(true);
  });

  it("un fotograma mas ancho que la muestra se reduce a LIVE_SAMPLE_WIDTH antes de analizarlo", () => {
    const big = frame();
    const doubled: Rgba = { data: new Uint8ClampedArray(640 * 480 * 4), width: 640, height: 480 };
    for (let y = 0; y < 480; y += 1) for (let x = 0; x < 640; x += 1) doubled.data.set(big.data.subarray(((y >> 1) * 320 + (x >> 1)) * 4, ((y >> 1) * 320 + (x >> 1)) * 4 + 4), (y * 640 + x) * 4);
    const reading = readFrame(doubled);
    expect(reading.gray.width).toBe(LIVE_SAMPLE_WIDTH);
    expect(reading.quad).not.toBeNull();
  });

  it("modo foto: no se busca documento (quad null) y la luz se juzga sin pedir hoja", () => {
    const reading = readFrame(frame({ paper: [120, 120, 120] }), "photo");
    expect(reading.quad).toBeNull();
    expect(reading.dark).toBe(false);
    expect(readFrame({ data: new Uint8ClampedArray(320 * 240 * 4).fill(10), width: 320, height: 240 }, "photo").dark).toBe(true);
  });
});

describe("pickHint — una sola guia, por prioridad", () => {
  const base: FrameReading = { quad: {} as QuadCorners, confidence: 1, coverage: 0.6, blurry: false, sharpness: 0.5, glare: false, dark: false, cutOff: false, gray: { data: new Uint8Array(1), width: 1, height: 1 } };
  it("prioridad: sin documento > poca luz > brillo > alejarse > acercarse > firme > ok", () => {
    expect(pickHint({ ...base, quad: null }, true)).toBe("no_document");
    expect(pickHint({ ...base, dark: true, glare: true, blurry: true }, false)).toBe("too_dark");
    expect(pickHint({ ...base, glare: true, blurry: true }, false)).toBe("glare");
    expect(pickHint({ ...base, cutOff: true, coverage: 0.5 }, false)).toBe("move_away");
    expect(pickHint({ ...base, coverage: 0.98 }, true)).toBe("move_away");
    expect(pickHint({ ...base, coverage: 0.1 }, true)).toBe("move_closer");
    expect(pickHint({ ...base, blurry: true }, true)).toBe("hold_steady");
    expect(pickHint(base, false)).toBe("hold_steady");
    expect(pickHint(base, true)).toBe("ok");
  });

  it("la cobertura minima baja para tarjetas y recibos; en modo foto solo importa la luz y la quietud", () => {
    expect(minCoverageFor("document")).toBeGreaterThan(minCoverageFor("id-card"));
    expect(minCoverageFor("id-card")).toBeGreaterThan(minCoverageFor("receipt"));
    expect(pickHint({ ...base, coverage: 0.2 }, true, "id-card")).toBe("ok");
    expect(pickHint({ ...base, coverage: 0.2 }, true, "document")).toBe("move_closer");
    expect(pickHint({ ...base, quad: null }, true, "photo")).toBe("ok");
    expect(pickHint({ ...base, quad: null, dark: true }, true, "photo")).toBe("too_dark");
    expect(pickHint({ ...base, quad: null }, false, "photo")).toBe("hold_steady");
  });
});

describe("analyzeLiveFrame — estabilidad temporal y captura automatica", () => {
  const run = (frames: Rgba[], stepMs = 150, options?: { mode?: "photo" }) => {
    const tracker = createFrameTracker();
    let previous: { quad: QuadCorners | null; at: number } | undefined;
    return frames.map((f, i) => {
      const now = 5000 + i * stepMs;
      const verdict = analyzeLiveFrame(f, tracker, previous, now, options);
      previous = { quad: verdict.quad, at: now };
      return verdict;
    });
  };

  it("quieto: no dispara antes de AUTO_CAPTURE_STABLE_MS y si despues; la guia pasa de 'firme' a 'ok'", () => {
    const verdicts = run(Array.from({ length: 8 }, () => frame({ noise: 4 })));
    expect(verdicts[0].stable).toBe(false);
    expect(verdicts[0].hint).toBe("hold_steady");
    for (const v of verdicts.filter((x) => x.stableMs < AUTO_CAPTURE_STABLE_MS)) expect(v.shouldAutoCapture).toBe(false);
    const first = verdicts.findIndex((v) => v.shouldAutoCapture);
    expect(first).toBeGreaterThan(0);
    expect(verdicts[first].stableMs).toBeGreaterThanOrEqual(AUTO_CAPTURE_STABLE_MS);
    expect(verdicts.at(-1)?.hint).toBe("ok");
    expect(verdicts.at(-1)?.stable).toBe(true);
  });

  it("con movimiento (la hoja se desplaza cada fotograma) nunca dispara y reinicia la quietud", () => {
    const verdicts = run(Array.from({ length: 8 }, (_, i) => frame({ shift: (i % 2) * 14 })));
    expect(verdicts.every((v) => !v.shouldAutoCapture)).toBe(true);
    expect(verdicts.every((v) => v.stableMs === 0)).toBe(true);
  });

  it("la quietud exige las DOS medidas: el encuadre quieto (esquinas) Y la imagen quieta (movimiento)", () => {
    const f = frame();
    // Imagen identica (movimiento 0) pero la interfaz dice que el encuadre anterior estaba lejos: NO es quietud.
    const tracker = createFrameTracker();
    const first = analyzeLiveFrame(f, tracker, undefined, 1000);
    const shifted = { quad: { ...(first.quad as QuadCorners), topLeft: { x: 0.5, y: 0.5 } }, at: 1000 };
    expect(analyzeLiveFrame(f, tracker, shifted, 1150).stable).toBe(false);
    // Esquinas iguales pero la imagen cambio mucho (movimiento alto): tampoco.
    const second = createFrameTracker();
    analyzeLiveFrame(f, second, undefined, 1000);
    const bright = frame({ paper: [255, 255, 255] });
    for (let i = 0; i < bright.data.length; i += 4) if (bright.data[i] === 50) bright.data[i] = bright.data[i + 1] = bright.data[i + 2] = 180;
    expect(analyzeLiveFrame(bright, second, undefined, 1150).stable).toBe(false);
    // Y con las dos medidas quietas, si.
    const third = createFrameTracker();
    analyzeLiveFrame(f, third, undefined, 1000);
    expect(analyzeLiveFrame(f, third, undefined, 1150).stable).toBe(true);
  });

  it("si se mueve a mitad, la cuenta vuelve a cero", () => {
    const frames = [...Array.from({ length: 6 }, () => frame()), frame({ shift: 20 }), ...Array.from({ length: 2 }, () => frame({ shift: 20 }))];
    const verdicts = run(frames);
    expect(verdicts[5].stableMs).toBeGreaterThan(0);
    expect(verdicts[6].stableMs).toBe(0);
    expect(verdicts[6].shouldAutoCapture).toBe(false);
  });

  it("borroso, con brillo o a oscuras: estable pero NO dispara", () => {
    for (const f of [frame({ blur: true }), frame({ glare: true }), frame({ paper: [70, 68, 64] })]) {
      const verdicts = run(Array.from({ length: 8 }, () => f));
      expect(verdicts.every((v) => !v.shouldAutoCapture)).toBe(true);
    }
    expect(run(Array.from({ length: 3 }, () => frame({ glare: true }))).at(-1)?.hint).toBe("glare");
    expect(run(Array.from({ length: 3 }, () => frame({ paper: [70, 68, 64] }))).at(-1)?.hint).toBe("too_dark");
  });

  it("sin documento: 'no_document', sin cuadrilatero ni captura", () => {
    const verdicts = run(Array.from({ length: 6 }, () => ({ data: new Uint8ClampedArray(320 * 240 * 4).fill(120), width: 320, height: 240 })));
    expect(verdicts.every((v) => v.quad === null && v.hint === "no_document" && !v.shouldAutoCapture && v.stableMs === 0)).toBe(true);
  });

  it("una pausa larga (pestana en segundo plano) reinicia la quietud; resetFrameTracker tambien", () => {
    const tracker = createFrameTracker();
    const f = frame();
    for (let i = 0; i < 6; i += 1) analyzeLiveFrame(f, tracker, undefined, 1000 + i * 150);
    expect(tracker.stableSince).not.toBeNull();
    const after = analyzeLiveFrame(f, tracker, undefined, 1000 + 5 * 150 + 5000);
    expect(after.stableMs).toBe(0);
    resetFrameTracker(tracker);
    expect(tracker.lastAt).toBeNull();
    expect(tracker.stableSince).toBeNull();
  });

  it("modo foto: se dispara por quietud y luz, sin documento, y nunca devuelve cuadrilatero", () => {
    const verdicts = run(Array.from({ length: 8 }, () => frame({ paper: [120, 120, 120] })), 150, { mode: "photo" });
    expect(verdicts.every((v) => v.quad === null)).toBe(true);
    expect(verdicts.at(-1)?.shouldAutoCapture).toBe(true);
    expect(verdicts[0].shouldAutoCapture).toBe(false);
  });

  it("anti doble disparo: tras reiniciar el tracker (la interfaz lo hace al capturar) no vuelve a disparar hasta otros 700 ms", () => {
    const tracker = createFrameTracker();
    const f = frame();
    let now = 2000;
    let fired = 0;
    for (let i = 0; i < 6; i += 1) {
      if (analyzeLiveFrame(f, tracker, undefined, now).shouldAutoCapture) {
        fired += 1;
        resetFrameTracker(tracker);
      }
      now += 150;
    }
    expect(fired).toBe(1);
  });
});
