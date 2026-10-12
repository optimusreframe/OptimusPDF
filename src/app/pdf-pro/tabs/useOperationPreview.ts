"use client";

import { useEffect, useRef, useState } from "react";
import { readFirstPagePdf } from "@/app/pdf-pro/ops/pageInfo";
import { renderPreviewDataUrl } from "@/app/pdf-pro/ops/previewRender";
import type { DocToolContext, DocToolDefinition } from "@/app/pdf-pro/tabs/docToolTypes";

export type OperationPreview =
  | { status: "none" }
  | { status: "loading" }
  | { status: "outOfRange" }
  | { status: "unavailable" }
  | { status: "ready"; url: string };

/** Espera antes de recalcular tras un cambio de opciones. */
export const PREVIEW_DEBOUNCE_MS = 350;

/** Clave estable de unas opciones (los `File` cuentan por nombre y peso). */
export function optionsKey(options: unknown): string {
  return JSON.stringify(options, (_key, value: unknown) =>
    typeof File !== "undefined" && value instanceof File ? `file:${value.name}:${value.size}:${value.lastModified}` : value,
  );
}

/**
 * Vista previa REAL del resultado: ejecuta la misma operacion sobre un PDF de una sola pagina (la primera)
 * y la dibuja. Con debounce, cancelable (un cambio nuevo descarta el calculo anterior) y sin bloquear nunca
 * «Aplicar»: si algo falla, queda `unavailable`.
 */
export function useOperationPreview<T>(
  tool: DocToolDefinition<T>,
  options: T,
  ctx: DocToolContext | null,
  enabled = true,
): OperationPreview {
  const [state, setState] = useState<{ key: string; preview: OperationPreview }>({
    key: "",
    preview: { status: "none" },
  });
  const optionsRef = useRef(options);
  const ctxRef = useRef(ctx);
  useEffect(() => {
    optionsRef.current = options;
    ctxRef.current = ctx;
  });

  const supported = enabled && ctx !== null && tool.previewOptions !== undefined;
  const key = supported && ctx ? `${ctx.snapshotId}|${optionsKey(options)}` : "";

  useEffect(() => {
    if (!supported || !tool.previewOptions) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const current = ctxRef.current;
      if (!current) return;
      const remapped = tool.previewOptions?.(optionsRef.current, current) ?? null;
      if (remapped === null) {
        if (!cancelled) setState({ key, preview: { status: "outOfRange" } });
        return;
      }
      try {
        const first = await readFirstPagePdf(current.snapshotId, current.bytes);
        if (cancelled) return;
        if (!first) {
          setState({ key, preview: { status: "unavailable" } });
          return;
        }
        const result = await tool.operation.run(first, remapped, {
          signal: controller.signal,
          onProgress: () => {},
          lang: current.language,
        });
        if (cancelled) return;
        const url = await renderPreviewDataUrl(result.bytes);
        if (cancelled) return;
        setState({ key, preview: url ? { status: "ready", url } : { status: "unavailable" } });
      } catch {
        if (!cancelled) setState({ key, preview: { status: "unavailable" } });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
    // `key` resume snapshot + opciones; `tool` es una constante del registro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supported]);

  if (!supported) return { status: "none" };
  // Mientras llega el calculo de las opciones nuevas se conserva la imagen anterior (sin parpadeo).
  if (state.key === key) return state.preview;
  return state.preview.status === "ready" ? state.preview : { status: "loading" };
}
