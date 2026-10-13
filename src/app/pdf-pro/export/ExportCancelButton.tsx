"use client";

import { useLayoutEffect, useRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/Button";

export type ExportCancelButtonProps = Omit<ButtonProps, "onClick" | "ref"> & {
  onCancel: () => void;
  /**
   * Adonde va el foco si este boton desaparece teniendo el foco (se cancela, la exportacion termina sola...). Se
   * resuelve en ese momento, con el boton todavia en el DOM.
   */
  returnFocusTo: (button: HTMLButtonElement) => HTMLElement | null | undefined;
};

/**
 * «Cancelar» de una exportacion. Desaparece en cuanto la exportacion deja de correr, incluso si NO fue por pulsarlo
 * (termina sola con el foco puesto en el boton). El navegador dejaria el foco en <body>: aqui, la limpieza de la fase de
 * layout corre ANTES de que React quite el nodo del DOM, asi que el foco pasa al destino logico en el MISMO commit, sin
 * pasar por <body> ni un fotograma (WCAG 2.4.3).
 */
export function ExportCancelButton({ onCancel, returnFocusTo, ...props }: ExportCancelButtonProps) {
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const returnRef = useRef(returnFocusTo);
  useLayoutEffect(() => {
    returnRef.current = returnFocusTo;
  });
  useLayoutEffect(() => {
    const button = ownRef.current;
    return () => {
      if (!button || window.document.activeElement !== button) return;
      const target = returnRef.current(button);
      if (target && target.isConnected && target !== button) target.focus({ preventScroll: true });
    };
  }, []);
  return <Button ref={ownRef} onClick={onCancel} {...props} />;
}
