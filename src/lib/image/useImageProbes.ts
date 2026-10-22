"use client";

import { useEffect, useState } from "react";
import { probeImageFiles, type ImageProbe } from "@/lib/image/estimatePdfSize";

/** Cabecera ya leida de cada archivo (la lectura de 512 KB se hace una sola vez por archivo y sesion). */
const CACHE = new WeakMap<Blob, Promise<ImageProbe>>();

function probeOne(file: Blob): Promise<ImageProbe> {
  let cached = CACHE.get(file);
  if (!cached) {
    cached = probeImageFiles([file]).then((list) => list[0] ?? { size: file.size, header: null });
    CACHE.set(file, cached);
  }
  return cached;
}

/**
 * Cabeceras (dimensiones, formato, peso) de los archivos, leidas sin decodificar nada, de una en una. `null` mientras se
 * leen. Sirve para estimar el peso del PDF y para componer la vista previa de hojas.
 */
export function useImageProbes(files: readonly Blob[]): ImageProbe[] | null {
  const [state, setState] = useState<{ files: readonly Blob[]; probes: ImageProbe[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const probes: ImageProbe[] = [];
      for (const file of files) {
        if (cancelled) return;
        probes.push(await probeOne(file));
      }
      if (!cancelled) setState({ files, probes });
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);
  return state && state.files === files ? state.probes : null;
}
