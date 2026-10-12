"use client";

import { createContext, useContext } from "react";

/**
 * Lienzo compacto (Wave 7 · U7): dentro de los modos Firmar y Rellenar de PDF Pro el lienzo ocupa la region central
 * y cada pixel antes de la hoja cuenta. Con este contexto en `true`, `DocumentCanvas` deja el titulo y la ayuda
 * de arriba solo para lectores de pantalla y pega su barra de zoom al borde de la region que se desplaza. Fuera
 * (la herramienta suelta) el valor es `false` y el lienzo es el de siempre.
 */
export const CanvasCompactContext = createContext(false);

export function useCanvasCompact(): boolean {
  return useContext(CanvasCompactContext);
}
