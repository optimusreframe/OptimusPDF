"use client";

import { useEffect, useRef, type RefObject } from "react";
import { revealElement } from "@/app/sign-pdf/scrollReveal";

/**
 * Foco de la ceremonia por turnos. Cada etapa («traspaso», «captura»,
 * «revision») y cada turno sustituye al bloque anterior: el boton que se acaba
 * de pulsar («Estoy listo», «Continuar», «Siguiente»...) se desmonta y, sin
 * ayuda, el foco cae a `<body>` y quien navega con teclado o lector de
 * pantalla se queda sin sitio.
 *
 * Devuelve la referencia que hay que poner (con `tabIndex={-1}`) en el
 * encabezado de la etapa visible; al cambiar `stage` o `position` se enfoca
 * con `preventScroll` y la vista se lleva a ese encabezado, justo bajo las
 * barras fijas: sin esto el navegador conservaba la posicion de la etapa
 * anterior y el traspaso («Pasale el dispositivo a Ana») quedaba fuera de
 * pantalla (movil e iPad, SC-01).
 *
 * NO enfoca al montar: entrar al paso no debe robar el foco (la persona viene
 * de pulsar «Continuar» en el paso anterior, que ya gestiona el suyo). Se
 * compara con la ultima pareja vista en vez de usar un indicador de «primera
 * vez», para que el doble efecto de StrictMode tampoco lo robe.
 */
export function useCeremonyFocus<T extends HTMLElement = HTMLHeadingElement>(
  stage: string,
  position: number,
): RefObject<T | null> {
  const headingRef = useRef<T | null>(null);
  const lastRef = useRef<{ stage: string; position: number } | null>(null);

  useEffect(() => {
    const last = lastRef.current;
    lastRef.current = { stage, position };
    if (!last) return;
    if (last.stage === stage && last.position === position) return;
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    revealElement(heading, { align: "start", margin: 12 });
  }, [stage, position]);

  return headingRef;
}
