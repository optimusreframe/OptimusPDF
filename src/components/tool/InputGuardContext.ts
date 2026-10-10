"use client";

import { createContext, useContext } from "react";
import { browserInputGuard, type InputGuard } from "@/lib/pdf/inputGuard";

/**
 * Proveedor opcional de la comprobacion de entrada (`inputGuard.ts`) que usa
 * `ToolShell` al elegir archivos. Sin proveedor manda el valor de produccion
 * (abre el PDF con pdf.js); `null` la desactiva y un valor propio la sustituye
 * (las pruebas inyectan una con `createInputGuard`).
 *
 * En Vitest (`NODE_ENV === "test"`) el valor por defecto es «sin comprobacion»:
 * pdf.js no corre en jsdom y las pruebas de componentes suben bytes de mentira
 * (`[1, 2, 3]`) a herramientas que nunca los abren. Una prueba que quiera
 * comprobar archivos envuelve el shell en `<InputGuardContext.Provider>`.
 */
export const InputGuardContext = createContext<InputGuard | null | undefined>(undefined);

export function useInputGuard(): InputGuard | null {
  const value = useContext(InputGuardContext);
  if (value !== undefined) return value;
  return process.env.NODE_ENV === "test" ? null : browserInputGuard;
}
