"use client";

import { useEffect, useState, type CSSProperties } from "react";

/** Damero (las zonas transparentes se ven): claro en los dos temas, para que la tinta oscura se lea siempre. */
export const CHECKER_STYLE: CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%), linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

/** URL de objeto de un Blob mientras el componente lo muestra (se revoca al cambiar o desmontar). */
export function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!blob) {
      queueMicrotask(() => {
        if (alive) setUrl(null);
      });
      return () => {
        alive = false;
      };
    }
    const next = URL.createObjectURL(blob);
    queueMicrotask(() => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
      URL.revokeObjectURL(next);
    };
  }, [blob]);
  return url;
}

/** Campo de texto de la hoja (16 px con dedo: iOS no hace zoom al enfocarlo; 44 px de alto). */
export const INPUT_CLASS =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 disabled:opacity-50 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";
