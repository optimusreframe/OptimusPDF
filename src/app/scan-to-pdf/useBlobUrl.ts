"use client";

import { useEffect, useSyncExternalStore } from "react";

/*
 * Object URL de un blob mientras algun componente lo usa. Las URL viven en un registro con cuenta de usos: varias tarjetas
 * (o la misma tras un nuevo montaje) comparten una sola URL, y se revoca cuando la ultima la suelta. El registro se lee con
 * `useSyncExternalStore`: nada de `setState` dentro de efectos.
 */
const registry = new Map<Blob, { url: string; refs: number }>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function acquire(blob: Blob): void {
  const entry = registry.get(blob);
  if (entry) entry.refs += 1;
  else registry.set(blob, { url: URL.createObjectURL(blob), refs: 1 });
  emit();
}

function release(blob: Blob): void {
  const entry = registry.get(blob);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  // Un turno de gracia: un remontaje inmediato (StrictMode, reordenar tarjetas) reutiliza la misma URL sin parpadeo.
  setTimeout(() => {
    if (entry.refs > 0 || registry.get(blob) !== entry) return;
    URL.revokeObjectURL(entry.url);
    registry.delete(blob);
    emit();
  }, 0);
}

/** URL del blob (o `null` hasta que el efecto la registra y mientras no hay blob). */
export function useBlobUrl(blob: Blob | null | undefined): string | null {
  useEffect(() => {
    if (!blob) return;
    acquire(blob);
    return () => release(blob);
  }, [blob]);
  return useSyncExternalStore(
    subscribe,
    () => (blob ? (registry.get(blob)?.url ?? null) : null),
    () => null,
  );
}
