"use client";

import { useEffect, useRef } from "react";
import {
  deleteProDraft,
  proDraftsSupported,
  saveProDraft,
  warmProDraftsConnection,
  type SaveProDraftResult,
} from "@/app/pdf-pro/proDrafts";
import { flushOnPageHide } from "@/app/sign-pdf/flushOnPageHide";
import { useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import type { ProDocument, ProHistoryNote } from "@/app/pdf-pro/proTypes";

/**
 * Autoguardado del borrador de PDF Pro (Wave 7 · U2). Mismo diseno que `editDraftAutosave.ts`:
 * debounce corto, volcado en `beforeunload` (`flushOnPageHide`) con la conexion de vida larga ya
 * abierta, y disciplina de generaciones (un guardado lento ya superado, o posterior a `discard`,
 * calla justo antes de escribir: lo borrado no resucita).
 *
 * Reglas propias:
 *  - sin cambios pendientes (`dirty` = false: abierto sin tocar, o deshecho hasta el guardado) no se
 *    guarda; y si esta pestana habia guardado ese documento, el borrador se retira;
 *  - los PDF CIFRADOS no se guardan NUNCA (un borrador dejaria su contenido sin el cifrado);
 *  - sin huella (`crypto.subtle`) o sin IndexedDB no hay borrador.
 */

export const PRO_DRAFT_SAVE_DEBOUNCE_MS = 600;

export type ProDraftSnapshot = {
  /** Huella del archivo ORIGINAL (`ProDocument.fingerprint`). */
  id: string;
  fileName: string;
  /** Bytes del snapshot actual. */
  bytes: Uint8Array;
  snapshotId: string;
  history: readonly ProHistoryNote[];
  pageCount?: number | null;
  currentPage?: number;
  /** Hay cambios sin guardar/exportar. */
  dirty: boolean;
};

export type ProDraftAutosaverOptions = {
  debounceMs?: number;
  onResult?: (result: SaveProDraftResult) => void;
  /**
   * Avisa cuando cambia «hay una escritura de borrador sin confirmar» (cambios a la espera del debounce o guardandose).
   * Mientras es `true` el borrador AUN NO cubre los cambios: cerrar la pestaña ahora podria perderlos.
   */
  onPendingChange?: (pending: boolean) => void;
  save?: typeof saveProDraft;
  remove?: typeof deleteProDraft;
};

export type ProDraftAutosaver = {
  schedule: (snapshot: ProDraftSnapshot) => void;
  /** Hay cambios a la espera de guardarse o guardandose (el borrador todavia no los cubre). */
  isPending: () => boolean;
  /** Guarda YA lo pendiente. `null` si no habia nada o no habia cambios que guardar. */
  flush: () => Promise<SaveProDraftResult | null>;
  /** Borra el borrador de ese documento y descarta lo pendiente. */
  discard: (id: string) => Promise<void>;
  dispose: (options?: { flush?: boolean }) => void;
};

export function createProDraftAutosaver(options: ProDraftAutosaverOptions = {}): ProDraftAutosaver {
  const debounceMs = options.debounceMs ?? PRO_DRAFT_SAVE_DEBOUNCE_MS;
  const save = options.save ?? saveProDraft;
  const remove = options.remove ?? deleteProDraft;

  let generation = 0;
  let pending: ProDraftSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopHide: (() => void) | null = null;
  let disposed = false;
  const savedHere = new Set<string>();
  /** Guardados de cambios (`dirty`) en vuelo: la escritura aun no ha terminado. */
  let inFlight = 0;
  let announcedPending = false;

  const isPending = () => (!disposed || inFlight > 0) && (pending?.dirty === true || inFlight > 0);
  const emitPending = () => {
    const now = isPending();
    if (now === announcedPending) return;
    announcedPending = now;
    options.onPendingChange?.(now);
  };

  const clearPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stopHide?.();
    stopHide = null;
  };

  const flush = async (): Promise<SaveProDraftResult | null> => {
    const snapshot = pending;
    pending = null;
    clearPending();
    if (!snapshot) {
      emitPending();
      return null;
    }
    const mine = generation;
    const isCurrent = () => generation === mine;

    if (!snapshot.dirty) {
      emitPending();
      if (!savedHere.has(snapshot.id)) return null;
      const result = await remove(snapshot.id);
      if (isCurrent() && result.ok) savedHere.delete(snapshot.id);
      return null;
    }
    savedHere.add(snapshot.id);
    inFlight += 1;
    emitPending();
    try {
      const result = await save({ ...snapshot, isCurrent });
      if (!result.ok && result.reason !== "superseded" && isCurrent()) savedHere.delete(snapshot.id);
      // El resultado se entrega ANTES de bajar la marca: un fallo ya activa el aviso por su propia via.
      if (isCurrent() || result.ok) options.onResult?.(result);
      return result;
    } finally {
      inFlight -= 1;
      emitPending();
    }
  };

  return {
    schedule(snapshot) {
      if (disposed) return;
      generation += 1;
      pending = snapshot;
      if (timer) clearTimeout(timer);
      if (snapshot.dirty) void warmProDraftsConnection();
      timer = setTimeout(() => void flush(), debounceMs);
      stopHide ??= flushOnPageHide(() => {
        void flush();
      });
      emitPending();
    },
    isPending,
    flush,
    async discard(id) {
      generation += 1;
      pending = null;
      clearPending();
      savedHere.delete(id);
      emitPending();
      await remove(id);
    },
    dispose(disposeOptions) {
      if (disposed) return;
      if (disposeOptions?.flush !== false && pending) void flush();
      disposed = true;
      pending = null;
      clearPending();
      emitPending();
    },
  };
}

/** Apunta del documento de trabajo al snapshot a guardar, o `null` si no corresponde guardarlo. */
export function draftSnapshotOf(
  document: ProDocument | null,
  dirty: boolean,
  currentPage = 0,
): ProDraftSnapshot | null {
  if (!document || !document.fingerprint) return null;
  // Un PDF cifrado NUNCA se guarda: el borrador dejaria su contenido sin el cifrado.
  if (document.wasEncrypted) return null;
  const current = document.snapshots[document.cursor];
  if (!current) return null;
  const history: ProHistoryNote[] = document.snapshots.slice(0, document.cursor + 1).map((snapshot) => ({
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    source: snapshot.source,
    ...(snapshot.opId ? { opId: snapshot.opId } : {}),
  }));
  return {
    id: document.fingerprint,
    fileName: document.name,
    bytes: current.bytes,
    snapshotId: current.id,
    history,
    pageCount: current.pageCount,
    currentPage,
    dirty,
  };
}

export type UseProDraftAutosaveOptions = ProDraftAutosaverOptions & {
  /** `false` apaga el autoguardado (flag `proAutosave`, sin soporte...). */
  enabled?: boolean;
  /** Pagina visible (0-based) para retomar donde se dejo. */
  currentPage?: number;
  doc?: ProWorkingDoc;
};

/** Autoguarda el borrador mientras el documento de trabajo cambia. */
export function useProDraftAutosave(options: UseProDraftAutosaveOptions = {}): {
  flush: () => Promise<SaveProDraftResult | null>;
  discard: (id: string) => Promise<void>;
} {
  const doc = useProWorkingDocInstance(options.doc);
  const autosaverRef = useRef<ProDraftAutosaver | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const enabled = options.enabled !== false && proDraftsSupported();

  useEffect(() => {
    if (!enabled) return;
    const autosaver = createProDraftAutosaver({
      debounceMs: options.debounceMs,
      save: options.save,
      remove: options.remove,
      onResult: (result) => optionsRef.current.onResult?.(result),
      onPendingChange: (pending) => optionsRef.current.onPendingChange?.(pending),
    });
    autosaverRef.current = autosaver;
    let lastDocument: ProDocument | null | undefined;
    let lastDirty: boolean | undefined;
    const push = () => {
      const state = doc.getState();
      // Un anuncio de la region viva no cambia nada que guardar.
      if (state.document === lastDocument && state.dirty === lastDirty) return;
      lastDocument = state.document;
      lastDirty = state.dirty;
      const snapshot = draftSnapshotOf(state.document, state.dirty, optionsRef.current.currentPage ?? 0);
      if (snapshot) autosaver.schedule(snapshot);
    };
    push();
    const unsubscribe = doc.subscribe(push);
    return () => {
      unsubscribe();
      autosaver.dispose();
      autosaverRef.current = null;
    };
    // El autoguardador se crea una vez por activacion; sus opciones inyectables no cambian.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, enabled]);

  return {
    flush: () => autosaverRef.current?.flush() ?? Promise.resolve(null),
    discard: (target) => autosaverRef.current?.discard(target) ?? deleteProDraft(target).then(() => {}),
  };
}
