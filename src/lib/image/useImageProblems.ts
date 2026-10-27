"use client";

import { useEffect, useState } from "react";
import type { ImageProblem } from "@/lib/image/imageIntegrity";
import { getThumbnailInfo } from "@/lib/image/thumbnail";

export type ImageProblemEntry = { file: File; problem: ImageProblem };

/**
 * Fotos de `files` que NO se pueden usar (vacias, que no son una imagen, incompletas, danadas, HEIC que este navegador no
 * abre), en el orden de `files`. Comparte el trabajo con las miniaturas (`getThumbnailInfo`: una sola lectura por archivo, en
 * un worker y en cola), asi que la lista se va completando a medida que se miran las fotos; una foto que se quita de
 * `files` desaparece de la lista.
 */
export function useImageProblems(files: readonly File[]): ImageProblemEntry[] {
  const [found, setFound] = useState<ReadonlyMap<File, ImageProblem>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const file of files) {
        if (cancelled) return;
        const info = await getThumbnailInfo(file);
        if (cancelled) return;
        if (info.problem) setFound((previous) => (previous.get(file) === info.problem ? previous : new Map(previous).set(file, info.problem as ImageProblem)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [files]);

  const entries: ImageProblemEntry[] = [];
  for (const file of files) {
    const problem = found.get(file);
    if (problem) entries.push({ file, problem });
  }
  return entries;
}
