"use client";

import { useSyncExternalStore } from "react";

/**
 * ¿Hay algo que aun no llego al disco? (Fase 0 «Firma agil», U0.3). Los autoguardados de Firmar esperan unos cientos de
 * milisegundos de calma antes de escribir en IndexedDB y la escritura es asincrona: en esa ventana el trabajo de pantalla
 * es MAS NUEVO que el borrador. El aviso de «salir de la pagina» (`useLeaveGuard`) solo molesta mientras esa diferencia
 * existe -- con el borrador al dia no hay nada que perder y cerrar no debe preguntar.
 *
 * Cada autoguardado abre una «marca» al agendar su escritura y la cierra cuando la escritura termina (o se sustituye por
 * otra mas nueva, o se descarta). Es un contador de modulo con suscripcion, no estado de React: lo escriben los efectos de
 * dos componentes distintos (`SessionDraftAutosave` y el autoguardado de un solo documento de `MultiFlow`).
 */

const open = new Set<symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Abre una marca de escritura pendiente. Devuelve la funcion que la cierra (idempotente). */
export function beginDraftWrite(): () => void {
  const mark = Symbol("draft-write");
  open.add(mark);
  notify();
  return () => {
    if (!open.delete(mark)) return;
    notify();
  };
}

/** Hay alguna escritura de borrador agendada o en vuelo. */
export function hasPendingDraftWrite(): boolean {
  return open.size > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resuelve cuando no queda ninguna escritura de borrador pendiente (o, como muy tarde, tras `timeoutMs`). Quien va a BORRAR
 * un borrador (F0 · U0.4: «Borrar el borrador de esta firma» al descargar) espera antes a que se asiente el ultimo
 * guardado: un volcado tardio que aterrizara DESPUES del borrado lo resucitaria.
 */
export function whenDraftWritesSettle(timeoutMs = 3000): Promise<void> {
  if (open.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      listeners.delete(check);
      resolve();
    };
    const check = () => {
      if (open.size === 0) finish();
    };
    timer = setTimeout(finish, timeoutMs);
    listeners.add(check);
  });
}

/** Reactivo: `true` mientras haya una escritura de borrador pendiente. */
export function useDraftWritePending(): boolean {
  return useSyncExternalStore(subscribe, hasPendingDraftWrite, () => false);
}

/** Solo para tests: olvida todas las marcas. */
export function __resetDraftActivityForTests(): void {
  open.clear();
  notify();
}
