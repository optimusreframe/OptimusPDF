"use client";

import { useEffect, useRef } from "react";
import {
  deleteEditDraft,
  saveEditDraft,
  warmEditDraftsConnection,
  type SaveEditDraftResult,
} from "@/app/edit-pdf/editDrafts";
import { pendingChangeCount, type EditSession } from "@/app/edit-pdf/editSession";
import { flushOnPageHide } from "@/app/sign-pdf/flushOnPageHide";

/**
 * Autoguardado del borrador del editor (Wave 5 · U3).
 *
 * Calma corta (350 ms) porque solo se reescriben los metadatos: los bytes del PDF
 * y de las imagenes se escriben una vez. Si la pestana se recarga o se cierra
 * ANTES de que dispare el debounce, el cambio pendiente se vuelca al momento
 * reutilizando `flushOnPageHide` (ver su comentario: `pagehide` y
 * `visibilitychange` NO sobreviven a una recarga con IndexedDB, `beforeunload`
 * si, por eso se escucha esa) y con la conexion de vida larga ya abierta para
 * que la transaccion nazca en la misma pasada sincrona del evento.
 *
 * Disciplina de generaciones: cada `schedule` invalida al anterior; un guardado
 * lento ya superado, o uno posterior a `discard`, calla justo antes de escribir
 * (lo borrado no resucita). Sin cambios pendientes no se guarda, y si esta
 * pestana habia guardado ese documento se retira el borrador (el ultimo cambio
 * deshecho tambien se refleja).
 */

export const EDIT_DRAFT_SAVE_DEBOUNCE_MS = 350;

export type EditDraftSnapshot = {
  /** Huella del contenido (`fingerprintPdfBytes`). */
  id: string;
  fileName: string;
  fileBytes: Uint8Array;
  session: EditSession;
  pageCount?: number | null;
  currentPage?: number;
};

export type EditDraftAutosaverOptions = {
  debounceMs?: number;
  /** Se llama con el resultado de cada guardado (para un indicador discreto). */
  onResult?: (result: SaveEditDraftResult) => void;
  /** Inyectables para tests. */
  save?: typeof saveEditDraft;
  remove?: typeof deleteEditDraft;
};

export type EditDraftAutosaver = {
  /** Programa el guardado de este estado (debounce); reemplaza al pendiente. */
  schedule: (snapshot: EditDraftSnapshot) => void;
  /** Guarda YA lo pendiente. `null` si no habia nada o no habia cambios que guardar. */
  flush: () => Promise<SaveEditDraftResult | null>;
  /** Borra el borrador de ese documento y descarta lo pendiente (p. ej. tras descargar). */
  discard: (id: string) => Promise<void>;
  /** Para el autoguardado; con `flush` (por defecto) vuelca antes lo pendiente. */
  dispose: (options?: { flush?: boolean }) => void;
};

export function createEditDraftAutosaver(
  options: EditDraftAutosaverOptions = {},
): EditDraftAutosaver {
  const debounceMs = options.debounceMs ?? EDIT_DRAFT_SAVE_DEBOUNCE_MS;
  const save = options.save ?? saveEditDraft;
  const remove = options.remove ?? deleteEditDraft;

  let generation = 0;
  let pending: EditDraftSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopHide: (() => void) | null = null;
  let disposed = false;
  /** Documentos para los que ESTA pestana tiene un borrador guardado. */
  const savedHere = new Set<string>();

  const clearPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stopHide?.();
    stopHide = null;
  };

  const flush = async (): Promise<SaveEditDraftResult | null> => {
    const snapshot = pending;
    pending = null;
    clearPending();
    if (!snapshot) return null;
    const mine = generation;
    const isCurrent = () => generation === mine;

    if (pendingChangeCount(snapshot.session) === 0) {
      if (!savedHere.has(snapshot.id)) return null;
      const result = await remove(snapshot.id);
      if (isCurrent() && result.ok) savedHere.delete(snapshot.id);
      return null;
    }
    // Se marca de inmediato: una transicion posterior ya ve la intencion vigente.
    savedHere.add(snapshot.id);
    const result = await save({ ...snapshot, isCurrent });
    if (!result.ok && result.reason !== "superseded" && isCurrent()) {
      // Si no se pudo guardar, no se presume un borrador en disco.
      savedHere.delete(snapshot.id);
    }
    if (isCurrent() || result.ok) options.onResult?.(result);
    return result;
  };

  return {
    schedule(snapshot) {
      if (disposed) return;
      generation += 1;
      pending = snapshot;
      if (timer) clearTimeout(timer);
      // Con cambios pendientes la conexion queda abierta: el volcado de
      // `beforeunload` no puede esperar a abrirla.
      if (pendingChangeCount(snapshot.session) > 0) void warmEditDraftsConnection();
      timer = setTimeout(() => void flush(), debounceMs);
      stopHide ??= flushOnPageHide(() => {
        void flush();
      });
    },
    flush,
    async discard(id) {
      generation += 1;
      pending = null;
      clearPending();
      savedHere.delete(id);
      await remove(id);
    },
    dispose(disposeOptions) {
      if (disposed) return;
      if (disposeOptions?.flush !== false && pending) void flush();
      disposed = true;
      pending = null;
      clearPending();
    },
  };
}

export type UseEditDraftAutosaveOptions = EditDraftAutosaverOptions & {
  /** `false` apaga el autoguardado (flag, sin soporte, documento cifrado...). */
  enabled?: boolean;
};

/**
 * Autoguarda el borrador mientras `snapshot` cambia. `snapshot` es `null` mientras
 * no hay documento o no hay huella (sin `crypto.subtle`): entonces no hace nada.
 */
export function useEditDraftAutosave(
  snapshot: EditDraftSnapshot | null,
  options: UseEditDraftAutosaveOptions = {},
): { flush: () => Promise<SaveEditDraftResult | null>; discard: (id: string) => Promise<void> } {
  const autosaverRef = useRef<EditDraftAutosaver | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const autosaver = createEditDraftAutosaver({
      debounceMs: options.debounceMs,
      save: options.save,
      remove: options.remove,
      onResult: (result) => optionsRef.current.onResult?.(result),
    });
    autosaverRef.current = autosaver;
    return () => {
      autosaver.dispose();
      autosaverRef.current = null;
    };
    // El autoguardador se crea una vez por activacion; sus opciones inyectables no cambian.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const id = snapshot?.id;
  const fileName = snapshot?.fileName;
  const fileBytes = snapshot?.fileBytes;
  const session = snapshot?.session;
  const pageCount = snapshot?.pageCount;
  const currentPage = snapshot?.currentPage;
  useEffect(() => {
    if (!enabled || id === undefined || fileName === undefined || !fileBytes || !session) return;
    autosaverRef.current?.schedule({ id, fileName, fileBytes, session, pageCount, currentPage });
  }, [enabled, id, fileName, fileBytes, session, pageCount, currentPage]);

  return {
    flush: () => autosaverRef.current?.flush() ?? Promise.resolve(null),
    discard: (target) => autosaverRef.current?.discard(target) ?? deleteEditDraft(target).then(() => {}),
  };
}
