"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { setSignHandoff, type SignHandoffMode } from "@/lib/docLibrary/signHandoff";

/**
 * «Firmar» / «Configurar plantilla» / «Firmar seleccionados»: deja el traspaso (ids de la biblioteca y el modo) justo antes
 * de navegar a Firmar, que lo recoge UNA vez al montar (contrato en `src/lib/docLibrary/signHandoff.ts`). Devuelve
 * `false` (y no navega) si los ids no son validos o son mas de los admitidos.
 */
export function useOpenInSign(): (documentIds: string[], mode: SignHandoffMode) => boolean {
  const router = useRouter();
  return useCallback(
    (documentIds, mode) => {
      if (!setSignHandoff({ documentIds, mode })) return false;
      router.push("/sign-pdf");
      return true;
    },
    [router],
  );
}
