"use client";

import { useSyncExternalStore } from "react";

function subscribe(): () => void {
  return () => {};
}

/**
 * `false` durante el render del servidor y la hidratacion, `true` una vez
 * en el cliente. Evita tocar `document` antes de tiempo sin recurrir a
 * setState dentro de un efecto.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
