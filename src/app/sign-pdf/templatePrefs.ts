/*
 * Preferencias propias de las plantillas de Firmar (Fase 2 · U2.4): con cuantos firmantes se aplico la ultima plantilla.
 * Un dato de interfaz (1 o 2), sin PII, en este navegador. Nunca rompe el flujo si no hay almacenamiento.
 */

export const REMEMBERED_SIGNERS_KEY = "optimuspdf.sign.templateSigners";

export function readRememberedCount(): 1 | 2 | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_SIGNERS_KEY);
    return raw === "1" ? 1 : raw === "2" ? 2 : null;
  } catch {
    return null;
  }
}

export function rememberCount(count: 1 | 2): void {
  try {
    window.localStorage.setItem(REMEMBERED_SIGNERS_KEY, String(count));
  } catch {
    // Sin almacenamiento: se vuelve a preguntar la proxima vez.
  }
}
