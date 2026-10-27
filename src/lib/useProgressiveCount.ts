"use client";

import { useEffect, useState } from "react";

/**
 * Cuantos elementos de una lista larga pintar AHORA: los primeros `first` de inmediato y `step` mas en cada fotograma hasta
 * llegar a `total`. Pintar 117 filas con animacion de layout de golpe congelaba la pantalla ~200 ms en WebKit (una tarea larga
 * justo al elegir las fotos); en trozos de 10-20 cada tarea queda muy por debajo de 100 ms y la lista completa esta lista en
 * unos 5 fotogramas. Con `first` o menos elementos no cambia nada (es lo que ven las pruebas con pocos archivos).
 */
export function useProgressiveCount(total: number, first = 10, step = 20): number {
  const [shown, setShown] = useState(first);
  useEffect(() => {
    if (shown >= total) return;
    const id = requestAnimationFrame(() => setShown((current) => current + step));
    return () => cancelAnimationFrame(id);
  }, [shown, total, step]);
  return Math.min(total, Math.max(first, shown));
}
