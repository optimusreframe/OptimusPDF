"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { registerNavigationGuard } from "@/lib/navigationGuard";
import { hasScanInUrl, hideScanFromUrl, isBaseEntry, showScanInUrl } from "@/app/scan-to-pdf/scanUrl";

/** Cuanto se espera, tras «Salir», a que la pagina de verdad se vaya antes de volver a proteger el trabajo. */
export const LEAVE_GIVE_UP_MS = 1200;

export type ScanWork = {
  /** Hay un escaneo con paginas que merece protegerse. */
  progress: boolean;
  sessionId: string;
  /** Lo que se ve en pantalla esta a salvo en el dispositivo (guardado automatico al dia). */
  saved: boolean;
  pages: number;
};

/**
 * ¿Debe el navegador preguntar antes de cerrar o recargar? SOLO con progreso y, ademas, algo que perder: un cambio que aun no
 * llego al disco (`pendingWrite`) o un escaneo que no se pudo guardar. Con todo guardado, cerrar no molesta (Safari en iPhone
 * ignora este aviso: por eso existen tambien la entrada de historial `?scan=` y la hoja de salida).
 */
export function shouldWarnBeforeUnload(work: ScanWork | null, pendingWrite: boolean): boolean {
  if (work === null || !work.progress) return false;
  return pendingWrite || !work.saved;
}

type LeaveRequest = { kind: "back" } | { kind: "link"; href: string; proceed: () => void };

export type ScanLeaveState = {
  open: boolean;
  saved: boolean;
  pages: number;
  onStay: () => void;
  onLeave: () => void;
};

/**
 * Las tres redes de seguridad del Escaner al salir (patron de `useLeaveGuard` de Firmar): `beforeunload` solo si hay algo sin
 * guardar; la sesion en la direccion (`?scan=`) para atrapar el «Atras»; y los enlaces internos (`GuardedLink`) consultan la
 * guarda. La opcion segura es quedarse (`onStay`: tambien Escape y tocar fuera).
 */
export function useScanLeaveGuard(work: ScanWork | null, hasPendingWrite: () => boolean): ScanLeaveState {
  const [request, setRequest] = useState<LeaveRequest | null>(null);
  const workRef = useRef(work);
  const pendingRef = useRef(hasPendingWrite);
  const bypassRef = useRef(false);
  const giveUpRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushedRef = useRef(false);
  useEffect(() => {
    workRef.current = work;
    pendingRef.current = hasPendingWrite;
  });

  const progress = work?.progress === true;
  const sessionId = work?.sessionId ?? null;

  // La entrada `?scan=` existe mientras hay progreso y se retira (sin dejar entradas) cuando ya no lo hay.
  useEffect(() => {
    if (progress && sessionId) {
      if (showScanInUrl(sessionId) !== "unavailable") pushedRef.current = true;
    } else {
      hideScanFromUrl();
    }
  }, [progress, sessionId]);

  useEffect(() => {
    if (!progress) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassRef.current || !shouldWarnBeforeUnload(workRef.current, pendingRef.current())) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [progress]);

  useEffect(() => {
    const onPopState = () => {
      if (bypassRef.current) return;
      if (!workRef.current?.progress) {
        // La sesion ya termino y el «Atras» cae en la entrada base que dejamos: se salta para que UN «Atras» salga de verdad.
        if (pushedRef.current && isBaseEntry() && !hasScanInUrl()) window.history.back();
        return;
      }
      if (hasScanInUrl()) {
        setRequest((current) => (current?.kind === "back" ? null : current));
        return;
      }
      setRequest({ kind: "back" });
    };
    window.addEventListener("popstate", onPopState);
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
    if (was?.kind === "back") {
      const current = workRef.current;
      if (current?.progress) showScanInUrl(current.sessionId);
    }
  }, [request]);

  const onLeave = useCallback(() => {
    const was = request;
    setRequest(null);
    if (!was) return;
    bypassRef.current = true;
    if (was.kind === "link") was.proceed();
    else window.history.back();
    if (giveUpRef.current !== null) clearTimeout(giveUpRef.current);
    giveUpRef.current = setTimeout(() => {
      giveUpRef.current = null;
      bypassRef.current = false;
      const current = workRef.current;
      if (current?.progress) showScanInUrl(current.sessionId);
    }, LEAVE_GIVE_UP_MS);
  }, [request]);

  return { open: request !== null, saved: work?.saved ?? true, pages: work?.pages ?? 0, onStay, onLeave };
}
