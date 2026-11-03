"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subscribeToLibrary } from "@/lib/docLibrary/store";
import type { Fingerprint } from "@/lib/docLibrary/types";
import { buildRows, fingerprintOfFile, loadLibrarySnapshot, type LibraryTemplateRow } from "@/app/sign-pdf/templateCandidates";
import { readTemplateUse } from "@/app/sign-pdf/templateUse";

/*
 * Las plantillas de «Mis documentos» ordenadas por parecido con el PDF cargado, para la hoja «Plantillas» (W3-A2). Solo trabaja con
 * la hoja abierta: lee la biblioteca (IndexedDB), calcula la huella del archivo (en el worker, con memoria) y compara. Se
 * vuelve a leer si la biblioteca cambia (en esta u otra pestaña). Todo local: ningun archivo ni dato sale del dispositivo.
 */

/** `idle`: aun no se leyo nada (la hoja trata `idle` y `loading` igual). */
export type CandidatesStatus = "idle" | "loading" | "ready";

export type TemplateCandidates = {
  status: CandidatesStatus;
  /** `false` = este navegador no deja usar la biblioteca (sin IndexedDB). */
  libraryAvailable: boolean;
  rows: LibraryTemplateRow[];
  /** Huella del PDF cargado; `null` si aun no esta o no se pudo calcular. */
  fingerprint: Fingerprint | null;
  /** No se pudo leer el PDF cargado para compararlo (cifrado, dañado): las plantillas se ofrecen sin porcentaje. */
  fingerprintFailed: boolean;
  /** `legacyId` de las plantillas antiguas (localStorage) que ya estan copiadas en la biblioteca. */
  migratedLegacyIds: ReadonlySet<string>;
  /** Vuelve a leer la biblioteca. */
  reload: () => void;
};

const EMPTY: ReadonlySet<string> = new Set();

type State = Omit<TemplateCandidates, "reload">;

const INITIAL: State = { status: "idle", libraryAvailable: true, rows: [], fingerprint: null, fingerprintFailed: false, migratedLegacyIds: EMPTY };

export function useTemplateCandidates(open: boolean, file: File | null): TemplateCandidates {
  const [state, setState] = useState<State>(INITIAL);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  // Otra pestaña (o este mismo editor) cambio la biblioteca mientras la hoja esta abierta.
  useEffect(() => {
    if (!open) return;
    return subscribeToLibrary(reload);
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    // La lista se pinta sin porcentajes en cuanto llega y se reordena al tener la huella.
    void (async () => {
      const snapshot = await loadLibrarySnapshot();
      if (cancelled) return;
      const migrated = new Set<string>();
      for (const template of snapshot.templates) if (template.origin?.kind === "local") migrated.add(template.origin.legacyId);
      const use = readTemplateUse();
      setState({
        status: "loading",
        libraryAvailable: snapshot.available,
        rows: buildRows({ templates: snapshot.templates, documents: snapshot.documents, fingerprint: null, use }),
        fingerprint: null,
        fingerprintFailed: false,
        migratedLegacyIds: migrated,
      });
      let fingerprint: Fingerprint | null = null;
      let failed = false;
      if (file) {
        try {
          fingerprint = await fingerprintOfFile(file, controller.signal);
        } catch {
          failed = !controller.signal.aborted;
        }
      }
      if (cancelled) return;
      setState({
        status: "ready",
        libraryAvailable: snapshot.available,
        rows: buildRows({ templates: snapshot.templates, documents: snapshot.documents, fingerprint, use }),
        fingerprint,
        fingerprintFailed: failed,
        migratedLegacyIds: migrated,
      });
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, file, tick]);

  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
