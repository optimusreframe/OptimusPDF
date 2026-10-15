import { docIdOf, docStateOf } from "@/app/sign-pdf/docSet";
import { whenDraftWritesSettle } from "@/app/sign-pdf/draftActivity";
import { deleteDraft, deleteSessionDraft, draftExists } from "@/app/sign-pdf/signDrafts";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { SingleDraftIdentity } from "@/app/sign-pdf/singleDraft";
import { sessionHasSavedProgress } from "@/app/sign-pdf/signWork";

/*
 * «Borrar el borrador de esta firma» tras descargar (Fase 0 «Firma agil», U0.4), sin React.
 *
 * Una ronda que ya se entrego no debe seguir ofreciendose como «firma sin terminar» (la tarjeta de entrada, «Ver
 * borradores» y Recientes leen los mismos borradores). Este modulo dice QUE borrador corresponde a la ronda que acaba de
 * descargarse y lo borra de forma comprobada.
 */

/** El borrador de una ronda entregada: una sesion (varios documentos) o un documento suelto (su id: el de la sesion de trabajo, o la huella en un borrador anterior). */
export type DeliveredDraft = { kind: "session" | "document"; id: string };

/**
 * El borrador que corresponde a la ronda que se acaba de entregar, o `null` si no hay ninguno que ofrecer borrar:
 *  - sin progreso guardable (modo «Solo yo», copia descifrada, nada hecho): no se escribio ningun borrador;
 *  - una ronda demasiado grande para guardarse (`tooBig`): tampoco;
 *  - un resultado con fallos parciales (`partial`): algun documento sigue sin firmar y el borrador es lo unico que lo guarda.
 */
export function deliveredDraftOf(args: {
  files: readonly File[];
  session: SignSession;
  /** Id de la sesion guardada (`SessionIdentity.id`), solo con varios documentos. */
  sessionId: string | null;
  /**
   * Identidad del borrador del documento suelto (F0-fix, D3): su id ya no es la huella del PDF. Sin ella (o si es de otro
   * documento) se usa la huella, como en los borradores anteriores.
   */
  singleDraft?: SingleDraftIdentity | null;
  tooBig: boolean;
  partial: boolean;
}): DeliveredDraft | null {
  const { files, session, sessionId, singleDraft, tooBig, partial } = args;
  if (tooBig || partial || files.length === 0) return null;
  if (!sessionHasSavedProgress(files, session)) return null;
  if (files.length >= 2) return sessionId ? { kind: "session", id: sessionId } : null;
  const docId = docIdOf(files[0]);
  const key = docStateOf(session.docs, docId).sealedKey;
  if (!key) return null;
  return { kind: "document", id: singleDraft && singleDraft.docId === docId && singleDraft.fingerprint === key ? singleDraft.id : key };
}

/**
 * Borra ese borrador (y sus bytes) y COMPRUEBA que ya no esta: `true` solo si de verdad desaparecio. Antes espera a que se
 * asiente el ultimo guardado pendiente, para que un volcado tardio no lo resucite despues del borrado.
 */
export async function deleteDeliveredDraft(draft: DeliveredDraft): Promise<boolean> {
  await whenDraftWritesSettle();
  if (draft.kind === "session") await deleteSessionDraft(draft.id);
  else await deleteDraft(draft.id);
  return !(await draftExists(draft.kind, draft.id));
}
