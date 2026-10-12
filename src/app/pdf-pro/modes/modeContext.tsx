"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Canal OPCIONAL entre el host de modos y el modo que monta (Wave 7 · U6). El contrato basico de un modo
 * (`ProModeProps`) no cambia: un modo que ignora este canal sigue funcionando con sus propios botones. Quien
 * quiera que el host dibuje «Aplicar» y «Descartar», pregunte al salir con cambios y recuerde la pagina, usa
 * `useProModeControls` y `useProModeHost`.
 */

/** Lo que el host puede pedirle a un modo. */
export type ProModeControls = {
  /** Exporta y llama a `onApply`; `true` si se aplico (el host sale del modo), `false` si no (se queda). */
  apply: () => Promise<boolean>;
  /** Limpia lo que el modo guarde fuera de memoria (borradores) al descartar o al aplicar. */
  discard: () => void | Promise<void>;
  /** Cancela una aplicacion en curso (opcional). */
  cancel?: () => void;
};

/** Una peticion de la paleta de comandos o de un atajo: «arma esta herramienta». */
export type ProModeIntent = { tool: string; nonce: number };

export type ProModeHostValue = {
  /** Pestana del modo. */
  tab: string;
  /** Pagina (base 0) que se miraba en el visor al entrar: el modo arranca ahi. */
  initialPage: number;
  /** El modo informa de su pagina visible: el visor vuelve a ella al salir. */
  reportPage: (page: number) => void;
  /** El modo registra (o retira con `null`) sus controles. */
  registerControls: (controls: ProModeControls | null) => void;
  /** Peticion pendiente de herramienta (`nonce` crece con cada una). */
  intent: ProModeIntent | null;
  /** Se esta aplicando: el modo no debe aceptar mas cambios. */
  busy: boolean;
  /**
   * Un modo con varias herramientas (Firmar / Rellenar en la pestana Firmar) dice cual esta abierta para que la
   * barra del host la nombre («Rellenando»); `null` vuelve al nombre de la pestana.
   */
  reportName?: (tab: "sign" | "fill" | null) => void;
};

export const ProModeHostContext = createContext<ProModeHostValue | null>(null);

/** El canal del host, o `null` si el modo se monta fuera de el (tests, uso aislado). */
export function useProModeHost(): ProModeHostValue | null {
  return useContext(ProModeHostContext);
}

/**
 * Registra los controles de un modo mientras esta montado. `controls` puede cambiar en cada pintado: el host
 * siempre llama a la version mas reciente (se guarda por referencia).
 */
export function useProModeControls(controls: ProModeControls | null): void {
  const host = useProModeHost();
  const latest = useRef(controls);
  useEffect(() => {
    latest.current = controls;
  });
  const registered = controls !== null;
  const register = host?.registerControls;
  useEffect(() => {
    if (!register || !registered) return;
    register({
      apply: () => latest.current?.apply() ?? Promise.resolve(false),
      discard: () => latest.current?.discard(),
      cancel: () => latest.current?.cancel?.(),
    });
    return () => register(null);
  }, [register, registered]);
}

/** Error de `ProModeControls.apply` con el texto ya redactado para mostrar en la barra del host. */
export class ProModeApplyError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "ProModeApplyError";
    this.userMessage = userMessage;
  }
}
