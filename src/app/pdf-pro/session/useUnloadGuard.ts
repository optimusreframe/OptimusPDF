"use client";

import { useEffect } from "react";

/**
 * Pide confirmacion al cerrar o recargar la pestaña mientras `active` (Wave 7 · U8). Nada de `alert` propio: el
 * navegador pone su texto. Sin `active` no se registra ningun manejador (cerrar sin cambios nunca molesta).
 */
export function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Los navegadores antiguos exigen asignar `returnValue` para mostrar el aviso.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
