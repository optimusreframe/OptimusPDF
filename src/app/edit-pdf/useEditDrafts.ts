"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readFileBytes } from "@/lib/pdf/core";
import { useEditDraftAutosave } from "@/app/edit-pdf/editDraftAutosave";
import {
  deleteEditDraft,
  editDraftsSupported,
  fingerprintPdfBytes,
  loadEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { pendingChangeCount, type EditSession } from "@/app/edit-pdf/editSession";
import type { UseEditSession } from "@/app/edit-pdf/useEditSession";

/**
 * Borradores del editor integrados en la herramienta (Wave 5 · U5).
 *
 * Al abrir un documento: se calcula la huella de su contenido y, si hay un
 * borrador de ese mismo PDF con cambios, se RESTAURA en la sesion (con la
 * pagina en la que se dejo) antes de montar el lienzo. Desde ahi, cada cambio
 * se autoguarda (calma de 350 ms y volcado en `beforeunload`; ver
 * `editDraftAutosave`).
 *
 * `enabled = false` (documento protegido con contrasena, flag...) no guarda ni
 * restaura nada: un borrador guardaria el contenido SIN el cifrado.
 */

export type DraftSaveFailure = "tooBig" | "failed";

export type EditDraftsState = {
  /** Termino la busqueda del borrador (o no hay soporte): el lienzo ya puede montarse. */
  checked: boolean;
  /** Pagina (base 0) en la que se dejo el trabajo restaurado. */
  initialPage: number;
  /** El trabajo restaurado: cambios recuperados y cambios que no se pudieron leer. */
  restored: { count: number; lost: number } | null;
  /** El ultimo autoguardado fallo (se avisa una vez, sin interrumpir). */
  saveFailure: DraftSaveFailure | null;
  /** Descarta el borrador de este documento y la sesion restaurada. */
  startFresh: () => Promise<void>;
  /** Oculta el aviso de «recuperamos tu trabajo» sin tocar nada. */
  dismissRestored: () => void;
  /** Huella del documento (id del borrador), o `null`. */
  id: string | null;
};

/** Si buscar el borrador tarda mas, se abre el documento sin el (IndexedDB bloqueada). */
export const DRAFT_LOOKUP_TIMEOUT_MS = 2500;

type Lookup = {
  file: File;
  id: string | null;
  bytes: Uint8Array | null;
  initialPage: number;
  restored: { count: number; lost: number } | null;
};

export function useEditDrafts({
  file,
  enabled,
  session,
  pageCount,
  currentPage,
  fallbackPage = 0,
}: {
  file: File;
  enabled: boolean;
  session: UseEditSession;
  pageCount: number | null;
  currentPage: number;
  /** Pagina con la que arranca si no se restaura nada (al volver tras desmontar el area de trabajo). */
  fallbackPage?: number;
}): EditDraftsState {
  const supported = enabled && editDraftsSupported();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [saveFailure, setSaveFailure] = useState<DraftSaveFailure | null>(null);
  const [dismissed, setDismissed] = useState<File | null>(null);
  const fallbackRef = useRef(fallbackPage);
  const loadRef = useRef(session.load);
  const resetRef = useRef(session.reset);
  const itemCountRef = useRef(session.items.length);
  useEffect(() => {
    loadRef.current = session.load;
    resetRef.current = session.reset;
    itemCountRef.current = session.items.length;
    fallbackRef.current = fallbackPage;
  });

  useEffect(() => {
    if (!supported) return;
    let abandoned = false;
    const finish = (result: Omit<Lookup, "file">) => {
      if (abandoned) return;
      abandoned = true;
      window.clearTimeout(timer);
      setLookup({ file, ...result });
    };
    const timer = window.setTimeout(
      () => finish({ id: null, bytes: null, initialPage: 0, restored: null }),
      DRAFT_LOOKUP_TIMEOUT_MS,
    );
    void (async () => {
      try {
        const bytes = await readFileBytes(file);
        const id = await fingerprintPdfBytes(bytes);
        if (abandoned) return;
        if (!id) return finish({ id: null, bytes: null, initialPage: 0, restored: null });
        const loaded = await loadEditDraft(id);
        if (abandoned) return;
        // Con cambios ya en la sesion (se volvio de una cancelacion o de un error) NO se pisan con el borrador.
        if (itemCountRef.current === 0 && loaded.ok && pendingChangeCount(loaded.draft.session) > 0) {
          loadRef.current(loaded.draft.session);
          return finish({
            id,
            bytes,
            initialPage: loaded.draft.meta.currentPage,
            restored: { count: pendingChangeCount(loaded.draft.session), lost: loaded.draft.discarded },
          });
        }
        finish({ id, bytes, initialPage: fallbackRef.current, restored: null });
      } catch {
        finish({ id: null, bytes: null, initialPage: 0, restored: null });
      }
    })();
    return () => {
      abandoned = true;
      window.clearTimeout(timer);
    };
  }, [file, supported]);

  const current = lookup && lookup.file === file ? lookup : null;
  const checked = !supported || current !== null;
  const id = current?.id ?? null;

  // El autoguardado solo reacciona a cambios del CONTENIDO, no a seleccionar.
  const raw = session.session;
  const [stable, setStable] = useState<EditSession>(raw);
  if (stable.items !== raw.items || stable.assets !== raw.assets) setStable(raw);

  const { discard } = useEditDraftAutosave(
    id && current?.bytes
      ? {
          id,
          fileName: file.name,
          fileBytes: current.bytes,
          session: stable,
          pageCount,
          currentPage,
        }
      : null,
    {
      enabled: supported && id !== null,
      onResult: (result) => {
        if (result.ok) setSaveFailure(null);
        else if (result.reason === "tooBig") setSaveFailure("tooBig");
        else if (result.reason !== "superseded") setSaveFailure("failed");
      },
    },
  );

  const startFresh = useCallback(async () => {
    if (id) {
      await discard(id).catch(() => deleteEditDraft(id));
    }
    resetRef.current();
    setDismissed(file);
  }, [discard, file, id]);

  return {
    checked,
    initialPage: current?.initialPage ?? 0,
    restored: dismissed === file ? null : (current?.restored ?? null),
    saveFailure,
    startFresh,
    dismissRestored: () => setDismissed(file),
    id,
  };
}
