"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listProDrafts, proDraftsSupported, subscribeToProDrafts, type ProDraftSummary } from "@/app/pdf-pro/proDrafts";

const noopSubscribe = () => () => {};

/**
 * Lista reactiva de borradores de PDF Pro («Documentos recientes»). Se refresca al montar y cuando
 * cambian (esta pestana u otra). Sin soporte de IndexedDB devuelve siempre una lista vacia.
 */
export function useProDraftList(): {
  drafts: ProDraftSummary[];
  loaded: boolean;
  supported: boolean;
  refresh: () => Promise<void>;
} {
  const [drafts, setDrafts] = useState<ProDraftSummary[]>([]);
  const [fetched, setFetched] = useState(false);
  // El servidor (y la hidratacion) asumen soporte; el cliente decide de verdad sin desajuste de hidratacion.
  const supported = useSyncExternalStore(noopSubscribe, proDraftsSupported, () => true);

  // Sin soporte no hay nada que consultar: se da por cargado (derivado, sin estado extra).
  const loaded = supported ? fetched : true;

  const refresh = useCallback(async () => {
    if (!supported) return;
    const next = await listProDrafts();
    setDrafts(next);
    setFetched(true);
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const run = () => {
      void listProDrafts().then((next) => {
        if (cancelled) return;
        setDrafts(next);
        setFetched(true);
      });
    };
    run();
    const unsubscribe = subscribeToProDrafts(run);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [supported]);

  return { drafts, loaded, supported, refresh };
}
