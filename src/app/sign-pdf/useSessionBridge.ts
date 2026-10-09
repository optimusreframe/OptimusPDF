"use client";

import { useMemo, useRef } from "react";
import {
  docIdOf,
  docIdsOf,
  type DocId,
} from "@/app/sign-pdf/docSet";
import {
  DEFAULT_SESSION,
  activeDocOf,
  applyViewPatch,
  type SignSession,
} from "@/app/sign-pdf/signSession";
import type { SignToolOptions } from "@/app/sign-pdf/SignToolClient";

/**
 * Puente entre la sesion canonica (que guarda `ToolShell` como "opciones") y
 * quien necesita ESCRIBIRLE desde fuera de un render: efectos, resultados
 * asincronos (huella, deteccion de campos) y manejadores de eventos.
 *
 * `ToolShell.setOptions` solo admite un patch superficial. Calcular un patch
 * de `docs` o `blocks` contra el estado de un render ya viejo pisaria lo que
 * otra escritura de ese mismo instante acaba de dejar (dos escrituras en el
 * mismo tick, una resultado asincrono que llega entre medias...). El puente
 * lleva por tanto un espejo del ultimo estado conocido que SE ACTUALIZA EN EL
 * ACTO con cada escritura propia, y calcula cada patch contra el:
 * escrituras consecutivas se componen siempre, vengan de donde vengan.
 */
export type SessionBridge = {
  /** Lo llama el anfitrion tras cada render confirmado: el estado vigente de `ToolShell`. */
  sync: (
    files: File[],
    session: SignSession,
    setShellOptions: (patch: Partial<SignSession>) => void,
  ) => void;
  /** Calcula un patch contra el estado mas reciente y lo aplica. Un patch vacio no hace nada. */
  commit: (
    compute: (current: SignSession, files: File[]) => Partial<SignSession>,
  ) => void;
  /**
   * Escribe en SU documento (`docId`), con un patch en el formato plano de
   * siempre. Si el documento ya no esta en la cola el patch se DESCARTA: una
   * respuesta tardia de un archivo retirado no puede aterrizar en otro.
   */
  setView: (docId: DocId, patch: Partial<SignToolOptions>) => void;
  /** Igual, sobre el documento activo EN EL MOMENTO de la llamada (para paneles que no estan atados a un documento). */
  setActiveView: (patch: Partial<SignToolOptions>) => void;
  /** Tras cargar o reiniciar la sesion por la puerta de `ToolShell` (`loadRef`/`resetRef`): el espejo debe seguirla. */
  replace: (files: File[], patch: Partial<SignSession> | undefined) => void;
  read: () => { session: SignSession; files: File[] };
};

export function useSessionBridge(): SessionBridge {
  const sessionRef = useRef<SignSession>(DEFAULT_SESSION);
  const filesRef = useRef<File[]>([]);
  const setShellRef = useRef<(patch: Partial<SignSession>) => void>(() => {});

  return useMemo<SessionBridge>(() => {
    const commit: SessionBridge["commit"] = (compute) => {
      const patch = compute(sessionRef.current, filesRef.current);
      if (Object.keys(patch).length === 0) return;
      sessionRef.current = { ...sessionRef.current, ...patch };
      setShellRef.current(patch);
    };
    return {
      sync: (files, session, setShellOptions) => {
        filesRef.current = files;
        sessionRef.current = session;
        setShellRef.current = setShellOptions;
      },
      commit,
      setView: (docId, patch) =>
        commit((current, files) => {
          const order = docIdsOf(files);
          if (!order.includes(docId)) return {};
          return applyViewPatch(current, docId, patch, order);
        }),
      setActiveView: (patch) =>
        commit((current, files) => {
          const order = docIdsOf(files);
          const active = activeDocOf(current, order);
          return active ? applyViewPatch(current, active, patch, order) : {};
        }),
      replace: (files, patch) => {
        filesRef.current = files;
        sessionRef.current = { ...DEFAULT_SESSION, ...patch };
        // Los `DocId` de los archivos nuevos existen desde ya.
        files.forEach(docIdOf);
      },
      read: () => ({ session: sessionRef.current, files: filesRef.current }),
    };
  }, []);
}
