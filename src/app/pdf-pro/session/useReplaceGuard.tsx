"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { useI18n } from "@/lib/i18n";
import { getSessionStrings } from "@/app/pdf-pro/session/sessionStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

/**
 * Cambiar de documento (abrir otro PDF, uno nuevo o un reciente) con cambios sin descargar pide confirmacion
 * (Wave 7 · U8). Sin cambios, la accion corre al instante. El borrador automatico conserva el trabajo. Un paso en
 * vuelo (operacion corriendo o confirmacion que aun no esta en el historial) cuenta como cambios pendientes (D7).
 */
export function useReplaceGuard(): { request: (action: () => void) => void; node: ReactNode } {
  const { t, language } = useI18n();
  const { doc } = useProWorkingDoc();
  const s = getSessionStrings(language);
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);

  const request = useCallback(
    (action: () => void) => {
      const state = doc.getState();
      // Un paso en vuelo (operacion corriendo, confirmacion encolada) cuenta como cambios pendientes (D7).
      if (state.document && (state.dirty || state.stepInFlight)) {
        pending.current = action;
        setOpen(true);
        return;
      }
      action();
    },
    [doc],
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
        action?.();
      }}
      title={s.replaceTitle}
      body={s.replaceBody}
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
