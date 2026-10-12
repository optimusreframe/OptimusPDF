"use client";

import { useMemo, useSyncExternalStore } from "react";
import { getPagesStore } from "@/app/pdf-pro/pages/pagesStore";
import { useProViewerOptional } from "@/app/pdf-pro/viewer/ProViewerContext";
import { EMPTY_VIEWER_STATE } from "@/app/pdf-pro/viewer/viewerStore";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

const NO_SUBSCRIBE = () => () => {};

/**
 * Paginas elegidas por el usuario (0-based, ordenadas), para «exportar solo las seleccionadas»:
 *  1. las del visor / miniaturas (Ctrl+clic, Mayus+clic, Ctrl+A), si hay alguna;
 *  2. si no, las del organizador de paginas (solo las que son del documento actual, no las insertadas).
 * Sin visor ni organizador (un test de la pestaña suelta) devuelve una lista vacia.
 */
export function useSelectedPages(): readonly number[] {
  const viewer = useProViewerOptional();
  const { doc, document } = useProWorkingDoc();
  const viewerState = useSyncExternalStore(
    viewer ? viewer.store.subscribe : NO_SUBSCRIBE,
    viewer ? viewer.store.getState : () => EMPTY_VIEWER_STATE,
    () => EMPTY_VIEWER_STATE,
  );
  const pagesStore = getPagesStore(doc);
  const pagesState = useSyncExternalStore(pagesStore.subscribe, pagesStore.getState, pagesStore.getState);
  const currentId = document ? document.snapshots[document.cursor]?.id : null;

  return useMemo(() => {
    if (viewerState.selectedPages.size > 0) return [...viewerState.selectedPages].sort((a, b) => a - b);
    if (!currentId || pagesState.baseSnapshotId !== currentId || pagesState.selection.size === 0) return [];
    const indices: number[] = [];
    for (const entry of pagesState.plan) {
      if (entry.kind === "existing" && pagesState.selection.has(entry.id as string)) indices.push(entry.sourceIndex);
    }
    return [...new Set(indices)].sort((a, b) => a - b);
  }, [viewerState.selectedPages, pagesState.baseSnapshotId, pagesState.plan, pagesState.selection, currentId]);
}
