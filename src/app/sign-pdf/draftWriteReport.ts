import type { SaveDraftResult, SaveSessionResult } from "@/app/sign-pdf/signDrafts";

/*
 * Lo que un autoguardado cuenta a la pantalla tras intentar escribir el borrador (F0-fix, D1 y D2). Sin React.
 *
 * La regla de fondo: la pantalla solo puede decir «guardado» si el ultimo intento de escribir SALIO BIEN. Cualquier fallo de
 * escritura -- cuota llena, almacenamiento bloqueado (Safari en navegacion privada), base no disponible, error --
 * es `failed`, no solo «no cabe» (`tooBig`).
 */
export type DraftWriteReport =
  /** Se guardo. */
  | { kind: "saved" }
  /** NO se pudo guardar (cualquier motivo salvo `tooBig`): salir pierde el trabajo. */
  | { kind: "failed" }
  /** No cabe como borrador (la sesion pesa demasiado). */
  | { kind: "tooBig" }
  /** Otra pestaña habia guardado una version mas nueva: lo de esta se guardo aparte, con este id. */
  | { kind: "forked"; toId: string };

/**
 * Traduce el resultado de `saveDraft` / `saveSessionDraft`. `null` = nada que contar: un guardado superado por otro mas nuevo
 * (`superseded`) no es un fallo ni un exito, y sin resultado (pruebas con un doble) no se afirma nada.
 */
export function reportOfWrite(result: SaveDraftResult | SaveSessionResult | null | undefined): DraftWriteReport | null {
  if (!result) return null;
  if (result.ok) return result.forkedTo ? { kind: "forked", toId: result.forkedTo } : { kind: "saved" };
  if (result.reason === "superseded") return null;
  return result.reason === "tooBig" ? { kind: "tooBig" } : { kind: "failed" };
}
