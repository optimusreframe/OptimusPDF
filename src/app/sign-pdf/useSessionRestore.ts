"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hideSessionFromUrl, readSessionFromSearch } from "@/app/sign-pdf/sessionUrl";
import { listAllDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import { RESUME_PARAM } from "@/lib/resumeLinks";
import type { ResumeLinkState } from "@/lib/useResumeLink";

/**
 * Recargar con `/sign-pdf?s=<id>` restaura la sesion SOLA (Fase 0 «Firma agil», U0.3): al montar la herramienta se lee
 * `?s=`, se busca ese borrador entre los de este navegador y se retoma con `onResume` (el mismo camino que «Ver borradores»
 * -> «Reanudar» y que `?resume=`). Lo lee de `window.location`, igual que `useResumeLink`, para que la pagina siga
 * prerenderizada entera (sin `useSearchParams` ni frontera `Suspense`).
 *
 *  - La URL es entrada no confiable: un `s` invalido, repetido o con otra forma no restaura nada y se limpia sin avisar.
 *  - Si el borrador ya no existe (se borro o caduco) se avisa con el mismo mensaje que `?resume=` (`gone`) y se limpia.
 *  - Si la direccion trae TAMBIEN `?resume=` manda este (Recientes): se restaura una sola vez, y `?resume=` se convierte en
 *    `?s=` cuando hay progreso (`showSessionInUrl`); aqui no se toca nada.
 *  - Con una sesion restaurada la URL se queda como esta (`?s=` ES la sesion): no se limpia.
 */
export function useSessionRestore(onResume: (entry: DraftEntry) => void): ResumeLinkState {
  const [gone, setGone] = useState(false);
  const onResumeRef = useRef(onResume);
  const startedRef = useRef(false);
  useEffect(() => {
    onResumeRef.current = onResume;
  });

  useEffect(() => {
    // El doble efecto de StrictMode (y cualquier remontaje) no vuelve a restaurar.
    if (startedRef.current) return;
    startedRef.current = true;
    const search = window.location.search;
    let values: string[] = [];
    try {
      values = new URLSearchParams(search).getAll(RESUME_PARAM);
    } catch {
      // Sin parametros legibles: nada que ceder.
    }
    if (values.length > 0) return;
    const { present, target } = readSessionFromSearch(search);
    if (!present) return;
    if (!target) {
      hideSessionFromUrl();
      return;
    }
    void (async () => {
      let entry: DraftEntry | undefined;
      try {
        const entries = await listAllDrafts();
        entry = entries.find(
          (candidate) => candidate.meta.id === target.id && (candidate.kind === "session") === (target.kind === "session"),
        );
      } catch {
        entry = undefined;
      }
      if (entry) {
        onResumeRef.current(entry);
        return;
      }
      hideSessionFromUrl();
      setGone(true);
    })();
  }, []);

  const dismiss = useCallback(() => setGone(false), []);

  // El aviso se retira solo en cuanto la persona sigue adelante: elige un archivo o suelta uno (como `useResumeLink`).
  useEffect(() => {
    if (!gone) return;
    const onChange = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "file") setGone(false);
    };
    const onDrop = () => setGone(false);
    document.addEventListener("change", onChange, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      document.removeEventListener("change", onChange, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [gone]);

  return { gone, dismiss };
}
