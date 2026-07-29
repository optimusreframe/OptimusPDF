"use client";

import { useEffect, useState } from "react";

/**
 * Devuelve `false` en el primer render (y en el HTML del servidor) para
 * no romper la hidratacion; se ajusta al montar en el cliente y sigue
 * escuchando, asi que reacciona a un giro del telefono o a un cambio de
 * tamaño de la ventana sin recargar nada.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
