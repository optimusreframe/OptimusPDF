"use client";

import { useCallback, useEffect, useState } from "react";
import { contentKeyOnce } from "@/app/sign-pdf/documentKey";
import {
  findDraftsForUpload,
  recoverableDrafts,
  uploadSetKey,
} from "@/app/sign-pdf/draftLookup";
import { listAllDrafts, subscribeToDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";

/**
 * Calma antes de releer la lista de borradores. Cada autoguardado (cada ~350 ms mientras se trabaja) avisa a los
 * suscriptores: sin esta espera, el contador de «Ver borradores» releeria todos los borradores en cada uno. Se lee cuando
 * pasan `DRAFT_LIST_REFRESH_MS` sin avisos nuevos (la edicion se paro), no a intervalos fijos durante la edicion.
 */
export const DRAFT_LIST_REFRESH_MS = 800;

function sameList(a: readonly DraftEntry[] | null, b: readonly DraftEntry[]): boolean {
  if (a === null || a.length !== b.length) return false;
  return a.every(
    (entry, index) =>
      entry.kind === b[index].kind && entry.meta.id === b[index].meta.id && entry.meta.savedAt === b[index].meta.savedAt,
  );
}

/**
 * Los borradores que Firmar sabe retomar, del mas reciente al mas antiguo; `null` mientras se leen por primera vez.
 * Se actualiza solo cuando algo cambia (esta pestaña u otra: `subscribeToDrafts`). Nunca lanza: sin IndexedDB, lista vacia.
 */
export function useRecoverableDrafts(): DraftEntry[] | null {
  const [entries, setEntries] = useState<DraftEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      void listAllDrafts().then((list) => {
        if (cancelled) return;
        const next = recoverableDrafts(list);
        setEntries((previous) => (sameList(previous, next) ? previous : next));
      });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(read, DRAFT_LIST_REFRESH_MS);
    };
    read();
    const unsubscribe = subscribeToDrafts(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return entries;
}

export type UploadOffer = {
  /** El borrador de estos mismos documentos (el mas reciente), si lo hay y no se rechazo; `null` si no. */
  entry: DraftEntry | null;
  /** Cuantos borradores MAS tienen estos mismos documentos (la misma plantilla para otros clientes): «Ver todos». */
  others: number;
  /** «Empezar de nuevo»: no vuelve a ofrecerse para ESTOS archivos. */
  dismiss: () => void;
};

/**
 * La oferta «Retomar lo que tenias» al subir archivos: por la huella de contenido de cada PDF (`documentContentKey`,
 * compartida con el resto de la herramienta: no se lee dos veces ningun archivo) se busca un borrador de EXACTAMENTE esos
 * documentos. Las huellas se calculan de una en una (un PDF grande entero en memoria, no N a la vez).
 *
 * `enabled = false` (ya hay trabajo en pantalla) no ofrece nada. El rechazo se recuerda por conjunto de huellas: otro
 * conjunto de archivos vuelve a poder ofrecerse.
 */
export function useUploadOffer(
  files: readonly File[],
  entries: readonly DraftEntry[] | null,
  enabled: boolean,
): UploadOffer {
  const [resolved, setResolved] = useState<{ files: readonly File[]; keys: (string | null)[] } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || files.length === 0) return;
    let cancelled = false;
    void (async () => {
      const keys: (string | null)[] = [];
      for (const file of files) {
        if (cancelled) return;
        keys.push(await contentKeyOnce(file).catch(() => null));
      }
      if (!cancelled) setResolved({ files, keys });
    })();
    return () => {
      cancelled = true;
    };
  }, [files, enabled]);

  const keys = resolved !== null && resolved.files === files ? resolved.keys : null;
  const setKey = keys === null ? null : uploadSetKey(keys);
  const matches =
    enabled && keys !== null && entries !== null && setKey !== dismissed ? findDraftsForUpload(entries, keys) : [];

  const dismiss = useCallback(() => {
    if (setKey !== null) setDismissed(setKey);
  }, [setKey]);

  return { entry: matches[0] ?? null, others: Math.max(0, matches.length - 1), dismiss };
}
