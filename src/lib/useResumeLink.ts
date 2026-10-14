"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  readResumeFromSearch,
  withoutResume,
  type ResumeKind,
  type ResumeTarget,
} from "@/lib/resumeLinks";

/**
 * Lo que dice la herramienta tras intentar restaurar el trabajo de `?resume=`:
 *  - `restored`: lo restauro (o ya esta en ello);
 *  - `gone`: ya no existe (se borro, caduco o se perdio): se avisa con «Este trabajo ya no se puede recuperar...»;
 *  - `failed`: no se pudo leer ahora (almacen bloqueado...): la herramienta ya lo cuenta con su propio aviso.
 */
export type ResumeOutcome = "restored" | "gone" | "failed";

export type ResumeLinkState = {
  /** El trabajo del enlace ya no existe: hay que mostrar `ResumeGoneNotice`. */
  gone: boolean;
  dismiss: () => void;
};

/**
 * Quita `?resume=` de la direccion SIN anadir una entrada al historial: `replaceState` nativo, que el router de
 * Next 16 integra (sincroniza `usePathname`/`useSearchParams`). Asi «Atras» vuelve a Recientes y nunca a un enlace que
 * volveria a restaurar. Se pasa `null` como estado: el router conserva el suyo.
 */
export function clearResumeFromUrl(): void {
  try {
    const next = withoutResume(window.location.href);
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, "", next);
    }
  } catch {
    // Sin History API (o bloqueada): el parametro se queda, sin consecuencias.
  }
}

/**
 * Lee `?resume=` UNA vez al montar la herramienta y, si es un trabajo valido de esta herramienta (`kinds`), llama a
 * `restore`. Despues limpia la URL. Valores invalidos, de otra herramienta o repetidos no restauran nada y se limpian
 * sin avisar. Se lee de `window.location` (no de `useSearchParams`) a proposito: asi la pagina de la herramienta sigue
 * prerenderizada entera, sin una frontera `Suspense` ni renderizado solo en cliente.
 */
export function useResumeLink(
  kinds: readonly ResumeKind[],
  restore: (target: ResumeTarget) => Promise<ResumeOutcome> | ResumeOutcome,
): ResumeLinkState {
  const [gone, setGone] = useState(false);
  const kindsRef = useRef(kinds);
  const restoreRef = useRef(restore);
  const startedRef = useRef(false);
  useEffect(() => {
    kindsRef.current = kinds;
    restoreRef.current = restore;
  });

  useEffect(() => {
    // El doble efecto de StrictMode (y cualquier remontaje) no vuelve a restaurar.
    if (startedRef.current) return;
    startedRef.current = true;
    const { present, target } = readResumeFromSearch(window.location.search, kindsRef.current);
    if (!present) return;
    if (!target) {
      clearResumeFromUrl();
      return;
    }
    void (async () => {
      let outcome: ResumeOutcome;
      try {
        outcome = await restoreRef.current(target);
      } catch {
        outcome = "failed";
      }
      clearResumeFromUrl();
      if (outcome === "gone") setGone(true);
    })();
  }, []);

  const dismiss = useCallback(() => setGone(false), []);

  // El aviso se retira solo en cuanto la persona sigue adelante: elige un archivo o suelta uno.
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
