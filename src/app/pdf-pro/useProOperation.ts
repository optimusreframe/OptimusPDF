"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { PdfErrorCode } from "@/lib/pdf/core";
import { createProRunner, type ProRunner } from "@/app/pdf-pro/proAdapter";
import { proOperationLabel, proWarningText } from "@/app/pdf-pro/proStrings";
import { useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import type { ProOperation, ProSnapshot, ProWarning } from "@/app/pdf-pro/proTypes";

/**
 * Ejecuta operaciones sobre el snapshot ACTUAL del documento de trabajo y confirma el resultado
 * como un snapshot nuevo (Wave 7 · U2). Estado para la interfaz: progreso 0..1, error tipado
 * (`PdfErrorCode`, que `errorCopy` traduce) y avisos de la ultima ejecucion.
 *
 * Reglas:
 *  - una sola ejecucion a la vez (lanzar otra o `cancel()` descarta el resultado de la anterior);
 *  - si el snapshot actual cambia mientras corre (deshacer, otra operacion), el resultado ya no
 *    aplica y se descarta sin commit;
 *  - una operacion que devuelve el aviso `unchanged` NO crea snapshot.
 */
export type ProOperationRunState = {
  status: "idle" | "running";
  progress: number;
  error: PdfErrorCode | null;
  cancelled: boolean;
  warnings: ProWarning[];
  /** Informe de la ultima ejecucion terminada (`ProOperationResult.report`), p. ej. el ahorro de Comprimir. */
  report: unknown;
};

export type ProApplyResult =
  | { ok: true; snapshot: ProSnapshot | null; warnings: ProWarning[]; report?: unknown }
  | { ok: false; cancelled: boolean; code: PdfErrorCode };

const IDLE: ProOperationRunState = {
  status: "idle",
  progress: 0,
  error: null,
  cancelled: false,
  warnings: [],
  report: null,
};

export function useProOperation(explicit?: ProWorkingDoc) {
  const doc = useProWorkingDocInstance(explicit);
  const { language } = useI18n();
  const runnerRef = useRef<ProRunner | null>(null);
  const mountedRef = useRef(true);
  const [state, setState] = useState<ProOperationRunState>(IDLE);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runnerRef.current?.cancel();
    };
  }, []);

  const update = useCallback((next: Partial<ProOperationRunState>) => {
    if (mountedRef.current) setState((previous) => ({ ...previous, ...next }));
  }, []);

  const apply = useCallback(
    async <TOptions,>(
      operation: ProOperation<TOptions>,
      options: TOptions,
      applyOptions: { label?: string } = {},
    ): Promise<ProApplyResult> => {
      const startSnapshot = doc.currentSnapshot();
      if (!startSnapshot) return { ok: false, cancelled: false, code: "empty" };
      runnerRef.current ??= createProRunner();
      update({ status: "running", progress: 0, error: null, cancelled: false, warnings: [], report: null });

      const outcome = await runnerRef.current.run(operation, startSnapshot.bytes, options, {
        lang: language,
        onProgress: (progress) => update({ progress }),
      });

      if (outcome.stale || (!outcome.ok && outcome.cancelled)) {
        update({ ...IDLE, cancelled: true });
        return { ok: false, cancelled: true, code: "cancelled" };
      }
      if (!outcome.ok) {
        update({ ...IDLE, error: outcome.code });
        return { ok: false, cancelled: false, code: outcome.code };
      }
      // Entretanto se deshizo, se cerro o se aplico otra cosa: este resultado ya no corresponde.
      if (doc.currentSnapshot()?.id !== startSnapshot.id) {
        update({ ...IDLE, cancelled: true });
        return { ok: false, cancelled: true, code: "cancelled" };
      }
      if (outcome.warnings.some((warning) => warning.code === "unchanged")) {
        update({ ...IDLE, warnings: outcome.warnings, report: outcome.report ?? null });
        const unchanged = outcome.warnings.find((warning) => warning.code === "unchanged");
        if (unchanged) doc.announce(proWarningText(language, unchanged));
        return { ok: true, snapshot: null, warnings: outcome.warnings, report: outcome.report };
      }
      const label = applyOptions.label ?? proOperationLabel(language, operation.labelKey);
      const snapshot = await doc.commit(
        outcome.bytes,
        label,
        operation.kind === "mode" ? "mode-apply" : "operation",
        {
          opId: operation.id,
          pageCount:
            outcome.pageCount ?? (operation.preservesPageCount ? startSnapshot.pageCount : undefined),
        },
      );
      update({ ...IDLE, warnings: outcome.warnings, report: outcome.report ?? null });
      return { ok: true, snapshot, warnings: outcome.warnings, report: outcome.report };
    },
    [doc, language, update],
  );

  const cancel = useCallback(() => {
    runnerRef.current?.cancel();
    update({ ...IDLE, cancelled: true });
  }, [update]);

  const clearError = useCallback(() => update({ error: null, cancelled: false }), [update]);

  return { ...state, apply, cancel, clearError };
}
