"use client";

import { useRef } from "react";
import { FillEmbedded } from "@/app/sign-pdf/FillEmbedded";
import type { ProModeProps } from "@/app/pdf-pro/modes/modeTypes";
import { useEntryFocus } from "@/app/pdf-pro/modes/modeFocus";
import { useOptionalProWorkingDocState } from "@/app/pdf-pro/useProWorkingDoc";

/**
 * Modo Rellenar de PDF Pro (Wave 7 · U7): campos AcroForm reales (se escribe `/V` y la apariencia), huecos
 * sugeridos y texto libre sobre el snapshot vigente; «Aplicar formulario» crea UN snapshot.
 */
export function ProFillMode({ file, bytes, lang, onApply, onCancel, onDirtyChange }: ProModeProps) {
  const state = useOptionalProWorkingDocState();
  // Entrar con el teclado deja el foco en <body> al desmontarse el visor: pasa a la region del modo.
  const rootRef = useRef<HTMLDivElement>(null);
  useEntryFocus(rootRef, '[data-pro-mode="fill"]');
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
    <FillEmbedded
      file={file}
      bytes={bytes}
      lang={lang}
      onApply={onApply}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
      facts={
        state?.document
          ? { signatures: state.document.signatures, encrypted: state.document.wasEncrypted }
          : undefined
      }
    />
    </div>
  );
}
