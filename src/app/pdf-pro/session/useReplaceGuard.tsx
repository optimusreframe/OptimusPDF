"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { discardExportBeforeLeaving, leaveConfirmation } from "@/app/pdf-pro/export/exportGuard";
import { useI18n } from "@/lib/i18n";
import { getSessionStrings } from "@/app/pdf-pro/session/sessionStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

/**
 * Cambiar de documento (abrir otro PDF, uno nuevo o un reciente) con cambios sin descargar pide confirmacion
 * (Wave 7 · U8). Sin cambios, la accion corre al instante. El borrador automatico conserva el trabajo. Un paso en
 * vuelo (operacion corriendo o confirmacion que aun no esta en el historial) cuenta como cambios pendientes (D7), y
 * una exportacion en curso tambien (Wave 9): se cancela al confirmar y la hoja lo dice.
 */
export function useReplaceGuard(): { request: (action: () => void) => void; node: ReactNode } {
  const { t, language } = useI18n();
  const { doc } = useProWorkingDoc();
  const s = getSessionStrings(language);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(s.replaceBody);
  const pending = useRef<(() => void) | null>(null);

  const request = useCallback(
    (action: () => void) => {
      // Un paso en vuelo (operacion corriendo, confirmacion encolada) cuenta como cambios pendientes (D7); una
      // exportacion en curso tambien (Wave 9).
      const decision = leaveConfirmation(doc, language, "replace", s.replaceBody);
      if (decision.needed) {
        pending.current = action;
        setBody(decision.body);
        setOpen(true);
        return;
      }
      action();
    },
    [doc, language, s.replaceBody],
  );

  const node = (
    <ConfirmSheet
      open={open}
      onClose={() => {
        pending.current = null;
        setOpen(false);
      }}
      onConfirm={() => {
        const action = pending.current;
        pending.current = null;
        // La exportacion en curso se cancela y se limpia ANTES de cambiar de documento (nada huerfano).
        discardExportBeforeLeaving(doc);
        action?.();
      }}
      title={s.replaceTitle}
      body={body}
      confirmLabel={s.replaceConfirm}
      cancelLabel={t.common.cancel}
      closeLabel={t.common.close}
      // «Continuar» puede llevar el foco a un aviso nuevo (archivo roto): la hoja no se lo quita al cerrarse.
      restoreFocusOnClose={() => {
        const active = window.document.activeElement;
        return !active || active === window.document.body || !!active.closest('[role="dialog"]');
      }}
    />
  );
  return { request, node };
}
