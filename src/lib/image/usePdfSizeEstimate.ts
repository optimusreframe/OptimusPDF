"use client";

import { useEffect, useMemo, useState } from "react";
import { estimatePdfSizeSampled, HIGH_DETAIL_PIXELS, type ImageProbe, type PdfSizeEstimate, type SampleRunner } from "@/lib/image/estimatePdfSize";
import { createPrepareSession, type PrepareSession } from "@/lib/image/prepareBrowser";
import type { ImagePresetId } from "@/lib/image/prepareForPdf";
import { useImageProbes } from "@/lib/image/useImageProbes";
import type { PhotoGridOptions } from "@/lib/pdf/photoGrid";

type Grid = Omit<PhotoGridOptions, "margin"> & { margin: number };

/** Resultado de codificar una foto de muestra, recordado por foto, calidad y tamano de celda (cambiar de calidad y volver es instantaneo). */
const SAMPLES = new WeakMap<Blob, Map<string, { bytes: number; width: number; height: number } | null>>();

/** Ejecutor de muestras que reutiliza UNA sesion (un worker) para todas las de una estimacion; `done()` la cierra. */
function sampleRunner(files: readonly Blob[], preset: ImagePresetId, signal: AbortSignal): { run: SampleRunner; done: () => void } {
  let session: PrepareSession | null = null;
  const run: SampleRunner = async (index, fit) => {
    const file = files[index];
    const key = `${preset}:${fit === undefined ? "full" : Math.round(fit / 20)}`;
    let byKey = SAMPLES.get(file);
    if (!byKey) {
      byKey = new Map();
      SAMPLES.set(file, byKey);
    }
    if (byKey.has(key)) return byKey.get(key) ?? null;
    session ??= createPrepareSession();
    const prepared = await session.prepare(file, preset, signal, fit);
    const encoded = prepared.encoded ?? (prepared.changed && prepared.width && prepared.height ? { bytes: prepared.bytes.byteLength, width: prepared.width, height: prepared.height } : null);
    if (!signal.aborted) byKey.set(key, encoded);
    return encoded;
  };
  return {
    run,
    done: () => {
      session?.dispose();
      session = null;
    },
  };
}

export type PdfSizeEstimateState = {
  /** Estimacion con la calidad elegida; `null` mientras se calcula. */
  estimate: PdfSizeEstimate | null;
  /** Peso central estimado con «Alta», solo si alguna foto pasa de 12 Mpx y la calidad elegida no es «Alta» ni «Original». */
  highDetailBytes: number | null;
};

/**
 * Estimacion del peso del PDF de `files` con la calidad y la composicion dadas: lee las cabeceras (sin decodificar) y codifica
 * 1-2 fotos de muestra con el motor real (`estimatePdfSizeSampled`). Se recalcula (cancelando el calculo anterior) al
 * cambiar las fotos, la calidad o las fotos por hoja. Con calidad «Original» no hay nada que muestrear.
 */
export function usePdfSizeEstimate(files: readonly Blob[], preset: ImagePresetId, grid: Grid): PdfSizeEstimateState {
  const probes = useImageProbes(files);
  const gridKey = `${grid.perPage}|${grid.pageSize.width}x${grid.pageSize.height}|${grid.orientation}|${grid.margin}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `grid` se resume en `gridKey`
  const stableGrid = useMemo(() => grid, [gridKey]);
  const [state, setState] = useState<{ key: object; value: PdfSizeEstimateState } | null>(null);
  const key = useMemo(() => ({}), [probes, preset, stableGrid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!probes) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const run = async (list: readonly ImageProbe[], quality: ImagePresetId): Promise<PdfSizeEstimate> => {
        const runner = sampleRunner(files, quality, signal);
        try {
          return await estimatePdfSizeSampled(list, quality, stableGrid, runner.run, signal);
        } finally {
          runner.done();
        }
      };
      const estimate = await run(probes, preset);
      if (signal.aborted) return;
      setState({ key, value: { estimate, highDetailBytes: null } });
      if (preset !== "high" && preset !== "original" && (estimate.maxPhotoPixels ?? 0) > HIGH_DETAIL_PIXELS) {
        const high = await run(probes, "high");
        if (signal.aborted) return;
        setState({ key, value: { estimate, highDetailBytes: high.optimizedBytes } });
      }
    })();
    return () => controller.abort();
  }, [probes, preset, stableGrid, files, key]);

  return state && state.key === key ? state.value : { estimate: null, highDetailBytes: null };
}
