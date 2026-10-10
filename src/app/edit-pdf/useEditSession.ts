"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  applyOp,
  canRedo as sessionCanRedo,
  canUndo as sessionCanUndo,
  createEditSession,
  getSelectedItem,
  itemsOnPage as sessionItemsOnPage,
  pendingChangeCount as sessionPendingChangeCount,
  redo as sessionRedo,
  resetSession,
  selectItem,
  undo as sessionUndo,
  type EditItem,
  type EditOp,
  type EditSession,
} from "@/app/edit-pdf/editSession";

/**
 * Hook de la sesion de edicion (Wave 5 · U3): envuelve el estado PURO de
 * `editSession.ts` con un reductor de React y los atajos de teclado de deshacer
 * y rehacer.
 *
 * Por que NO se reutiliza `redact-pdf/useHistoryState.ts`: aquel hook guarda
 * snapshots COMPLETOS que empuja quien llama (`pushState(next)`), sin nocion de
 * operacion, sin agrupado de tecleo, sin reloj inyectable y sin seleccion. La
 * sesion de edicion necesita todo eso (y su historial vive en el estado puro,
 * testeable sin React), asi que promoverlo a `src/hooks/` obligaria a rehacerlo
 * y arriesgaria los tests de Censurar sin ganar nada. Se deja tal cual.
 */

export type EditShortcutOptions = {
  /** Apaga los atajos sin desmontar el hook. Por defecto, activos. */
  enabled?: boolean;
  /** Donde escuchar `keydown`. Por defecto `document`; inyectable en tests. */
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
  /**
   * Los atajos NO actuan dentro de campos de texto editables (input, textarea,
   * select, contenteditable): ahi el deshacer es el del propio campo. Con `true`
   * actuan tambien ahi; con una funcion, solo en los elementos para los que
   * devuelva `true` (p. ej. el editor inline cuando quiere el historial global).
   */
  allowInEditable?: boolean | ((element: Element) => boolean);
};

export type UseEditSessionOptions = {
  /** Sesion con la que arrancar (p. ej. un borrador restaurado). */
  initial?: EditSession | (() => EditSession);
  /** Reloj inyectable (ms) para el agrupado de tecleo. Por defecto `Date.now`. */
  now?: () => number;
  /** `false` desactiva los atajos; un objeto los configura. Por defecto, activos. */
  shortcuts?: boolean | EditShortcutOptions;
};

export type UseEditSession = {
  session: EditSession;
  items: readonly EditItem[];
  /** El item seleccionado, o `null`. */
  selected: EditItem | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Aplica una op (con el reloj del hook). Identidad estable. */
  dispatch: (op: EditOp) => void;
  undo: () => void;
  redo: () => void;
  /** Selecciona un item (o ninguno); no entra en el historial. */
  select: (id: string | null) => void;
  /** Descarta todos los cambios (sin historial: pide confirmacion antes). */
  reset: () => void;
  /** Sustituye la sesion entera (restaurar un borrador). Rompe el historial. */
  load: (session: EditSession) => void;
  itemsOnPage: (pageIndex: number) => EditItem[];
  pendingChangeCount: number;
};

type Action =
  | { type: "op"; op: EditOp; now: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; id: string | null }
  | { type: "reset" }
  | { type: "load"; session: EditSession };

function reducer(state: EditSession, action: Action): EditSession {
  switch (action.type) {
    case "op":
      return applyOp(state, action.op, action.now);
    case "undo":
      return sessionUndo(state);
    case "redo":
      return sessionRedo(state);
    case "select":
      return selectItem(state, action.id);
    case "reset":
      return resetSession(state);
    case "load":
      return action.session;
  }
}

/** `true` si el elemento es (o esta dentro de) un campo donde se escribe texto. */
export function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    // Casillas, botones y demas no reciben texto: ahi el atajo global si vale.
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(
      type,
    );
  }
  const html = element as HTMLElement;
  if (html.isContentEditable) return true;
  const attr = element.closest?.("[contenteditable]");
  return attr !== null && attr !== undefined && attr.getAttribute("contenteditable") !== "false";
}

export type UndoRedoShortcut = "undo" | "redo" | null;

/** Que atajo es (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) o `null`. Puro. */
export function matchUndoRedoShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): UndoRedoShortcut {
  if (event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  const isZ = key === "z" || event.code === "KeyZ";
  if (isZ) return event.shiftKey ? "redo" : "undo";
  // Ctrl+Y (Windows/Linux). Cmd+Y no: en macOS abre el historial del navegador.
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}

export function useEditSession(options: UseEditSessionOptions = {}): UseEditSession {
  const [session, dispatchAction] = useReducer(
    reducer,
    options.initial,
    (initial): EditSession =>
      typeof initial === "function" ? initial() : (initial ?? createEditSession()),
  );

  const nowRef = useRef(options.now);
  useEffect(() => {
    nowRef.current = options.now;
  }, [options.now]);

  const dispatch = useCallback((op: EditOp) => {
    dispatchAction({ type: "op", op, now: nowRef.current ? nowRef.current() : Date.now() });
  }, []);
  const undo = useCallback(() => dispatchAction({ type: "undo" }), []);
  const redo = useCallback(() => dispatchAction({ type: "redo" }), []);
  const select = useCallback((id: string | null) => dispatchAction({ type: "select", id }), []);
  const reset = useCallback(() => dispatchAction({ type: "reset" }), []);
  const load = useCallback((next: EditSession) => dispatchAction({ type: "load", session: next }), []);

  const shortcuts = options.shortcuts ?? true;
  const shortcutEnabled = shortcuts === false ? false : shortcuts === true ? true : shortcuts.enabled !== false;
  const shortcutTarget = typeof shortcuts === "object" ? shortcuts.target : undefined;
  const allowInEditable = typeof shortcuts === "object" ? shortcuts.allowInEditable : undefined;

  const allowRef = useRef(allowInEditable);
  useEffect(() => {
    allowRef.current = allowInEditable;
  }, [allowInEditable]);

  useEffect(() => {
    if (!shortcutEnabled) return;
    const target =
      shortcutTarget === undefined
        ? typeof document === "undefined"
          ? null
          : document
        : shortcutTarget;
    if (!target) return;

    const onKeyDown = (raw: Event) => {
      const event = raw as KeyboardEvent;
      if (event.defaultPrevented || event.isComposing) return;
      const shortcut = matchUndoRedoShortcut(event);
      if (!shortcut) return;

      const origin = event.target instanceof Element ? event.target : null;
      if (origin && isEditableElement(origin)) {
        const allow = allowRef.current;
        const allowed = typeof allow === "function" ? allow(origin) : allow === true;
        if (!allowed) return;
      }
      event.preventDefault();
      dispatchAction({ type: shortcut });
    };
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [shortcutEnabled, shortcutTarget]);

  const selected = useMemo(() => getSelectedItem(session), [session]);
  const itemsOnPage = useCallback(
    (pageIndex: number) => sessionItemsOnPage(session, pageIndex),
    [session],
  );

  return useMemo(
    () => ({
      session,
      items: session.items,
      selected,
      canUndo: sessionCanUndo(session),
      canRedo: sessionCanRedo(session),
      dispatch,
      undo,
      redo,
      select,
      reset,
      load,
      itemsOnPage,
      pendingChangeCount: sessionPendingChangeCount(session),
    }),
    [session, selected, dispatch, undo, redo, select, reset, load, itemsOnPage],
  );
}
