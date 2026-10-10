"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";

/**
 * Foco con destino logico para los flujos que desmontan el control que lo tenia (Wave 6 · N2/V-F).
 *
 * Quien pulsa «Quitar archivo», «Elegir otro archivo» o «Cancelar» tiene el foco en un boton que el
 * siguiente render retira: el navegador lo deja en <body>. Este hook lo evita: el llamador PIDE un
 * destino (`request("run")`) y el hook lo aplica en la fase de layout del commit siguiente, es decir,
 * en el MISMO turno y antes de pintar el siguiente cuadro, asi que `document.activeElement` no pasa
 * por <body> ni un fotograma. Si el destino aun no se puede enfocar (esta desactivado, o dentro de algo
 * inerte que sale) reintenta cada 16 ms hasta ~2,5 s.
 *
 * - `resolve(target)` devuelve, EN EL MOMENTO de intentarlo, los candidatos por orden de preferencia
 *   (lee refs: nunca se queda con datos de un render viejo).
 * - `settling`: el destino ideal aun no esta listo (p. ej. «Procesar» mientras se comprueba el archivo):
 *   se acepta un control de reserva y se MEJORA al terminar, sin quedarse en el de reserva.
 * - `respectFocus`: no le quita el foco a un control util que ya lo tiene (solo a <body>, a algo
 *   inerte o al propio banner de error que acaba de desaparecer).
 * - Recuperacion: durante 2 s, si el foco recien dado se pierde (el control se desmonta en el render
 *   siguiente), se vuelve a pedir el mismo destino.
 */
export type FocusPlan = {
  candidates: (HTMLElement | null)[];
  respectFocus?: boolean;
  settling?: boolean;
};

/** Un elemento se puede enfocar si esta pintado (fixed incluido), activo y no es inert. */
export function isFocusable(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !(element as HTMLButtonElement).disabled &&
    !element.closest("[inert]")
  );
}

const MAX_ATTEMPTS = 150;
const RETRY_MS = 16;
const RECOVER_MS = 2000;

export function useFocusTarget<T extends string>(resolve: (target: T) => FocusPlan) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  const resolveRef = useRef(resolve);
  const pendingRef = useRef<T | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptsRef = useRef(0);
  /** El ultimo control al que este hook dio el foco (un control de reserva que se puede mejorar). */
  const ownedRef = useRef<HTMLElement | null>(null);
  const recoverRef = useRef<{ target: T; until: number } | null>(null);
  /** Para que el reintento llame a la version vigente de `step` sin auto-referirse. */
  const stepRef = useRef<() => void>(() => {});

  const step = useCallback(() => {
    timerRef.current = null;
    const target = pendingRef.current;
    if (!target) return;
    const plan = resolveRef.current(target);
    const active = document.activeElement;
    const occupied =
      !!plan.respectFocus &&
      !!active &&
      active !== document.body &&
      active !== ownedRef.current &&
      active.isConnected &&
      !active.closest("[inert]") &&
      // El foco dentro de un banner de error es el que este mismo flujo acaba de resolver: no cuenta.
      !active.closest("[data-error-banner]");
    const element = occupied ? undefined : plan.candidates.find(isFocusable);
    if (element) {
      if (document.activeElement !== element) element.focus({ preventScroll: true });
      if (document.activeElement === element) {
        ownedRef.current = element;
        if (!plan.settling) {
          pendingRef.current = null;
          if (plan.respectFocus) recoverRef.current = { target, until: performance.now() + RECOVER_MS };
          return;
        }
        // En reserva: se sigue vigilando para pasar al destino ideal cuando este listo.
      }
    }
    attemptsRef.current += 1;
    if (attemptsRef.current < MAX_ATTEMPTS) {
      timerRef.current = window.setTimeout(() => stepRef.current(), RETRY_MS);
    } else {
      pendingRef.current = null;
    }
  }, []);

  // Despues de CADA commit (fase de layout, antes de pintar): ultima funcion de resolucion + intento.
  useLayoutEffect(() => {
    resolveRef.current = resolve;
    stepRef.current = step;
    const recover = recoverRef.current;
    if (!pendingRef.current && recover && performance.now() < recover.until) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || active.closest("[inert]")) {
        pendingRef.current = recover.target;
        attemptsRef.current = 0;
      }
    }
    if (pendingRef.current) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      step();
    }
  });

  /*
   * Vigilancia de la recuperacion: hay perdidas de foco que NO vienen de un render de este componente
   * (una hoja que termina de salir y «restaura» el foco en <body>, un banner que se desmonta). Mientras dura
   * la ventana de recuperacion, `focusout` y los cambios del DOM reevaluan en una microtarea: antes de
   * pintar el siguiente cuadro el foco ya esta de vuelta en su destino.
   */
  useEffect(() => {
    const check = () => {
      const recover = recoverRef.current;
      if (!recover) return;
      if (performance.now() >= recover.until) {
        recoverRef.current = null;
        return;
      }
      queueMicrotask(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body || !active.isConnected || !!active.closest("[inert]");
        if (!lost || pendingRef.current || recoverRef.current !== recover) return;
        pendingRef.current = recover.target;
        attemptsRef.current = 0;
        stepRef.current();
      });
    };
    document.addEventListener("focusout", check, true);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusout", check, true);
      observer.disconnect();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  /** Pide el destino para el commit siguiente (fuerza uno si no hay otro cambio de estado). */
  const request = useCallback((target: T) => {
    pendingRef.current = target;
    attemptsRef.current = 0;
    recoverRef.current = null;
    force();
  }, []);

  return { request };
}

/** El primer control util (boton, enlace o campo activo y visible) dentro de `root`. */
export function firstControl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const controls = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]):not([type="file"]):not([type="hidden"]), [tabindex="0"]',
  );
  return Array.from(controls).find(isFocusable) ?? null;
}
