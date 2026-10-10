"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { docIdsOf } from "@/app/sign-pdf/docSet";
import { flushOnPageHide } from "@/app/sign-pdf/flushOnPageHide";
import {
  hasSessionProgress,
  identityFor,
  snapshotSession,
  type SessionIdentity,
} from "@/app/sign-pdf/sessionDraft";
import {
  deleteDraft,
  deleteSessionDraft,
  saveSessionDraft,
  wasDraftSavedHere,
  warmDraftsConnection,
} from "@/app/sign-pdf/signDrafts";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";

/**
 * Calma antes de guardar la sesion. Corto a proposito: solo se reescriben los
 * metadatos (los bytes de los PDF solo cuando cambia el conjunto de archivos),
 * asi que guardar a menudo es barato, y lo ultimo editado se pierde menos si la
 * pestana se cierra de golpe.
 */
export const SESSION_SAVE_DEBOUNCE_MS = 350;

/** Bytes de cada archivo, leidos una sola vez: el autoguardado dispara muchas veces. */
const bytesCache = new WeakMap<File, Promise<Uint8Array>>();

function bytesOf(file: File): Promise<Uint8Array> {
  let bytes = bytesCache.get(file);
  if (!bytes) {
    bytes = file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    bytesCache.set(file, bytes);
  }
  return bytes;
}

export type SessionDraftAutosaveProps = {
  /** Archivos de la ronda: su orden es la cola de documentos. */
  files: File[];
  /** La sesion ya puesta al dia con los archivos. */
  session: SignSession;
  /**
   * Identidad de la sesion guardada. La posee quien monta este componente (no
   * el componente): sobrevive a que `ToolShell` lo desmonte durante el procesado
   * y lo vuelva a montar si este falla, y la fija quien retoma un borrador.
   */
  identityRef: MutableRefObject<SessionIdentity | null>;
  /** `true` mientras la sesion pesa demasiado para guardarse como borrador. */
  onTooBig: (tooBig: boolean) => void;
};

/**
 * Autoguardado del borrador de UNA SESION (dos o mas documentos). No pinta
 * nada. Misma disciplina que el autoguardado de un documento (`MultiFlow`):
 *
 *  - debounce de ~350 ms (`SESSION_SAVE_DEBOUNCE_MS`); si el efecto se limpia antes de que dispare (cambio
 *    siguiente o desmontaje) el guardado pendiente se vuelca de inmediato;
 *  - generacion: un volcado tardio que ya fue reemplazado por otro mas nuevo
 *    (o por un borrado) calla justo antes de escribir -- lo borrado no resucita;
 *  - sin progreso no se guarda, y si ya se habia guardado esta sesion se borra
 *    (el ultimo firmante o hueco quitado se refleja);
 *  - con menos de dos documentos la sesion ya no existe: el flujo de un solo
 *    documento toma el relevo con su borrador de siempre, y el de sesion se borra.
 *
 * Solo guarda en "Varios firmantes", como el flujo de un documento (el modo
 * "Solo yo" no guarda borrador).
 */
export function SessionDraftAutosave({
  files,
  session,
  identityRef,
  onTooBig,
}: SessionDraftAutosaveProps) {
  const generationRef = useRef(0);
  const { mode, signMode, signers, blocks, docs, step, activeDocId, docOrder } =
    session;

  useEffect(() => {
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const isCurrent = () => generationRef.current === myGeneration;

    const current = identityRef.current;
    const liveIds = docIdsOf(files);
    // Con varios documentos, la conexion queda abierta para que el volcado de
    // `pagehide` no tenga que esperar a abrirla.
    if (files.length >= 2 && mode === "multi") void warmDraftsConnection();

    /**
     * Borra el borrador de ESTA sesion. El estado "guardada" solo se baja cuando
     * el borrado termino: si el efecto se repite antes (cualquier cambio), la
     * repeticion vuelve a pedir el borrado en vez de darlo por hecho. Un borrado
     * superado por un estado mas nuevo se descarta.
     */
    const deleteSession = (identity: SessionIdentity) =>
      Promise.resolve().then(async () => {
        if (!isCurrent()) return;
        await deleteSessionDraft(identity.id);
        if (!isCurrent()) return;
        identity.saved = false;
        onTooBig(false);
      });

    // Una sola ronda de un documento (o ninguno): no hay sesion que guardar.
    // El flujo de un documento toma el relevo con su borrador de siempre.
    if (files.length < 2) {
      if (!current?.saved) return;
      void deleteSession(current).then(() => {
        if (!current.saved && identityRef.current === current) {
          identityRef.current = null;
        }
      });
      return;
    }
    if (mode !== "multi") return;
    // Una copia descifrada (PDF abierto con contrasena) nunca se guarda como borrador (Wave 6 · U3).
    if (files.some(isDecryptedCopy)) return;

    const hasProgress = hasSessionProgress({ signers, docs }, liveIds);
    if (!hasProgress) {
      if (!current?.saved) return;
      let fired = false;
      let stopHide = () => {};
      const flushDelete = () => {
        fired = true;
        stopHide();
        void deleteSession(current);
      };
      const timer = setTimeout(flushDelete, SESSION_SAVE_DEBOUNCE_MS);
      stopHide = flushOnPageHide(() => {
        if (!fired) flushDelete();
      });
      return () => {
        clearTimeout(timer);
        stopHide();
        if (!fired) flushDelete();
      };
    }

    const identity = identityFor(current, liveIds);
    identityRef.current = identity;
    // Marcado de inmediato (no cuando el guardado asincrono termina): una
    // transicion posterior, incluso muy rapida, tiene que ver ya la intencion
    // vigente.
    identity.saved = true;

    const snapshot = snapshotSession({
      identity,
      session: { mode, signMode, signers, blocks, docs, step, activeDocId, docOrder },
      files,
      getBytes: bytesOf,
    });

    let fired = false;
    let stopHide = () => {};
    const flush = () => {
      fired = true;
      stopHide();
      void saveSessionDraft({ ...snapshot, isCurrent }).then((result) => {
        if (result.ok) {
          // La sesion sustituye al borrador de un documento suelto que ESTA
          // pestaña guardo cuando la ronda aun tenia uno solo.
          for (const doc of snapshot.documents) {
            const key = doc.state.sealedKey;
            if (key && wasDraftSavedHere(key)) void deleteDraft(key);
          }
        }
        if (!isCurrent()) return;
        if (result.ok) onTooBig(false);
        else if (result.reason === "tooBig") onTooBig(true);
      });
    };
    const timer = setTimeout(flush, SESSION_SAVE_DEBOUNCE_MS);
    // Al irse de la pagina (recargar, cerrar, pestana oculta) no se espera al debounce.
    stopHide = flushOnPageHide(() => {
      if (!fired) flush();
    });
    return () => {
      clearTimeout(timer);
      stopHide();
      if (!fired) flush();
    };
  }, [
    files,
    mode,
    signMode,
    signers,
    blocks,
    docs,
    step,
    activeDocId,
    docOrder,
    identityRef,
    onTooBig,
  ]);

  return null;
}
