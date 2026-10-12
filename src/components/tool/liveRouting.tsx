"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

/*
 * Una region viva por suceso (A11Y-3).
 *
 * PDF Pro monta UNA region viva (`ProToolClient`) que anuncia abrir, aplicar, deshacer y rehacer. Los modos (Editar,
 * Anotar, Firmar, Rellenar) traen componentes que, solos en su ruta, llevan sus propias regiones `role="status"`.
 * Dentro de PDF Pro eso duplicaba: varias regiones vivas a la vez y un mismo suceso anunciado dos veces.
 *
 * Solucion: el anfitrion de los modos ofrece un «sumidero» (`LiveSinkProvider`) que lleva el texto a la region
 * unica. Un componente que quiere anunciar un cambio usa `StatusRegion` (o `useRoutedAnnouncement`):
 *   - SIN sumidero (la ruta suelta /sign-pdf, /edit-pdf): es la region viva de siempre (`role="status"`).
 *   - CON sumidero (dentro de PDF Pro): el contenido sigue a la vista pero ya no es region viva; su texto, cuando
 *     CAMBIA y no es vacio, se anuncia por la region unica. El valor inicial no se anuncia (igual que una region
 *     que nace con contenido).
 * Las hojas modales (`Sheet`) quitan el sumidero: una region fuera del dialogo no llega a un lector de pantalla con
 * `aria-modal`, asi que sus mensajes siguen en su propia region.
 */

export type LiveSink = (text: string) => void;

const LiveSinkContext = createContext<LiveSink | null>(null);

export const LiveSinkProvider = LiveSinkContext.Provider;

/** El sumidero activo, o `null` si no hay (region propia). */
export function useLiveSink(): LiveSink | null {
  return useContext(LiveSinkContext);
}

/**
 * Anuncia `text` por el sumidero cuando cambia (nunca el valor inicial ni el vacio). Devuelve `true` si hay
 * sumidero: quien llama entonces NO debe ser region viva.
 */
export function useRoutedAnnouncement(text: string): boolean {
  const sink = useLiveSink();
  const previous = useRef(text);
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    if (sink && text.trim() !== "") sink(text);
  }, [sink, text]);
  return sink !== null;
}

type StatusRegionProps = Omit<ComponentPropsWithoutRef<"div">, "role"> & {
  /** Texto que se anuncia cuando cambia (el que un lector de pantalla leeria de `children`). */
  text: string;
  as?: "div" | "p" | "span";
  children?: ReactNode;
};

/** Region de estado siempre montada: viva por si misma o, dentro de PDF Pro, encaminada a su region unica. */
export function StatusRegion({ text, as = "div", children, ...rest }: StatusRegionProps) {
  const routed = useRoutedAnnouncement(text);
  const props: ComponentPropsWithoutRef<"div"> = routed ? rest : { role: "status", "aria-live": "polite", ...rest };
  return createElement(as, props, children);
}

/**
 * Agrupa los anuncios de un mismo instante en uno solo: la region unica guarda UN texto, asi que dos mensajes del
 * mismo pintado se unirian si no, perdiendose el primero.
 */
export function createBatchedSink(deliver: (text: string) => void): LiveSink {
  let pending: string[] = [];
  return (text) => {
    if (pending.length === 0) {
      queueMicrotask(() => {
        const joined = pending.join(" ");
        pending = [];
        if (joined !== "") deliver(joined);
      });
    }
    if (!pending.includes(text)) pending.push(text);
  };
}
