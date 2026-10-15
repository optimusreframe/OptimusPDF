"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hasPendingDraftWrite } from "@/app/sign-pdf/draftActivity";
import { hasSessionInUrl, hideSessionFromUrl, isBaseEntry, showSessionInUrl } from "@/app/sign-pdf/sessionUrl";
import { registerNavigationGuard } from "@/lib/navigationGuard";

/**
 * Lo que el espacio de trabajo de Firmar cuenta a la guarda de salida (Fase 0 «Firma agil», U0.3).
 *
 * Solo hay `SignWork` mientras hay un espacio de trabajo con archivos; sin el (zona de carga, pantalla de descarga) la guarda
 * recibe `null` y no hace nada.
 */
/** Por que lo que se ve en pantalla NO esta a salvo: no cabe como borrador, el navegador no deja guardar, o el modo no guarda. */
export type UnsavedReason = "tooBig" | "failed" | "solo";

export type SignWork = {
  /**
   * Hay trabajo que merece protegerse: firmantes, huecos o campos en un modo que SE GUARDA («Varios firmantes»), o -- sin
   * red -- lo ya hecho en «Solo yo», que no guarda borrador (`unsaved: "solo"`): ahi no hay nada que retomar, pero perder
   * lo hecho tampoco se puede deshacer, asi que se pregunta antes de salir y la hoja lo dice con esas palabras.
   */
  progress: boolean;
  /** Id del borrador al que apunta `?s=`; `null` mientras aun no se conoce (la huella del documento sigue calculandose). */
  draftId: string | null;
  /** El borrador esta guardado de verdad (cabe y la ultima escritura salio bien): si es `false`, salir PIERDE el trabajo. */
  saved: boolean;
  /** Por que no esta guardado (solo con `saved: false`); sin dato se dice «no cabe», como siempre. */
  unsaved?: UnsavedReason;
  /** Ronda de firmas a medias: alguien ya firmo y falta otra persona. */
  roundOpen: boolean;
};

/**
 * ¿Debe el navegador preguntar antes de cerrar o recargar? SOLO con progreso y, ademas, algo que perder o a medias: un
 * cambio que aun no llego al disco (`pendingWrite`: el autoguardado esta agendado o escribiendo), un borrador que no cabe o
 * una ronda de firmas a medias. Con todo guardado y la ronda en reposo cerrar no molesta. Safari en iPhone/iPad ignora este
 * aviso: por eso tambien existen la entrada de historial (`?s=`) y la hoja de salida.
 */
export function shouldWarnBeforeUnload(work: SignWork | null, pendingWrite: boolean): boolean {
  if (work === null || !work.progress) return false;
  return pendingWrite || !work.saved || work.roundOpen;
}

type LeaveRequest =
  | { kind: "back" }
  | { kind: "link"; href: string; proceed: () => void };

export type LeaveSheetState = {
  open: boolean;
  /** Lo que se dice: «todo esta guardado» (`true`) o «se perdera» (`false`). */
  saved: boolean;
  /** Si no esta guardado, por que: la hoja dice la razon verdadera (no cabe / no se pudo guardar / este modo no guarda). */
  reason?: UnsavedReason | null;
  /** «Seguir firmando»: cierra la hoja y deja la sesion como estaba. */
  onStay: () => void;
  /** «Salir»: sigue el camino que se interrumpio (atras en el historial, o el enlace pulsado). */
  onLeave: () => void;
};

/** Cuanto se espera, tras «Salir», a que la pagina de verdad se vaya antes de volver a proteger el trabajo. */
export const LEAVE_GIVE_UP_MS = 1200;

/**
 * Las tres redes de seguridad de Firmar al salir (Fase 0 «Firma agil», U0.3):
 *
 *  1. `beforeunload` con confirmacion, SOLO cuando `shouldWarnBeforeUnload` lo pide en ese instante (cerrar/recargar en
 *     escritorio). La decision se toma al disparar el evento, no al pintar: asi el cambio entre «guardando» y «guardado» no
 *     vuelve a pintar nada.
 *  2. La sesion en la URL: con progreso hay una entrada de historial `?s=<id>`; el «Atras» del navegador (o el gesto del
 *     iPad) vuelve a `/sign-pdf` sin `s` SIN desmontar la pagina y aparece la hoja «¿Salir de la firma?».
 *  3. Los enlaces internos (cabecera, menu, barra lateral: `GuardedLink`) consultan la guarda y, con progreso, abren la
 *     misma hoja en vez de navegar.
 *
 * Devuelve el estado de la hoja para pintarla (`LeaveSheet`). `onStay` es lo que hace tambien Escape o tocar fuera: la
 * opcion segura es quedarse. Con `work = null` (sin espacio de trabajo) no se registra nada que moleste.
 */
export function useLeaveGuard(work: SignWork | null): LeaveSheetState {
  const [request, setRequest] = useState<LeaveRequest | null>(null);
  const workRef = useRef(work);
  const bypassRef = useRef(false);
  const giveUpRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Esta pagina llego a poner una entrada `?s=` (detras de ella quedo una base propia). */
  const pushedRef = useRef(false);
  useEffect(() => {
    workRef.current = work;
  });

  const active = work !== null;
  const progress = work?.progress === true;
  const draftId = work?.draftId ?? null;

  // La entrada `?s=` existe mientras hay progreso y se retira (sin dejar entradas) cuando ya no lo hay.
  useEffect(() => {
    if (!active) return;
    if (progress) {
      if (draftId && showSessionInUrl(draftId) !== "unavailable") pushedRef.current = true;
    } else {
      hideSessionFromUrl();
    }
  }, [active, progress, draftId]);

  // 1) Cerrar o recargar. El manejador solo existe mientras hay progreso; si pregunta o no, se decide al dispararse.
  useEffect(() => {
    if (!progress) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassRef.current || !shouldWarnBeforeUnload(workRef.current, hasPendingDraftWrite())) return;
      event.preventDefault();
      // Los navegadores antiguos exigen asignar `returnValue` para mostrar el aviso.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [progress]);

  // 2) «Atras» del navegador y 3) enlaces internos.
  useEffect(() => {
    const onPopState = () => {
      if (bypassRef.current) return;
      if (!workRef.current?.progress) {
        // La sesion ya terminó (se descargo, o se quitaron los archivos) y el «Atras» cae en la entrada base que dejamos
        // atras, que no tiene nada que mostrar: se salta, para que UN «Atras» salga de verdad (como espera quien acaba).
        if (pushedRef.current && isBaseEntry() && !hasSessionInUrl()) window.history.back();
        return;
      }
      // De vuelta a la entrada con `?s=` (adelante en el historial): ya no hay nada que preguntar.
      if (hasSessionInUrl()) {
        setRequest((current) => (current?.kind === "back" ? null : current));
        return;
      }
      setRequest({ kind: "back" });
    };
    window.addEventListener("popstate", onPopState);
    // Volver desde la cache de «atras/adelante» (bfcache) devuelve la pagina tal y como estaba al irse, con el permiso de
    // salida de «Salir» aun puesto: la guarda vuelve a ser la de siempre.
    const onPageShow = (event: Event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      bypassRef.current = false;
      if (giveUpRef.current !== null) {
        clearTimeout(giveUpRef.current);
        giveUpRef.current = null;
      }
      setRequest(null);
    };
    window.addEventListener("pageshow", onPageShow);
    const unregister = registerNavigationGuard((href, proceed) => {
      if (bypassRef.current || !workRef.current?.progress) return false;
      setRequest({ kind: "link", href, proceed });
      return true;
    });
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
      unregister();
      if (giveUpRef.current !== null) clearTimeout(giveUpRef.current);
    };
  }, []);

  const onStay = useCallback(() => {
    const was = request;
    setRequest(null);
    // Tras el «Atras» la direccion perdio `?s=`: se vuelve a poner para que el SIGUIENTE «Atras» tambien pregunte.
    if (was?.kind === "back") {
      const current = workRef.current;
      if (current?.progress && current.draftId) showSessionInUrl(current.draftId);
    }
  }, [request]);

  const onLeave = useCallback(() => {
    const was = request;
    setRequest(null);
    if (!was) return;
    bypassRef.current = true;
    if (was.kind === "link") was.proceed();
    else window.history.back();
    // Si la pagina no se fue (no habia a donde volver) se vuelve a proteger el trabajo. Si se fue, el desmontaje cancela esto.
    if (giveUpRef.current !== null) clearTimeout(giveUpRef.current);
    giveUpRef.current = setTimeout(() => {
      giveUpRef.current = null;
      bypassRef.current = false;
      const current = workRef.current;
      if (current?.progress && current.draftId) showSessionInUrl(current.draftId);
    }, LEAVE_GIVE_UP_MS);
  }, [request]);

  const saved = work?.saved ?? true;
  return { open: request !== null, saved, reason: saved ? null : (work?.unsaved ?? "tooBig"), onStay, onLeave };
}
