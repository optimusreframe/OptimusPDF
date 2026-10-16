"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { docIdsOf } from "@/app/sign-pdf/docSet";
import { beginDraftWrite } from "@/app/sign-pdf/draftActivity";
import { reportOfWrite, type DraftWriteReport } from "@/app/sign-pdf/draftWriteReport";
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
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import type { SignSession } from "@/app/sign-pdf/signSession";
import type { SingleDraftRef } from "@/app/sign-pdf/singleDraft";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";

/**
 * Calma antes de guardar la sesion. Corto a proposito: solo se reescriben los
 * metadatos (los bytes de los PDF solo cuando cambia el conjunto de archivos),
 * asi que guardar a menudo es barato, y lo ultimo editado se pierde menos si la
 * pestana se cierra de golpe.
 */
export const SESSION_SAVE_DEBOUNCE_MS = 350;

/**
 * Ventana de «Deshacer» al quitar un documento con trabajo hecho (Fase 0 «Firma agil», U0.3): lo que dura el aviso con el
 * boton «Deshacer» de `SignToolClient`.
 */
export const DOCUMENT_UNDO_MS = 6000;

/**
 * Cuanto se espera, ademas, para borrar el borrador de la SESION cuando quitar documentos la deja en menos de dos: el
 * borrador no se borra hasta que expira el «Deshacer» (con un margen para que el aviso se retire primero). Deshacer a
 * tiempo devuelve los documentos y este borrado se cancela solo (el efecto se repite con la sesion de nuevo completa).
 */
export const SESSION_DELETE_GRACE_MS = DOCUMENT_UNDO_MS + 500;

let deleteGraceMs = SESSION_DELETE_GRACE_MS;

/** Solo para tests: acorta la espera del borrado diferido (`null` la devuelve a `SESSION_DELETE_GRACE_MS`). */
export function __setSessionDeleteGraceForTests(ms: number | null): void {
  deleteGraceMs = ms ?? SESSION_DELETE_GRACE_MS;
}

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
  /**
   * Como acabo el ultimo guardado (F0-fix): `saved`, `failed` (cuota llena, almacenamiento bloqueado, base no disponible...:
   * NO esta guardado), `tooBig` o `forked` (otra pestaña habia guardado una version mas nueva de esta sesion y la de esta
   * se guardo aparte). Es lo que impide que la pantalla diga «guardado» cuando no lo esta.
   */
  onWrite?: (report: DraftWriteReport) => void;
  /**
   * Identidad del borrador de UN documento suelto de esta sesion de trabajo. Cuando la ronda pasa a tener varios documentos y
   * la sesion se guarda, ese borrador suelto (el de ESTA pestaña) queda sustituido y se retira.
   */
  singleDraftRef?: SingleDraftRef;
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
 *    documento toma el relevo con su borrador de siempre, y el de sesion se borra
 *    -- pero NO de inmediato: solo tras `SESSION_DELETE_GRACE_MS`, para que el
 *    «Deshacer» de quitar un documento (F0 · U0.3) pueda devolver la ronda entera
 *    con todo su borrador. Si la pagina se cierra antes, el borrador se queda.
 *
 *  - firmas (U0.4): con «Guardar tambien las firmas recogidas» APAGADO el borrador guarda todo menos los trazos
 *    (`keepSignatures: false`); cambiar el interruptor repite el guardado al instante (no espera a la proxima edicion),
 *    asi que apagarlo quita ya de IndexedDB las firmas de la sesion que esta en pantalla.
 *
 * Solo guarda en "Varios firmantes", como el flujo de un documento. El modo
 * "Solo yo" NO guarda borrador, por decision (F0 · U0.3, punto 9): (1) su estado no
 * esta en el esquema del borrador -- falta la imagen de la firma, su proporcion y la
 * colocacion -- y guardarla significaria dejar la firma propia en IndexedDB sin que
 * nadie lo decida, cuando el baul de firmas (`signatureVault`) existe justo para que
 * eso sea opt-in; (2) el aviso de privacidad solo promete guardar «mientras trabajas
 * con varios firmantes»; (3) rehacer lo de «Solo yo» (crear la firma y colocarla)
 * cuesta segundos, no una ronda con varias personas; (4) el interruptor de «guardar
 * tambien las firmas» es U0.4 y aun no existe. Se revisa en U0.4. Mientras tanto la
 * guarda de salida (`useLeaveGuard`) tampoco actua en «Solo yo»: no promete lo que
 * no hay.
 */
export function SessionDraftAutosave({
  files,
  session,
  identityRef,
  onTooBig,
  onWrite,
  singleDraftRef,
}: SessionDraftAutosaveProps) {
  const generationRef = useRef(0);
  const keepSignatures = useSignPdfFeatureFlag("signaturesInDraft");
  const { mode, signMode, signers, blocks, docs, step, activeDocId, docOrder, ceremony, turnOrder } =
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
        // Una pestaña desactualizada no borra lo que otra guardo despues (F0-fix, D1).
        await deleteSessionDraft(identity.id, { unlessNewer: true });
        if (!isCurrent()) return;
        identity.saved = false;
        onTooBig(false);
      });

    // Una sola ronda de un documento (o ninguno): no hay sesion que guardar.
    // El flujo de un documento toma el relevo con su borrador de siempre.
    if (files.length < 2) {
      if (!current?.saved) return;
      // El borrador de la sesion espera a que expire el «Deshacer»; repetir el efecto (la ronda vuelve a tener
      // documentos) o desmontar cancelan el borrado y lo dejan todo como estaba.
      const timer = setTimeout(() => {
        void deleteSession(current).then(() => {
          if (!current.saved && identityRef.current === current) {
            identityRef.current = null;
          }
        });
      }, deleteGraceMs);
      return () => clearTimeout(timer);
    }
    if (mode !== "multi") return;
    // Una copia descifrada (PDF abierto con contrasena) nunca se guarda como borrador (Wave 6 · U3).
    if (files.some(isDecryptedCopy)) return;

    const hasProgress = hasSessionProgress({ signers, docs }, liveIds);
    if (!hasProgress) {
      if (!current?.saved) return;
      let fired = false;
      let stopHide = () => {};
      const endWrite = beginDraftWrite();
      const flushDelete = () => {
        fired = true;
        stopHide();
        void deleteSession(current).finally(endWrite);
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
      session: { mode, signMode, signers, blocks, docs, step, activeDocId, docOrder, ceremony, turnOrder },
      files,
      getBytes: bytesOf,
    });

    let fired = false;
    let stopHide = () => {};
    // Mientras la escritura esta agendada o en vuelo, el borrador va por detras de la pantalla (`draftActivity`).
    const endWrite = beginDraftWrite();
    const flush = () => {
      fired = true;
      stopHide();
      void saveSessionDraft({ ...snapshot, keepSignatures, isCurrent })
        .then((result) => {
          if (result.ok) {
            // Otra pestaña tenia una version mas nueva de esta sesion: la de esta se guardo APARTE y de ahora en adelante
            // se sigue guardando sobre esa copia (y se dice, sea cual sea la generacion: el aviso no puede perderse).
            if (result.forkedTo) {
              identity.id = result.forkedTo;
              onWrite?.({ kind: "forked", toId: result.forkedTo });
            }
            // La sesion sustituye al borrador de un documento suelto que ESTA
            // pestaña guardo cuando la ronda aun tenia uno solo.
            const replaced = new Set<string>();
            const single = singleDraftRef?.current;
            if (single && snapshot.documents.some((doc) => doc.state.sealedKey === single.fingerprint)) {
              replaced.add(single.id);
            }
            // Un borrador anterior (su id ES la huella del PDF) que esta pestaña siguio guardando.
            for (const doc of snapshot.documents) {
              const key = doc.state.sealedKey;
              if (key && wasDraftSavedHere(key)) replaced.add(key);
            }
            for (const id of replaced) void deleteDraft(id, { unlessNewer: true });
          }
          if (!isCurrent()) return;
          if (result.ok) onTooBig(false);
          else if (result.reason === "tooBig") onTooBig(true);
          const report = reportOfWrite(result);
          if (report && report.kind !== "forked") onWrite?.(report);
        })
        .finally(endWrite);
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
    ceremony,
    turnOrder,
    keepSignatures,
    identityRef,
    onTooBig,
    onWrite,
    singleDraftRef,
  ]);

  return null;
}
