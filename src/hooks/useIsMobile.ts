"use client";

import { useEffect, useState } from "react";

export const MOBILE_QUERY = "(max-width: 767px)";

/**
 * Devuelve `false` en el primer render (y en el HTML del servidor) para
 * no romper la hidratacion; se ajusta al montar en el cliente.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}
