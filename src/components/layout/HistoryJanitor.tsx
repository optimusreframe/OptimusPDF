"use client";

import { useEffect } from "react";
import { sweepDeadHistoryDatabases } from "@/lib/historyJanitor";

/**
 * Al cargar cualquier pagina de la app, cuando el navegador esta ocioso, borra los historiales de PDF Pro que
 * dejo una pestana cerrada sin cerrar su documento. No pinta nada.
 */
export function HistoryJanitor() {
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void sweepDeadHistoryDatabases();
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof idle === "function") {
      const id = idle(run, { timeout: 4000 });
      return () => {
        cancelled = true;
        (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
      };
    }
    const timer = window.setTimeout(run, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
