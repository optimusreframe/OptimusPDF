"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Pila de historial generica para Censurar PDF: cada entrada es un
 * snapshot COMPLETO del arreglo de elementos (no un parche/diff), mas un
 * puntero al snapshot activo. No existia nada reutilizable para esto en
 * el resto del proyecto ("Undo" de edit-pdf es solo `elements.slice(0,
 * -1)`, sin redo), asi que este hook se queda local a redact-pdf.
 */
export type HistoryState<T> = {
  /** Snapshot actualmente activo. */
  current: T;
  canUndo: boolean;
  canRedo: boolean;
  /** Anade un snapshot nuevo, descartando cualquier "redo" pendiente. */
  pushState: (next: T) => void;
  undo: () => void;
  redo: () => void;
};

type HistoryInternal<T> = { items: T[]; index: number };

export function useHistoryState<T>(initial: T): HistoryState<T> {
  const [state, setState] = useState<HistoryInternal<T>>(() => ({
    items: [initial],
    index: 0,
  }));

  const pushState = useCallback((next: T) => {
    setState((prev) => {
      const truncated = prev.items.slice(0, prev.index + 1);
      truncated.push(next);
      return { items: truncated, index: truncated.length - 1 };
    });
  }, []);

  const undo = useCallback(() => {
    setState((prev) => (prev.index <= 0 ? prev : { ...prev, index: prev.index - 1 }));
  }, []);

  const redo = useCallback(() => {
    setState((prev) =>
      prev.index >= prev.items.length - 1 ? prev : { ...prev, index: prev.index + 1 },
    );
  }, []);

  return useMemo(
    () => ({
      current: state.items[state.index],
      canUndo: state.index > 0,
      canRedo: state.index < state.items.length - 1,
      pushState,
      undo,
      redo,
    }),
    [state, pushState, undo, redo],
  );
}
