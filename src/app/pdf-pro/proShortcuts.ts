import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Atajos globales de deshacer/rehacer del documento de trabajo (Wave 7 · U2):
 * Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z y Ctrl+Y. Se escuchan a nivel de documento pero SOLO actuan si:
 *  - el foco NO esta en un campo donde se escribe (el navegador deshace el texto del campo);
 *  - ningun modo con sesion propia esta activo (`registerMode(id, { hasOwnUndo: true })`): el
 *    modo gestiona su propio historial y el global lo pisaria;
 *  - nadie ha cancelado ya el evento (`defaultPrevented`);
 *  - hay algo que deshacer/rehacer (si no, el evento sigue su curso).
 */

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
  "file",
  "submit",
  "reset",
  "image",
  "color",
  "hidden",
]);

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** El elemento es un campo en el que se escribe (input de texto, textarea, contenteditable...). */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((element as HTMLInputElement).type || "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (element.isContentEditable) return true;
  if (element.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) {
    return true;
  }
  const role = element.getAttribute("role");
  return role !== null && TEXT_ROLES.has(role);
}

export type ProUndoAction = "undo" | "redo";

/** Que accion pide esta pulsacion, o `null` si no es un atajo de deshacer/rehacer. */
export function undoActionForKey(event: KeyboardEvent): ProUndoAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z" && (event.ctrlKey || event.metaKey)) return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}

/** Atiende una pulsacion; `true` si la consumio. */
export function handleProUndoKey(doc: ProWorkingDoc, event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  const action = undoActionForKey(event);
  if (!action) return false;
  if (isTextEditingTarget(event.target) || isTextEditingTarget(document.activeElement)) return false;
  if (doc.isOwnUndoActive()) return false;
  const state = doc.getState();
  if (action === "undo" ? !state.canUndo : !state.canRedo) return false;
  event.preventDefault();
  if (action === "undo") doc.undo();
  else doc.redo();
  return true;
}

/** Engancha los atajos a `document`; devuelve la funcion que los retira. */
export function attachProUndoShortcuts(doc: ProWorkingDoc, target: Document = document): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    handleProUndoKey(doc, event);
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
