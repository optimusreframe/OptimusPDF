import { describe, expect, it, vi } from "vitest";
import {
  UNCERTAIN_HALF_WIDTH,
  estimateFromSamples,
  estimatePdfSize,
  estimatePdfSizeSampled,
  planSamples,
  type ImageProbe,
  type PhotoSample,
} from "@/lib/image/estimatePdfSize";
import { readImageHeader } from "@/lib/image/prepareForPdf";
import { SHEET_POINTS } from "@/lib/pdf/photoGrid";

/**
 * Estimacion del peso del PDF: cabeceras (aproximacion gruesa) y MUESTRAS reales extrapoladas por pixeles. El «mundo» de estas
 * pruebas obedece la ley que se midio en fotos reales: bytes por pixel del resultado ~ k x (bytes por pixel del original)^g.
 */

const MB = 1024 * 1024;
const GRID = { perPage: 1 as const, pageSize: { width: SHEET_POINTS.a4.width, height: SHEET_POINTS.a4.height }, orientation: "auto" as const, margin: 0 };

/** Cabecera JPEG minima con las dimensiones dadas (SOI + SOF0 + EOI): suficiente para `readImageHeader`. */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}
function probe(width: number, height: number, bytes: number): ImageProbe {
  return { size: bytes, header: readImageHeader(jpegHeader(width, height)) };
}

/** Peso que daria reencodar la foto en este mundo (bytes por pixel segun lo denso que sea el original). */
function worldBytes(p: ImageProbe, outPixels: number, k: number): number {
  const header = p.header!;
  const srcPixels = (header.width as number) * (header.height as number);
  const ob = p.size / srcPixels;
  const reduction = outPixels / srcPixels;
  const gamma = Math.min(1.2, Math.max(0, 0.25 + 0.8 * Math.sqrt(Math.min(1, reduction))));
  return outPixels * k * ob ** gamma;
}

describe("planSamples", () => {
  it("elige hasta dos fotos (de menos y mas bytes por pixel) entre las que SI se reencodan", () => {
    const probes = [
      probe(8000, 6000, 9 * MB), // 0,19 B/px
      probe(8000, 6000, 14 * MB), // 0,29
      probe(8000, 6000, 20 * MB), // 0,42
      probe(8000, 6000, 11 * MB),
      probe(8000, 6000, 17 * MB),
    ];
    const picks = planSamples(probes, "balanced", GRID);
    expect(picks.length).toBe(2);
    const ordered = probes.map((p, index) => ({ index, bpp: p.size })).sort((a, b) => a.bpp - b.bpp);
    // Una de las mas ligeras y una de las mas pesadas, nunca la misma.
    expect(new Set(picks.map((p) => p.index)).size).toBe(2);
    expect(Math.min(...picks.map((p) => ordered.findIndex((o) => o.index === p.index)))).toBeLessThanOrEqual(1);
    expect(Math.max(...picks.map((p) => ordered.findIndex((o) => o.index === p.index)))).toBeGreaterThanOrEqual(3);
  });

  it("una foto sola da una muestra; ninguna foto que se reencode, ninguna muestra", () => {
    expect(planSamples([probe(8000, 6000, 9 * MB)], "balanced", GRID)).toHaveLength(1);
    // Un JPEG ligero de 12 Mpx cabe en «Alta» y pasa intacto: nada que muestrear.
    expect(planSamples([probe(4000, 3000, 800 * 1024), probe(4000, 3000, 900 * 1024)], "high", GRID)).toEqual([]);
    expect(planSamples([], "balanced", GRID)).toEqual([]);
  });

  it("«Original» no muestrea (el peso es el de las fotos)", () => {
    expect(planSamples([probe(8000, 6000, 9 * MB)], "original", GRID)).toEqual([]);
  });

  it("con varias fotos por hoja, la muestra se codifica con el tope de SU celda", () => {
    const picks = planSamples([probe(8000, 6000, 9 * MB), probe(8000, 6000, 14 * MB)], "balanced", { ...GRID, perPage: 4 });
    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
      expect(pick.fit).toBeGreaterThan(500);
      expect(pick.fit).toBeLessThan(2000);
    }
  });
});

describe("estimateFromSamples", () => {
  const probes = [
    probe(8064, 6048, 9 * MB),
    probe(8064, 6048, 12 * MB),
    probe(5712, 4284, 6 * MB),
    probe(5712, 4284, 9 * MB),
    probe(8064, 6048, 15 * MB),
    probe(5712, 4284, 7 * MB),
  ];
  const k = 0.31;

  function truth(preset: "balanced" | "compact" | "high", maxSide: number): number {
    return probes.reduce((sum, p) => {
      const w = p.header!.width as number;
      const h = p.header!.height as number;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      return sum + worldBytes(p, w * scale * (h * scale), k);
    }, 0);
  }

  it("extrapola la muestra al resto con un error de pocos %% en un lote con fotos de distinto peso", () => {
    for (const [preset, maxSide] of [["balanced", 3000], ["compact", 2200], ["high", 4096]] as const) {
      const picks = planSamples(probes, preset, GRID);
      const samples: PhotoSample[] = picks.map((pick) => {
        const w = probes[pick.index].header!.width as number;
        const h = probes[pick.index].header!.height as number;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const width = Math.round(w * scale);
        const height = Math.round(h * scale);
        return { index: pick.index, bytes: Math.round(worldBytes(probes[pick.index], width * height, k)), width, height };
      });
      const estimate = estimateFromSamples(probes, preset, GRID, samples);
      const real = truth(preset, maxSide);
      expect(Math.abs(estimate.optimizedBytes - real) / real, preset).toBeLessThan(0.1);
      expect(estimate.sampled).toBe(true);
      expect(estimate.lowBytes as number).toBeLessThanOrEqual(estimate.optimizedBytes);
      expect(estimate.highBytes as number).toBeGreaterThanOrEqual(estimate.optimizedBytes);
      expect(estimate.photos).toBe(probes.length);
      expect(estimate.sourceBytes).toBe(probes.reduce((sum, p) => sum + p.size, 0));
    }
  });

  it("si las muestras coinciden entre si, el resultado es un solo numero; si discrepan mucho, un rango", () => {
    const sample = (index: number, bytesPerPixel: number): PhotoSample => {
      const w = probes[index].header!.width as number;
      const h = probes[index].header!.height as number;
      const scale = 3000 / Math.max(w, h);
      const width = Math.round(w * scale);
      const height = Math.round(h * scale);
      return { index, bytes: Math.round(width * height * bytesPerPixel), width, height };
    };
    const picks = planSamples(probes, "balanced", GRID);
    // Mismo peso por pixel en dos fotos de densidad muy distinta: el modelo (g > 0) las ve incoherentes -> rango.
    const incoherent = estimateFromSamples(probes, "balanced", GRID, [sample(picks[0].index, 0.1), sample(picks[1].index, 0.3)]);
    expect(incoherent.uncertain).toBe(true);
    expect((incoherent.highBytes as number) - (incoherent.lowBytes as number)).toBeGreaterThan(incoherent.optimizedBytes * 2 * UNCERTAIN_HALF_WIDTH);
    // Muestras coherentes con la ley (fotos del mismo tamano): sin rango.
    const same = [probe(8064, 6048, 9 * MB), probe(8064, 6048, 12 * MB), probe(8064, 6048, 15 * MB), probe(8064, 6048, 10 * MB)];
    const coherent = estimateFromSamples(
      same,
      "balanced",
      GRID,
      planSamples(same, "balanced", GRID).map((pick) => {
        const width = 3000;
        const height = 2250;
        return { index: pick.index, bytes: Math.round(worldBytes(same[pick.index], width * height, k)), width, height };
      }),
    );
    expect(coherent.uncertain).toBe(false);
    expect((coherent.highBytes as number) - (coherent.lowBytes as number)).toBeLessThanOrEqual(coherent.optimizedBytes * 2 * UNCERTAIN_HALF_WIDTH);
  });

  it("una sola muestra no permite saber cuanto se equivoca: se da el rango", () => {
    const estimate = estimateFromSamples([probes[0]], "balanced", GRID, [{ index: 0, bytes: 700_000, width: 3000, height: 2250 }]);
    expect(estimate.uncertain).toBe(true);
  });

  it("sin muestras cae a la aproximacion gruesa: rango amplio y sampled = false", () => {
    const estimate = estimateFromSamples(probes, "balanced", GRID, []);
    expect(estimate.sampled).toBe(false);
    expect(estimate.uncertain).toBe(true);
    expect(estimate.lowBytes as number).toBeLessThan(estimate.optimizedBytes * 0.7);
    expect(estimatePdfSize(probes, "balanced", GRID).optimizedBytes).toBe(estimate.optimizedBytes);
  });

  it("una foto que reencodada no ahorraria el 15 %% se conserva: nunca se estima mas que el original", () => {
    const light = probe(4000, 3000, 380 * 1024); // 0,03 B/px: ya muy comprimida
    const estimate = estimateFromSamples([light], "balanced", GRID, [{ index: 0, bytes: 900_000, width: 3000, height: 2250 }]);
    expect(estimate.optimizedBytes).toBeLessThanOrEqual(light.size + 4096);
  });

  it("«Original»: el peso es exactamente el de las fotos y no hay incertidumbre", () => {
    const estimate = estimatePdfSize(probes, "original", GRID);
    expect(estimate.uncertain).toBe(false);
    expect(estimate.lowBytes).toBe(estimate.highBytes);
    expect(estimate.optimizedBytes).toBeGreaterThanOrEqual(estimate.sourceBytes);
    expect(estimate.optimizedBytes).toBeLessThan(estimate.sourceBytes + 20_000);
  });

  it("maxPhotoPixels es la foto mas grande (decide la linea de “Alta conserva mas detalle”)", () => {
    expect(estimatePdfSize(probes, "balanced", GRID).maxPhotoPixels).toBe(8064 * 6048);
  });
});

describe("estimatePdfSizeSampled", () => {
  const probes = [probe(8000, 6000, 9 * MB), probe(8000, 6000, 15 * MB), probe(6000, 4000, 7 * MB)];

  it("codifica las muestras planificadas con el ejecutor y estima con ellas", async () => {
    const runner = vi.fn(async (index: number, fit: number | undefined) => {
      void fit;
      const w = probes[index].header!.width as number;
      const h = probes[index].header!.height as number;
      const scale = 3000 / Math.max(w, h);
      const width = Math.round(w * scale);
      const height = Math.round(h * scale);
      return { bytes: Math.round(width * height * 0.15), width, height };
    });
    const estimate = await estimatePdfSizeSampled(probes, "balanced", GRID, runner);
    expect(runner).toHaveBeenCalledTimes(planSamples(probes, "balanced", GRID).length);
    expect(estimate.sampled).toBe(true);
    expect(estimate.optimizedBytes).toBeGreaterThan(0);
  });

  it("si una muestra falla (lanza o da null) no impide estimar: cae a la aproximacion gruesa", async () => {
    const throwing = await estimatePdfSizeSampled(probes, "balanced", GRID, async () => {
      throw new Error("sin canvas");
    });
    expect(throwing.sampled).toBe(false);
    const nulls = await estimatePdfSizeSampled(probes, "balanced", GRID, async () => null);
    expect(nulls.sampled).toBe(false);
    expect(nulls.optimizedBytes).toBe(estimatePdfSize(probes, "balanced", GRID).optimizedBytes);
  });

  it("deja de codificar muestras cuando se cancela", async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => {
      controller.abort();
      return { bytes: 500_000, width: 3000, height: 2250 };
    });
    await estimatePdfSizeSampled(probes, "balanced", GRID, runner, controller.signal);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
