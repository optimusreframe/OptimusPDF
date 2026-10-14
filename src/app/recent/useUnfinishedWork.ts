"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { listEditDrafts, subscribeToEditDrafts, type EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import { listProDrafts, subscribeToProDrafts, type ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import { buildUnfinishedItems, type UnfinishedItem } from "@/app/recent/unfinishedWork";
import { listAllDrafts, subscribeToDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";

type Sources = { sign: DraftEntry[]; edit: EditDraftSummary[]; pro: ProDraftSummary[] };

/** Ninguna lista lanza (los almacenes tragan sus errores), pero un fallo inesperado nunca debe romper Recientes. */
async function settled<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

/**
 * Lee los borradores reales de Firmar, Editar PDF y PDF Pro y los mantiene al dia: se refresca cuando cambian (esta
 * pestana u otra: cada almacen avisa por su `BroadcastChannel`). `loaded` = ya se leyeron los tres.
 */
export function useUnfinishedWork(): { items: UnfinishedItem[]; loaded: boolean; refresh: () => Promise<void> } {
  const [sources, setSources] = useState<Sources | null>(null);

  const read = useCallback(async (): Promise<Sources> => {
    const [sign, edit, pro] = await Promise.all([
      settled(listAllDrafts),
      settled(listEditDrafts),
      settled(listProDrafts),
    ]);
    return { sign, edit, pro };
  }, []);

  const refresh = useCallback(async () => {
    setSources(await read());
  }, [read]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void read().then((next) => {
        if (!cancelled) setSources(next);
      });
    };
    run();
    const unsubscribes = [subscribeToDrafts(run), subscribeToEditDrafts(run), subscribeToProDrafts(run)];
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [read]);

  const items = useMemo(() => (sources ? buildUnfinishedItems(sources) : []), [sources]);
  return { items, loaded: sources !== null, refresh };
}
