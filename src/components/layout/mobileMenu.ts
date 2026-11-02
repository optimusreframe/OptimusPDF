"use client";

import { useCallback, useSyncExternalStore, type RefCallback } from "react";

/*
 * Estado del menu de la hoja (movil y tablet). Store externo minimo, mismo patron que `activeSection.ts`: lo escriben los
 * dos disparadores (la quinta pestana de `MobileTabBar` por debajo de 768 px y el boton «Menu» de `Header` en tablet) y lo
 * lee la unica hoja (`MobileMenuSheet`, montada en `Header`). Asi la hoja sobrevive a un giro del aparato (el telefono
 * pasa de 375 a 812 px y cambia de disparador) sin cerrarse ni duplicarse, y no hace falta un proveedor en el layout.
 *
 * No toca el historial del navegador: la hoja se cierra al navegar (ver `MobileMenuSheet`).
 */

let open = false;
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();
const triggers = new Set<HTMLElement>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Abre la hoja; `from` es el disparador pulsado (a el vuelve el foco al cerrar si sigue visible). */
export function openMobileMenu(from?: HTMLElement | null): void {
  if (open) return;
  open = true;
  opener = from ?? null;
  emit();
}

export function closeMobileMenu(): void {
  if (!open) return;
  open = false;
  emit();
}

export function useMobileMenuOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

/** El elemento ocupa sitio en pantalla (no esta en `display: none`, p. ej. la pestana movil con la pantalla ya en tablet). */
function isRendered(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0;
}

/**
 * Devuelve el foco a un disparador al cerrar la hoja y responde `true` si lo hizo. Entre las pestañas posibles manda el que
 * abrio la hoja; si un giro del aparato lo oculto, el otro que se ve. Safari no da foco a un boton al pulsarlo, asi que no
 * basta con confiar en `document.activeElement` al abrir.
 */
export function focusMenuTrigger(): boolean {
  const candidates = [opener, ...triggers].filter((element): element is HTMLElement => element !== null);
  const target = candidates.find(isRendered) ?? (opener?.isConnected ? opener : null);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** Id del contenedor del contenido de la hoja: lo controla el disparador (`aria-controls`). */
export const MOBILE_MENU_CONTENT_ID = "mobile-menu-content";

/**
 * Props y ref de un boton que abre el menu. `aria-controls` solo existe con la hoja abierta (un idref colgado rompe
 * `aria-valid-attr-value`).
 */
export function useMenuTrigger(): {
  ref: RefCallback<HTMLElement>;
  onClick: (event: { currentTarget: HTMLElement }) => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
} {
  const isOpen = useMobileMenuOpen();
  const ref = useCallback<RefCallback<HTMLElement>>((node) => {
    if (!node) return;
    triggers.add(node);
    // React 19 llama al valor devuelto al desmontar.
    return () => {
      triggers.delete(node);
      if (opener === node) opener = null;
    };
  }, []);
  return {
    ref,
    onClick: (event) => (isOpen ? closeMobileMenu() : openMobileMenu(event.currentTarget)),
    "aria-haspopup": "dialog",
    "aria-expanded": isOpen,
    "aria-controls": isOpen ? MOBILE_MENU_CONTENT_ID : undefined,
  };
}
