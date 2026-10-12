"use client";

import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Foco de los modos de PDF Pro (Wave 7 · U7): nunca queda en `<body>` al entrar, al aplicar, al descartar ni al
 * quedar el contenido inerte.
 */

// En orden de preferencia: la pestana activa (escritorio), el boton del dock de la pestana activa (movil), cualquier
// pestana seleccionada y, por ultimo, el visor. Se prueban UNO A UNO: una lista separada por comas devuelve el primero
// que aparezca en el DOM (en movil, el visor, que no admite foco, iria antes que el dock).
const RETURN_TARGETS = [
  '[role="tab"][aria-selected="true"][data-tab]',
  '[data-dock][aria-current="page"]',
  '[role="tab"][aria-selected="true"]',
  '[data-pro-region="viewer"]',
];

function focusReturnTarget(): void {
  for (const selector of RETURN_TARGETS) {
    const target = window.document.querySelector<HTMLElement>(selector);
    if (!target) continue;
    target.focus({ preventScroll: true });
    if (window.document.activeElement === target) return;
  }
}

/**
 * Al salir (aplicar, descartar o cambio externo) el foco no se pierde en `<body>`: si estaba dentro de `rootRef`
 * se coloca, ANTES de que el DOM se retire, en la pestana activa de PDF Pro (de donde se llego) o, si no la hay,
 * en el visor. El anfitrion la corrige despues con el control exacto de la pestana de vuelta.
 */
export function useFocusReturn(rootRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      const active = window.document.activeElement;
      if (!root || !active || active === window.document.body || !root.contains(active)) return;
      focusReturnTarget();
    };
  }, [rootRef]);
}

/**
 * Entrar al modo con el teclado (S, F, la paleta de comandos) deja el foco en `<body>` al desmontarse el visor:
 * pasa al primer control del modo (`selector`, dentro de `rootRef`), sin esperar a que haya cargado la hoja. Se
 * respeta el foco si la persona entro pulsando una pestana (o el dock) o ya esta dentro del modo, y se espera si hay
 * una hoja abierta (la paleta de comandos se esta cerrando y devolvera su foco).
 */
export function useEntryFocus(rootRef: RefObject<HTMLElement | null>, selector: string): void {
  useEffect(() => {
    let frames = 0;
    let frame = 0;
    const attempt = () => {
      const active = window.document.activeElement;
      const sheetOpen = window.document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      if (active?.closest('[data-pro-region="tabs"]')) return;
      if (active && active !== window.document.body && rootRef.current?.contains(active)) return;
      const target = rootRef.current?.querySelector<HTMLElement>(selector);
      if (target && !sheetOpen) {
        target.focus({ preventScroll: true });
        return;
      }
      frames += 1;
      if (frames < 90) frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [rootRef, selector]);
}

/**
 * Mientras se aplica, el contenido del modo queda `inert`. Si el foco estaba dentro, se lleva antes a la zona de
 * estado de la barra (enfocable por codigo): `inert` lo soltaria a `<body>`.
 */
export function useBusyFocus(contentRef: RefObject<HTMLElement | null>, busy: boolean): void {
  useLayoutEffect(() => {
    if (!busy) return;
    const content = contentRef.current;
    const active = window.document.activeElement;
    if (!content || !active || !content.contains(active)) return;
    window.document
      .querySelector<HTMLElement>("[data-pro-mode-actions] [data-pro-mode-status-wrap]")
      ?.focus({ preventScroll: true });
  }, [busy, contentRef]);
}

/**
 * Avisa del navegador antes de recargar o cerrar la pestana mientras haya trabajo sin aplicar en el modo (una firma
 * dibujada, un formulario a medias). Solo aviso: la sesion no se guarda como borrador (ni firmas manuscritas ni
 * datos de un formulario se dejan en el navegador sin que la persona lo pida). Se retira al aplicar o descartar.
 */
export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Algunos navegadores solo muestran el dialogo si se asigna `returnValue`.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
