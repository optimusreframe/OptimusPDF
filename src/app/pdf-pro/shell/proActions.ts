"use client";

import { useEffect, useRef } from "react";

/*
 * Acciones globales de la barra superior que otras unidades cablean (Wave 7 · U3):
 *  - `save`: «Descargar» el documento tal como esta. Por defecto lo hace la suite (descarga + marca como guardado).
 *  - `export`: «Exportar…» (convertir a imagenes, texto, otros formatos). Por defecto lleva a la pestaña «Convertir».
 * La unidad que implemente algo mejor registra su manejador con `registerProAction` (o `useProAction`) y la
 * suite lo usa en lugar del valor por defecto; al retirarlo vuelve el valor por defecto.
 */

export type ProActionId = "save" | "export";

const handlers = new Map<ProActionId, () => void>();

/** Registra el manejador de una accion global; devuelve la funcion que lo retira. */
export function registerProAction(id: ProActionId, handler: () => void): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

/** El manejador registrado (o `null` si manda el valor por defecto). */
export function getProAction(id: ProActionId): (() => void) | null {
  return handlers.get(id) ?? null;
}

/** Solo para tests. */
export function __clearProActionsForTests(): void {
  handlers.clear();
}

/** Registra la accion mientras el componente esta montado (siempre llama a la ultima version del manejador). */
export function useProAction(id: ProActionId, handler: () => void, active = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    return registerProAction(id, () => ref.current());
  }, [id, active]);
}
