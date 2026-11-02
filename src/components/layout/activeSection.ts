"use client";

import { useSyncExternalStore } from "react";
import type { SectionId } from "@/lib/tools-registry";

/*
 * Seccion del catalogo (categoria de PDF, OptimusSCAN o grupo de OptimusTOOLS) que esta a la vista en Home. La publica
 * `ToolCatalogGrid` (IntersectionObserver sobre sus secciones) y la leen
 * el Sidebar y la barra de categorias para resaltar el ancla activa.
 * Store externo minimo (mismo patron que i18n/theme): sin contexto, para
 * que el Sidebar -- que vive en el layout raiz -- no dependa de la Home.
 */

let active: SectionId | null = null;
const listeners = new Set<() => void>();

export function setActiveSection(next: SectionId | null): void {
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

function getSnapshot(): SectionId | null {
  return active;
}

function getServerSnapshot(): SectionId | null {
  return null;
}

export function useActiveSection(): SectionId | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/*
 * Peticion de ancla: el Sidebar y los chips avisan de que el usuario ha
 * pulsado una categoria. Next cambia el hash con pushState (sin evento
 * `hashchange`), asi que la Home no se enteraria por su cuenta; con esto
 * limpia la busqueda (si la hay) y desplaza a la seccion una vez pintada.
 */
const requestListeners = new Set<(section: SectionId) => void>();

export function requestSection(section: SectionId): void {
  for (const listener of requestListeners) listener(section);
}

export function onSectionRequest(
  listener: (section: SectionId) => void,
): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}
