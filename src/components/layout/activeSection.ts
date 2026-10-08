"use client";

import { useSyncExternalStore } from "react";
import type { ToolCategory } from "@/lib/tools-registry";

/*
 * Categoria del catalogo que esta a la vista en Home. La publica
 * `ToolCatalogGrid` (IntersectionObserver sobre sus secciones) y la leen
 * el Sidebar y la barra de categorias para resaltar el ancla activa.
 * Store externo minimo (mismo patron que i18n/theme): sin contexto, para
 * que el Sidebar -- que vive en el layout raiz -- no dependa de la Home.
 */

let active: ToolCategory | null = null;
const listeners = new Set<() => void>();

export function setActiveSection(next: ToolCategory | null): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToolCategory | null {
  return active;
}

function getServerSnapshot(): ToolCategory | null {
  return null;
}

export function useActiveSection(): ToolCategory | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
 * Peticion de ancla: el Sidebar y los chips avisan de que el usuario ha
 * pulsado una categoria. Next cambia el hash con pushState (sin evento
 * `hashchange`), asi que la Home no se enteraria por su cuenta; con esto
 * limpia la busqueda (si la hay) y desplaza a la seccion una vez pintada.
 */
const requestListeners = new Set<(category: ToolCategory) => void>();

export function requestSection(category: ToolCategory): void {
  for (const listener of requestListeners) listener(category);
}

export function onSectionRequest(
  listener: (category: ToolCategory) => void,
): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}
