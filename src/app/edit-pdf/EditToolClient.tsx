"use client";

import { EditInlineTool } from "@/app/edit-pdf/EditInlineTool";

/**
 * Entrada de la herramienta «Editar PDF». Desde la Wave 5 · U5 hay UN solo
 * editor (inline, sobre el documento): el ajuste `editExistingText` ya no
 * devuelve a un editor antiguo, solo activa o desactiva la edicion del texto
 * que ya trae el PDF (ver `EditInlineTool`).
 */
export function EditToolClient() {
  return <EditInlineTool />;
}
