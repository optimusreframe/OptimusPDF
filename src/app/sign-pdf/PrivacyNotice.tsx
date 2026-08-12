"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { clearValueHistory } from "@/lib/valueHistory";
import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";
import { clearAllTemplates } from "@/app/sign-pdf/signTemplates";
import type { SignStrings } from "@/app/sign-pdf/strings";

const PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

function hasSeenNotice(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_NOTICE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markNoticeSeen(): void {
  try {
    window.localStorage.setItem(PRIVACY_NOTICE_SEEN_KEY, "1");
  } catch {
    // Sin localStorage disponible no hay nada que marcar; el aviso
    // simplemente reaparecera la proxima vez, sin romper nada.
  }
}

export type PrivacyNoticeProps = {
  strings: SignStrings;
};

/**
 * Aviso de privacidad + botón "Borrar datos" del modo "varios firmantes"
 * -- el único que toca `src/lib/valueHistory.ts` y `signDrafts.ts` (el
 * modo "solo yo" no guarda nada localmente, así que no renderiza nada de
 * esto). El texto completo se abre solo, sin preguntar, la primera vez
 * que se ve un documento; a partir de ahí queda colapsado mientras siga
 * alcanzable con el icono "i". El botón de borrado vive siempre en la
 * misma fila, no solo dentro del aviso: la idea explícita del producto es
 * que "Borrar datos" nunca dependa de haber abierto el aviso primero.
 */
export function PrivacyNotice({ strings }: PrivacyNoticeProps) {
  const [open, setOpen] = useState(() => !hasSeenNotice());
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [cleared, setCleared] = useState(false);

  const dismiss = () => {
    setOpen(false);
    markNoticeSeen();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="hud-label flex items-center gap-1.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Info aria-hidden="true" className="size-3.5" />
          {strings.privacyNoticeToggle}
        </button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmClearOpen(true)}
        >
          {strings.privacyClearData}
        </Button>
        {cleared ? (
          <span className="text-xs text-success">
            {strings.privacyDataCleared}
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="glass rounded-ios flex items-start gap-3 p-4">
          <Info
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
            {strings.privacyNoticeBody}
          </p>
          <button
            type="button"
            aria-label={strings.confirmClose}
            onClick={dismiss}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmClearOpen}
        onClose={() => setConfirmClearOpen(false)}
        onConfirm={() => {
          // `clearAllDrafts()` es asincrono (IndexedDB): no se afirma
          // "Datos borrados" hasta que de verdad termino.
          void (async () => {
            clearValueHistory();
            clearAllTemplates();
            await clearAllDrafts();
            setCleared(true);
          })();
        }}
        title={strings.privacyClearDataTitle}
        body={strings.privacyClearDataBody}
        confirmLabel={strings.privacyClearData}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </div>
  );
}
