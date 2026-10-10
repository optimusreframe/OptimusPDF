"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { firstControl, useFocusTarget } from "@/components/tool/useFocusTarget";

/**
 * Foco de las herramientas con cabecera propia (pdf-to-pdfa, compare, summarizer, scan), con el MISMO
 * mecanismo que `ToolShell` (`useFocusTarget`): tras mostrar el banner, «Elegir otro archivo», «Quitar
 * archivo», «Quitar» o «Cancelar», el foco va a un destino logico en el mismo commit (nunca por <body>).
 *
 * Destinos: `attention` = banner si lo hay, si no el boton principal, si esta desactivado el primer
 * control util de la zona de archivos y, por ultimo, la zona de carga; `dropzone`; `run`.
 * `bannerKey` identifica el aviso que se muestra AHORA (`null` = ninguno): al cambiar a uno nuevo el foco
 * va a el. `checking`: la comprobacion de algun archivo sigue en curso (se acepta un control de reserva y
 * se mejora al terminar).
 */
export type OwnFocusTarget = "attention" | "dropzone" | "run";

export function useOwnToolFocus({
  bannerKey,
  checking,
}: {
  bannerKey: string | null;
  checking: boolean;
}) {
  const bannerRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLButtonElement>(null);
  const dropzoneRef = useRef<HTMLButtonElement>(null);
  /** Contenedor de la zona de archivos (su primer control es el destino de reserva). */
  const areaRef = useRef<HTMLElement>(null);
  const bannerVisibleRef = useRef(false);
  const requestRef = useRef<(target: OwnFocusTarget) => void>(() => {});

  // Antes que el efecto de foco (mismo commit): un banner que se acaba de retirar no es destino.
  useLayoutEffect(() => {
    bannerVisibleRef.current = bannerKey !== null;
  });

  const { request } = useFocusTarget<OwnFocusTarget>((target) => {
    const banner = bannerVisibleRef.current ? bannerRef.current : null;
    const runDisabled = !!runRef.current && runRef.current.disabled && runRef.current.getClientRects().length > 0;
    switch (target) {
      case "run":
        return { candidates: [runRef.current] };
      case "dropzone":
        return { candidates: [dropzoneRef.current, firstControl(areaRef.current)] };
      case "attention":
        return {
          respectFocus: true,
          settling: checking || runDisabled,
          candidates: [banner, runRef.current, firstControl(areaRef.current), dropzoneRef.current],
        };
    }
  });
  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);

  /** Pide un destino (estable: se puede usar en cualquier manejador). */
  const ask = useCallback((target: OwnFocusTarget) => requestRef.current(target), []);

  // Un aviso nuevo (o de otro tipo) recibe el foco.
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (bannerKey && bannerKey !== lastKeyRef.current) ask("attention");
    lastKeyRef.current = bannerKey;
  }, [bannerKey, ask]);

  return { ask, bannerRef, runRef, dropzoneRef, areaRef };
}
