"use client";

import { useMemo } from "react";
import { isIosWebKit } from "@/lib/image/platform";
import { useImageProbes } from "@/lib/image/useImageProbes";
import { useImageProblems } from "@/lib/image/useImageProblems";
import type { ConvertProblem } from "@/lib/media/image/convert";
import { limitsFor } from "@/lib/media/image/sizing";

export type ConverterProblemEntry = { file: File; problem: ConvertProblem };

/**
 * Imagenes de `files` que no se podran convertir, en el orden de la lista, ANTES de pulsar «Convertir»: vacias, que no son
 * imagen, incompletas, danadas o HEIC que este navegador no abre (las comprueba el mismo trabajo de las miniaturas, que ya se
 * hace una vez por archivo), y las que pesan o miden mas de lo que este dispositivo se atreve a abrir. `failed` son las que
 * fallaron en la ultima conversion (solo cuentan si siguen en la lista).
 */
export function useConverterProblems(files: readonly File[], failed: readonly ConverterProblemEntry[]): ConverterProblemEntry[] {
  const structural = useImageProblems(files);
  const probes = useImageProbes(files);
  return useMemo(() => {
    const limits = limitsFor(isIosWebKit());
    const byFile = new Map<File, ConvertProblem>();
    for (const entry of failed) if (files.includes(entry.file)) byFile.set(entry.file, entry.problem);
    files.forEach((file, index) => {
      const header = probes?.[index]?.header;
      if (header?.displayWidth && header.displayHeight && header.displayWidth * header.displayHeight > limits.maxInputPixels) byFile.set(file, "tooManyPixels");
      if (file.size > limits.maxFileBytes) byFile.set(file, "tooBig");
    });
    for (const entry of structural) byFile.set(entry.file, entry.problem);
    return files.filter((file) => byFile.has(file)).map((file) => ({ file, problem: byFile.get(file) as ConvertProblem }));
  }, [files, failed, probes, structural]);
}
