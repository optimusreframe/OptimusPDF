"use client";

import { createContext } from "react";

/**
 * Puerta opcional de admision de archivos para `FileDropzone`, pensada para una
 * herramienta que fija topes propios (numero de documentos, peso total) sin que
 * `ToolShell` los conozca: la herramienta provee el contexto alrededor del
 * shell y el dropzone, si lo encuentra, le consulta antes de aceptar. Sin
 * proveedor (el caso de todas las demas herramientas) no cambia nada.
 */
export type FileAdmission = {
  /** Decide que archivos de `incoming` entran en la lista que ya tiene `current`. */
  admit: (
    current: readonly File[],
    incoming: readonly File[],
  ) => { accepted: File[]; notice: string | null };
  /** Recibe el aviso de la ultima carga (`null` = nada que avisar); la herramienta decide donde pintarlo. */
  onNotice: (notice: string | null) => void;
};

export const FileAdmissionContext = createContext<FileAdmission | null>(null);
