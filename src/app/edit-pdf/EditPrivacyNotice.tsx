"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { clearLocalEditData, type EditClearFailure } from "@/app/edit-pdf/clearLocalEditData";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";

export const EDIT_PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.edit-pdf.privacyNoticeSeen";

function hasSeenNotice(): boolean {
  try {
    return window.localStorage.getItem(EDIT_PRIVACY_NOTICE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markNoticeSeen(): void {
  try {
    window.localStorage.setItem(EDIT_PRIVACY_NOTICE_SEEN_KEY, "1");
  } catch {
    // Sin localStorage el aviso reaparece la proxima vez, sin romper nada.
  }
}

export type EditPrivacyNoticeProps = {
  flow: EditFlowStrings;
  /** Se llama cuando se vaciaron los borradores (para que el autoguardado no lo contradiga). */
  onCleared?: () => void;
  /** (W7-U6) Dentro de PDF Pro el texto completo no se abre solo: la fila (icono + «Borrar datos») basta. */
  compact?: boolean;
};

/**
 * Aviso de privacidad + «Borrar datos» del editor (Wave 5 · U5), con el patron
 * del `PrivacyNotice` de Firmar: el texto completo se abre solo la primera vez y
 * luego queda detras del icono «i»; el boton de borrado vive SIEMPRE en la misma
 * fila, sin depender de haber abierto el aviso. Borrar es asincrono (IndexedDB):
 * «Datos borrados» solo se afirma si terminaron BIEN; si falla se dice, y el boton
 * sigue sirviendo para reintentar.
 */
export function EditPrivacyNotice({ flow, onCleared, compact = false }: EditPrivacyNoticeProps) {
  const [open, setOpen] = useState(() => !compact && !hasSeenNotice());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [failed, setFailed] = useState<EditClearFailure[]>([]);

  const statusText = failed.length > 0 ? flow.privacyClearFailed : cleared ? flow.privacyCleared : "";

  const dismiss = () => {
    setOpen(false);
    markNoticeSeen();
  };

  return (
    <div data-edit-privacy="" className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="relative flex items-center gap-1.5 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:min-h-11 pointer-coarse:-my-[13px] pointer-coarse:px-2 pointer-coarse:-mx-2"
        >
          <Info aria-hidden="true" className="size-3.5" />
          {flow.privacyToggle}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:h-11 pointer-coarse:before:hidden"
          onClick={() => setConfirmOpen(true)}
        >
          {flow.privacyClear}
        </Button>
        {/* Region de estado siempre montada: solo cambia su contenido. */}
        <StatusRegion
          as="span"
          text={statusText}
          data-privacy-status=""
          className={failed.length > 0 ? "text-xs text-destructive-text" : "text-xs text-success-text"}
        >
          {statusText}
        </StatusRegion>
      </div>

      {open ? (
        <div className="surface-card rounded-ios flex items-start gap-3 p-4">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="flex-1 text-xs leading-relaxed text-muted-foreground">{flow.privacyBody}</p>
          <button
            type="button"
            aria-label={flow.confirmClose}
            onClick={dismiss}
            className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11 pointer-coarse:-m-3.5"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          void (async () => {
            setCleared(false);
            setFailed([]);
            const failures = await clearLocalEditData();
            setFailed(failures);
            setCleared(failures.length === 0);
            if (failures.length === 0) onCleared?.();
          })();
        }}
        title={flow.privacyClearTitle}
        body={flow.privacyClearBody}
        confirmLabel={flow.privacyClear}
        cancelLabel={flow.confirmCancel}
        closeLabel={flow.confirmClose}
      />
    </div>
  );
}
