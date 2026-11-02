"use client";

import { useEffect, useState } from "react";
import { detectOutputSupport, type OutputSupport } from "@/lib/media/audio/capabilities";

/** Formatos de salida que admite este navegador; `null` mientras se comprueba (solo unos milisegundos). */
export function useOutputSupport(): OutputSupport | null {
  const [support, setSupport] = useState<OutputSupport | null>(null);
  useEffect(() => {
    let alive = true;
    void detectOutputSupport().then((result) => {
      if (alive) setSupport(result);
    });
    return () => {
      alive = false;
    };
  }, []);
  return support;
}
