"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createBatchedSink } from "@/components/tool/liveRouting";

/**
 * UNA region viva para todo el Escaner. Los avisos (pagina capturada, borrada, deshecho, guardado...) pasan por `announce`.
 * La region vive en un contenedor propio colgado de <body> y marcado `data-scan-live-host`: las capas a pantalla completa
 * (camara, editor, hoja) ponen `inert` al resto de la pagina, pero NUNCA a este contenedor, asi el lector de pantalla sigue
 * oyendolo y no hay dos regiones vivas a la vez.
 */
type Announce = (text: string) => void;

const AnnounceContext = createContext<Announce>(() => {});

export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

export const LIVE_HOST_ATTR = "data-scan-live-host";

let host: HTMLElement | null = null;
let users = 0;
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

function mountHost(): void {
  users += 1;
  if (!host) {
    host = document.createElement("div");
    host.setAttribute(LIVE_HOST_ATTR, "");
    document.body.appendChild(host);
  }
  emit();
}

function unmountHost(): void {
  users -= 1;
  if (users > 0) return;
  host?.remove();
  host = null;
  emit();
}

export function ScanLiveProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const element = useSyncExternalStore(
    subscribe,
    () => host,
    () => null,
  );

  useEffect(() => {
    mountHost();
    return unmountHost;
  }, []);

  // Varios avisos del mismo instante se unen en UNO (la region guarda un solo texto); un mismo texto dos veces seguidas debe volver a
  // anunciarse: se alterna un caracter invisible.
  const announce = useMemo<Announce>(() => createBatchedSink((next) => setText((previous) => (previous === next ? next + "\u200b" : next))), []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      {element
        ? createPortal(
            <p role="status" aria-live="polite" aria-atomic="true" data-scan-live="" className="sr-only">
              {text}
            </p>,
            element,
          )
        : null}
    </AnnounceContext.Provider>
  );
}
