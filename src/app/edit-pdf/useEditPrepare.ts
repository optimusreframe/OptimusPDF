"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PdfErrorCode } from "@/lib/pdf/core";
import {
  getPreparedFor,
  prepareEditDocument,
  setPreparedFor,
  type PrepareResult,
  type PreparedDocument,
} from "@/app/edit-pdf/editPrepare";

/**
 * Estado de la preparacion del documento (Wave 5 · U5): comprobar cifrado y
 * firmas, pedir la contrasena si hace falta y entregar la copia de trabajo.
 *
 * El estado se guarda JUNTO al archivo al que pertenece: si cambia el archivo,
 * el resultado de otro se descarta sin tener que sincronizar nada en un efecto.
 */

export type PrepareState =
  | { phase: "checking" }
  | {
      phase: "password";
      /** La ultima contrasena no abrio el documento. */
      wrong: boolean;
      /** Fallo distinto de contrasena incorrecta al probar la contrasena. */
      failed: boolean;
      busy: boolean;
      /** Aumenta con cada intento fallido: devuelve el foco al campo. */
      attempt: number;
    }
  | { phase: "ready"; document: PreparedDocument }
  /** No se puede abrir (cifrado no soportado, archivo danado...): el codigo ya se publico. */
  | { phase: "blocked"; code: PdfErrorCode };

export type UseEditPrepare = {
  state: PrepareState;
  submitPassword: (password: string) => void;
};

type Stored = { file: File; state: PrepareState };

export function useEditPrepare(
  file: File,
  prepare: (file: File, password?: string) => Promise<PrepareResult> = prepareEditDocument,
  onBlocked?: (code: PdfErrorCode) => void,
): UseEditPrepare {
  const [stored, setStored] = useState<Stored | null>(() => {
    const cached = getPreparedFor(file);
    return cached ? { file, state: { phase: "ready", document: cached } } : null;
  });
  const prepareRef = useRef(prepare);
  const blockedRef = useRef(onBlocked);
  useEffect(() => {
    prepareRef.current = prepare;
    blockedRef.current = onBlocked;
  });
  /** Descarta resultados de intentos viejos (otro archivo, otro intento). */
  const runRef = useRef(0);
  /** Intentos fallidos de contrasena (devuelve el foco al campo en cada uno). */
  const attemptRef = useRef(0);

  const apply = useCallback(
    (forFile: File, result: PrepareResult) => {
      let state: PrepareState;
      switch (result.status) {
        case "ready":
          state = { phase: "ready", document: result.document };
          setPreparedFor(forFile, result.document);
          break;
        case "password":
          state = { phase: "password", wrong: false, failed: false, busy: false, attempt: attemptRef.current };
          break;
        case "wrongPassword":
          attemptRef.current += 1;
          state = {
            phase: "password",
            wrong: true,
            failed: false,
            busy: false,
            attempt: attemptRef.current,
          };
          break;
        case "unsupported":
        case "error":
          state = { phase: "blocked", code: result.code };
          blockedRef.current?.(result.code);
          break;
      }
      setStored({ file: forFile, state });
    },
    [],
  );

  useEffect(() => {
    const run = (runRef.current += 1);
    attemptRef.current = 0;
    if (getPreparedFor(file)) return; // ya preparado (el area de trabajo se desmonto y vuelve)
    void prepareRef.current(file).then(
      (result) => {
        if (runRef.current === run) apply(file, result);
      },
      () => {
        if (runRef.current === run) apply(file, { status: "error", code: "unknown" });
      },
    );
    return () => {
      // Un cambio de archivo (o desmontar) invalida lo que siga en vuelo.
      runRef.current += 1;
    };
  }, [file, apply]);

  const current = stored && stored.file === file ? stored.state : null;

  const submitPassword = useCallback(
    (password: string) => {
      const run = (runRef.current += 1);
      setStored((previous) => {
        if (!previous || previous.file !== file || previous.state.phase !== "password") return previous;
        return { file, state: { ...previous.state, busy: true, wrong: false, failed: false } };
      });
      void prepareRef.current(file, password).then(
        (result) => {
          if (runRef.current === run) apply(file, result);
        },
        () => {
          if (runRef.current !== run) return;
          attemptRef.current += 1;
          setStored({
            file,
            state: { phase: "password", wrong: false, failed: true, busy: false, attempt: attemptRef.current },
          });
        },
      );
    },
    [file, apply],
  );

  return { state: current ?? { phase: "checking" }, submitPassword };
}
