"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { docIdOf, type DocId } from "@/app/sign-pdf/docSet";
import type { SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { ensureSingleDraft, type SingleDraftRef } from "@/app/sign-pdf/singleDraft";
import { SOLO_GUARD_ID, hasSavedProgress, hasSoloWork, isRoundOpen } from "@/app/sign-pdf/signWork";
import type { SignWork, UnsavedReason } from "@/app/sign-pdf/useLeaveGuard";

export type SessionWorkSyncProps = {
  files: File[];
  /** La sesion ya puesta al dia con los archivos. */
  session: SignSession;
  /** Vista plana del documento activo. */
  options: SignToolOptions;
  /** Huella de cada documento (solo se calcula con varios). */
  keys: Record<DocId, string | null>;
  /** La sesion pesa demasiado para guardarse (`SessionDraftAutosave.onTooBig`). */
  tooBig: boolean;
  /** Identidad del borrador de SESION: la fija `SessionDraftAutosave`, que se monta antes que este componente. */
  identityRef: MutableRefObject<SessionIdentity | null>;
  /** F0-fix (D2): el ultimo intento de escribir el borrador FALLO (cuota llena, almacenamiento bloqueado, base no disponible...). */
  writeFailed?: boolean;
  /** Identidad del borrador de UN documento suelto (id unico por sesion de trabajo, F0-fix D3). Sin ella, la huella del PDF. */
  singleDraftRef?: SingleDraftRef;
  onWork: (work: SignWork) => void;
};

/**
 * Cuenta a la guarda de salida (`useLeaveGuard`) como esta el espacio de trabajo: si hay progreso (que se guarda, o el de
 * «Solo yo», que no tiene red), a que borrador apunta `?s=`, si lo que se ve esta guardado DE VERDAD y si la ronda de firmas
 * esta a medias. No pinta nada.
 *
 * `saved` solo es verdad con el borrador al dia: no cabe (`tooBig`), el navegador no dejo escribirlo (`writeFailed`) o el modo
 * no guarda (`Solo yo`) lo ponen en falso, cada uno con su razon (`unsaved`) para que la hoja de salida diga la verdad.
 *
 * El id del borrador se lee DENTRO del efecto, no al pintar: con varios documentos lo fija `SessionDraftAutosave` en su
 * propio efecto (esta antes en el arbol, asi que corre antes en el mismo commit); con uno es el id propio de la sesion de
 * trabajo (`ensureSingleDraft`: lo estrena quien llegue primero, este componente o el autoguardado del documento).
 */
export function SessionWorkSync({
  files,
  session,
  options,
  keys,
  tooBig,
  identityRef,
  writeFailed = false,
  singleDraftRef,
  onWork,
}: SessionWorkSyncProps) {
  const savedProgress = hasSavedProgress(files, session, options);
  const solo = !savedProgress && hasSoloWork(files, session);
  const progress = savedProgress || solo;
  const roundOpen = savedProgress && isRoundOpen({ files, session, options, keys });
  const single = files.length < 2;
  const documentKey = options.signature;
  const lastRef = useRef<SignWork | null>(null);

  useEffect(() => {
    let draftId: string | null = null;
    if (savedProgress) {
      if (!single) draftId = identityRef.current?.id ?? null;
      else if (documentKey) {
        draftId = singleDraftRef ? ensureSingleDraft(singleDraftRef, docIdOf(files[0]), documentKey).id : documentKey;
      }
    } else if (solo) {
      draftId = SOLO_GUARD_ID;
    }
    const unsaved: UnsavedReason | undefined = solo ? "solo" : tooBig ? "tooBig" : writeFailed ? "failed" : undefined;
    const next: SignWork = { progress, draftId, saved: unsaved === undefined, ...(unsaved ? { unsaved } : {}), roundOpen };
    const last = lastRef.current;
    if (
      last &&
      last.progress === next.progress &&
      last.draftId === next.draftId &&
      last.saved === next.saved &&
      last.unsaved === next.unsaved &&
      last.roundOpen === next.roundOpen
    ) {
      return;
    }
    lastRef.current = next;
    onWork(next);
  });

  return null;
}
