"use client";

import { useEffect, useState } from "react";
import { BASELINE_SUPPORT, type OutputSupport } from "@/lib/media/image/formats";
import { probeOutputSupport } from "@/lib/media/image/browserBackend";

/**
 * Formatos que ESTE navegador sabe crear. Hasta que termina la prueba (milisegundos) vale la base segura (JPG, PNG, BMP), que
 * es lo mismo que se pinta en el servidor: sin desajuste de hidratacion. WebP y AVIF aparecen al confirmarse.
 */
export function useOutputSupport(): { support: OutputSupport; probed: boolean } {
  const [state, setState] = useState<{ support: OutputSupport; probed: boolean }>({ support: BASELINE_SUPPORT, probed: false });
  useEffect(() => {
    let alive = true;
    void probeOutputSupport().then((support) => {
      if (alive) setState({ support, probed: true });
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
