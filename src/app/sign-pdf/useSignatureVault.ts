"use client";

import { useEffect, useState } from "react";
import { useIsClient } from "@/hooks/useIsClient";
import {
  listVault,
  subscribeToVault,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";

/**
 * Estado del baul de firmas para la interfaz.
 * - "loading": aun no hay primera lectura.
 * - "ready": lectura correcta (la lista puede estar vacia).
 * - "unavailable": IndexedDB no existe o esta bloqueado (modo privado...).
 */
export type VaultStatus = "loading" | "ready" | "unavailable";

export type VaultState = {
  status: VaultStatus;
  entries: VaultEntry[];
};

const IDLE: VaultState = { status: "loading", entries: [] };

/**
 * Lista del baul, reactiva. IndexedDB es asincrono, asi que (como
 * `DraftsSheet` con los borradores) se lee con `useState`/`useEffect` y se
 * refresca ante `subscribeToVault`, que tambien avisa de los cambios hechos
 * en OTRA pestaña.
 *
 * El baul es estado PROPIO: nunca vive dentro de `SignToolOptions`, porque
 * `CLEARED_DOCUMENT_STATE` lo limpiaria al cambiar de archivo y una firma
 * guardada no describe un documento.
 *
 * Con `enabled = false` (flag apagado, o un sheet cerrado que aun no hace
 * falta) no abre la base ni se suscribe, y devuelve una lista vacia.
 *
 * El flag (`useSignPdfFeatureFlag`) vale su valor POR DEFECTO (encendido)
 * mientras dura la hidratacion y solo despues lee `localStorage`; si el
 * efecto corriera ya en ese primer render, abriria (y crearia) la base aunque
 * el usuario tenga el baul apagado. Por eso tambien se espera a `useIsClient`,
 * que pasa a `true` en el MISMO re-render en que el flag toma su valor real:
 * hasta entonces `enabled` no cuenta.
 */
export function useSignatureVault(enabled: boolean): VaultState {
  const [state, setState] = useState<VaultState>(IDLE);
  const hydrated = useIsClient();
  const active = enabled && hydrated;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => {
      void listVault().then((result) => {
        if (cancelled) return;
        setState({
          status: result.ok ? "ready" : "unavailable",
          entries: result.entries,
        });
      });
    };
    refresh();
    const unsubscribe = subscribeToVault(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active]);

  return active ? state : IDLE;
}
