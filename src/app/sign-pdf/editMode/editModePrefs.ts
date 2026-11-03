import type { FitMode } from "@/app/sign-pdf/editMode/viewMath";

/*
 * Preferencias de interfaz del modo «Editar campos» (localStorage, con try/catch: sin almacenamiento todo sigue
 * funcionando con los valores por defecto). No guardan nada del documento ni de la persona.
 */

/** Ajuste de la hoja: `"width"` llena el ancho; cualquier otro valor o ausente = pagina entera (por defecto). */
export const EDIT_FIT_KEY = "optimuspdf.sign.editFit";
/** `"1"` = abrir el modo solo al entrar en el paso Documento (solo con puntero tactil). Ausente = no. */
export const EDIT_OPEN_KEY = "optimuspdf.sign.editOpen";

export function readFitPref(): FitMode {
  try {
    return window.localStorage.getItem(EDIT_FIT_KEY) === "width" ? "width" : "height";
  } catch {
    return "height";
  }
}

export function writeFitPref(mode: FitMode): void {
  try {
    window.localStorage.setItem(EDIT_FIT_KEY, mode);
  } catch {
    // Sin almacenamiento: dura lo que dure la pantalla.
  }
}

export function readOpenOnEnterPref(): boolean {
  try {
    return window.localStorage.getItem(EDIT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeOpenOnEnterPref(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(EDIT_OPEN_KEY, "1");
    else window.localStorage.removeItem(EDIT_OPEN_KEY);
  } catch {
    // Sin almacenamiento: no se recuerda.
  }
}
