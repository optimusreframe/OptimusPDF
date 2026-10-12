"use client";

import { ProEditorMode } from "@/app/pdf-pro/modes/ProEditorMode";
import type { ProModeProps } from "@/app/pdf-pro/modes/modeTypes";
import { registerProMode } from "@/app/pdf-pro/modes/proModes";

/**
 * Registro de los modos Editar y Anotar (Wave 7 · U6). Importar este modulo basta: se registran solos (efecto al
 * cargar), como cualquier otro modo de PDF Pro. `ProSuite` lo importa a traves de `tabs/proTabContent`.
 */

export function ProEditMode(props: ProModeProps) {
  return <ProEditorMode variant="edit" {...props} />;
}

export function ProAnnotateMode(props: ProModeProps) {
  return <ProEditorMode variant="annotate" {...props} />;
}

registerProMode({ id: "edit", tab: "edit", labelKey: "edit", Component: ProEditMode, preferredTool: "edit-pdf" });
registerProMode({
  id: "annotate",
  tab: "annotate",
  labelKey: "annotate",
  Component: ProAnnotateMode,
  preferredTool: "edit-pdf",
});
