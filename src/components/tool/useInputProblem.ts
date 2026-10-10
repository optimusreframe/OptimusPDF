"use client";

import { useEffect, useRef, useState } from "react";
import { useInputGuard } from "@/components/tool/InputGuardContext";
import type { PdfErrorCode } from "@/lib/pdf/core";
import type { InputCheck } from "@/lib/pdf/inputGuard";

/**
 * Comprobacion de entrada para las herramientas con cabecera propia (Wave 6 · U5),
 * que no pasan por `ToolShell`: mira cada archivo recien elegido con la misma
 * `inputGuard` (vacio, no PDF, danado, cifrado) y devuelve el primero inservible
 * para que la herramienta bloquee «Procesar» y pinte el banner compartido.
 *
 * Un PDF cifrado cuenta como inservible (estas herramientas no tienen hoja de
 * contrasena: el banner ofrece abrir Desbloquear PDF).
 */
export type InputProblem = { file: File; code: PdfErrorCode };

function problemCode(check: InputCheck | undefined): PdfErrorCode | null {
  if (!check) return null;
  if (check.status === "problem") return check.code === "tooLarge" ? null : check.code;
  if (check.status === "encrypted") return "encrypted";
  if (check.status === "unsupported") return check.code;
  return null;
}

export type InputProblemState = {
  problem: InputProblem | null;
  /** La comprobacion de algun archivo sigue en curso (aun no hay veredicto). */
  checking: boolean;
};

export function useInputProblem(files: readonly (File | null | undefined)[]): InputProblemState {
  const guard = useInputGuard();
  const [results, setResults] = useState<ReadonlyMap<File, InputCheck>>(() => new Map());
  const startedRef = useRef(new WeakSet<File>());

  useEffect(() => {
    if (!guard) return;
    for (const file of files) {
      if (!file || startedRef.current.has(file)) continue;
      startedRef.current.add(file);
      guard(file).then(
        (check) => setResults((previous) => new Map(previous).set(file, check)),
        () => undefined,
      );
    }
  }, [files, guard]);

  const checking = !!guard && files.some((file) => !!file && !results.has(file));
  for (const file of files) {
    if (!file) continue;
    const code = problemCode(results.get(file));
    if (code) return { problem: { file, code }, checking };
  }
  return { problem: null, checking };
}
